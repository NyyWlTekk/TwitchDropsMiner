"""
Watch service for managing channel watching and drop progress monitoring.

This service handles the core watching loop that sends watch payloads to Twitch,
monitors drop progress, and determines when to switch channels.
"""

from __future__ import annotations

import asyncio
import logging
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

        # Compare names/IDs to prevent typing mismatched bugs
        channel_game_name = channel.game.name if hasattr(channel.game, 'name') else str(channel.game)
        settings = getattr(self._twitch, "settings", None)

        # Check game eligibility based on auto_add_all_games and ignored_games
        if settings and getattr(settings, "auto_add_all_games", False):
            ignored_games = getattr(settings, "ignored_games", [])
            if channel_game_name in ignored_games:
                logger.debug(
                    "Cannot watch %s: Game '%s' is in ignored games list.",
                    channel.name,
                    channel_game_name,
                )
                return False
        else:
            if not self._twitch.wanted_games:
                logger.debug("Cannot watch %s: No wanted games configured.", channel.name)
                return False

            game_names = [g.name if hasattr(g, 'name') else str(g) for g in self._twitch.wanted_games]
            if channel_game_name not in game_names:
                logger.debug(
                    "Cannot watch %s: Game '%s' is not in wanted games list.",
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
                    logger.debug(
                        "Campaign '%s' is eligible for channel %s.",
                        campaign.name,
                        channel.name,
                    )
                    matching_campaigns.append(campaign)
                else:
                    # Build detailed explanation why can_earn returned False
                    reasons = []
                    
                    if getattr(campaign, "progress", 0) >= 100:
                        reasons.append("campaign 100% completed")
                    if hasattr(campaign, "account_connected") and not campaign.account_connected:
                        reasons.append("account not linked")
                    if hasattr(campaign, "allowed_channels") and campaign.allowed_channels:
                        if channel not in campaign.allowed_channels:
                            reasons.append("channel not in ACL list")

                    reason_msg = ", ".join(reasons) if reasons else "can_earn condition failed"
                    logger.debug(
                        "Campaign '%s' rejected for %s (Reason: %s).",
                        campaign.name,
                        channel.name,
                        reason_msg,
                    )

        if not matching_campaigns:
            logger.info(
                "Skipping channel %s for game '%s': No earnable campaigns active.",
                channel.name,
                channel_game_name,
            )
            return False

        return True
    
    def should_switch(self, channel: Channel) -> bool:
        """
        Determines if the given channel qualifies as a switch candidate.

        A channel should be switched to if:
        - We're not currently watching anything
        - The channel's game has higher priority than the watching channel's game
        - The channel has the same game priority but is ACL-based and watching isn't

        Args:
            channel: The channel to evaluate as a switch candidate

        Returns:
            True if we should switch to this channel, False otherwise
        """
        watching_channel = self._twitch.watching_channel.get_with_default(None)
        if watching_channel is None:
            return True

        channel_order = self._twitch._channel_service.get_priority(channel)
        watching_order = self._twitch._channel_service.get_priority(watching_channel)

        return (
            # this channel's game is higher order than the watching one's
            channel_order < watching_order
            or channel_order == watching_order  # or the order is the same
            # and this channel is ACL-based and the watching channel isn't
            and channel.acl_based > watching_channel.acl_based
        )

    def watch(self, channel: Channel, *, update_status: bool = True) -> None:
        """
        Start watching a specific channel.

        Updates GUI elements and sets the watching channel. Optionally prints
        a status message and updates the status bar.

        Args:
            channel: The channel to start watching
            update_status: Whether to print status message and update status bar
        """
        self._twitch.gui.channels.set_watching(channel)
        self._twitch.watching_channel.set(channel)

        if update_status:
            # Check if manual mode is active for custom status message
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
        self._twitch.gui.clear_drop()
        self._twitch.watching_channel.clear()
        self._twitch.gui.channels.clear_watching()

    def restart_watching(self) -> None:
        """
        Restart the watch loop (forces immediate re-send of watch payload).

        Stops the progress timer and signals the watch loop to restart.
        """
        self._twitch.gui.progress.stop_timer()
        self._twitch._watching_restart.set()

    async def watch_sleep(self, delay: float) -> None:
        """
        Sleep for a delay that can be interrupted by restart_watching().

        Uses wait_for with a timeout to allow an asyncio.sleep-like behavior
        that can be ended prematurely via the watching restart event.

        Args:
            delay: Time in seconds to sleep
        """
        self._twitch._watching_restart.clear()
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._twitch._watching_restart.wait(), timeout=delay)

    @task_wrapper(critical=True)
    async def watch_loop(self) -> NoReturn:
        """
        Main watch loop that sends watch payloads and monitors drop progress.

        This loop:
        1. Waits for a channel to watch
        2. Sends watch payload to the channel
        3. Waits ~20 seconds for websocket progress update
        4. If no update received, queries drop progress via GQL or estimates it
        5. Sleeps until next watch interval (~20 seconds)
        6. Repeats

        The loop handles cases where Twitch temporarily stops reporting progress
        by falling back to GQL queries or minute bumping.
        """
        interval: float = WATCH_INTERVAL.total_seconds()

        while True:
            channel: Channel = await self._twitch.watching_channel.get()

            # --- POJISTKA: Debugování stavu ---
            channel_campaigns = [c for c in self._twitch.inventory if c.game == channel.game]
            active_campaign = self._twitch._inventory_service.get_active_campaign(channel)
            
            logger.info(f"DEBUG: Checking {channel.name}. Active campaign found: {active_campaign is not None}")
            
            if active_campaign:
                logger.info(f"DEBUG: Active campaign progress: {getattr(active_campaign, 'progress', 'N/A')}%")
            
            # Původní logika, ale přidáme kontrolu i pro případ, že kampaň už není "aktivní"
            if active_campaign and active_campaign.progress >= 100:
                logger.info(f"Skipping {channel.name}: Active campaign at 100%.")
                self.stop_watching()
                continue

            channel_drops = getattr(channel, 'drops', [])
            
            if channel_drops and not any(drop.can_earn() for drop in channel_drops):
                logger.info(f"Stopping watch for {channel.name}: No drops left to earn.")
                self.stop_watching()
                continue

            if not channel.online:
                self.stop_watching()
                continue

            # logger.log(CALL, f"Sending watch payload to: {channel.name}")
            succeeded: bool = await channel.send_watch()
            last_sent: float = time()

            if not succeeded:
                logger.log(CALL, f"Watch requested failed for channel: {channel.name}")

            # wait ~20 seconds for a progress update
            await asyncio.sleep(20)

            if self._twitch.gui.progress.minute_almost_done():
                # If the previous update was more than ~60s ago, and the progress tracker
                # isn't counting down anymore, that means Twitch has temporarily
                # stopped reporting drop's progress. To ensure the timer keeps at least somewhat
                # accurate time, we can use GQL to query for the current drop,
                # or even "pretend" mining as a last resort option.
                handled: bool = False

                # Solution 1: use GQL to query for the currently mined drop status
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
                        logger.log(CALL, f"Drop progress from GQL: {drop_text}")
                        handled = True

                # Solution 2: If GQL fails, figure out which campaign we're most likely mining
                # right now, and then bump up the minutes on it's drops
                if not handled:
                    active_campaign = self._twitch._inventory_service.get_active_campaign(channel)
                    if active_campaign is not None:
                        active_campaign.bump_minutes(channel)
                        # NOTE: This usually gets overwritten below
                        drop_text = f"Unknown drop ({active_campaign.game})"
                        if (active_drop := active_campaign.first_drop) is not None:
                            active_drop.display()
                            drop_text = (
                                f"{active_drop.name} ({active_drop.campaign.game}, "
                                f"{active_drop.current_minutes}/{active_drop.required_minutes})"
                            )
                        logger.log(CALL, f"Drop progress from active search: {drop_text}")
                        handled = True
                    else:
                        logger.log(CALL, "No active drop could be determined")

            await self.watch_sleep(interval - min(time() - last_sent, interval))
