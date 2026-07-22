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
from src.models.campaign import DropsCampaign
from src.models.channel import Channel
from src.services.channel_service import ChannelService
from src.services.inventory_service import InventoryService
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
    from src.models.channel import Stream
    from src.models.drop import TimedDrop
    from src.models.game import Game
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
            self._watching_task = None
        if self._mnt_task is not None:
            self._mnt_task.cancel()
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
        await asyncio.sleep(start_time + 0.5 - time())

    def wait_until_login(self) -> abc.Coroutine[Any, Any, Literal[True]]:
        return self._auth_state._logged_in.wait()

    def change_state(self, state: State) -> None:
        if self._state is not State.EXIT:
            self._state = state
        self._state_change.set()

    def get_change_state_callable(self, state: State) -> abc.Callable[[], None]:
        return partial(self.change_state, state)

    def close(self) -> None:
        self.change_state(State.EXIT)

    def print(self, message: str) -> None:
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
        while True:
            try:
                self.ignored_count = 0
                self.claimed_count = 0
                self._ensure_api_clients()
                auth_state = await self.get_auth()
                await self.websocket.start()

                if self._watching_task is not None:
                    self._watching_task.cancel()
                self._watching_task = asyncio.create_task(self._watch_service.watch_loop())

                self.websocket.add_topics([
                    WebsocketTopic("User", "Drops", auth_state.user_id, self._message_handler_service.process_drops),
                    WebsocketTopic("User", "Notifications", auth_state.user_id, self._message_handler_service.process_notifications),
                ])

                self.change_state(State.INVENTORY_FETCH)
                await run_state_machine_loop(self)
                break
            except ExitRequest:
                break
            except aiohttp.ContentTypeError as exc:
                raise RequestException(_.t["login"]["unexpected_content"]) from exc

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
        self.gui.broadcast_manual_mode_change(self.get_manual_mode_info())

    def exit_manual_mode(self, reason: str = "") -> None:
        if not self.is_manual_mode():
            return
        game_name = self._manual_target_game.name if self._manual_target_game else "Unknown"
        logger.info(f"Exiting manual mode for game: {game_name}. Reason: {reason or 'User requested'}")
        self._manual_target_channel = None
        self._manual_target_game = None
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
        raw_inventory = await self.gql_request(GQL_OPERATIONS["Inventory"])
        claimed_benefits = {b["id"]: isoparse(b["lastAwardedAt"]) for b in raw_inventory.get("gameEventDrops", [])}
        campaigns_data = raw_inventory.get("dropCampaignsInProgress", [])
        for camp_data in campaigns_data:
            DropsCampaign(self, camp_data, claimed_benefits)
        self._inventory_dirty = True
        await self._inventory_service.fetch_inventory()

        # Po načtení zavoláme prioritizaci
        prioritize_badge_games(self)

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
            client.gui.status.update(_.t["gui"]["status"]["exiting"])
            break

        await dispatch_state(client)
        await client._state_change.wait()


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
    client.gui.status.update(_.t["gui"]["status"]["idle"])
    client.stop_watching()
    client._state_change.clear()


async def handle_state_inventory_fetch(client: Twitch) -> None:
    await client.websocket.start()
    await client.fetch_inventory()
    client.gui.set_games({campaign.game for campaign in client.inventory})
    client.gui.broadcast_wanted_items()
    client.change_state(State.GAMES_UPDATE)


async def handle_state_games_update(client: Twitch) -> None:
    await claim_eligible_drops(client)
    filtered_inventory = get_filtered_inventory(client)

    handle_auto_add_games(client, filtered_inventory)
    handle_auto_sort_games(client, filtered_inventory)

    next_hour: datetime = datetime.now(timezone.utc) + timedelta(hours=1)
    logger.info("inventory has %d eligible campaigns", sum(1 for c in client.inventory if c.eligible))
    logger.debug("inventories: %s", client.inventory)

    if logger.isEnabledFor(logging.DEBUG):
        output_campaign_mapping(client, next_hour)

    client.wanted_games = get_wanted_games(client, filtered_inventory, next_hour)
    handle_manual_mode_priority(client)

    client._full_cleanup = True
    client.restart_watching()
    client.change_state(State.CHANNELS_CLEANUP)


