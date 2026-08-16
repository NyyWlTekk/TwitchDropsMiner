from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict, abc, deque
from datetime import datetime
from functools import partial
from time import time
from typing import TYPE_CHECKING, Any, Literal

import aiohttp

from src.api import GQLClient, HTTPClient
from src.auth import _AuthState
from src.config import ClientType, State, WebsocketTopic
from src.exceptions import ExitRequest, RequestException
from src.i18n import _
from src.models.models import Channel, DropsCampaign
from src.services.campaign_service import InventoryCoordinator
from src.services.maintenance import MaintenanceService
from src.services.message_handlers import MessageHandlerService
from src.services.stream_selector import StreamSelector
from src.services.watch_service import WatchService
from src.utils import AwaitableValue
from src.websocket import WebsocketPool

if TYPE_CHECKING:
    from src.config import ClientInfo, GQLRequest, JsonType
    from src.config.settings import Settings
    from src.models.models import Game, TimedDrop
    from src.web.gui_manager import WebGUIManager


logger = logging.getLogger("TwitchDrops")
gql_logger = logging.getLogger("TwitchDrops.gql")


# ==============================================================================
# 1. CORE CLIENT (Holds Shared State & API Configurations)
# ==============================================================================

class Twitch:
    def __init__(self, settings: Settings) -> None:
        self.settings: Settings = settings

        # --- State Management ---
        self._state: State = State.IDLE
        self._state_change = asyncio.Event()

        # --- Core Data & Inventory ---
        self.inventory: list[DropsCampaign] = []
        self.wanted_games: list[Game] = []
        self.channels: OrderedDict[int, Channel] = OrderedDict()
        self._drops: dict[str, TimedDrop] = {}
        self._campaigns: dict[str, DropsCampaign] = {}

        # --- Stream & Watch Tracking ---
        self.watching_channel: AwaitableValue[Channel] = AwaitableValue()
        self._watching_task: asyncio.Task[None] | None = None
        self._watching_restart = asyncio.Event()

        # --- Internal Flags & Cache ---
        self._inventory_dirty: bool = True
        self._wanted_games_cache: list[Game] = []
        self._full_cleanup: bool = False
        self._mnt_triggers: deque[datetime] = deque()

        # --- Auth & API Clients ---
        self._client_type: ClientInfo = ClientType.ANDROID_APP
        self._auth_state: _AuthState = _AuthState(self)
        self._http_client: HTTPClient | None = None
        self._gql_client: GQLClient | None = None

        # --- GUI & WebSockets ---
        self.gui: WebGUIManager = None  # type: ignore[assignment]
        self.websocket = WebsocketPool(self)

        # --- Domain Services ---
        self._stream_selector: StreamSelector = StreamSelector()
        self._maintenance_service: MaintenanceService = MaintenanceService(self)
        self._message_handler_service: MessageHandlerService = MessageHandlerService(self)
        self._inventory_service: InventoryCoordinator = InventoryCoordinator(self)
        self._watch_service: WatchService = WatchService(self)

        # --- Maintenance & Metrics ---
        self._mnt_task: asyncio.Task[None] | None = None
        self.ignored_count: int = 0
        self.claimed_count: int = 0

    # --------------------------------------------------------------------------
    # Service Properties & Delegations
    # --------------------------------------------------------------------------
    @property
    def watch_service(self) -> WatchService:
        return self._watch_service

    @property
    def inventory_service(self) -> InventoryService:
        return self._inventory_service

    @property
    def stream_selector(self) -> StreamSelector:
        return self._stream_selector
        
    @property
    def channel_service(self) -> ChannelService:
        return self._channel_service

    def stop_watching(self) -> None:
        self._watch_service.stop_watching()

    def is_manual_mode(self) -> bool:
        return self._watch_service.is_manual_mode()

    def enter_manual_mode(self, channel: Channel) -> None:
        self._watch_service.enter_manual_mode(channel)

    def exit_manual_mode(self, reason: str = "") -> None:
        self._watch_service.exit_manual_mode(reason)

    # --------------------------------------------------------------------------
    # API Client Management
    # --------------------------------------------------------------------------
    def _ensure_api_clients(self) -> None:
        """Ensure HTTP and GQL API clients are initialized."""
        if self._http_client is None:
            self._http_client = HTTPClient(self.settings, self.gui, self, self._client_type)
        if self._gql_client is None:
            self._gql_client = GQLClient(self._http_client, self._auth_state, self._client_type)

    async def get_session(self) -> aiohttp.ClientSession:
        self._ensure_api_clients()
        assert self._http_client is not None
        return await self._http_client.get_session()

    def request(self, method: str, url: str | Any, **kwargs) -> Any:
        self._ensure_api_clients()
        assert self._http_client is not None
        return self._http_client.request(method, url, **kwargs)

    async def get_auth(self) -> _AuthState:
        await self._auth_state.validate()
        return self._auth_state

    async def gql_request(self, ops: GQLRequest | list[GQLRequest]) -> JsonType | list[JsonType]:
        self._ensure_api_clients()
        assert self._gql_client is not None
        return await self._gql_client.request(ops)

    # --------------------------------------------------------------------------
    # Client Lifecycle & State Control
    # --------------------------------------------------------------------------
    def change_state(self, state: State) -> None:
        if self._state is not State.EXIT:
            self._state = state
        self._state_change.set()

    def get_change_state_callable(self, state: State) -> abc.Callable[[], None]:
        return partial(self.change_state, state)

    def trigger_stream_selection(self, force: bool = False) -> None:
        """Vyvolá okamžitý výběr nového streamu nebo kompletní re-evaluaci inventáře."""
        logger.info("Triggering stream selection (force=%s)...", force)
        if force:
            self._inventory_dirty = True
            self._full_cleanup = True
            self.change_state(State.INVENTORY_FETCH)
        else:
            self.change_state(State.CHANNEL_SWITCH)

    def request_stream_select(self) -> None:
        """Callback pro WatchService v případě ztráty/ukončení sledovaného kanálu."""
        self.change_state(State.CHANNEL_SWITCH)

    def build_wanted_games(self) -> list[Game]:
        """Přebuduje seznam požadovaných her přes StreamSelector."""
        self.wanted_games = self._stream_selector.get_wanted_games(self.settings, self.inventory)
        return self.wanted_games

    def wait_until_login(self) -> abc.Coroutine[Any, Any, Literal[True]]:
        return self._auth_state._logged_in.wait()

    def print(self, message: str) -> None:
        if self.gui:
            self.gui.print(message)

    def close(self) -> None:
        self.change_state(State.EXIT)

    async def shutdown(self) -> None:
        start_time = time()
        self.stop_watching()

        if self._watching_task is not None:
            self._watching_task.cancel()
            try:
                await self._watching_task
            except asyncio.CancelledError:
                pass
            self._watching_task = None

        if self._mnt_task is not None:
            self._mnt_task.cancel()
            try:
                await self._mnt_task
            except asyncio.CancelledError:
                pass
            self._mnt_task = None

        await self.websocket.stop(clear_topics=True)
        if self._http_client is not None:
            await self._http_client.close()

        self._drops.clear()
        self.channels.clear()
        self.inventory.clear()
        self._auth_state.clear()
        self.wanted_games.clear()
        self._mnt_triggers.clear()
        await asyncio.sleep(max(0, start_time + 0.5 - time()))

    def _remove_channel_topics(self, channels: abc.Iterable[Channel]) -> None:
        topics_to_remove: list[str] = []
        for channel in channels:
            topics_to_remove.append(WebsocketTopic.as_str("Channel", "StreamState", channel.id))
            topics_to_remove.append(WebsocketTopic.as_str("Channel", "StreamUpdate", channel.id))
        if topics_to_remove:
            self.websocket.remove_topics(topics_to_remove)

    # --------------------------------------------------------------------------
    # Inventory & Channel Passthroughs
    # --------------------------------------------------------------------------
    async def fetch_campaigns(self, campaigns_chunk: list[tuple[str, JsonType]]) -> dict[str, JsonType]:
        return await self._inventory_service.fetch_campaigns(campaigns_chunk)

    async def fetch_inventory(self) -> None:
        await self._inventory_service.fetch_inventory()

    def get_active_campaign(self, channel: Channel | None = None) -> DropsCampaign | None:
        return self._inventory_service.get_active_campaign(channel)

    # --------------------------------------------------------------------------
    # Main Application Entry Point
    # --------------------------------------------------------------------------
    async def run(self) -> None:
        """Bootstrap the client services and hand execution over to the state loop."""
        try:
            while True:
                try:
                    self.ignored_count = 0
                    self.claimed_count = 0
                    self._ensure_api_clients()
                    auth_state = await self.get_auth()
                    await self.websocket.start()

                    if self._watching_task is not None:
                        self._watching_task.cancel()
                        try:
                            await self._watching_task
                        except asyncio.CancelledError:
                            pass

                    self._watching_task = asyncio.create_task(self._watch_service.watch_loop())

                    user_id = getattr(auth_state, "user_id", getattr(self._auth_state, "user_id", None))
                    if user_id:
                        self.websocket.add_topics([
                            WebsocketTopic("User", "Drops", user_id, self._message_handler_service.process_drops),
                            WebsocketTopic("User", "Notifications", user_id, self._message_handler_service.process_notifications),
                        ])

                    self.change_state(State.INVENTORY_FETCH)
                    await run_state_machine_loop(self)
                    break
                except ExitRequest:
                    break
                except aiohttp.ContentTypeError as exc:
                    raise RequestException(_.t["login"]["unexpected_content"]) from exc
        finally:
            await self.shutdown()


