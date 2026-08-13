from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from time import time
from typing import TYPE_CHECKING, NoReturn, Optional

from pydantic import ValidationError

from src.config import CALL, GQL_OPERATIONS, WATCH_INTERVAL
from src.exceptions import GQLException
from src.i18n import _
from src.models.models import CurrentDropSession, CurrentDropInfo
from src.utils import task_wrapper

if TYPE_CHECKING:
    from src.config import JsonType
    from src.core.client import Twitch
    from src.models.models import Channel, TimedDrop

logger = logging.getLogger("TwitchDrops")


class WatchService:
    """
    Service responsible for watching channels and monitoring drop progress.
    """

    def __init__(self, twitch: Twitch) -> None:
        self._twitch = twitch
        self.current_drop: Optional[TimedDrop] = None

    def get_current_drop_info(self) -> Optional[CurrentDropInfo]:
        """Sestaví Pydantic DTO pro frontend."""
        if not self.current_drop:
            return None

        return CurrentDropInfo(
            id=str(self.current_drop.id),
            name=self.current_drop.name,
            game_name=getattr(self.current_drop.campaign.game, "name", "Unknown"),
            current_minutes=self.current_drop.current_minutes,
            required_minutes=self.current_drop.required_minutes,
            progress=int(self.current_drop.progress),
            image_url=getattr(self.current_drop, "image_url", None),
        )

    def is_drop_actively_mining(self, drop) -> bool:
        active = getattr(self, "current_drop", None)

        if not active or not drop:
            return False

        return str(active.id) == str(drop.id)

    def can_watch(self, channel: Channel) -> bool:
        if not channel.online:
            logger.debug("Cannot watch %s: Channel is offline.", channel.name)
            return False

        if not channel.drops_enabled:
            logger.debug("Cannot watch %s: Drops are disabled on channel.", channel.name)
            return False

        if channel.game is None:
            logger.debug("Cannot watch %s: Channel has no active game.", channel.name)
            return False

        channel_game_name = channel.game.name if hasattr(channel.game, "name") else str(channel.game)
        settings = getattr(self._twitch, "settings", None)

        ignored_games = getattr(settings, "ignored_games", []) if settings else []
        if channel_game_name in ignored_games:
            logger.debug("Cannot watch %s: Game '%s' is in ignored games list.", channel.name, channel_game_name)
            return False

        if not (settings and getattr(settings, "auto_add_all_games", False)):
            if not self._twitch.wanted_games:
                logger.debug("Cannot watch %s: No wanted games configured.", channel.name)
                return False

            # OPRAVA: Převedeme vše na malé písmena pro spolehlivou shodu
            game_names_lower = [
                (g.name.lower() if hasattr(g, "name") else str(g).lower()) 
                for g in self._twitch.wanted_games
            ]
            
            if channel_game_name.lower() not in game_names_lower:
                logger.debug("Cannot watch %s: Game '%s' is NOT in wanted games list.", channel.name, channel_game_name)
                return False

        matching_campaigns = []
        for campaign in self._twitch.inventory:
            if not campaign.has_watchable_drops:
                continue
            camp_game_name = campaign.game.name if hasattr(campaign.game, "name") else str(campaign.game)
            if camp_game_name.lower() == channel_game_name.lower():
                can = campaign.can_earn_on(channel)
                if can:
                    matching_campaigns.append(campaign)

        if not matching_campaigns:
            if not self._twitch.inventory:
                logger.debug("Inventory is currently empty during sync, waiting for campaigns update...")

            logger.debug("Skipping channel %s for game '%s': No earnable active campaigns.", channel.name, channel_game_name)
            return False

        return True

    def should_switch(self, channel: Channel) -> bool:
        if not self.can_watch(channel):
            return False

        watching_channel = self._twitch.watching_channel.get_with_default(None)
        if watching_channel is None:
            return True

        # OPRAVA: Pokud je to ten samý kanál, NIKDY nepřepínat!
        if watching_channel.id == channel.id:
            return False

        channel_order = self._twitch._channel_service.get_priority(channel)
        watching_order = self._twitch._channel_service.get_priority(watching_channel)

        return channel_order < watching_order or (
            channel_order == watching_order and channel.acl_based > watching_channel.acl_based
        )

    def watch(self, channel: Channel, *, update_status: bool = True) -> None:
        current_watching = self._twitch.watching_channel.get_with_default(None)
        
        # Pokud už přesně tento kanál sledujeme, nepřenastavujeme znovu stav
        if current_watching and current_watching.id == channel.id:
            logger.debug("Already watching %s, skipping watch re-initialization.", channel.name)
            return

        self._twitch.gui.channels.set_watching(channel)
        self._twitch.watching_channel.set(channel)

        game_name = channel.game.name if hasattr(channel.game, "name") else str(channel.game)
        logger.info("Started watching %s for game '%s'", channel.name, game_name)

        if update_status:
            if self._twitch.is_manual_mode() and self._twitch._manual_target_game:
                status_text = f"🎯 Manual Mode: Watching {channel.name} for {self._twitch._manual_target_game.name}"
            else:
                status_text = _.t["status"]["watching"].format(channel=channel.name)
            self._twitch.print(status_text)
            self._twitch.gui.status.update(status_text)

        # Přerušíme případný běžící časovač předchozího kanálu
        self.restart_watching()

    def stop_watching(self, *, notify_state_machine: bool = True) -> None:
        watching_channel = self._twitch.watching_channel.get_with_default(None)
        if watching_channel is None and self.current_drop is None:
            # Už jsme zastavení, neprovádíme zbytečné operace
            return

        logger.info("Stopped watching current channel.")
        self.current_drop = None
        self._twitch.gui.clear_drop()
        self._twitch.watching_channel.clear()
        self._twitch.gui.channels.clear_watching()
        
        # OŠETŘENÍ SMYČKY: Notifikujeme státní stroj POZE pokud o to volající výslovně požádá
        if notify_state_machine and hasattr(self._twitch, "request_stream_select"):
            self._twitch.request_stream_select()

    def restart_watching(self) -> None:
        logger.debug("Restarting watch loop timer.")
        gui = getattr(self._twitch, "gui", None)
        if gui and hasattr(gui, "progress"):
            progress = getattr(gui, "progress", None)
            if progress and hasattr(progress, "stop_timer"):
                progress.stop_timer()

        self._twitch._watching_restart.set()

    async def watch_sleep(self, delay: float) -> None:
        self._twitch._watching_restart.clear()
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._twitch._watching_restart.wait(), timeout=delay)

    @task_wrapper(critical=True)
    async def watch_loop(self) -> NoReturn:
        interval: float = WATCH_INTERVAL.total_seconds()

        while True:
            channel: Channel = await self._twitch.watching_channel.get()

            if not self.can_watch(channel):
                logger.info("Channel %s is no longer watchable. Dropping current watch target.", channel.name)
                self.stop_watching(notify_state_machine=True)
                await asyncio.sleep(1)  # Malá pauza, aby se zabránilo CPU-spinningu při chybě
                continue

            active_campaign = self._twitch._inventory_service.get_active_campaign(channel)
            logger.debug("Checking channel %s | Active campaign found: %s", channel.name, active_campaign is not None)

            if active_campaign:
                progress_val = getattr(active_campaign, "progress", "N/A")
                logger.debug("Active campaign progress for %s: %s%%", channel.name, progress_val)

                if active_campaign.progress >= 100:
                    logger.info("Skipping %s: Active campaign reached 100%%.", channel.name)
                    # Vynutíme kompletní re-evaluaci, aby se vyřadil dokončený streamer
                    self.stop_watching(notify_state_machine=False)
                    self._twitch.trigger_stream_selection(force=True)
                    continue

            channel_drops = getattr(channel, "drops", [])
            if channel_drops and not any(drop.can_earn() for drop in channel_drops):
                logger.info("Stopping watch for %s: No earnable drops left.", channel.name)
                self.stop_watching(notify_state_machine=True)
                continue

            if not channel.online:
                logger.info("Stopping watch for %s: Channel went offline.", channel.name)
                self.stop_watching(notify_state_machine=True)
                continue

            # Send watch payload
            logger.info("Sending watch payload to %s...", channel.name)
            succeeded: bool = await channel.send_watch()
            last_sent: float = time()

            if not succeeded:
                logger.warning("Watch payload request failed for channel: %s", channel.name)

            await self.watch_sleep(20)

            if not self.can_watch(channel):
                logger.info("Channel %s became unwatchable during loop interval. Stopping watch.", channel.name)
                self.stop_watching(notify_state_machine=True)
                continue

            progress_mgr = getattr(self._twitch.gui, "progress", None)
            if progress_mgr and getattr(progress_mgr, "minute_almost_done", None) and progress_mgr.minute_almost_done():
                handled: bool = False

                try:
                    context = await self._twitch.gql_request(
                        GQL_OPERATIONS["CurrentDrop"].with_variables({"channelID": str(channel.id)})
                    )
                    data = context.get("data") if isinstance(context, dict) else None
                    current_user = data.get("currentUser") if isinstance(data, dict) else None
                    drop_data = current_user.get("dropCurrentSession") if isinstance(current_user, dict) else None
                except GQLException:
                    drop_data = None

                if drop_data is not None:
                    try:
                        session = CurrentDropSession.model_validate(drop_data)
                        gql_drop: TimedDrop | None = self._twitch._drops.get(session.drop_id)
                        if gql_drop is not None and gql_drop.can_earn(channel):
                            gql_drop.update_minutes(session.current_minutes_watched)
                            self.current_drop = gql_drop
                            drop_text: str = (
                                f"{gql_drop.name} ({gql_drop.campaign.game}, "
                                f"{gql_drop.current_minutes}/{gql_drop.required_minutes})"
                            )
                            logger.info("Progress (GQL) [%s]: %s", channel.name, drop_text)
                            handled = True
                    except ValidationError as err:
                        logger.debug("Failed to parse CurrentDropSession GQL payload: %s", err)

                if not handled:
                    active_campaign = self._twitch._inventory_service.get_active_campaign(channel)
                    if active_campaign is not None:
                        active_campaign.bump_minutes(channel)
                        drop_text = f"Unknown drop ({active_campaign.game})"
                        if (active_drop := active_campaign.first_drop) is not None:
                            self.current_drop = active_drop
                            self._twitch.gui.display_drop(active_drop)
                            drop_text = (
                                f"{active_drop.name} ({active_drop.campaign.game}, "
                                f"{active_drop.current_minutes}/{active_drop.required_minutes})"
                            )
                        logger.info("Progress (Fallback) [%s]: %s", channel.name, drop_text)
                        handled = True
                    else:
                        logger.debug("No active drop could be determined for channel %s", channel.name)

            await self.watch_sleep(interval - min(time() - last_sent, interval))
