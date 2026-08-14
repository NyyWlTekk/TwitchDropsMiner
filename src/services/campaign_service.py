from __future__ import annotations

import asyncio
from collections import deque
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from src.api import GQLClient
from src.config import GQL_OPERATIONS, State
from src.i18n import _
from src.models.models import DropsCampaign
from src.utils import chunk

if TYPE_CHECKING:
    from src.config import JsonType
    from src.core.client import Twitch
    from src.models.models import Channel

logger = logging.getLogger("TwitchDrops")
HISTORY_FILE = Path("data/claimed_history.json")


# ============================================================================
# 2. INVENTORY FETCHER (GQL Komunikace)
# ============================================================================
class InventoryFetcher:
    """
    Služba starající se o přímé GQL dotazy na Twitch API.
    """

    def __init__(self, twitch: Twitch) -> None:
        self._twitch = twitch

    async def fetch_user_badges(self) -> set[str]:
        """Načte profilové odznaky a získané odměny uživatele."""
        badges: set[str] = set()
        gql_payload = {
            "operationName": "UserBadgesAndInventory",
            "query": """
            query UserBadgesAndInventory {
              currentUser {
                id
                displayBadges { id setID title }
                inventory { gameEventDrops { id name } }
              }
            }
            """,
            "variables": {},
        }

        try:
            response = await self._twitch.gql_request(gql_payload)
            data = response.get("data", response) if isinstance(response, dict) else {}
            current_user = data.get("currentUser") or {}

            for badge in current_user.get("displayBadges") or []:
                if not isinstance(badge, dict):
                    continue
                if badge.get("id"):
                    badges.add(str(badge["id"]).lower().strip())
                if badge.get("setID"):
                    badges.add(str(badge["setID"]).lower().strip())
                if badge.get("title"):
                    # Přímá sanitace bez závislosti na CampaignSanitizer
                    clean_title = str(badge["title"]).lower().strip()
                    if len(clean_title) > 2:
                        badges.add(clean_title)

            inventory = current_user.get("inventory") or {}
            for drop in inventory.get("gameEventDrops") or []:
                if not isinstance(drop, dict):
                    continue
                if drop.get("id"):
                    badges.add(str(drop["id"]).lower().strip())
                if drop.get("name"):
                    badges.add(str(drop["name"]).lower().strip())

            logger.info("Načteno %d uživatelských odznaků/odměn přes GQL.", len(badges))
        except Exception as e:
            logger.error("Chyba při dotazu na uživatelské odznaky (GQL): %s", e)

        return badges

    async def fetch_user_emotes(self) -> set[str]:
        """Načte všechny emoty uživatele."""
        emotes: set[str] = set()
        gql_payload = {
            "operationName": "EmotePicker_UserEmotes",
            "query": """
            query EmotePicker_UserEmotes {
              currentUser {
                id
                emoteSets { id emotes { id token } }
              }
            }
            """,
            "variables": {},
        }

        try:
            response = await self._twitch.gql_request(gql_payload)
            data = response.get("data", response) if isinstance(response, dict) else {}
            current_user = data.get("currentUser") or {}

            for emote_set in current_user.get("emoteSets") or []:
                if not isinstance(emote_set, dict):
                    continue
                for emote in emote_set.get("emotes") or []:
                    if not isinstance(emote, dict):
                        continue
                    
                    if emote.get("id"):
                        emotes.add(str(emote["id"]).lower().strip())
                    
                    token = emote.get("token") or emote.get("name")
                    if token:
                        clean_name = str(token).lower().strip()
                        if len(clean_name) > 2:
                            emotes.add(clean_name)

            logger.info("Načteno %d uživatelských emotů přes GQL.", len(emotes))
        except Exception as e:
            logger.error("Chyba při dotazu na uživatelské emoty (GQL): %s", e)

        return emotes

    async def fetch_raw_inventory(self) -> dict[str, Any]:
        """Stáhne surový inventář."""
        response = await self._twitch.gql_request(GQL_OPERATIONS["Inventory"])
        data = response.get("data", response) if isinstance(response, dict) else {}
        user_data = data.get("currentUser", data) if isinstance(data, dict) else {}
        return user_data.get("inventory", {}) if isinstance(user_data, dict) else {}

    async def fetch_campaign_details(
        self, campaigns_chunk: list[tuple[str, JsonType]]
    ) -> dict[str, JsonType]:
        """Stáhne detaily kampaní pro zadanou dávku (chunk)."""
        campaign_ids: dict[str, JsonType] = dict(campaigns_chunk)
        auth_state = await self._twitch.get_auth()
        user_identifier = getattr(auth_state, "username", str(auth_state.user_id))

        response_list_raw = await self._twitch.gql_request(
            [
                GQL_OPERATIONS["CampaignDetails"].with_variables(
                    {"channelLogin": str(user_identifier), "dropID": cid}
                )
                for cid in campaign_ids
            ]
        )

        response_list: list[JsonType] = (
            response_list_raw if isinstance(response_list_raw, list) else [response_list_raw]
        )

        fetched_data: dict[str, JsonType] = {}
        for response_json in response_list:
            if not isinstance(response_json, dict):
                continue
            data = response_json.get("data") or {}
            user_data = data.get("user") or {}
            campaign_data = user_data.get("dropCampaign") or data.get("dropCampaign")

            if campaign_data and "id" in campaign_data:
                fetched_data[campaign_data["id"]] = campaign_data

        return GQLClient.merge_data(campaign_ids, fetched_data)


