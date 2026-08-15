from __future__ import annotations

import asyncio
import inspect
import logging
from contextlib import suppress
from time import time
from typing import TYPE_CHECKING, Any, NoReturn, Optional

from pydantic import ValidationError

from src.config import CALL, GQL_OPERATIONS, WATCH_INTERVAL, State
from src.exceptions import GQLException
from src.i18n import _
from src.models.models import CurrentDropInfo, CurrentDropSession
from src.utils import task_wrapper

if TYPE_CHECKING:
    from src.config import JsonType
    from src.core.client import Twitch
    from src.models.models import Channel, Game, Stream, TimedDrop

logger = logging.getLogger("TwitchDrops")


class WatchService:
    """
    Service responsible for watching channels, managing manual watch overrides,
    and monitoring drop progress.
    """

    def __init__(self, twitch: Twitch) -> None:
        self._twitch: Twitch = twitch
        self.current_drop: Optional[TimedDrop] = None

        # State pre Manuálny režim (přeneseno z klienta)
        self._manual_target_channel: Optional[Channel] = None
        self._manual_target_game: Optional[Game] = None

    # main function

    async def process_channel_switch(self) -> None:
        """
        Ucelená metoda, která kompletně vyřeší výběr i spuštění sledování kanálu.
        """
        logger.info("CHANNEL_SWITCH: Processing %d channels in inventory/cache", len(self._twitch.channels))

        if self._twitch.gui and hasattr(self._twitch.gui, "status"):
            self._twitch.gui.status.update(_.t["gui"]["status"]["switching"])

        channels = self._twitch.channels
        new_watching: Channel | None = None
        selected_channel: Channel | None = (
            self._twitch.gui.channels.get_selection()
            if self._twitch.gui and hasattr(self._twitch.gui, "channels")
            else None
        )
        watching_channel: Channel | None = self._twitch.watching_channel.get_with_default(None)

        # 1. Kontrola hotových kampaní u sledovaného kanálu
        if watching_channel:
            active_campaign = self._twitch.inventory_service.get_active_campaign(watching_channel)
            if active_campaign and getattr(active_campaign, "progress", 0) >= 100:
                logger.info("Campaign for %s is 100%% finished, forcing switch.", watching_channel.name)
                self.stop_watching()
                watching_channel = None

        # 2. Manuální výběr nebo aktivní manuální režim
        if selected_channel is not None and self.can_watch(selected_channel):
            if watching_channel and selected_channel.game != watching_channel.game:
                self.enter_manual_mode(selected_channel)
            new_watching = selected_channel

        elif self.is_manual_mode():
            if self._manual_target_channel and self.can_watch(self._manual_target_channel):
                new_watching = self._manual_target_channel
            else:
                for channel in channels.values():
                    same_game = (
                        channel.game == self._manual_target_game
                        or (getattr(channel.game, "id", None) == getattr(self._manual_target_game, "id", -1))
                    )
                    if same_game and self.can_watch(channel):
                        new_watching = channel
                        self._manual_target_channel = channel
                        break

            if new_watching is None:
                self.exit_manual_mode("No channels available for manual game")

        else:
            # 3. Automatika přes StreamSelector (filtrujeme neplatné/nesledovatelné kanály)
            watchable_channels = [ch for ch in channels.values() if self.can_watch(ch)]
            logger.info("🔍 [Channels] Načteno v cache: %d | Sledovatelných: %d", len(channels), len(watchable_channels))
            new_watching = self._twitch.stream_selector.select_best_channel(watchable_channels)

        # 4. Aplikování výsledku
        if new_watching is not None:
            game_name = getattr(new_watching.game, "name", str(new_watching.game or "N/A"))
            logger.info("▶️ [Select] Vybrán kanál: %s | Hra: '%s'", new_watching.name, game_name)
            
            self.watch(new_watching)

            if (active_campaign := self._twitch.inventory_service.get_active_campaign(new_watching)) is not None:
                if (active_drop := active_campaign.first_drop) is not None and self._twitch.gui:
                    self._twitch.gui.display_drop(active_drop, countdown=False, subone=True)

        elif watching_channel is not None and self.can_watch(watching_channel):
            logger.info("▶️ [Select] Pokračuji ve sledování: %s", watching_channel.name)

        else:
            logger.warning("⚠️ [Select] Žádný vhodný kanál nenalezen! Přecházím do State.IDLE.")
            self._twitch.print(_.t["status"]["no_channel"])
            self._twitch.change_state(State.IDLE)
            
            
    # ==========================================================================
    # 1. MANUAL MODE STATE MANAGEMENT
    # ==========================================================================

    def is_manual_mode(self) -> bool:
        """Vrátí True, pokud uživatel ručně vynutil sledování konkrétní hry/kanálu."""
        return self._manual_target_channel is not None and self._manual_target_game is not None

    def enter_manual_mode(self, channel: Channel) -> None:
        """Aktivuje manuální režim pro zadaný kanál a jeho hru."""
        if channel.game is None:
            logger.warning("Cannot enter manual mode: channel %s has no game", channel.name)
            return

        self._manual_target_channel = channel
        self._manual_target_game = channel.game
        logger.info("Entered manual mode for game: %s, channel: %s", channel.game.name, channel.name)

        if self._twitch.gui:
            self._twitch.gui.broadcast_manual_mode_change(self.get_manual_mode_info())

    def exit_manual_mode(self, reason: str = "") -> None:
        """Ukončí manuální režim a vrátí klient do stavu přepínání kanálů."""
        if not self.is_manual_mode():
            return

        game_name = self._manual_target_game.name if self._manual_target_game else "Unknown"
        logger.info("Exiting manual mode for game: %s. Reason: %s", game_name, reason or "User requested")

        self._manual_target_channel = None
        self._manual_target_game = None

        if self._twitch.gui:
            self._twitch.gui.broadcast_manual_mode_change(self.get_manual_mode_info())

        self._twitch.change_state(State.CHANNEL_SWITCH)

    def get_manual_mode_info(self) -> dict[str, Any]:
        """Sestaví DTO informace o manuálním režimu pro GUI rozhraní."""
        if self.is_manual_mode():
            return {
                "active": True,
                "game_name": self._manual_target_game.name if self._manual_target_game else "",
                "channel_name": self._manual_target_channel.name if self._manual_target_channel else "",
            }
        return {"active": False}

    # ==========================================================================
    # 2. DROP & CAN WATCH CHECKS
    # ==========================================================================

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

        wanted_games = getattr(self._twitch, "wanted_games", []) or []
        if not (settings and getattr(settings, "auto_add_all_games", False)):
            if not wanted_games:
                logger.debug("Cannot watch %s: No wanted games configured.", channel.name)
                return False

            game_names_lower = [
                (g.name.lower() if hasattr(g, "name") else str(g).lower())
                for g in wanted_games
            ]

            if channel_game_name.lower() not in game_names_lower:
                logger.debug("Cannot watch %s: Game '%s' is NOT in wanted games list.", channel.name, channel_game_name)
                return False

        # --- Kontrola aktivní kampaně přes inventory_service ---
        active_campaign = self._twitch.inventory_service.get_active_campaign(channel)

        if active_campaign is None:
            inventory = getattr(self._twitch, "inventory", []) or []
            if not inventory:
                logger.debug("Inventory is currently empty during sync, waiting for campaigns update...")

            logger.debug("Skipping channel %s for game '%s': No earnable active campaigns.", channel.name, channel_game_name)
            return False

        # Kontrola, zda kampaň není dokončená (>= 100 %)
        progress = getattr(active_campaign, "progress", 0)
        is_completed = getattr(active_campaign, "is_completed", False) or progress >= 100
        if is_completed:
            logger.debug("Skipping channel %s: Active campaign '%s' is 100%% finished.", channel.name, getattr(active_campaign, "name", ""))
            return False

        return True

    async def send_watch_payload(self, channel: Channel) -> bool:
        """
        Zajišťuje aktivní sledování kanálu přes přihlášení PubSub WebSocket témat.
        """
        if not channel or not self._twitch:
            return False

        try:
            ws = getattr(self._twitch, "websocket", None)
            if ws and hasattr(ws, "add_topics"):
                # Twitch PubSub téma pro sledování živého vysílání kanálu
                topic = f"video-playback-by-id.{channel.id}"
                
                if inspect.iscoroutinefunction(ws.add_topics):
                    await ws.add_topics([topic])
                else:
                    ws.add_topics([topic])
                
                logger.info("📡 [PubSub] Sledování aktivováno -> Kanál: %s (ID: %s)", channel.name, channel.id)
                return True

            logger.exception("❌ [PubSub] Chyba při přihlášení témata pro %s: %s", getattr(channel, "name", "unknown"), e)
            return False

        except Exception as e:
            logger.exception("send_watch_payload failed for channel %s: %s", getattr(channel, "name", "unknown"), e)
            return False

    def should_switch(self, channel: Channel) -> bool:
        if not self.can_watch(channel):
            return False

        watching_channel = self._twitch.watching_channel.get_with_default(None)
        if watching_channel is None:
            return True

        if watching_channel.id == channel.id:
            return False

        channel_order = self._twitch.channel_service.get_priority(channel)
        watching_order = self._twitch.channel_service.get_priority(watching_channel)

        return channel_order < watching_order or (
            channel_order == watching_order and channel.acl_based > watching_channel.acl_based
        )

    # ==========================================================================
    # 3. WATCH CONTROL & TIMERS
    # ==========================================================================

    def watch(self, channel: Channel, *, update_status: bool = True) -> None:
        current_watching = self._twitch.watching_channel.get_with_default(None)

        if current_watching and current_watching.id == channel.id:
            logger.debug("Already watching %s, skipping watch re-initialization.", channel.name)
            return

        self._twitch.gui.channels.set_watching(channel)
        self._twitch.watching_channel.set(channel)

        game_name = channel.game.name if hasattr(channel.game, "name") else str(channel.game)
        logger.info("Started watching %s for game '%s'", channel.name, game_name)

        if update_status:
            if self.is_manual_mode() and self._manual_target_game:
                status_text = f"🎯 Manual Mode: Watching {channel.name} for {self._manual_target_game.name}"
            else:
                status_text = _.t["status"]["watching"].format(channel=channel.name)
            self._twitch.print(status_text)
            self._twitch.gui.status.update(status_text)

        self.restart_watching()

    def stop_watching(self, *, notify_state_machine: bool = True) -> None:
        watching_channel = self._twitch.watching_channel.get_with_default(None)
        if watching_channel is None and self.current_drop is None:
            return

        # Odhlášení PubSub témata starého kanálu
        ws = getattr(self._twitch, "websocket", None)
        if ws and hasattr(ws, "remove_topics") and watching_channel:
            topic = f"video-playback-by-id.{watching_channel.id}"
            if inspect.iscoroutinefunction(ws.remove_topics):
                asyncio.create_task(ws.remove_topics([topic]))
            else:
                ws.remove_topics([topic])

        logger.info("Stopped watching current channel: %s", getattr(watching_channel, "name", "Unknown"))
        self.current_drop = None
        self._twitch.gui.clear_drop()
        self._twitch.watching_channel.clear()
        self._twitch.gui.channels.clear_watching()

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

    # ==========================================================================
    # 4. BACKGROUND WATCH WORKER LOOP
    # ==========================================================================

    @task_wrapper(critical=True)
	async def watch_loop(self) -> NoReturn:
		interval: float = WATCH_INTERVAL.total_seconds()

		while True:
			channel: Channel = await self._twitch.watching_channel.get()

			# 🔄 1. Osvěžení stavu kanálu přes GQL (Live Check)
			# Musíš aktivně ověřit, zda je stream stále živý
			try:
				is_live = await self._twitch.check_channel_is_live(channel.id)
				channel.online = is_live
			except Exception as err:
				logger.debug("Failed to refresh online status for %s: %s", channel.name, err)

			# 2. Kontrola sledovatelnosti
			if not self.can_watch(channel):
				logger.info("⚠️ [Watch] Kanál %s už není sledovatelný. Ruším sledování.", channel.name)
				self.stop_watching(notify_state_machine=True)
				await asyncio.sleep(1)
				continue

            active_campaign = self._twitch.inventory_service.get_active_campaign(channel)
            logger.debug("Checking channel %s | Active campaign found: %s", channel.name, active_campaign is not None)

            if active_campaign:
                progress_val = getattr(active_campaign, "progress", "N/A")
                logger.debug("Active campaign progress for %s: %s%%", channel.name, progress_val)

                if active_campaign.progress >= 100:
                    logger.info("🎉 [Campaign] Kampaň pro kanál %s dosáhla 100 %%. Přepínám...", channel.name)
                    self.stop_watching(notify_state_machine=False)
                    self._twitch.trigger_stream_selection(force=True)
                    continue

            channel_drops = getattr(channel, "drops", [])
            if channel_drops and not any(drop.can_earn() for drop in channel_drops):
                logger.info("🛑 [Watch] Ukončuji sledování %s: Žádné dostupné dropy.", channel.name)
                self.stop_watching(notify_state_machine=True)
                continue

            # 📴 3. Teď už channel.online obsahuje aktuální pravdivý stav z GQL!
			if not channel.online:
				logger.info("📴 [Watch] Ukončuji sledování %s: Kanál přešel do offline stavu.", channel.name)
				self.stop_watching(notify_state_machine=True)
				continue

            # Odeslání watch payloadu (PubSub / Spade)
            logger.info("📡 [Watch] Odesílám watch payload pro kanál: %s", channel.name)
            succeeded: bool = await self.send_watch_payload(channel)
            last_sent: float = time()

            if not succeeded:
                logger.warning("❌ [Watch] Požadavek na watch payload selhal pro kanál: %s", channel.name)

            await self.watch_sleep(20)

            if not self.can_watch(channel):
                logger.info("⚠️ [Watch] Kanál %s se během intervalu stal nesledovatelným.", channel.name)
                self.stop_watching(notify_state_machine=True)
                continue

            # Zpracování odpočtu minut a progresu dropů
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
                            
                            # ⏱️ Jednořádkový výpis pro GQL progres
                            logger.info(
                                "⏱️ [Progress/GQL] %s | Drop: %s | %d/%d min (%d%%)",
                                channel.name,
                                gql_drop.name,
                                gql_drop.current_minutes,
                                gql_drop.required_minutes,
                                int(gql_drop.progress),
                            )
                            handled = True
                    except ValidationError as err:
                        logger.debug("Failed to parse CurrentDropSession GQL payload: %s", err)

                if not handled:
                    active_campaign = self._twitch.inventory_service.get_active_campaign(channel)
                    if active_campaign is not None:
                        active_campaign.bump_minutes(channel)
                        if (active_drop := active_campaign.first_drop) is not None:
                            self.current_drop = active_drop
                            self._twitch.gui.display_drop(active_drop)
                            
                            # ⏱️ Jednořádkový výpis pro Fallback progres
                            logger.info(
                                "⏱️ [Progress/Fallback] %s | Drop: %s | %d/%d min (%d%%)",
                                channel.name,
                                active_drop.name,
                                active_drop.current_minutes,
                                active_drop.required_minutes,
                                int(active_drop.progress),
                            )
                        else:
                            logger.info("⏱️ [Progress/Fallback] %s | Hra: %s (Neznámý drop)", channel.name, active_campaign.game)
                        handled = True
                    else:
                        logger.debug("No active drop could be determined for channel %s", channel.name)

            await self.watch_sleep(interval - min(time() - last_sent, interval))
