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
        claimed_benefits = {
            b["id"]: isoparse(b["lastAwardedAt"]) 
            for b in raw_inventory.get("gameEventDrops", [])
        }

        # Fetch both in-progress and potential new campaigns if returned by GQL query
        campaigns_data = raw_inventory.get("dropCampaignsInProgress", [])
        
        # FIX: Direct mapping to self.inventory so rest of application reads current campaigns
        self.inventory = [
            DropsCampaign(self, camp_data, claimed_benefits)
            for camp_data in campaigns_data
        ]

        self._inventory_dirty = True
        await self._inventory_service.fetch_inventory()

        # Call prioritization after loading
        handle_prioritize_badge_games(self)

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
    client.gui.status.update("Campaigns reloaded successfully")
    asyncio.create_task(client.gui._broadcaster.emit("reload_complete", {}))
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

    client._full_cleanup = False  # Reset flagu
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
    logger.debug("Campaign count in inventory: %d", len(client.inventory))

    for campaign in client.inventory:
        if not campaign.has_watchable_drops:
            continue

        if not getattr(campaign, "linked", True):
            client.ignored_count += 1
            continue

        if not campaign.upcoming:
            for drop in campaign.drops:
                if drop.can_claim:
                    logger.info("Attempting to claim drop: %s (ID: %s)", drop.name, drop.id)

                    await asyncio.sleep(2)

                    if await drop.claim():
                        client.claimed_count += 1
                        # FIX: Invalidate cache after successful drop claim
                        client._inventory_dirty = True
                        logger.info(
                            "Successfully claimed drop: %s (Total session claims: %d)",
                            drop.name,
                            client.claimed_count,
                        )
                    else:
                        logger.warning(
                            "Claim failed for drop: %s (ID: %s)",
                            drop.name,
                            drop.id,
                        )
                else:
                    if hasattr(drop, "current_minutes") and hasattr(drop, "required_minutes"):
                        if drop.current_minutes < drop.required_minutes:
                            progress = (drop.current_minutes / drop.required_minutes) * 100
                            logger.debug(
                                "Drop %s in progress: %d/%d min (%.1f%%)",
                                drop.name,
                                drop.current_minutes,
                                drop.required_minutes,
                                progress,
                            )
                    else:
                        logger.debug("Drop %s cannot be claimed yet (can_claim=False)", drop.name)


def get_filtered_inventory(client: Twitch) -> list[DropsCampaign]:
    return [c for c in client.inventory if getattr(c, "progress", 0) < 100 and c.has_watchable_drops]


# ==========================================
# Helpers for Stream Queue Management
# ==========================================

def force_stream_reevaluation(client: Twitch) -> None:
    """Force immediate stop and re-evaluation of stream queue."""
    logger.info("[DEBUG-EVAL] Forcing stream re-evaluation and switch...")
    watch_service = getattr(client, "_watch_service", None)
    
    if watch_service:
        if hasattr(watch_service, "stop_watching"):
            watch_service.stop_watching()
        if hasattr(watch_service, "restart_watching"):
            watch_service.restart_watching()

    if hasattr(client, "trigger_stream_selection") and callable(client.trigger_stream_selection):
        client.trigger_stream_selection(force=True)


# ==========================================
# Handlers for Ignored & Auto-Added Games
# ==========================================

def handle_ignored_games_update(client: Twitch, new_ignored_games: list[str]) -> None:
    logger.info("==================================================")
    logger.info("[DEBUG-IGN] Event received. New ignored games: %s", new_ignored_games)

    normalized_ignored = [g.strip() for g in new_ignored_games if g]
    client.settings.ignored_games = normalized_ignored
    client.settings.save()

    # 1. Rebuild wanted games in client
    if hasattr(client, "build_wanted_games"):
        client.build_wanted_games()
        logger.info("[DEBUG-IGN] Client wanted_games rebuilt: %s", getattr(client, "wanted_games", "N/A"))

    # 2. Force immediate re-evaluation and stream switch
    force_stream_reevaluation(client)

    logger.info("==================================================")
    
