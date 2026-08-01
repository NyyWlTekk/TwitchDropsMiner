"""
Watch service for managing channel watching and drop progress monitoring.

This service handles the core watching loop that sends watch payloads to Twitch,
monitors drop progress, and determines when to switch channels.
"""

from __future__ import annotations

import asyncio
import logging
import time

from contextlib import suppress
from time import time
from typing import TYPE_CHECKING, NoReturn

from src.config import CALL, GQL_OPERATIONS, WATCH_INTERVAL
from src.exceptions import GQLException
from src.i18n import _
from src.utils import task_wrapper


if TYPE_CHECKING:
    from src.config import JsonType
    from src.core.client import Twitch
    from src.models import TimedDrop
    from src.models.channel import Channel


logger = logging.getLogger("TwitchDrops")


class WatchService:
    """
    Service responsible for watching channels and monitoring drop progress.

    Handles:
    - Starting/stopping channel watching
    - Watch loop that sends periodic watch payloads
    - Drop progress monitoring via GQL and websocket
    - Channel switch eligibility checks
    - Watch loop sleep with restart capability
    """

    def __init__(self, twitch: Twitch) -> None:
        """
        Initialize the watch service.

        Args:
            twitch: The Twitch client instance
        """
        self._twitch = twitch

    def can_watch(self, channel: Channel) -> bool:
        """
        Determines if a channel can be watched for earning drops.

        Checks online status, drops status, game list matching, and specific
        campaign requirements (ACL, account linking, completion state).
        """
        if not channel.online:
            logger.debug("Cannot watch %s: Channel is offline.", channel.name)
            return False

        if not channel.drops_enabled:
            logger.debug("Cannot watch %s: Drops are disabled on channel.", channel.name)
            return False

        if channel.game is None:
            logger.debug("Cannot watch %s: Channel has no active game.", channel.name)
            return False

        channel_game_name = channel.game.name if hasattr(channel.game, 'name') else str(channel.game)
        settings = getattr(self._twitch, "settings", None)

        # Check ignored games list first
        ignored_games = getattr(settings, "ignored_games", []) if settings else []
        if channel_game_name in ignored_games:
            logger.debug(
                "Cannot watch %s: Game '%s' is in ignored games list.",
                channel.name,
                channel_game_name,
            )
            return False

        # Check game eligibility based on auto_add_all_games or wanted_games
        if not (settings and getattr(settings, "auto_add_all_games", False)):
            if not self._twitch.wanted_games:
                logger.debug("Cannot watch %s: No wanted games configured.", channel.name)
                return False

            game_names = [g.name if hasattr(g, 'name') else str(g) for g in self._twitch.wanted_games]
            if channel_game_name not in game_names:
                logger.debug(
                    "Cannot watch %s: Game '%s' is NOT in wanted games list.",
                    channel.name,
                    channel_game_name,
                )
                return False

        matching_campaigns = []
        for campaign in self._twitch.inventory:
            camp_game_name = campaign.game.name if hasattr(campaign.game, 'name') else str(campaign.game)
            if camp_game_name.lower() == channel_game_name.lower():
                can = campaign.can_earn(channel)
                if can:
                    matching_campaigns.append(campaign)

        if not matching_campaigns:
            if not self._twitch.inventory:
                logger.debug("Inventory is currently empty during sync, waiting for campaigns update...")
                time.sleep(1)

            logger.debug(
                "Skipping channel %s for game '%s': No earnable active campaigns.",
                channel.name,
                channel_game_name,
            )
            return False

        return True

    def should_switch(self, channel: Channel) -> bool:
        """
        Determines if the given channel qualifies as a switch candidate.
        """
        if not self.can_watch(channel):
            return False

        watching_channel = self._twitch.watching_channel.get_with_default(None)
        if watching_channel is None:
            return True

        channel_order = self._twitch._channel_service.get_priority(channel)
        watching_order = self._twitch._channel_service.get_priority(watching_channel)

        return (
            channel_order < watching_order
            or (
                channel_order == watching_order
                and channel.acl_based > watching_channel.acl_based
            )
        )

    def watch(self, channel: Channel, *, update_status: bool = True) -> None:
        """
        Start watching a specific channel.

        Updates GUI elements and sets the watching channel. Optionally prints
        a status message and updates the status bar.
        """
        self._twitch.gui.channels.set_watching(channel)
        self._twitch.watching_channel.set(channel)

        game_name = channel.game.name if hasattr(channel.game, 'name') else str(channel.game)
        logger.info("Started watching %s for game '%s'", channel.name, game_name)

        if update_status:
            if self._twitch.is_manual_mode() and self._twitch._manual_target_game:
                status_text = f"🎯 Manual Mode: Watching {channel.name} for {self._twitch._manual_target_game.name}"
            else:
                status_text = _.t["status"]["watching"].format(channel=channel.name)
            self._twitch.print(status_text)
            self._twitch.gui.status.update(status_text)

    def stop_watching(self) -> None:
        """
        Stop watching the current channel.

        Clears the watching channel and updates GUI elements.
        """
        logger.info("Stopped watching current channel.")
        self._twitch.gui.clear_drop()
        self._twitch.watching_channel.clear()
        self._twitch.gui.channels.clear_watching()

    def restart_watching(self) -> None:
        """
        Restart the watch loop (forces immediate re-send of watch payload).
        """
        logger.debug("Restarting watch loop timer.")
        self._twitch.gui.progress.stop_timer()
        self._twitch._watching_restart.set()

    async def watch_sleep(self, delay: float) -> None:
        """
        Sleep for a delay that can be interrupted by restart_watching().
        """
        self._twitch._watching_restart.clear()
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._twitch._watching_restart.wait(), timeout=delay)

    @task_wrapper(critical=True)
    async def watch_loop(self) -> NoReturn:
        """
        Main watch loop that sends watch payloads and monitors drop progress.
        """
        interval: float = WATCH_INTERVAL.total_seconds()

        while True:
            channel: Channel = await self._twitch.watching_channel.get()

            # Channel eligibility check
            if not self.can_watch(channel):
                logger.info("Channel %s is no longer watchable. Dropping current watch target.", channel.name)
                self.stop_watching()
                continue

            active_campaign = self._twitch._inventory_service.get_active_campaign(channel)
            logger.debug("Checking channel %s | Active campaign found: %s", channel.name, active_campaign is not None)

            if active_campaign:
                progress_val = getattr(active_campaign, 'progress', 'N/A')
                logger.debug("Active campaign progress for %s: %s%%", channel.name, progress_val)

                if active_campaign.progress >= 100:
                    logger.info("Skipping %s: Active campaign reached 100%%.", channel.name)
                    self.stop_watching()
                    continue

            channel_drops = getattr(channel, 'drops', [])
            if channel_drops and not any(drop.can_earn() for drop in channel_drops):
                logger.info("Stopping watch for %s: No earnable drops left.", channel.name)
                self.stop_watching()
                continue

            if not channel.online:
                logger.info("Stopping watch for %s: Channel went offline.", channel.name)
                self.stop_watching()
                continue

            # Send watch payload
            logger.info("Sending watch payload to %s...", channel.name)
            succeeded: bool = await channel.send_watch()
            last_sent: float = time()

            if not succeeded:
                logger.warning("Watch payload request failed for channel: %s", channel.name)

            # FIX: Use watch_sleep instead of asyncio.sleep to allow instant interruption on GUI events
            await self.watch_sleep(20)

            # Re-check after sleep interval
            if not self.can_watch(channel):
                logger.info("Channel %s became unwatchable during loop interval. Stopping watch.", channel.name)
                self.stop_watching()
                continue

            if self._twitch.gui.progress.minute_almost_done():
                handled: bool = False

                # Query GQL for current drop
                try:
                    context = await self._twitch.gql_request(
                        GQL_OPERATIONS["CurrentDrop"].with_variables({"channelID": str(channel.id)})
                    )
                    drop_data: JsonType | None = context["data"]["currentUser"][
                        "dropCurrentSession"
                    ]
                except GQLException:
                    drop_data = None

                if drop_data is not None:
                    gql_drop: TimedDrop | None = self._twitch._drops.get(drop_data["dropID"])
                    if gql_drop is not None and gql_drop.can_earn(channel):
                        gql_drop.update_minutes(drop_data["currentMinutesWatched"])
                        drop_text: str = (
                            f"{gql_drop.name} ({gql_drop.campaign.game}, "
                            f"{gql_drop.current_minutes}/{gql_drop.required_minutes})"
                        )
                        logger.info("Progress (GQL) [%s]: %s", channel.name, drop_text)
                        handled = True

                # Fallback: Bump minutes if GQL failed
                if not handled:
                    active_campaign = self._twitch._inventory_service.get_active_campaign(channel)
                    if active_campaign is not None:
                        active_campaign.bump_minutes(channel)
                        drop_text = f"Unknown drop ({active_campaign.game})"
                        if (active_drop := active_campaign.first_drop) is not None:
                            active_drop.display()
                            drop_text = (
                                f"{active_drop.name} ({active_drop.campaign.game}, "
                                f"{active_drop.current_minutes}/{active_drop.required_minutes})"
                            )
                        logger.info("Progress (Fallback) [%s]: %s", channel.name, drop_text)
                        handled = True
                    else:
                        logger.debug("No active drop could be determined for channel %s", channel.name)

            await self.watch_sleep(interval - min(time() - last_sent, interval))