async def handle_state_channels_cleanup(client: Twitch) -> None:
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
    client.gui.status.update(_.t["gui"]["status"]["gathering"])
    channels = client.channels
    new_channels: set[Channel] = set(channels.values())
    channels.clear()

    no_acl: set[Game] = set()
    acl_channels: set[Channel] = set()
    next_hour = datetime.now(timezone.utc) + timedelta(hours=1)

    for campaign in client.inventory:
        if campaign.game in client.wanted_games and campaign.can_earn_within(next_hour):
            if campaign.allowed_channels:
                acl_channels.update(campaign.allowed_channels)
            else:
                no_acl.add(campaign.game)

    acl_channels.difference_update(new_channels)
    await client.bulk_check_online(acl_channels)
    new_channels.update(acl_channels)

    for game in no_acl:
        new_channels.update(await client.get_live_streams(game, drops_enabled=True))

    ordered_channels: list[Channel] = sorted(new_channels, key=ChannelService.get_viewers_key, reverse=True)
    ordered_channels.sort(key=lambda ch: ch.acl_based, reverse=True)
    ordered_channels.sort(key=client._channel_service.get_priority)

    to_remove_channels = ordered_channels[MAX_CHANNELS:]
    ordered_channels = ordered_channels[:MAX_CHANNELS]
    if to_remove_channels:
        client._remove_channel_topics(to_remove_channels)
        del to_remove_channels

    for channel in ordered_channels:
        channels[channel.id] = channel

    client.gui.channels.batch_update(ordered_channels)

    to_add_topics: list[WebsocketTopic] = []
    for channel_id in channels:
        to_add_topics.append(WebsocketTopic("Channel", "StreamState", channel_id, client._message_handler_service.process_stream_state))
        to_add_topics.append(WebsocketTopic("Channel", "StreamUpdate", channel_id, client._message_handler_service.process_stream_update))
    client.websocket.add_topics(to_add_topics)

    watching_channel = client.watching_channel.get_with_default(None)
    if watching_channel is not None:
        new_watching: Channel | None = channels.get(watching_channel.id)
        if new_watching is not None and client.can_watch(new_watching):
            client.watch(new_watching, update_status=False)
        del new_watching

    for channel in channels.values():
        if client.can_watch(channel):
            if (active_campaign := client.get_active_campaign(channel)) is not None and (active_drop := active_campaign.first_drop) is not None:
                active_drop.display(countdown=False, subone=True)
            break

    client.change_state(State.CHANNEL_SWITCH)


async def handle_state_channel_switch(client: Twitch) -> None:
    client.gui.status.update(_.t["gui"]["status"]["switching"])
    channels = client.channels
    new_watching: Channel | None = None
    selected_channel: Channel | None = client.gui.channels.get_selection()
    watching_channel: Channel | None = client.watching_channel.get_with_default(None)

    if watching_channel:
        for campaign in client.inventory:
            if campaign.game == watching_channel.game and getattr(campaign, "progress", 0) >= 100:
                logger.info(f"Campaign for {watching_channel.name} is 100% finished, forcing switch.")
                client.stop_watching()
                watching_channel = None
                break

    if selected_channel is not None and client.can_watch(selected_channel):
        if watching_channel and selected_channel.game != watching_channel.game:
            client.enter_manual_mode(selected_channel)
        new_watching = selected_channel
    elif client.is_manual_mode():
        if client._manual_target_channel and client.can_watch(client._manual_target_channel):
            new_watching = client._manual_target_channel
        else:
            for channel in channels.values():
                if channel.game == client._manual_target_game and client.can_watch(channel):
                    new_watching = channel
                    client._manual_target_channel = channel
                    game_name = client._manual_target_game.name if client._manual_target_game else "Unknown"
                    logger.info(f"Manual mode: switching to {channel.name} (same game: {game_name})")
                    break
            if new_watching is None:
                client.exit_manual_mode("No channels available for manual game")
    else:
        for channel in sorted(channels.values(), key=client._channel_service.get_priority):
            if client.can_watch(channel) and client.should_switch(channel):
                new_watching = channel
                break

    if new_watching is not None:
        client.watch(new_watching)
        if (active_campaign := client.get_active_campaign(new_watching)) is not None and (active_drop := active_campaign.first_drop) is not None:
            active_drop.display(countdown=False, subone=True)
        client._state_change.clear()
    elif watching_channel is not None and client.can_watch(watching_channel):
        if client.is_manual_mode() and client._manual_target_game:
            status_text = f"🎯 Manual Mode: Watching {watching_channel.name} for {client._manual_target_game.name}"
        else:
            status_text = _.t["status"]["watching"].format(channel=watching_channel.name)
        client.gui.status.update(status_text)
        client._state_change.clear()
    else:
        client.print(_.t["status"]["no_channel"])
        client.change_state(State.IDLE)