def handle_auto_sort_games(client: Twitch, filtered_inventory: list[DropsCampaign]) -> None:
    """
    Sorts games_to_watch based on pending badges and campaign ending times.
    Serves as the missing handler referenced during client state updates.
    """
    logger.info("Auto-sorting games by pending badges and ending time")

    if not client.settings.games_to_watch:
        logger.debug("Skip auto-sorting: games_to_watch is empty.")
        return

    # Map campaigns by game name
    campaign_map: dict[str, list[DropsCampaign]] = {}
    for c in filtered_inventory:
        if not c.has_watchable_drops:
            continue
        c_game = getattr(c, "game", "")
        c_name = c_game.name if hasattr(c_game, "name") else str(c_game)
        c_name_lower = c_name.strip().lower()
        if c_name_lower not in campaign_map:
            campaign_map[c_name_lower] = []
        campaign_map[c_name_lower].append(c)

    def sort_key(game_name: str):
        g_lower = game_name.strip().lower()
        campaigns = campaign_map.get(g_lower, [])
        if not campaigns:
            return (0, float('inf'))
        
        # Priority based on earliest campaign end time
        earliest_end = min(
            (getattr(c, "end_time", float('inf')) for c in campaigns),
            default=float('inf')
        )
        return (1, earliest_end)

    old_queue = list(client.settings.games_to_watch)
    client.settings.games_to_watch.sort(key=sort_key)
    logger.debug("Games successfully auto-sorted.")

    if client.settings.games_to_watch != old_queue:
        client.settings.save()


def handle_auto_add_games(client: Twitch, filtered_inventory: list[DropsCampaign]) -> None:
    logger.debug(
        "handle_auto_add_games invoked. Auto-add setting: %s, Inventory count: %d",
        getattr(client.settings, "auto_add_all_games", False),
        len(filtered_inventory) if client.inventory else 0,
    )
    
    if not getattr(client.settings, "auto_add_all_games", False) or not client.inventory:
        logger.debug("Skipping handle_auto_add_games (auto_add_all_games is disabled or inventory empty).")
        return

    if not isinstance(client.settings.games_to_watch, list):
        client.settings.games_to_watch = []

    ignored_games = {g.strip().lower() for g in getattr(client.settings, "ignored_games", [])}
    logger.debug("Active ignored_games filter (lowercase): %s", ignored_games)

    inventory_games_original = {}
    for c in filtered_inventory:
        if not c.has_watchable_drops:
            continue
        c_game = getattr(c, "game", "")
        c_game_name = c_game.name if hasattr(c_game, "name") else str(c_game)
        c_game_name = c_game_name.strip()
        c_lower = c_game_name.lower()
        
        if c_game_name:
            if c_lower in ignored_games:
                logger.debug("Ignoring campaign game: '%s' (matched ignore list)", c_game_name)
            else:
                inventory_games_original[c_lower] = c_game_name

    logger.debug("Filtered inventory games available to watch: %s", list(inventory_games_original.values()))

    existing_games = {g.strip().lower(): g for g in client.settings.games_to_watch}
    newly_added = []

    # 1. Add new games
    for c_lower, c_original in inventory_games_original.items():
        if c_lower not in existing_games:
            client.settings.games_to_watch.append(c_original)
            existing_games[c_lower] = c_original
            newly_added.append(c_original)

    # 2. Remove inactive or ignored games
    removed_games = []
    updated_list = []
    for g in client.settings.games_to_watch:
        g_lower = g.strip().lower()
        if g_lower in inventory_games_original and g_lower not in ignored_games:
            updated_list.append(g)
        else:
            removed_games.append(g)

    client.settings.games_to_watch = updated_list

    # Save and handle changes
    if newly_added or removed_games:
        if newly_added:
            logger.info("Automatically added new games to watch list: %s", ", ".join(newly_added))
        if removed_games:
            logger.info("Automatically removed inactive/ignored games from watch list: %s", ", ".join(removed_games))

        client.settings.save()
        if hasattr(client, "socketio"):
            client.socketio.emit("settings_updated", client.settings.__dict__)

        current_watched_game = getattr(client, "current_game", None)
        is_watched_removed = current_watched_game and current_watched_game.strip().lower() in {
            g.strip().lower() for g in removed_games
        }
        
        if is_watched_removed:
            logger.info(
                "Currently watched game '%s' was removed/ignored during auto-sync. Stopping stream and switching...",
                current_watched_game,
            )

        if newly_added or is_watched_removed:
            force_stream_reevaluation(client)
    else:
        logger.debug("No changes in games_to_watch after auto-add sync.")
        
