from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict, abc, deque
from datetime import datetime, timedelta, timezone
from functools import partial
from time import time
from typing import TYPE_CHECKING, Any, Final, Literal

import aiohttp
from dateutil.parser import isoparse

from src.api import GQLClient, HTTPClient
from src.auth import _AuthState
from src.config import (
    MAX_CHANNELS,
    ClientType,
    State,
    WebsocketTopic,
)
from src.config import GQL_OPERATIONS
from src.exceptions import (
    ExitRequest,
    RequestException,
)
from src.i18n import _
from src.models.models import DropsCampaign
from src.models.models import Channel
from src.models.models import BaseDrop
from src.services.channel_service import ChannelService
from src.services.campaign_service import InventoryService
from src.services.maintenance import MaintenanceService
from src.services.message_handlers import MessageHandlerService
from src.services.stream_selector import StreamSelector
from src.services.watch_service import WatchService
from src.utils import (
    AwaitableValue,
)
from src.websocket import WebsocketPool

if TYPE_CHECKING:
    from src.config import ClientInfo, GQLRequest, JsonType
    from src.config.settings import Settings
    from src.models.models import Stream
    from src.models.models import TimedDrop
    from src.models.models import Game
    from src.web.gui_manager import WebGUIManager


logger = logging.getLogger("TwitchDrops")
gql_logger = logging.getLogger("TwitchDrops.gql")


# ==============================================================================
# 1. CORE CLIENT (Holds Shared State & API Configurations)
# ==============================================================================