# ==============================================================================
# 4. STATE MACHINE AUXILIARY WORKERS (Flat module level - 0 Indentations)
# ==============================================================================

async def claim_eligible_drops(client: Twitch) -> None:
    logger.debug(f"DEBUG: Počet kampaní v inventory: {len(client.inventory)}")

    for campaign in client.inventory:
        # Kontrola linknutí
        if not getattr(campaign, "linked", True):
            client.ignored_count += 1
            continue

        if not campaign.upcoming:
            for drop in campaign.drops:
                # 1. Kontrola, zda je drop připraven k vyzvednutí
                if drop.can_claim:
                    logger.info(f"🚀 Pokus o claim dropu: {drop.name} (ID: {drop.id})")

                    # 2. THROTTLING: Pauza mezi claimy, aby bot nespamoval API
                    await asyncio.sleep(2)

                    # 3. Pokus o claim
                    if await drop.claim():
                        client.claimed_count += 1
                        logger.info(f"✅ Úspěšně claimnuto: {drop.name}! (Celkem v relaci: {client.claimed_count})")
                    else:
                        # Zde uvidíš varování, pokud se claim nezdařil
                        logger.warning(f"❌ Claim selhal pro drop: {drop.name} (ID: {drop.id}) - Twitch vrátil chybu nebo byl drop odmítnut.")

                # 4. DEBUG: Pokud není drop připraven, vypíše proč
                else:
                    # Pokud má drop atributy pro minuty, vypíšeme progress pro přehled
                    if hasattr(drop, "current_minutes") and hasattr(drop, "required_minutes"):
                        if drop.current_minutes < drop.required_minutes:
                            progress = (drop.current_minutes / drop.required_minutes) * 100
                            logger.debug(f"⏳ Drop {drop.name} není hotový: {drop.current_minutes}/{drop.required_minutes} min ({progress:.1f}%)")
                    else:
                        logger.debug(f"ℹ️ Drop {drop.name} zatím nelze claimovat (can_claim=False).")


def get_filtered_inventory(client: Twitch) -> list[DropsCampaign]:
    return [c for c in client.inventory if getattr(c, "progress", 0) < 100]


def handle_auto_add_games(client: Twitch, filtered_inventory: list[DropsCampaign]) -> None:
    if getattr(client.settings, "auto_add_all_games", False) and client.inventory:
        added_count = 0
        for c in filtered_inventory:
            c_game = getattr(c, "game", "")
            c_game_name = c_game.name if hasattr(c_game, "name") else str(c_game)

            if c_game_name and c_game_name not in client.settings.games_to_watch:
                client.settings.games_to_watch.append(c_game_name)
                added_count += 1

        if added_count > 0:
            logger.info("Automatically added %d new game(s) to watch list.", added_count)
            client.settings.save()
            if hasattr(client, "socketio"):
                client.socketio.emit("settings_updated", client.settings.__dict__)