# ==============================================================================
# 2. STATE MACHINE CORE LOOP
# ==============================================================================
async def run_state_machine_loop(client: Twitch) -> None:
    """Hlavní smyčka spravující přechody stavů a spouštění odpovídajících handlerů."""
    state_handlers = {
        State.IDLE: handle_state_idle,
        State.INVENTORY_FETCH: lambda c: c.inventory_service.process_inventory_fetch(),
        State.GAMES_UPDATE: handle_state_games_update,
        State.CHANNELS_CLEANUP: handle_state_channels_cleanup,
        State.CHANNELS_FETCH: lambda c: c.watch_service.handle_state_channels_fetch(),
        State.CHANNEL_SWITCH: lambda c: c.watch_service.process_channel_switch(),
        State.WATCHING: handle_state_watching,
    }
    while True:
        current_state = client._state

        # Při ukončení aktualizujeme GUI a korektně ukončíme smyčku
        if current_state is State.EXIT:
            if client.gui:
                client.gui.status.update(_.t["gui"]["status"]["exiting"])
            break

        try:
            handler = state_handlers.get(current_state)
            if handler:
                await handler(client)
            else:
                logger.error("Unknown state machine state: %s", current_state)
                client.change_state(State.IDLE)

        except asyncio.CancelledError:
            logger.debug("State machine loop task cancelled")
            raise
        except Exception as exc:
            logger.exception("Unhandled error in state machine loop (current state: %s): %s", current_state, exc)
            if client.gui:
                client.gui.status.update(f"Error in state {current_state.name}. Recovering...")
            client.change_state(State.IDLE)
            await asyncio.sleep(5)

        # Čekání na další signál – přeskočí se, pokud už handler změnil stav
        if client._state is not State.EXIT:
            if client._state == current_state and not client._state_change.is_set():
                try:
                    await client._state_change.wait()
                except asyncio.CancelledError:
                    break
            
            client._state_change.clear()