class Twitch:
    def __init__(self, settings: Settings):
        self.settings: Settings = settings
        # State management
        self._state: State = State.IDLE
        self._state_change = asyncio.Event()
        self.wanted_games: list[Game] = []
        self.inventory: list[DropsCampaign] = []
        self._drops: dict[str, TimedDrop] = {}
        self._campaigns: dict[str, DropsCampaign] = {}
        self._mnt_triggers: deque[datetime] = deque()

        # Cache and flow flags
        self._inventory_dirty: bool = True
        self._wanted_games_cache: list[Game] = []
        self._full_cleanup: bool = False

        # Client type and auth
        self._client_type: ClientInfo = ClientType.ANDROID_APP
        self._auth_state: _AuthState = _AuthState(self)
        # GUI
        self.gui: WebGUIManager = None  # type: ignore[assignment]
        # API clients
        self._http_client: HTTPClient | None = None
        self._gql_client: GQLClient | None = None
        # Channels
        self.channels: OrderedDict[int, Channel] = OrderedDict()
        self.watching_channel: AwaitableValue[Channel] = AwaitableValue()
        self._watching_task: asyncio.Task[None] | None = None
        self._watching_restart = asyncio.Event()
        # Manual mode
        self._manual_target_channel: Channel | None = None
        self._manual_target_game: Game | None = None
        # Websocket
        self.websocket = WebsocketPool(self)
        # Maintenance
        self._mnt_task: asyncio.Task[None] | None = None
        # Services
        self._maintenance_service: MaintenanceService = MaintenanceService(self)
        self._channel_service: ChannelService = ChannelService(self)
        self._message_handler_service: MessageHandlerService = MessageHandlerService(self)
        self._inventory_service: InventoryService = InventoryService(self)
        self._watch_service: WatchService = WatchService(self)
        self._stream_selector: StreamSelector = StreamSelector()
        # Counters
        self.ignored_count = 0
        self.claimed_count = 0

    def _ensure_api_clients(self) -> None:
        """Ensure API clients are initialized."""
        if self._http_client is None:
            self._http_client = HTTPClient(self.settings, self.gui, self, self._client_type)
        if self._gql_client is None:
            self._gql_client = GQLClient(self._http_client, self._auth_state, self._client_type)

    async def get_session(self):
        self._ensure_api_clients()
        assert self._http_client is not None
        return await self._http_client.get_session()

    def request(self, method: str, url: str | Any, **kwargs):
        self._ensure_api_clients()
        assert self._http_client is not None
        return self._http_client.request(method, url, **kwargs)

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

    def wait_until_login(self) -> abc.Coroutine[Any, Any, Literal[True]]:
        return self._auth_state._logged_in.wait()

    def change_state(self, state: State) -> None:
        if self._state is not State.EXIT:
            self._state = state
        self._state_change.set()

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

    def get_change_state_callable(self, state: State) -> abc.Callable[[], None]:
        return partial(self.change_state, state)

    def close(self) -> None:
        self.change_state(State.EXIT)

    def print(self, message: str) -> None:
        if self.gui:
            self.gui.print(message)

    def _remove_channel_topics(self, channels: abc.Iterable[Channel]) -> None:
        topics_to_remove: list[str] = []
        for channel in channels:
            topics_to_remove.append(WebsocketTopic.as_str("Channel", "StreamState", channel.id))
            topics_to_remove.append(WebsocketTopic.as_str("Channel", "StreamUpdate", channel.id))
        if topics_to_remove:
            self.websocket.remove_topics(topics_to_remove)

    async def run(self) -> None:
        """Bootstrap the client services and hand execution over to the flat state loop."""
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

    # ==========================================
    # Service Delegations
    # ==========================================

    def can_watch(self, channel: Channel) -> bool:
        return self._watch_service.can_watch(channel)

    def should_switch(self, channel: Channel) -> bool:
        return self._watch_service.should_switch(channel)

    def watch(self, channel: Channel, *, update_status: bool = True) -> None:
        self._watch_service.watch(channel, update_status=update_status)

    def stop_watching(self) -> None:
        self._watch_service.stop_watching()

    def restart_watching(self) -> None:
        self._watch_service.restart_watching()

    def is_manual_mode(self) -> bool:
        return self._manual_target_channel is not None and self._manual_target_game is not None

    def enter_manual_mode(self, channel: Channel) -> None:
        if channel.game is None:
            logger.warning(f"Cannot enter manual mode: channel {channel.name} has no game")
            return
        self._manual_target_channel = channel
        self._manual_target_game = channel.game
        logger.info(f"Entered manual mode for game: {channel.game.name}, channel: {channel.name}")
        if self.gui:
            self.gui.broadcast_manual_mode_change(self.get_manual_mode_info())

    def exit_manual_mode(self, reason: str = "") -> None:
        if not self.is_manual_mode():
            return
        game_name = self._manual_target_game.name if self._manual_target_game else "Unknown"
        logger.info(f"Exiting manual mode for game: {game_name}. Reason: {reason or 'User requested'}")
        self._manual_target_channel = None
        self._manual_target_game = None
        if self.gui:
            self.gui.broadcast_manual_mode_change(self.get_manual_mode_info())
        self.change_state(State.CHANNEL_SWITCH)

    def get_manual_mode_info(self) -> dict[str, Any]:
        if self.is_manual_mode():
            return {
                "active": True,
                "game_name": self._manual_target_game.name if self._manual_target_game else "",
                "channel_name": self._manual_target_channel.name if self._manual_target_channel else "",
            }
        return {"active": False}

    def on_channel_update(self, channel: Channel, stream_before: Stream | None, stream_after: Stream | None) -> None:
        self._message_handler_service.on_channel_update(channel, stream_before, stream_after)

    async def get_auth(self) -> _AuthState:
        await self._auth_state.validate()
        return self._auth_state

    async def gql_request(self, ops: GQLRequest | list[GQLRequest]) -> JsonType | list[JsonType]:
        self._ensure_api_clients()
        assert self._gql_client is not None
        return await self._gql_client.request(ops)

    async def fetch_campaigns(self, campaigns_chunk: list[tuple[str, JsonType]]) -> dict[str, JsonType]:
        return await self._inventory_service.fetch_campaigns(campaigns_chunk)

    async def fetch_inventory(self) -> None:
        await self._inventory_service.fetch_inventory()

    async def bulk_check_online(self, channels: abc.Iterable[Channel]) -> None:
        await self._channel_service.bulk_check_online(channels)

    async def get_live_streams(self, game: Game, *, drops_enabled: bool = False) -> list[Channel]:
        return await self._channel_service.get_live_streams(game, drops_enabled=drops_enabled)

    def get_active_campaign(self, channel: Channel | None = None) -> DropsCampaign | None:
        return self._inventory_service.get_active_campaign(channel)