def handle_prioritize_badge_games(client: Twitch, filtered_inventory: list[DropsCampaign] | None = None) -> None:
    """
    Separated function without full auto-sort.
    If 'mine_badges_first' is enabled, moves games with pending badges to the front of the queue.
    """
    if not getattr(client.settings, "mine_badges_first", False) or not client.inventory:
        return

    # If filtered_inventory is not provided, load it from client
    if filtered_inventory is None:
        filtered_inventory = get_filtered_inventory(client)

    # 1. Find game names that have active and unclaimed badges
    badge_games: set[str] = set()

    for campaign in filtered_inventory:
        if not campaign.has_watchable_drops or not campaign.active:
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

    # 2. Split the list into badge games and others
    current_games = getattr(getattr(client, "settings", None), "games_to_watch", []) or []
    with_badges = [g for g in current_games if g in badge_games]
    without_badges = [g for g in current_games if g not in badge_games]

    # 3. Put badge games first
    new_queue = with_badges + without_badges

    if new_queue != current_games:
        client.settings.games_to_watch = new_queue
        logger.info("Prioritized games with badges to the front of the queue: %s", with_badges)
        
        # Save settings and force immediate re-evaluation
        client.settings.save()
        force_stream_reevaluation(client)

def handle_manual_mode_priority(client: Twitch) -> None:
    if client.is_manual_mode():
        next_hour: datetime = datetime.now(timezone.utc) + timedelta(hours=1)
        manual_has_drops = any(
            campaign.can_earn_within(next_hour) and campaign.game == client._manual_target_game
            for campaign in client.inventory
            if campaign.has_watchable_drops
        )
        if not manual_has_drops:
            client.exit_manual_mode("All drops completed for manual game")
        elif client._manual_target_game in client.wanted_games:
            client.wanted_games.remove(client._manual_target_game)
            client.wanted_games.insert(0, client._manual_target_game)
            logger.info(f"Manual mode: prioritizing game {client._manual_target_game.name}")

def get_wanted_games(
    client: Twitch, 
    filtered_inventory: list[DropsCampaign], 
    next_hour: datetime, 
    force_rebuild: bool = False
) -> list[Game]:
    if client._inventory_dirty or force_rebuild or not client._wanted_games_cache:
        logger.info("Building wanted games list")
        
        # --- PODROBNÝ DEBUG KAMPANÍ ---
        logger.info("[DEBUG-WANTED] Analýza %d filtrovaných kampaní:", len(filtered_inventory))
        for c in filtered_inventory:
            if not c.has_watchable_drops:
                continue
            g_name = c.game.name if hasattr(c.game, "name") else str(c.game)
            drops_info = []
            has_watchable = False
            for d in getattr(c, "drops", []):
                req_min = getattr(d, "required_minutes", 0)
                drops_info.append(f"{d.name} ({req_min}m)")
                if req_min > 0:
                    has_watchable = True
            
            can_earn = c.can_earn_within(next_hour) if hasattr(c, "can_earn_within") else "N/A"
#            logger.info(
 #               "[DEBUG-WANTED] Hra: '%s' | Kampani: '%s' | can_earn: %s | má dropy >0m: %s | Dropy: %s",
  #              g_name,
   #             getattr(c, "name", "Unknown"),
    #            can_earn,
     #           has_watchable,
      #          ", ".join(drops_info)
       #     )
        # -----------------------------

        raw_wanted = client._stream_selector.get_wanted_games(
            client.settings, filtered_inventory
        )
        # OPRAVA: Extrakce čistých objektů Game ze slovníků
        client._wanted_games_cache = [
            item["game"] if isinstance(item, dict) and "game" in item else item 
            for item in raw_wanted
        ]
        
        logger.info("Wanted games list built")
        client._inventory_dirty = False

        if client._wanted_games_cache:
            logger.info("Wanted games (%d): %s", len(client._wanted_games_cache), ", ".join(game.name for game in client._wanted_games_cache))
        else:
            logger.warning(
                "No wanted games found! games_to_watch=%s, eligible_campaigns=%d",
                client.settings.games_to_watch,
                sum(1 for c in filtered_inventory if c.has_watchable_drops and getattr(c, 'eligible', True) and c.can_earn_within(next_hour)),
            )
            
    return client._wanted_games_cache

def output_campaign_mapping(client: Twitch, next_hour: datetime) -> None:
    logger.info("=== Active Campaigns Mapping ===")
    from collections import defaultdict

    game_campaign_map: dict[str, list[tuple[DropsCampaign, list[str]]]] = defaultdict(list)
    for campaign in client.inventory:
        if not campaign.has_watchable_drops:
            continue
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