# ==============================================================================
# 3. MODULAR STATE HANDLERS
# ==============================================================================

async def handle_state_idle(client: Twitch) -> None:
    if client.gui and hasattr(client.gui, "status"):
        client.gui.status.update(_.t["gui"]["status"]["idle"])
    client.stop_watching()
    
async def handle_state_watching(client: Twitch) -> None:
    """Handler pro stav WATCHING: udržuje stav sledování a čeká na přechodový signál."""
    logger.debug("Aplikace je ve stavu WATCHING.")
    await client._state_change.wait()

async def handle_state_games_update(client: Twitch) -> None:
    # 1. Claiming hotových dropů
    for campaign in client.inventory:
        if not getattr(campaign, "linked", True) or getattr(campaign, "upcoming", False):
            continue
        for drop in campaign.drops:
            if drop.can_claim:
                logger.info("Attempting to claim drop: %s (ID: %s)", drop.name, drop.id)
                await asyncio.sleep(2)
                await drop.claim(client)

    # 2. Automatické přidání, seřazení i sestavení wanted_games vyřídí StreamSelector
    client._stream_selector.process_auto_add_and_sort(client.settings, client.inventory)
    
    # Načtení stromu a přímé vytažení objektů her bez wrapperů
    tree = client._stream_selector.get_wanted_game_tree(client.settings, client.inventory)
    client.wanted_games = [item.game_obj for item in tree if item.game_obj is not None]

    handle_manual_mode_priority(client)
    client.change_state(State.CHANNELS_CLEANUP)