# ==============================================================================
# 2. STATE MACHINE CORE LOOP (Flat module level - 0 Indentations)
# ==============================================================================

async def run_state_machine_loop(client: Twitch) -> None:
    """The main worker loop that processes and coordinates state transitions."""
    while True:
        if client._state is State.EXIT:
            if client.gui and hasattr(client.gui, "status"):
                client.gui.status.update(_.t["gui"]["status"]["exiting"])
            break

        try:
            await dispatch_state(client)
        except asyncio.CancelledError:
            logger.debug("State machine loop task cancelled")
            raise
        except Exception as exc:
            logger.exception("Unhandled error in state machine loop (current state: %s): %s", client._state, exc)
            if client.gui and hasattr(client.gui, "status"):
                client.gui.status.update(f"Error in state {client._state.name}. Recovering...")
            client.change_state(State.IDLE)
            await asyncio.sleep(5)

        if client._state is not State.EXIT:
            if not client._state_change.is_set():
                try:
                    await client._state_change.wait()
                except asyncio.CancelledError:
                    break
            client._state_change.clear()


async def dispatch_state(client: Twitch) -> None:
    """Route control flow to the corresponding modular state handler."""
    state_handlers = {
        State.IDLE: handle_state_idle,
        State.INVENTORY_FETCH: handle_state_inventory_fetch,
        State.GAMES_UPDATE: handle_state_games_update,
        State.CHANNELS_CLEANUP: handle_state_channels_cleanup,
        State.CHANNELS_FETCH: handle_state_channels_fetch,
        State.CHANNEL_SWITCH: handle_state_channel_switch,
    }

    handler = state_handlers.get(client._state)
    if handler:
        await handler(client)
    else:
        logger.error(f"Unknown state machine state: {client._state}")
        client.change_state(State.IDLE)


# ==============================================================================
# 3. MODULAR STATE HANDLERS (Flat module level - 0 Indentations)
# ==============================================================================

async def handle_state_idle(client: Twitch) -> None:
    if client.gui and hasattr(client.gui, "status"):
        client.gui.status.update(_.t["gui"]["status"]["idle"])
    client.stop_watching()

async def handle_state_inventory_fetch(client: Twitch) -> None:
    await client.websocket.start()
    await client.fetch_inventory()
    if client.gui:
        client.gui.set_games({campaign.game for campaign in client.inventory if campaign.game})
        client.gui.broadcast_wanted_items()
        client.gui.status.update("Campaigns reloaded successfully")
        if hasattr(client.gui, "_broadcaster") and hasattr(client.gui._broadcaster, "emit"):
            try:
                await client.gui._broadcaster.emit("reload_complete", {})
            except Exception as e:
                logger.debug("Failed to emit reload_complete: %s", e)
    client.change_state(State.GAMES_UPDATE)

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

    # 2. Všechno zpracování, seřazení i sestavení wanted_games vyřídí StreamSelector!
    client._stream_selector.process_auto_add_and_sort(client.settings, client.inventory)
    client.wanted_games = client._stream_selector.get_wanted_games(client.settings, client.inventory)
    
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
            if not channel.acl_based and (channel.offline or (channel.game is None or channel.game not in client.wanted_games))
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