def handle_auto_sort_games(client: Twitch, filtered_inventory: list[DropsCampaign]) -> None:
    auto_sort = getattr(client.settings, "auto_sort_by_end", False)
    mine_badges_first = getattr(client.settings, "mine_badges_first", False)

    if (auto_sort or mine_badges_first) and client.inventory:
        logger.info("Auto-sorting games by pending badges and ending time")
        now_utc = datetime.now(timezone.utc)

        # Uložíme si původní indexy pro případ, že auto_sort je vypnutý (zachová ruční pořadí)
        original_indices = {game: idx for idx, game in enumerate(client.settings.games_to_watch)}

        def get_game_sort_key(game_name: str):
            game_campaigns = [
                c for c in filtered_inventory
                if (c.game.name if hasattr(c.game, "name") else str(c.game)) == game_name
            ]
            active_c = [c for c in game_campaigns if c.active]
            upcoming_c = [c for c in game_campaigns if c.upcoming]
            expired_c = [c for c in game_campaigns if c.expired]

            # 1. Kontrola, zda aktivní kampaň obsahuje NEDOTĚŽENOU badge
            has_pending_badge = False
            if mine_badges_first:
                for c in active_c:
                    for drop in getattr(c, "drops", []):
                        is_badge = getattr(drop, "is_badge", False) or "badge" in getattr(drop, "name", "").lower()
                        is_claimed = getattr(drop, "claimed", False) or getattr(drop, "completed", False)

                        if is_badge and not is_claimed:
                            has_pending_badge = True
                            break
                    if has_pending_badge:
                        break

            # Priority tier: 0 = Nedotěžená badge (první), 1 = Ostatní
            badge_tier = 0 if (mine_badges_first and has_pending_badge) else 1

            # 2A. Pokud je ZAPNUTÝ auto_sort podle času:
            if auto_sort:
                if active_c:
                    return (badge_tier, 0, min(c.ends_at for c in active_c))
                elif upcoming_c:
                    return (badge_tier, 1, min(c.starts_at for c in upcoming_c))
                elif expired_c:
                    return (badge_tier, 2, max(c.ends_at for c in expired_c))
                else:
                    return (badge_tier, 3, now_utc)

            # 2B. Pokud NENÍ zapnutý auto_sort: zachováme ruční pořadí u her bez badge
            return (badge_tier, original_indices.get(game_name, 999))

        client.settings.games_to_watch.sort(key=get_game_sort_key)

def prioritize_badge_games(client: Twitch, filtered_inventory: list[DropsCampaign] | None = None) -> None:
    """
    Vyčleněná funkce bez kompletního auto-sortu.
    Pokud je zapnuto 'mine_badges_first', posune hry s nedotěženou badge na začátek fronty.
    """
    if not getattr(client.settings, "mine_badges_first", False) or not client.inventory:
        return

    # Pokud filtered_inventory nedodáme, načteme ho z clienta
    if filtered_inventory is None:
        filtered_inventory = get_filtered_inventory(client)

    # 1. Najdeme názvy her, které mají aktivní a NEDOTĚŽENÝ odznak
    badge_games: set[str] = set()

    for campaign in filtered_inventory:
        if not campaign.active:
            continue

        game_name = campaign.game.name if hasattr(campaign.game, "name") else str(campaign.game)

        for drop in getattr(campaign, "drops", []):
            is_badge = getattr(drop, "is_badge", False) or "badge" in getattr(drop, "name", "").lower()
            is_claimed = getattr(drop, "claimed", False) or getattr(drop, "completed", False)

            if is_badge and not is_claimed:
                badge_games.add(game_name)
                break

    if not badge_games:
        return

    # 2. Rozdělíme seznam na hry s badge a ostatní (OPRAVENO: self -> client)
    current_games = getattr(getattr(client, "settings", None), "games_to_watch", []) or []
    with_badges = [g for g in current_games if g in badge_games]
    without_badges = [g for g in current_games if g not in badge_games]

    # 3. Hry s badge dáme dopředu
    new_queue = with_badges + without_badges

    if new_queue != current_games:
        client.settings.games_to_watch = new_queue
        logger.info(f"Prioritizovány hry s odznaky na začátek fronty: {with_badges}")