async def handle_state_channels_cleanup(client: Twitch) -> None:
    if client.gui and hasattr(client.gui, "status"):
        client.gui.status.update(_.t["gui"]["status"]["cleanup"])
    channels = client.channels

    if not client.wanted_games or client._full_cleanup:
        to_remove_channels: list[Channel] = list(channels.values())
    else:
        to_remove_channels = [
            channel for channel in channels.values()
             if not channel.acl_based and (not channel.online or (channel.game is None or channel.game not in client.wanted_games))
        ]

    client._full_cleanup = False
    if to_remove_channels:
        client._remove_channel_topics(to_remove_channels)
        for channel in to_remove_channels:
            del channels[channel.id]
        del to_remove_channels

    if client.wanted_games:
        client.change_state(State.CHANNELS_FETCH)
    else:
        client.print(_.t["status"]["no_campaign"])
        client.change_state(State.IDLE)


# ==============================================================================
# 4. STATE MACHINE AUXILIARY WORKERS
# ==============================================================================

def get_filtered_inventory(client: Twitch) -> list[DropsCampaign]:
    return [c for c in client.inventory if getattr(c, "progress", 0) < 100 and c.has_watchable_drops]


def force_stream_reevaluation(client: Twitch) -> None:
    """Force immediate stop and re-evaluation of stream queue."""
    logger.info("Forcing stream re-evaluation and switch...")
    if hasattr(client._watch_service, "stop_watching"):
        client._watch_service.stop_watching()
    if hasattr(client._watch_service, "restart_watching"):
        client._watch_service.restart_watching()

    client.trigger_stream_selection(force=True)


def handle_ignored_games_update(client: Twitch, new_ignored_games: list[str]) -> None:
    logger.info("Ignored games event received: %s", new_ignored_games)

    normalized_ignored = [g.strip() for g in new_ignored_games if g]
    client.settings.ignored_games = normalized_ignored
    client.settings.save()

    client.build_wanted_games()
    force_stream_reevaluation(client)


def handle_manual_mode_priority(client: Twitch) -> None:
    manual_target_game = getattr(client._watch_service, "_manual_target_game", None)
    if client.is_manual_mode() and manual_target_game is not None:
        target_id = getattr(manual_target_game, "id", None)
        target_name = getattr(manual_target_game, "name", str(manual_target_game))

        manual_has_drops = any(
            campaign.is_campaign_earnable() and (
                getattr(campaign.game, "id", None) == target_id if target_id else getattr(campaign.game, "name", str(campaign.game)) == target_name
            )
            for campaign in client.inventory
            if campaign.has_watchable_drops and campaign.game
        )

        if not manual_has_drops:
            client.exit_manual_mode("All drops completed for manual game")
        else:
            updated_wanted = list(client.wanted_games)
            matching_idx = None
            for idx, g in enumerate(updated_wanted):
                if (target_id and getattr(g, "id", None) == target_id) or getattr(g, "name", str(g)) == target_name:
                    matching_idx = idx
                    break

            if matching_idx is not None:
                game_obj = updated_wanted.pop(matching_idx)
                updated_wanted.insert(0, game_obj)
                client.wanted_games = updated_wanted


def output_campaign_mapping(client: Twitch) -> None:
    logger.info("=== Active Campaigns Mapping ===")
    from collections import defaultdict

    game_campaign_map: dict[str, list[tuple[DropsCampaign, list[str]]]] = defaultdict(list)
    for campaign in client.inventory:
        if not campaign.has_watchable_drops or not campaign.game:
            continue
        if campaign.is_campaign_earnable():
            channel_names = [ch.name for ch in campaign.allowed_channels] if campaign.allowed_channels else ["<directory>"]
            game_campaign_map[campaign.game.name].append((campaign, channel_names))

    for game_name in sorted(game_campaign_map.keys()):
        logger.debug(f"Game: {game_name}")
        for campaign, channel_list in game_campaign_map[game_name]:
            status_info = "ACTIVE" if campaign.active else "UPCOMING"
            logger.debug(f"  └─ Campaign: {campaign.name} [{status_info}]")
    logger.info("=== End Campaigns Mapping ===")