async def handle_state_channels_fetch(client: Twitch) -> None:
    if client.gui and hasattr(client.gui, "status"):
        client.gui.status.update(_.t["gui"]["status"]["gathering"])
    
    logger.info("Fetching channels for wanted games...")
    
    channels = client.channels
    old_channels = set(channels.values())
    channels.clear()

    no_acl: set[Game] = set()
    all_acl_channels: set[Channel] = set()

    for campaign in client.inventory:
        if campaign.game in client.wanted_games and campaign.can_earn_within():
            if campaign.allowed_channels:
                for channel in campaign.allowed_channels:
                    # PROPOVÁZÁNÍ HRY: Pokud kanál nemá nastavenou hru, předáme mu ji z kampaně
                    if channel.game is None:
                        channel.game = campaign.game
                all_acl_channels.update(campaign.allowed_channels)
            else:
                if campaign.game:
                    no_acl.add(campaign.game)

    logger.info("Found %d ACL channels and %d games without ACL to fetch.", len(all_acl_channels), len(no_acl))

    # Online stav zjišťujeme pouze pro NOVĚ objevené ACL kanály (pro úsporu API dotazů)
    new_acl_channels = all_acl_channels - old_channels
    if new_acl_channels:
        await client.bulk_check_online(new_acl_channels)
    
    # Do celkového seznamu sloučíme dřívější kanály + všechny ACL kanály
    gathered_channels: set[Channel] = old_channels | all_acl_channels

    # Získat živé streamy pro hry bez ACL restriction
    for game in no_acl:
        logger.debug("Fetching live streams for game: %s", game.name)
        gathered_channels.update(await client.get_live_streams(game, drops_enabled=True))

    # Uložení pouze živých kanálů do paměti
    for channel in gathered_channels:
        if getattr(channel, "online", False):
            channels[channel.id] = channel

    logger.info("Total gathered live channels saved to cache: %d", len(channels))

    # Přepnutí stavu
    client.change_state(State.CHANNEL_SWITCH)


async def handle_state_channel_switch(client: Twitch) -> None:
    logger.info("CHANNEL_SWITCH: Processing %d channels in inventory/cache", len(client.channels))
    
    if client.gui and hasattr(client.gui, "status"):
        client.gui.status.update(_.t["gui"]["status"]["switching"])
        
    channels = client.channels
    new_watching: Channel | None = None
    selected_channel: Channel | None = client.gui.channels.get_selection() if client.gui and hasattr(client.gui, "channels") else None
    watching_channel: Channel | None = client.watching_channel.get_with_default(None)

    # 1. Kontrola hotových kampaní
    if watching_channel:
        for campaign in client.inventory:
            if campaign.game == watching_channel.game and getattr(campaign, "progress", 0) >= 100:
                logger.info(f"Campaign for {watching_channel.name} is 100% finished, forcing switch.")
                client.stop_watching()
                watching_channel = None
                break

    # 2. Manuální výběr z GUI nebo manuální režim
    if selected_channel is not None and client.can_watch(selected_channel):
        if watching_channel and selected_channel.game != watching_channel.game:
            client.enter_manual_mode(selected_channel)
        new_watching = selected_channel

    elif client.is_manual_mode():
        # Manuální režim zachován...
        if client._manual_target_channel and client.can_watch(client._manual_target_channel):
            new_watching = client._manual_target_channel
        else:
            for channel in channels.values():
                same_game = (
                    channel.game == client._manual_target_game
                    or (getattr(channel.game, "id", None) == getattr(client._manual_target_game, "id", -1))
                )
                if same_game and client.can_watch(channel):
                    new_watching = channel
                    client._manual_target_channel = channel
                    break
            if new_watching is None:
                client.exit_manual_mode("No channels available for manual game")

    else:
        # 3. Automatický výběr skrze StreamSelector!
        new_watching = client._stream_selector.select_best_channel(
            list(channels.values())
        )

    # 4. Aplikování výsledku
    if new_watching is not None:
        logger.info("CHANNEL_SWITCH: Successfully selected channel to watch: %s", new_watching.name)
        client.watch(new_watching)
        if (active_campaign := client.get_active_campaign(new_watching)) is not None and (active_drop := active_campaign.first_drop) is not None:
            if client.gui:
                client.gui.display_drop(active_drop, countdown=False, subone=True)
    elif watching_channel is not None and client.can_watch(watching_channel):
        logger.info("CHANNEL_SWITCH: Continuing to watch current channel: %s", watching_channel.name)
    else:
        logger.warning("CHANNEL_SWITCH: No suitable channel found! Falling back to State.IDLE.")
        client.print(_.t["status"]["no_channel"])
        client.change_state(State.IDLE)


# ==============================================================================
# 4. STATE MACHINE AUXILIARY WORKERS (Flat module level - 0 Indentations)
# ==============================================================================

def get_filtered_inventory(client: Twitch) -> list[DropsCampaign]:
    return [c for c in client.inventory if getattr(c, "progress", 0) < 100 and c.has_watchable_drops]