def get_wanted_games(client: Twitch, filtered_inventory: list[DropsCampaign], next_hour: datetime, force_rebuild: bool = False) -> list[Game]:
    if client._inventory_dirty or force_rebuild or not client._wanted_games_cache:
        logger.info("Building wanted games list")
        client._wanted_games_cache = client._stream_selector.get_wanted_games(
            client.settings, filtered_inventory
        )
        logger.info("Wanted games list built")
        client._inventory_dirty = False

        if client._wanted_games_cache:
            logger.info("Wanted games: %s", ", ".join(game.name for game in client._wanted_games_cache))
        else:
            logger.warning(
                "No wanted games found! games_to_watch=%s, eligible_campaigns=%d",
                client.settings.games_to_watch,
                sum(1 for c in client.inventory if c.eligible and c.can_earn_within(next_hour)),
            )
    return client._wanted_games_cache


def handle_manual_mode_priority(client: Twitch) -> None:
    if client.is_manual_mode():
        next_hour: datetime = datetime.now(timezone.utc) + timedelta(hours=1)
        manual_has_drops = any(
            campaign.can_earn_within(next_hour) and campaign.game == client._manual_target_game
            for campaign in client.inventory
        )
        if not manual_has_drops:
            client.exit_manual_mode("All drops completed for manual game")
        elif client._manual_target_game in client.wanted_games:
            client.wanted_games.remove(client._manual_target_game)
            client.wanted_games.insert(0, client._manual_target_game)
            logger.info(f"Manual mode: prioritizing game {client._manual_target_game.name}")


def filter_wanted_campaigns(client: Twitch, next_hour: datetime) -> list[Game]:
    wanted_games: list[Game] = []
    games_to_watch: list[str] = client.settings.games_to_watch
    mining_benefits: dict[str, bool] = client.settings.mining_benefits

    for game_name in games_to_watch:
        game_name_lower: str = game_name.lower()
        for campaign in client.inventory:
            game: Game = campaign.game
            if (
                game.name.lower() == game_name_lower
                and game not in wanted_games
                and campaign.can_earn_within(next_hour)
                and campaign.has_wanted_unclaimed_benefits(mining_benefits)
            ):
                wanted_games.append(game)
                break
    return wanted_games


def output_campaign_mapping(client: Twitch, next_hour: datetime) -> None:
    logger.info("=== Active Campaigns Mapping ===")
    from collections import defaultdict

    game_campaign_map: dict[str, list[tuple[DropsCampaign, list[str]]]] = defaultdict(list)
    for campaign in client.inventory:
        if campaign.eligible and not campaign.finished:
            logger.info("eligible Campaign: %s - %s", campaign.name, campaign.game.name)
        if campaign.can_earn_within(next_hour):
            channel_names = []
            if campaign.allowed_channels:
                channel_names = [ch.name for ch in campaign.allowed_channels]
            else:
                channel_names = ["<directory>"]
            game_campaign_map[campaign.game.name].append((campaign, channel_names))
    for game_name in sorted(game_campaign_map.keys()):
        logger.debug(f"Game: {game_name}")
        for campaign, channel_list in game_campaign_map[game_name]:
            status_info = f"{'ACTIVE' if campaign.active else 'UPCOMING'}"
            ends_info = campaign.ends_at.astimezone().strftime("%Y-%m-%d %H:%M")
            channel_info = f"{len(channel_list)} channels" if channel_list[0] != "<directory>" else "directory"
            logger.debug(f"  └─ Campaign: {campaign.name} [{status_info}] (ends: {ends_info})")
            logger.debug(f"     Channels: {channel_info}")
            if channel_list[0] != "<directory>" and len(channel_list) <= 10:
                logger.debug(f"     └─ {', '.join(channel_list)}")
            elif channel_list[0] != "<directory>":
                logger.debug(f"     └─ {', '.join(channel_list[:10])} ... (+{len(channel_list) - 10} more)")
    logger.info("=== End Campaigns Mapping ===")


# momentaly unused
def log_summary(self) -> None:
        """Vypíše přehled o tom, co se za tento běh stihlo."""
        if self.ignored_count > 0 or self.claimed_count > 0:
            logger.info(
                f"Session Summary: {self.claimed_count} claimed, "
                f"{self.ignored_count} ignored (unlinked)."
            )