# ============================================================================
# 3. INVENTORY COORDINATOR (Hlavní řídící třída)
# ============================================================================
class InventoryCoordinator:
    """
    Hlavní koordinátor inventáře a správy kampaní.

    Řídí celý životní cyklus:
    1. Koordinace stahování přes InventoryFetcher
    2. Předávání dat k sanitaci přes CampaignSanitizer
    3. Aktualizace vnitřního stavu Twitch klienta a GUI
    4. Řízení událostí a přechodů mezi stavy (State Machine)
    """

    def __init__(self, twitch: Twitch) -> None:
        self._twitch = twitch
        self._fetcher = InventoryFetcher(twitch)
        self.user_emotes: set[str] = set()
        self.user_badges: set[str] = set()

    # --- KOORDINACE ÚLOH A WORKFLOW ---

    async def fetch_inventory(self) -> None:
        """Kompletní synchronizační workflow inventáře, odznaků a kampaní."""
        self._update_status(_.t["gui"]["status"]["fetching_inventory"])

        # 1. Stažení a synchronizace assetů
        user_emotes, user_badges = await self._sync_user_assets()

        # 2. Získání surových dat a příprava množiny claimed ID
        inventory_raw = await self._fetcher.fetch_raw_inventory()
        claimed_map, all_claimed_ids = self._extract_claimed_ids(
            inventory_raw, user_emotes, user_badges
        )

        # 3. Parsování a dotažení veřejných kampaní v dávkách
        inventory_data = self._parse_ongoing_campaigns(inventory_raw)
        await self._fetch_and_merge_available_campaigns(inventory_data)

        # 4. Sanitace, stavba modelů a seřazení
        campaigns = self._build_and_sort_campaigns(
            inventory_data, claimed_map, all_claimed_ids
        )

        # 5. Aplikace stavu a naplánování údržby
        await self._apply_inventory_to_state(campaigns)
        self._schedule_maintenance_tasks()

    async def process_inventory_fetch(self) -> None:
        """Vyvolá obnovu inventáře, upozorní GUI a přepne stav na GAMES_UPDATE."""
        await self._twitch.websocket.start()
        await self.fetch_inventory()

        gui = getattr(self._twitch, "gui", None)
        if gui:
            gui.set_games(
                {campaign.game for campaign in self._twitch.inventory if campaign.game}
            )
            gui.status.update("Campaigns reloaded successfully")
            if hasattr(gui, "_broadcaster") and hasattr(gui._broadcaster, "emit"):
                try:
                    await gui._broadcaster.emit("reload_complete", {})
                except Exception as e:
                    logger.debug("Failed to emit reload_complete: %s", e)

        # Přepnutí stavu v aplikaci
        self._twitch.change_state(State.GAMES_UPDATE)

    def get_active_campaign(self, channel: Channel | None = None) -> DropsCampaign | None:
        """Určí aktivní kampaň pro daný kanál."""
        if not self._twitch.wanted_games:
            return None

        watching_channel = self._twitch.watching_channel.get_with_default(channel)
        if watching_channel is None:
            return None

        campaigns: list[DropsCampaign] = [
            campaign
            for campaign in self._twitch.inventory
            if campaign.can_earn(watching_channel)
        ]

        if campaigns:
            campaigns.sort(key=lambda c: c.remaining_minutes)
            return campaigns[0]

        return None

    # --- INTERNÍ HELPERY KOORDINÁTORA ---

    async def _sync_user_assets(self) -> tuple[set[str], set[str]]:
        """Koordinuje načtení a uložení uživatelských emotů a odznaků."""
        emotes = await self._fetcher.fetch_user_emotes()
        badges = await self._fetcher.fetch_user_badges()

        self._twitch.user_emotes = emotes
        self._twitch.user_badges = badges
        self.user_emotes = emotes
        self.user_badges = badges

        logger.info(
            "[Inventory] Synchronizováno %d emotů a %d odznaků do systémového stavu.",
            len(emotes),
            len(badges),
        )
        return emotes, badges

    def _extract_claimed_ids(
        self,
        inventory_raw: dict[str, Any],
        user_emotes: set[str],
        user_badges: set[str],
    ) -> tuple[dict[str, datetime], set[str]]:
        """Sestaví množinu všech získaných ID pro name matching sanitaci."""
        claimed_map: dict[str, datetime] = {}
        all_claimed_ids: set[str] = set()

        now_utc = datetime.now(timezone.utc)
        game_event_drops = inventory_raw.get("gameEventDrops") or []
        for drop in game_event_drops:
            if isinstance(drop, dict) and drop.get("id"):
                drop_id = str(drop["id"]).lower().strip()
                claimed_map[drop_id] = now_utc

        all_claimed_ids.update(claimed_map.keys())
        all_claimed_ids.update(user_emotes)
        all_claimed_ids.update(user_badges)

        return claimed_map, all_claimed_ids

    def _parse_ongoing_campaigns(self, inventory: dict[str, Any]) -> dict[str, JsonType]:
        """Vytáhne probíhající kampaně z inventáře."""
        ongoing = inventory.get("dropCampaignsInProgress") or []
        return {c["id"]: c for c in ongoing if isinstance(c, dict) and "id" in c}

    async def _fetch_and_merge_available_campaigns(
        self, inventory_data: dict[str, JsonType]
    ) -> None:
        """Koordinuje stažení všech dostupných kampaní v dávkách."""
        response = await self._twitch.gql_request(GQL_OPERATIONS["Campaigns"])
        c_data = response.get("data", response) if isinstance(response, dict) else {}
        c_user_data = c_data.get("currentUser", c_data) if isinstance(c_data, dict) else {}
        available_list = c_user_data.get("dropCampaigns") or []

        available_campaigns = {
            c["id"]: c
            for c in available_list
            if isinstance(c, dict) and c.get("status") in ("ACTIVE", "UPCOMING")
        }

        self._update_status(_.t["gui"]["status"]["fetching_campaigns"])

        fetch_tasks = [
            asyncio.create_task(self._fetcher.fetch_campaign_details(chunk_data))
            for chunk_data in chunk(available_campaigns.items(), 20)
        ]
        logger.info(
            "Inventory fetched: %d total campaigns available.", len(available_list)
        )

        try:
            for coro in asyncio.as_completed(fetch_tasks):
                chunk_campaigns = await coro
                inventory_data.update(chunk_campaigns)
        except Exception:
            for task in fetch_tasks:
                task.cancel()
            await asyncio.gather(*fetch_tasks, return_exceptions=True)
            raise

    def _build_and_sort_campaigns(
        self,
        inventory_data: dict[str, JsonType],
        claimed_map: dict[str, datetime],
        all_claimed_ids: set[str],
    ) -> list[DropsCampaign]:
        """Sestaví a seřadí doménové objekty DropsCampaign ze surových dat."""
        campaigns: list[DropsCampaign] = []

        for cid, camp_dict in inventory_data.items():
            if not isinstance(camp_dict, dict):
                continue

            # Předáváme přímo surový slovník z GQL API
            campaigns.append(
                DropsCampaign.from_json(self._twitch, camp_dict, claimed_map)
            )

        campaigns.sort(
            key=lambda c: (
                not c.eligible,
                not c.active,
                c.starts_at if c.upcoming else c.ends_at,
            )
        )

        return campaigns
    
    async def _apply_inventory_to_state(self, campaigns: list[DropsCampaign]) -> None:
        """Aplikuje zpracované kampaně do vnitřního stavu Twitch klienta a GUI."""
        self._twitch._drops.clear()
        self._twitch.inventory.clear()
        self._twitch._mnt_triggers.clear()

        switch_triggers: set[datetime] = set()

        for campaign in campaigns:
            for drop in campaign.drops:
                drop.sync_minutes(drop.current_minutes)

            self._twitch._drops.update({drop.id: drop for drop in campaign.drops})
            if campaign.can_earn_within():
                switch_triggers.update(campaign.time_triggers)

            self._twitch.inventory.append(campaign)
            self._twitch._campaigns[campaign.id] = campaign

        # Převedeme na deque, aby fungoval .popleft()
        self._twitch._mnt_triggers = deque(sorted(switch_triggers))

        gui = getattr(self._twitch, "gui", None)
        if gui and hasattr(gui, "inventory"):
            gui.inventory.update(campaigns)

    def _schedule_maintenance_tasks(self) -> None:
        """Spravuje časovače a naplánuje údržbový task."""
        now = datetime.now(timezone.utc)
        while self._twitch._mnt_triggers and self._twitch._mnt_triggers[0] <= now:
            self._twitch._mnt_triggers.popleft()

        if self._twitch._mnt_task is not None and not self._twitch._mnt_task.done():
            self._twitch._mnt_task.cancel()

        self._twitch._mnt_task = asyncio.create_task(
            self._twitch._maintenance_service.run_maintenance_task()
        )

    def _update_status(self, msg: str) -> None:
        """Aktualizace stavového řádku v GUI."""
        gui = getattr(self._twitch, "gui", None)
        if gui and getattr(gui, "status", None):
            try:
                gui.status.update(msg)
            except Exception:
                pass