def force_stream_reevaluation(client: Twitch) -> None:
    """Force immediate stop and re-evaluation of stream queue."""
    logger.info("Forcing stream re-evaluation and switch...")
    watch_service = getattr(client, "_watch_service", None)
    
    if watch_service:
        if hasattr(watch_service, "stop_watching"):
            watch_service.stop_watching()
        if hasattr(watch_service, "restart_watching"):
            watch_service.restart_watching()

    client.trigger_stream_selection(force=True)


def handle_ignored_games_update(client: Twitch, new_ignored_games: list[str]) -> None:
    logger.info("Ignored games event received: %s", new_ignored_games)

    normalized_ignored = [g.strip() for g in new_ignored_games if g]
    client.settings.ignored_games = normalized_ignored
    client.settings.save()

    client.build_wanted_games()
    force_stream_reevaluation(client)


def handle_auto_add_games(client: Twitch, filtered_inventory: list[DropsCampaign]) -> None:
    if not getattr(client.settings, "auto_add_all_games", False) or not client.inventory:
        return

    if not isinstance(client.settings.games_to_watch, list):
        client.settings.games_to_watch = []

    ignored_games = {g.strip().lower() for g in getattr(client.settings, "ignored_games", [])}

    inventory_games_original = {}
    for c in filtered_inventory:
        if not c.has_watchable_drops:
            continue
        c_game = getattr(c, "game", "")
        c_game_name = c_game.name if hasattr(c_game, "name") else str(c_game)
        c_game_name = c_game_name.strip()
        c_lower = c_game_name.lower()
        
        if c_game_name and c_lower not in ignored_games:
            inventory_games_original[c_lower] = c_game_name

    existing_games = {g.strip().lower(): g for g in client.settings.games_to_watch}
    newly_added = []

    for c_lower, c_original in inventory_games_original.items():
        if c_lower not in existing_games:
            client.settings.games_to_watch.append(c_original)
            existing_games[c_lower] = c_original
            newly_added.append(c_original)

    if newly_added:
        client.settings.save()
        if hasattr(client, "socketio"):
            client.socketio.emit("settings_updated", client.settings.__dict__)

        force_stream_reevaluation(client)





def handle_manual_mode_priority(client: Twitch) -> None:
    if client.is_manual_mode() and client._manual_target_game is not None:
        
        target_id = getattr(client._manual_target_game, "id", None)
        target_name = getattr(client._manual_target_game, "name", str(client._manual_target_game))

        manual_has_drops = any(
            campaign.can_earn_within() and (
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


def get_wanted_games(
    client: Twitch, 
    filtered_inventory: list[DropsCampaign], 
    next_hour: datetime, 
    force_rebuild: bool = False
) -> list[Game]:
    if client._inventory_dirty or force_rebuild or not client._wanted_games_cache:
        raw_wanted = client._stream_selector.get_wanted_games(
            client.settings, filtered_inventory
        )
        
        client._wanted_games_cache = [
            item["game"] if isinstance(item, dict) and "game" in item else item 
            for item in raw_wanted
        ]
        
        client._inventory_dirty = False

    return list(client._wanted_games_cache)


def output_campaign_mapping(client: Twitch) -> None:
    logger.info("=== Active Campaigns Mapping ===")
    from collections import defaultdict

    game_campaign_map: dict[str, list[tuple[DropsCampaign, list[str]]]] = defaultdict(list)
    for campaign in client.inventory:
        if not campaign.has_watchable_drops or not campaign.game:
            continue
        if campaign.can_earn_within():
            channel_names = [ch.name for ch in campaign.allowed_channels] if campaign.allowed_channels else ["<directory>"]
            game_campaign_map[campaign.game.name].append((campaign, channel_names))

    for game_name in sorted(game_campaign_map.keys()):
        logger.debug(f"Game: {game_name}")
        for campaign, channel_list in game_campaign_map[game_name]:
            status_info = "ACTIVE" if campaign.active else "UPCOMING"
            logger.debug(f"  └─ Campaign: {campaign.name} [{status_info}]")
    logger.info("=== End Campaigns Mapping ===")
