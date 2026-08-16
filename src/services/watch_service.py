from __future__ import annotations

import inspect
import base64
import json
import asyncio
import aiohttp
import urllib.parse
from urllib.parse import quote
import json
import traceback
import logging
import re
from collections.abc import Callable
from contextlib import suppress
from time import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, NoReturn, Optional, Iterable

from pydantic import ValidationError
from yarl import URL

from src.config import (
    GQL_OPERATIONS,
    State,
)
from src.config.constants import (
    WATCH_INTERVAL,
)
from src.i18n import _
from src.models.models import CurrentDropInfo, CurrentDropSession, Channel
from src.utils import chunk, task_wrapper
from ..exceptions import GQLException, MinerException

if TYPE_CHECKING:
    from src.config import JsonType
    from src.core.client import Twitch
    from src.models.models import Game, TimedDrop


logger = logging.getLogger("TwitchDrops")

# Regex vzory
SPADE_PATTERN = re.compile(r'"beacon_?url": ?"(https://[^"]+)"', re.I)
SETTINGS_PATTERN = re.compile(r'src="(https://[\w.]+/config/settings\.[0-9a-f]{32}\.js)"', re.I)


def extract_spade_url_from_text(html_or_js: str) -> Optional[str]:
    """Extrahuje Spade beacon URL z obsahu HTML nebo JS pomocí regexu."""
    match = SPADE_PATTERN.search(html_or_js)
    return match.group(1) if match else None


def extract_settings_js_url(html_text: str) -> Optional[str]:
    """Extrahuje URL JS konfigurace ze stránky streamera."""
    match = SETTINGS_PATTERN.search(html_text)
    return match.group(1) if match else None


class WatchService:
    """
    Service responsible for watching channels, managing manual watch overrides,
    and monitoring drop progress.
    """

    def __init__(self, twitch: Twitch) -> None:
        self._twitch: Twitch = twitch
        self.current_drop: Optional[TimedDrop] = None

        # State pre Manuálny režim
        self._manual_target_channel: Optional[Channel] = None
        self._manual_target_game: Optional[Game] = None

    async def handle_state_channels_fetch(self) -> None:
        twitch = self._twitch

        if twitch.gui and hasattr(twitch.gui, "status"):
            twitch.gui.status.update(_.t["gui"]["status"]["gathering"])

        logger.info("Fetching channels for wanted games...")

        channels = twitch.channels
        channels.clear()

        no_acl: set[Game] = set()
        all_acl_channels: set[Channel] = set()

        # 1. Shromáždění všech ACL kanálů a her bez ACL z inventáře
        for campaign in twitch.inventory:
            if campaign.game in twitch.wanted_games and campaign.is_campaign_earnable:
                if campaign.allowed_channels:
                    for channel in campaign.allowed_channels:
                        if channel.game is None:
                            channel.game = campaign.game
                    all_acl_channels.update(campaign.allowed_channels)
                else:
                    if campaign.game:
                        no_acl.add(campaign.game)

        logger.info(
            "Found %d ACL channels and %d games without ACL to fetch.",
            len(all_acl_channels),
            len(no_acl),
        )

        # 2. Prověření online stavu pro VŠECHNY ACL kanály přímo přes WatchService
        if all_acl_channels:
            await self.bulk_check_online(all_acl_channels)

        # 3. Načtení živých streamů z adresáře pro hry bez omezení ACL
        directory_channels: set[Channel] = set()
        for game in no_acl:
            logger.info("Fetching live streams for game: %s", game.name)
            directory_channels.update(await self.get_live_streams(game, drops_enabled=True))

        # 4. Uložení všech nalezených kanálů do hlavní keše klienta
        gathered_channels: set[Channel] = all_acl_channels | directory_channels

        for channel in gathered_channels:
            channels[channel.id] = channel

        logger.info("Total gathered channels saved to cache: %d", len(channels))
        twitch.change_state(State.CHANNEL_SWITCH)
    # ==========================================================================
    # MAIN CHANNEL SWITCHING LOGIC
    # ==========================================================================

    async def process_channel_switch(self) -> None:
        """
        Kompletně vyřeší výběr a spuštění sledování kanálu.
        """
        channels = self._twitch.channels
        logger.info("CHANNEL_SWITCH: Processing %d channels in inventory/cache", len(channels))

        if self._twitch.gui and hasattr(self._twitch.gui, "status"):
            self._twitch.gui.status.update(_.t["gui"]["status"]["switching"])

        new_watching: Channel | None = None

        selected_channel: Channel | None = None
        if self._twitch.gui and getattr(self._twitch.gui, "channels", None):
            selected_channel = self._twitch.gui.channels.get_selection()

        watching_channel: Channel | None = self._twitch.watching_channel.get_with_default(None)

        # 1. Kontrola hotových kampaní a funkčnosti u sledovaného kanálu
        if watching_channel is not None:
            active_campaign = self._twitch.inventory_service.get_active_campaign(watching_channel)
            if active_campaign is None:
                logger.info(
                    "Channel %s has no active campaign (game changed to '%s' or campaign ended), forcing switch.",
                    watching_channel.name,
                    watching_channel.game.name if watching_channel.game else "N/A",
                )
                self.stop_watching()
                watching_channel = None
            elif active_campaign.progress >= 100:
                logger.info("Campaign for %s is 100%% finished, forcing switch.", watching_channel.name)
                self.stop_watching()
                watching_channel = None
            elif not watching_channel.can_watch_channel:
                logger.info(
                    "Channel %s is no longer watchable (offline/wrong game), forcing switch.",
                    watching_channel.name,
                )
                self.stop_watching()
                watching_channel = None

        # 2. Manuální výběr nebo aktivní manuální režim
        manual_candidate: Channel | None = None
        if selected_channel is not None and selected_channel.can_watch_channel:
            if watching_channel is not None and selected_channel.game != watching_channel.game:
                self.enter_manual_mode(selected_channel)
            manual_candidate = selected_channel

        elif self.is_manual_mode():
            if self._manual_target_channel is not None and self._manual_target_channel.can_watch_channel:
                manual_candidate = self._manual_target_channel
            else:
                for channel in channels.values():
                    same_game = (
                        channel.game == self._manual_target_game
                        or (
                            channel.game
                            and self._manual_target_game
                            and channel.game.id == self._manual_target_game.id
                        )
                    )
                    if same_game and channel.can_watch_channel:
                        manual_candidate = channel
                        self._manual_target_channel = channel
                        break

            if manual_candidate is None:
                self.exit_manual_mode("No channels available for manual game")

        # Ověření manuálního kandidáta přes GQL
        if manual_candidate is not None:
            stream = await self.fetch_stream(manual_candidate)
            if stream and await self.send_watch_payload(manual_candidate):
                manual_candidate.stream = stream
                new_watching = manual_candidate
            else:
                logger.warning("⚠️ [Manual] Kanál %s je offline nebo selhal watch payload.", manual_candidate.name)
                manual_candidate.online = False
                if self.is_manual_mode():
                    self.exit_manual_mode("Manual target channel offline")

        # 3. Automatika přes StreamSelector
        if new_watching is None:
            # 3a. Načtení živých streamů z adresáře přes WatchService
            current_queue = self._twitch.stream_selector._current_queue
            if current_queue:
                target_game = current_queue[0]
                logger.info("🌐 [LiveFetch] Načítám živé streamy z adresáře pro hru: %s", target_game.name)
                try:
                    live_directory_channels = await self.get_live_streams(target_game, limit=30)
                    for live_ch in live_directory_channels:
                        channels[live_ch.id] = live_ch
                except Exception as exc:
                    logger.warning("⚠️ [LiveFetch] Nepodařilo se načíst streamy z adresáře: %s", exc)

            # 3b. Filtr sledovatelných kanálů a seřazení
            watchable_channels: list[Channel] = [
                ch for ch in channels.values() if ch.can_watch_channel
            ]
            logger.info("🔍 [Channels] Načteno v cache: %d | Sledovatelných: %d", len(channels), len(watchable_channels))

            candidates: list[Channel] = self._twitch.stream_selector.select_best_channel(watchable_channels)

            # 3c. Hromadné ověření top 30 kandidátů přes self.bulk_check_online
            top_candidates = candidates[:30]
            if top_candidates:
                await self.bulk_check_online(top_candidates)

            for candidate in top_candidates:
                if not candidate.can_watch_channel:
                    logger.info("⏭️ [Select] Kanál %s je offline nebo nesledovatelný, přeskakuji.", candidate.name)
                    continue

                # Validace: Kanál musí mít pro aktuálně vysílanou hru aktivní kampaň s dropy
                candidate_campaign = self._twitch.inventory_service.get_active_campaign(candidate)
                if candidate_campaign is None:
                    game_title = candidate.game.name if candidate.game else "N/A"
                    logger.info(
                        "⏭️ [Select] Kanál %s nemá aktivní kampaň (vysílá: '%s'), přeskakuji.",
                        candidate.name,
                        game_title,
                    )
                    continue

                if await self.send_watch_payload(candidate):
                    new_watching = candidate
                    break
                else:
                    logger.warning("⚠️ [Select] Odeslání payloadu selhalo pro %s, zkouším dalšího.", candidate.name)
                    candidate.online = False

        # 4. Aplikování výsledku
        if new_watching is not None:
            game_name = new_watching.game.name if new_watching.game else "N/A"
            logger.info("▶️ [Select] Vybrán kanál: %s | Hra: '%s'", new_watching.name, game_name)

            self.watch(new_watching)

            active_campaign = self._twitch.inventory_service.get_active_campaign(new_watching)
            if active_campaign is not None:
                active_drop = active_campaign.first_drop
                self.current_drop = active_drop
                self._twitch.current_drop = active_drop

                if active_drop is not None and self._twitch.gui is not None:
                    self._twitch.gui.display_drop(active_drop, countdown=False, subone=True)

            self._twitch.change_state(State.WATCHING)

        elif watching_channel is not None and watching_channel.can_watch_channel:
            logger.info("▶️ [Select] Pokračuji ve sledování: %s", watching_channel.name)
            self._twitch.change_state(State.WATCHING)

        else:
            logger.warning("⚠️ [Select] Žádný vhodný kanál nenalezen! Přecházím do State.IDLE.")
            self._twitch.print(_.t["status"]["no_channel"])
            self._twitch.change_state(State.IDLE)

    # ==========================================================================
    # MANUAL MODE STATE MANAGEMENT
    # ==========================================================================

    def is_manual_mode(self) -> bool:
        return self._manual_target_channel is not None and self._manual_target_game is not None

    def enter_manual_mode(self, channel: Channel) -> None:
        if channel.game is None:
            logger.warning("Cannot enter manual mode: channel %s has no game", channel.name)
            return

        self._manual_target_channel = channel
        self._manual_target_game = channel.game

        game_name = getattr(channel.game, "name", str(channel.game))
        logger.info("Entered manual mode for game: %s, channel: %s", game_name, channel.name)

        if self._twitch.gui:
            self._twitch.gui.broadcast_manual_mode_change(self.get_manual_mode_info())

    def exit_manual_mode(self, reason: str = "") -> None:
        if not self.is_manual_mode():
            return

        game_name = getattr(self._manual_target_game, "name", "Unknown") if self._manual_target_game else "Unknown"
        logger.info("Exiting manual mode for game: %s. Reason: %s", game_name, reason or "User requested")

        self._manual_target_channel = None
        self._manual_target_game = None

        if self._twitch.gui:
            self._twitch.gui.broadcast_manual_mode_change(self.get_manual_mode_info())

        self._twitch.change_state(State.CHANNEL_SWITCH)

    def get_manual_mode_info(self) -> dict[str, Any]:
        if self.is_manual_mode():
            return {
                "active": True,
                "game_name": getattr(self._manual_target_game, "name", "") if self._manual_target_game else "",
                "channel_name": self._manual_target_channel.name if self._manual_target_channel else "",
            }
        return {"active": False}

    # ==========================================================================
    # DROP & CAN WATCH CHECKS      přesunout do modelů !!!!!!
    # ==========================================================================

    def get_current_drop_info(self) -> Optional[CurrentDropInfo]:
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
        if not self.current_drop or not drop:
            return False
        return str(self.current_drop.id) == str(drop.id)

    def can_watch(self, channel: Channel) -> bool:
        if not channel.can_watch_channel:
            if not channel.online:
                logger.info("Cannot watch %s: Channel is offline.", channel.name)
            elif not channel.drops_enabled:
                logger.info("Cannot watch %s: Drops are disabled on channel.", channel.name)
            elif channel.game is None:
                logger.info("Cannot watch %s: Channel has no active game.", channel.name)
            return False

        channel_game_name = channel.game.name if hasattr(channel.game, "name") else str(channel.game)
        settings = getattr(self._twitch, "settings", None)

        ignored_games = getattr(settings, "ignored_games", []) if settings else []
        if channel_game_name in ignored_games:
            logger.info("Cannot watch %s: Game '%s' is in ignored games list.", channel.name, channel_game_name)
            return False

        wanted_games = getattr(self._twitch, "wanted_games", []) or []
        if not (settings and getattr(settings, "auto_add_all_games", False)):
            if not wanted_games:
                logger.info("Cannot watch %s: No wanted games configured.", channel.name)
                return False

            game_names_lower = [
                (g.name.lower() if hasattr(g, "name") else str(g).lower())
                for g in wanted_games
            ]

            if channel_game_name.lower() not in game_names_lower:
                logger.info("Cannot watch %s: Game '%s' is NOT in wanted games list.", channel.name, channel_game_name)
                return False

        return True

    # ==========================================================================
    # STREAM & PAYLOAD FETCHING
    # ==========================================================================

    async def fetch_stream(self, channel: Channel) -> dict | None:
        try:
            # Použijeme channel.stream_gql místo neexistujícího klíče GQL_OPERATIONS["GetStream"]
            gql_payload = (
                GQL_OPERATIONS["StreamRefetch"].with_variables({"channel": channel.login})
                if "StreamRefetch" in GQL_OPERATIONS
                else channel.stream_gql
            )

            context = await self._twitch.gql_request(gql_payload)
            data = context.get("data") if isinstance(context, dict) else None
            user_data = data.get("user") if isinstance(data, dict) else None

            if isinstance(user_data, dict):
                # Aktualizuje ID, title, game a nastaví channel.online (True/False)
                channel.external_update(user_data)

                # Vrátíme data pouze pokud je stream reálně ONLINE
                return user_data if channel.online else None

        except Exception as err:
            logger.warning("Chyba při načítání streamu pro %s: %s", channel.name, err)

        channel.online = False
        return None

    async def send_watch_payload(self, channel: Channel) -> bool:
        """Odeslání spade pingu s využitím vlastní čisté HTTP relace."""
        if not channel.is_live:
            logger.info("⚠️ [Spade] Kanál %s není live, přeskočeno.", channel.name)
            return False

        await asyncio.sleep(0.5)

        game_name = channel.game.name if channel.game else "Neznámá hra"

        # Filtrování kampaní pro přehledný log
        camp_info = ""
        if channel.campaigns:
            relevant_camps = [
                c for c in channel.campaigns 
                if (getattr(c, "game", None) and getattr(c.game, "name", "") == game_name)
                or (hasattr(c, "progress") and 0 < c.progress < 100)
            ]
            display_camps = relevant_camps or [c for c in channel.campaigns if getattr(c, "progress", 0) < 100][:3]
            
            camp_details = []
            for camp in display_camps:
                info = f"{camp.name}"
                if hasattr(camp, "progress"):
                    info += f" ({camp.progress:.1f}%)"
                if getattr(camp, "active_drop", None):
                    drop = camp.active_drop
                    drop_pct = getattr(drop, "progress", getattr(drop, "percentage", 0))
                    info += f" | Drop: {drop.name} ({drop_pct:.1f}%)"
                camp_details.append(info)

            if camp_details:
                camp_info = f" [{', '.join(camp_details)}]"

        logger.info(
            "📡 [Spade] Povoluji sledování pro kanál: %s (hra: %s)%s",
            channel.name,
            game_name,
            camp_info,
        )

        # 1. Získání a validace Spade URL
        spade_url = getattr(channel, "spade_url", None)

        if not spade_url or "video-edge-sess.twitch.tv" in str(spade_url):
            logger.info("🔍 [Spade] Získávám novou Spade URL pro %s...", channel.name)
            channel_url = getattr(channel, "url", f"https://www.twitch.tv/{channel.login}")
            spade_url = await self.fetch_spade_url(channel_url)

            # Validace vyextrahované URL
            if not spade_url or "video-edge-sess.twitch.tv" in str(spade_url):
                spade_url = "https://spade.twitch.tv/v1/pay"

            # Pokud model používá interní privátní atribut _spade_url, ulož ho tam
            if hasattr(channel, "_spade_url"):
                try:
                    channel._spade_url = spade_url
                except AttributeError:
                    pass

        logger.info("🔗 [Spade] Odesílám POST na URL: %s", spade_url)

        # 2. Inicializace / opnové použití vlastní čisté HTTP relace pro Spade
        if not hasattr(self, "_spade_session") or self._spade_session is None or self._spade_session.closed:
            headers = {
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
                ),
                "Content-Type": "text/plain;charset=UTF-8",
            }
            self._spade_session = aiohttp.ClientSession(headers=headers)

        async def _do_post() -> int:
            async with self._spade_session.post(spade_url, data=channel.spade_payload) as resp:
                await resp.read()
                return resp.status

        try:
            status = await asyncio.wait_for(_do_post(), timeout=8.0)

            if status in (200, 204):
                logger.info(
                    "✅ [Spade] Minute-watched úspěšně odeslán pro %s [%s]%s (Status: %s)",
                    channel.name,
                    game_name,
                    camp_info,
                    status,
                )
                return True
            else:
                logger.warning(
                    "⚠️ [Spade] Odpověď ze serveru pro %s [%s]%s: Status %s",
                    channel.name,
                    game_name,
                    camp_info,
                    status,
                )
                return False

        except asyncio.TimeoutError:
            logger.error(
                "⏱️ [Spade] Vypršel časový limit (8s) při odesílání pingu pro %s [%s]",
                channel.name,
                game_name,
            )
            return False
        except Exception as err:
            logger.error(
                "❌ [Spade] Selhalo odeslání pingu pro %s [%s]: %s",
                channel.name,
                game_name,
                err,
                exc_info=True,
            )
            return False

    async def fetch_spade_url(self, channel_url: URL | str) -> URL:
        """Dvoukroková extrakce Spade URL ze stránek kanálu."""
        async with self._twitch.request("GET", channel_url) as response1:
            streamer_html: str = await response1.text(encoding="utf8")

        spade_url = extract_spade_url_from_text(streamer_html)
        if not spade_url:
            settings_url = extract_settings_js_url(streamer_html)
            if not settings_url:
                raise RuntimeError("Error while spade_url extraction: step #1")

            async with self._twitch.request("GET", settings_url) as response2:
                settings_js: str = await response2.text(encoding="utf8")

            spade_url = extract_spade_url_from_text(settings_js)
            if not spade_url:
                raise RuntimeError("Error while spade_url extraction: step #2")

        return URL(spade_url)

    async def fetch_stream_hls_url(
        self,
        channel_login: str,
        on_offline_callback: Optional[Callable[[], None]] = None,
    ) -> Optional[URL]:
        """Získá M3U8 HLS URL adresu streamu přes GQL AccessToken a Usher API."""
        gql_op = GQL_OPERATIONS["PlaybackAccessToken"].with_variables({"login": channel_login})
        playback_token_response = await self._twitch.gql_request(gql_op)

        token_data = (
            playback_token_response.get("data", {}).get("streamPlaybackAccessToken")
            if isinstance(playback_token_response, dict)
            else None
        )
        if not token_data or not isinstance(token_data, dict):
            if on_offline_callback:
                on_offline_callback()
            return None

        token_value = token_data.get("value")
        token_signature = token_data.get("signature")

        if not token_value or not token_signature:
            if on_offline_callback:
                on_offline_callback()
            return None

        usher_url = URL("https://usher.ttvnw.net/api/channel/hls").with_path(
            f"/api/channel/hls/{channel_login}.m3u8"
        ).with_query({"sig": token_signature, "token": token_value})

        async with self._twitch.request("GET", usher_url) as response:
            available_qualities = await response.text()
            try:
                available_json = json.loads(available_qualities)
            except json.JSONDecodeError:
                pass
            else:
                if isinstance(available_json, list) and available_json:
                    available_json = available_json[0]
                if isinstance(available_json, dict) and "error" in available_json:
                    logger.error('Stream URL get error: "%s"', available_json["error"])
                    if on_offline_callback:
                        on_offline_callback()
                    return None

            m3u8_lines = [
                line.strip()
                for line in available_qualities.splitlines()
                if line.strip() and not line.strip().startswith("#")
            ]
            if m3u8_lines:
                return URL(m3u8_lines[-1])

            return None

    # ==========================================================================
    # WATCH CONTROL & TIMERS
    # ==========================================================================

    def watch(self, channel: Channel, *, update_status: bool = True) -> None:
        current_watching = self._twitch.watching_channel.get_with_default(None)

        if current_watching and current_watching.id == channel.id:
            logger.info("Already watching %s, skipping watch re-initialization.", channel.name)
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
        logger.info("Restarting watch loop timer.")
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
    # BACKGROUND WATCH WORKER LOOP
    # ==========================================================================

    @task_wrapper(critical=True)
    async def watch_loop(self) -> NoReturn:
        interval: float = WATCH_INTERVAL.total_seconds()

        # Vnější smyčka udržuje úlohu aktivní a čeká na nové kanály z fronty
        while True:
            channel: Channel = await self._twitch.watching_channel.get()
            logger.info("▶️ [WatchLoop] Zahajuji sledovací smyčku pro kanál: %s", channel.name)

            # Vnitřní smyčka provádí minutové cykly sledování vybraného kanálu
            while True:
                # 1. Kontrola živého vysílání (Live Check)
                try:
                    stream_data = await self.fetch_stream(channel)
                    if stream_data and isinstance(stream_data, dict):
                        channel.external_update(stream_data)
                    elif stream_data:
                        channel.online = getattr(stream_data, "online", True)
                    else:
                        channel.online = False
                except Exception as err:
                    logger.info("Failed to refresh online status for %s: %s", channel.name, err)

                # 2. Kontrola, zda lze kanál dále sledovat
                if not self.can_watch(channel):
                    logger.info("⚠️ [Watch] Kanál %s už není sledovatelný. Ruším sledování.", channel.name)
                    self.stop_watching(notify_state_machine=True)
                    break

                active_campaign = self._twitch.inventory_service.get_active_campaign(channel)
                logger.info("Checking channel %s | Active campaign found: %s", channel.name, active_campaign is not None)

                if active_campaign:
                    progress_val = getattr(active_campaign, "progress", "N/A")
                    logger.info("Active campaign progress for %s: %s%%", channel.name, progress_val)

                    if active_campaign.progress >= 100:
                        logger.info("🎉 [Campaign] Kampaň pro kanál %s dosáhla 100 %%. Přepínám...", channel.name)
                        self.stop_watching(notify_state_machine=False)
                        self._twitch.trigger_stream_selection(force=True)
                        break

                channel_drops = getattr(channel, "drops", [])
                if channel_drops and not any(drop.can_earn() for drop in channel_drops):
                    logger.info("🛑 [Watch] Ukončuji sledování %s: Žádné dostupné dropy.", channel.name)
                    self.stop_watching(notify_state_machine=True)
                    break

                if not channel.online:
                    logger.info("📴 [Watch] Ukončuji sledování %s: Kanál přešel do offline stavu.", channel.name)
                    self.stop_watching(notify_state_machine=True)
                    break

                # 3. Odeslání Watch Payloadu
                logger.info("📡 [Watch] Odesílám watch payload pro kanál: %s", channel.name)
                succeeded: bool = await self.send_watch_payload(channel)
                last_sent: float = time()

                if not succeeded:
                    logger.warning("❌ [Watch] Požadavek na watch payload selhal pro kanál: %s", channel.name)

                await self.watch_sleep(20)

                if not self.can_watch(channel):
                    logger.info("⚠️ [Watch] Kanál %s se během intervalu stal nesledovatelným.", channel.name)
                    self.stop_watching(notify_state_machine=True)
                    break

                # 4. Aktualizace progresu z reálných dat Twitche (GQL s fallbackem na Inventory)
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
                        gql_drop: Drop | None = self._twitch._drops.get(session.drop_id)
                        
                        if gql_drop is not None and gql_drop.is_drop_earnable:
                            gql_drop.update_minutes(session.current_minutes_watched)
                            self.current_drop = gql_drop

                            # Výpočet procent sjednocen na 0-100%
                            pct = int(gql_drop.progress * 100) if gql_drop.progress <= 1.0 else int(gql_drop.progress)

                            logger.info(
                                "⏱️ [Progress/GQL] %s | Drop: %s | %d/%d min (%d%%)",
                                channel.name,
                                gql_drop.name,
                                gql_drop.current_minutes,
                                gql_drop.required_minutes,
                                pct,
                            )
                            handled = True
                    except ValidationError as err:
                        logger.info("Failed to parse CurrentDropSession GQL payload: %s", err)

                if not handled:
                    active_campaign = self._twitch.inventory_service.get_active_campaign(channel)
                    if active_campaign is not None:
                        if (active_drop := active_campaign.first_drop) is not None:
                            self.current_drop = active_drop
                            if getattr(self._twitch, "gui", None):
                                self._twitch.gui.display_drop(active_drop)

                            pct = int(active_drop.progress * 100) if active_drop.progress <= 1.0 else int(active_drop.progress)

                            logger.info(
                                "⏱️ [Progress/Fallback] %s | Drop: %s | %d/%d min (%d%%)",
                                channel.name,
                                active_drop.name,
                                active_drop.current_minutes,
                                active_drop.required_minutes,
                                pct,
                            )
                        else:
                            logger.info("⏱️ [Progress/Fallback] %s | Hra: %s (Neznámý drop)", channel.name, active_campaign.game)
                        handled = True
                    else:
                        logger.info("No active drop could be determined for channel %s", channel.name)

                # 5. Čekání do konce minutového intervalu
                await self.watch_sleep(interval - min(time() - last_sent, interval))
            
    async def bulk_check_online(
        self,
        channels: abc.Iterable[Channel],
        batch_size: int = 30,
        max_concurrent: int = 6,
    ) -> None:
        """
        Vysoce efektivní a stabilní kontrola stavu kanálů.
        Sdružuje `batch_size` GQL dotazů do 1 HTTP požadavku a omezuje 
        počet souběžných HTTP spojení na `max_concurrent`.
        """
        channel_list = [c for c in channels if c is not None]
        total_channels = len(channel_list)
        if not total_channels:
            return

        # 1. Rozdělení kanálů do dávek (po batch_size)
        channel_chunks = list(chunk(channel_list, batch_size))
        total_chunks = len(channel_chunks)

        logger.info(
            "🚀 [BulkCheck] Spouštím kontrolu %d kanálů (%d dávek po %d, max %d HTTP dotazů naráz)...",
            total_channels,
            total_chunks,
            batch_size,
            max_concurrent,
        )

        acl_streams_map: dict[int, JsonType] = {}
        semaphore = asyncio.Semaphore(max_concurrent)
        processed_chunks = 0

        # 2. Izolovaná pracovní jednotka pro zpracování jedné dávky pod semaforem
        async def _process_chunk(batch: list[Channel]) -> list[JsonType]:
            nonlocal processed_chunks
            gql_ops: list[GQLRequest] = [ch.stream_gql for ch in batch]

            async with semaphore:
                try:
                    response = await self._twitch.gql_request(gql_ops)
                    return response if isinstance(response, list) else [response]
                except Exception as exc:
                    logger.warning("⚠️ [BulkCheck] Dávka s %d kanály selhala: %s", len(batch), exc)
                    return []
                finally:
                    processed_chunks += 1
                    if processed_chunks % 5 == 0 or processed_chunks == total_chunks:
                        logger.info(
                            "⏳ [BulkCheck] Dokončeno %d/%d dávek (%.1f %%)",
                            processed_chunks,
                            total_chunks,
                            (processed_chunks / total_chunks) * 100,
                        )

        # 3. Paralelní spuštění dávek
        results = await asyncio.gather(*[_process_chunk(b) for b in channel_chunks])

        # 4. Sestavení mapy s explicitním převodem ID na int
        for batch_results in results:
            for response_json in batch_results:
                if not isinstance(response_json, dict):
                    continue

                data = response_json.get("data")
                if isinstance(data, dict):
                    user_data = data.get("user")
                    if isinstance(user_data, dict) and "id" in user_data:
                        try:
                            acl_streams_map[int(user_data["id"])] = user_data
                        except (ValueError, TypeError):
                            pass

        logger.info(
            "📊 [BulkCheck] Vráceno %d odpovědí ze %d testovaných kanálů.",
            len(acl_streams_map),
            total_channels,
        )

        # 5. Aktualizace stavu kanálů s předáním inventáře a ošetřením chyb
        online_count = 0
        for channel in channel_list:
            try:
                cid = int(channel.id)
            except (ValueError, TypeError):
                cid = channel.id

            if cid in acl_streams_map:
                channel_data = acl_streams_map[cid]
                try:
                    channel.external_update(channel_data, self._twitch.inventory)
                except Exception as exc:
                    logger.error("❌ [Error] Selhalo zpracování kanálu %s: %s", getattr(channel, "name", cid), exc)
                    channel.online = False
            else:
                channel.online = False

            if channel.online:
                online_count += 1

        logger.info(
            "✅ [BulkCheck] Hotovo. Zkontrolováno %d kanálů -> %d ONLINE, %d OFFLINE.",
            total_channels,
            online_count,
            total_channels - online_count,
        )
        
    async def get_live_streams(
        self, game: Game, *, limit: int = 20, drops_enabled: bool = True
    ) -> list[Channel]:
        """Fetch live streams for a specific game from Twitch directory."""
        filters: list[str] = []
        if drops_enabled:
            filters.append("DROPS_ENABLED")

        try:
            response = await self._twitch.gql_request(
                GQL_OPERATIONS["GameDirectory"].with_variables(
                    {
                        "limit": limit,
                        "slug": game.slug,
                        "options": {
                            "includeRestricted": ["SUB_ONLY_LIVE"],
                            "systemFilters": filters,
                        },
                    }
                )
            )
        except GQLException as exc:
            raise MinerException(f"Game: {game.slug}") from exc

        # Defenzivní kontrola obsahu odpovědi
        if isinstance(response, dict) and response.get("data"):
            game_data = response["data"].get("game")
            if game_data and "streams" in game_data and game_data["streams"]:
                edges = game_data["streams"].get("edges", [])
                return [
                    Channel.from_directory(
                        self._twitch,
                        stream_channel_data["node"],
                        drops_enabled=drops_enabled,
                    )
                    for stream_channel_data in edges
                    if isinstance(stream_channel_data, dict)
                    and stream_channel_data.get("node", {}).get("broadcaster") is not None
                ]
        return []
