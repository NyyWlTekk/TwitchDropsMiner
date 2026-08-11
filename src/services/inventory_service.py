from __future__ import annotations

import asyncio
import json
import logging
import aiohttp
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from dateutil.parser import isoparse

from src.api import GQLClient
from src.config import GQL_OPERATIONS, State
from src.exceptions import ExitRequest
from src.i18n import _
from src.models.campaign import DropsCampaign
from src.utils import chunk


if TYPE_CHECKING:
    from src.config import JsonType
    from src.core.client import Twitch
    from src.models.channel import Channel


logger = logging.getLogger("TwitchDrops")
HISTORY_FILE = Path("data/claimed_history.json")


def load_local_history() -> set[str]:
    """Načte ID z lokální pojistky (claimed_history.json)."""
    if HISTORY_FILE.exists():
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                return set(json.load(f))
        except Exception as e:
            logger.error("Chyba při načítání lokální historie: %s", e)
    return set()


def save_to_history(item_ids: set[str] | list[str] | str) -> None:
    """Uloží získaná/sanovaná ID do lokální pojistky."""
    if isinstance(item_ids, str):
        item_ids = [item_ids]

    history = load_local_history()
    history.update(str(i) for i in item_ids if i)

    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(sorted(list(history)), f, indent=2)
    except Exception as e:
        logger.error("Chyba při zápisu do lokální historie: %s", e)


class InventoryService:
    """
    Service responsible for inventory and campaign management.

    Handles:
    - Fetching campaign details from GraphQL
    - Fetching inventory (in-progress campaigns)
    - Determining active campaign for a channel
    - Managing campaign data and claimed benefits
    """

    def __init__(self, twitch: Twitch) -> None:
        """
        Initialize the inventory service.

        Args:
            twitch: The Twitch client instance
        """
        self._twitch = twitch

    def _merge_campaign_progress(
        self, existing: dict[str, Any], incoming: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Bezpečně sloučí detailní data kampaně z CampaignDetails s probíhajícím
        pokrokem uživatele z dropCampaignsInProgress tak, aby nedošlo ke ztrátě minut.
        """
        merged = {**existing, **incoming}

        # Získáme existující dropy podle ID pro zachování 'self'
        existing_drops = {
            str(d["id"]): d
            for d in existing.get("timeBasedDrops", [])
            if isinstance(d, dict) and "id" in d
        }
        incoming_drops = incoming.get("timeBasedDrops", []) or []

        merged_drops = []
        for inc_drop in incoming_drops:
            if not isinstance(inc_drop, dict):
                continue

            drop_id = str(inc_drop.get("id") or "")
            ex_drop = existing_drops.get(drop_id, {})

            ex_self = ex_drop.get("self") if isinstance(ex_drop.get("self"), dict) else {}
            inc_self = inc_drop.get("self") if isinstance(inc_drop.get("self"), dict) else {}

            # Sloučení 'self' – přednost má pokrok s naměřenými minutami
            merged_self = {**inc_self}
            for key, val in ex_self.items():
                if val is not None and (
                    key not in merged_self
                    or merged_self[key] is None
                    or merged_self[key] == 0
                ):
                    merged_self[key] = val

            combined_drop = {**inc_drop, "self": merged_self}

            if ex_drop.get("isClaimed"):
                combined_drop["isClaimed"] = True

            merged_drops.append(combined_drop)

        merged["timeBasedDrops"] = merged_drops
        return merged

    def _sanitize_campaign_dict(
        self,
        campaign_data: dict,
        claimed_benefit_ids: set[str],
        desync_log: list[dict] | None = None,
    ) -> dict:
        if not isinstance(campaign_data, dict):
            return campaign_data

        time_based_drops = campaign_data.get("timeBasedDrops", []) or []
        has_unclaimed_drops = False

        for drop in time_based_drops:
            if not isinstance(drop, dict):
                continue

            api_self = drop.get("self") if isinstance(drop.get("self"), dict) else {}
            api_claimed = bool(drop.get("isClaimed") or api_self.get("isClaimed"))
            api_minutes = api_self.get("currentMinutesWatched", 0)
            req_mins = drop.get("requiredMinutesWatched", 0)

            # Pokud sám Twitch tvrdí, že je claimed, přeskočíme
            if api_claimed:
                continue

            benefits = drop.get("benefitEdges", []) or drop.get("benefits", [])
            drop_should_be_claimed = False
            matched_reason = ""

            for edge in benefits:
                if not isinstance(edge, dict):
                    continue

                benefit_obj = edge.get("benefit", {}) or {}
                b_id = str(benefit_obj.get("id") or "").lower().strip()
                b_name = str(benefit_obj.get("name") or drop.get("name") or "").lower()

                # Normalizace názvu: odstranění závorek, pomlček, podtržítka a slov badge/emote
                clean_name = (
                    b_name.replace("emote", "")
                    .replace("badge", "")
                    .replace("emotes", "")
                    .replace("badges", "")
                    .replace("(", " ")
                    .replace(")", " ")
                    .replace("-", " ")
                    .replace("_", " ")
                )
                clean_name = " ".join(clean_name.split())  # Oříznutí nadbytečných mezer

                is_id_claimed = bool(b_id and b_id in claimed_benefit_ids)
                is_asset_claimed = False

                if not is_id_claimed and clean_name:
                    for token in claimed_benefit_ids:
                        if len(token) <= 2:
                            continue
                        
                        clean_token = (
                            token.replace("(", " ")
                            .replace(")", " ")
                            .replace("-", " ")
                            .replace("_", " ")
                        )
                        clean_token = " ".join(clean_token.split())

                        if clean_name == clean_token or clean_name in clean_token or clean_token in clean_name:
                            is_asset_claimed = True
                            break

                if is_id_claimed or is_asset_claimed:
                    drop_should_be_claimed = True
                    matched_reason = "ID v historii" if is_id_claimed else f"Match názvu: '{clean_name}'"
                    break

            if drop_should_be_claimed:
                # Uložení zjištěného desyncu pro závěrečný report
                if desync_log is not None:
                    desync_log.append({
                        "campaign": campaign_data.get("name", "Neznámá kampaň"),
                        "drop_name": drop.get("name", "Neznámý drop"),
                        "drop_id": drop.get("id", "N/A"),
                        "api_claimed": api_claimed,
                        "api_progress": f"{api_minutes}/{req_mins}m",
                        "reason": matched_reason,
                    })

                # Aplikace override opravení stavu
                drop["isClaimed"] = True
                if "self" not in drop or not isinstance(drop["self"], dict):
                    drop["self"] = {}

                drop["self"]["isClaimed"] = True
                drop["self"]["currentMinutesWatched"] = req_mins
                drop["self"]["dropInstanceID"] = drop["self"].get("dropInstanceID") or "SANITIZED_CLAIMED"
            else:
                has_unclaimed_drops = True

        # Pokud kampaň nemá žádné nevyzvednuté dropy, označíme ji celou jako dokončenou
        if not has_unclaimed_drops:
            campaign_data["isClaimed"] = True
            if "self" in campaign_data and isinstance(campaign_data["self"], dict):
                campaign_data["self"]["isClaimed"] = True
        else:
            campaign_data["isClaimed"] = False
            if "self" in campaign_data and isinstance(campaign_data["self"], dict):
                campaign_data["self"]["isClaimed"] = False

        return campaign_data

    async def fetch_campaigns(
        self, campaigns_chunk: list[tuple[str, JsonType]]
    ) -> dict[str, JsonType]:
        campaign_ids: dict[str, JsonType] = dict(campaigns_chunk)
        auth_state = await self._twitch.get_auth()

        # Use username/login if available, otherwise fallback to user_id
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

            # Fallback handling: data can be directly under dropCampaign or under user.dropCampaign
            campaign_data = user_data.get("dropCampaign") or data.get("dropCampaign")

            if campaign_data and "id" in campaign_data:
                fetched_data[campaign_data["id"]] = campaign_data

        return GQLClient.merge_data(campaign_ids, fetched_data)

    async def _fetch_user_badges(self) -> set[str]:
        """Načte profilové odznaky a ID/názvy všech získaných odměn z inventáře."""
        badges: set[str] = set()

        gql_payload = {
            "operationName": "UserBadgesAndInventory",
            "query": """
            query UserBadgesAndInventory {
              currentUser {
                id
                displayBadges {
                  id
                  setID
                  title
                }
                inventory {
                  gameEventDrops {
                    id
                    name
                  }
                }
              }
            }
            """,
            "variables": {},
        }

        try:
            response = await self._twitch.gql_request(gql_payload)
            data = response.get("data", response) if isinstance(response, dict) else {}
            current_user = data.get("currentUser") or {}

            # 1. Připnuté profilové/chatové odznaky (displayBadges)
            display_badges = current_user.get("displayBadges") or []
            for badge in display_badges:
                if not isinstance(badge, dict):
                    continue

                if badge.get("id"):
                    badges.add(str(badge["id"]).lower().strip())

                if badge.get("setID"):
                    badges.add(str(badge["setID"]).lower().strip())

                if badge.get("title"):
                    clean_title = (
                        str(badge["title"])
                        .lower()
                        .replace("badge", "")
                        .replace("badges", "")
                        .strip()
                    )
                    if len(clean_title) > 2:
                        badges.add(clean_title)

            # 2. Všechny získané položky/odznaky z inventáře (gameEventDrops)
            inventory = current_user.get("inventory") or {}
            event_drops = inventory.get("gameEventDrops") or []
            
            for drop in event_drops:
                if not isinstance(drop, dict):
                    continue

                d_id = drop.get("id")
                d_name = drop.get("name")

                if d_id:
                    badges.add(str(d_id).lower().strip())
                if d_name:
                    badges.add(str(d_name).lower().strip())

            logger.info("Načteno %d uživatelských odznaků/odměn přes GQL.", len(badges))
        except Exception as e:
            logger.error("Chyba při dotazu na uživatelské odznaky (GQL): %s", e)

        return badges

    async def _fetch_user_emotes(self) -> set[str]:
        """Načte všechny dostupné emoty uživatele přes Twitch GQL."""
        emotes: set[str] = set()

        gql_payload = {
            "operationName": "EmotePicker_UserEmotes",
            "query": """
            query EmotePicker_UserEmotes {
              currentUser {
                id
                emoteSets {
                  id
                  emotes {
                    id
                    token
                  }
                }
              }
            }
            """,
            "variables": {},
        }

        try:
            response = await self._twitch.gql_request(gql_payload)
            data = response.get("data", response) if isinstance(response, dict) else {}
            current_user = data.get("currentUser") or {}
            emote_sets = current_user.get("emoteSets") or []

            for emote_set in emote_sets:
                if not isinstance(emote_set, dict):
                    continue
                for emote in (emote_set.get("emotes") or []):
                    if not isinstance(emote, dict):
                        continue
                    # Uložíme ID emotu
                    if "id" in emote:
                        emotes.add(str(emote["id"]).lower().strip())
                    
                    # V Twitch GQL je textový název emotu v políčku 'token'
                    token = emote.get("token") or emote.get("name")
                    if token:
                        clean_name = str(token).lower().strip()
                        if len(clean_name) > 2:
                            emotes.add(clean_name)

            logger.info("Načteno %d uživatelských emotů přes GQL.", len(emotes))
        except Exception as e:
            logger.error("Chyba při dotazu na uživatelské emoty (GQL): %s", e)

        return emotes

    async def fetch_inventory(self) -> None:
        """
        Fetch the complete inventory including campaigns, drops, user emotes, and badges.
        """
        # Bezpečný obal pro status update (funguje s GUI i v headless testech)
        def status_update(msg: str) -> None:
            if getattr(self._twitch, "gui", None) and getattr(self._twitch.gui, "status", None):
                try:
                    self._twitch.gui.status.update(msg)
                except Exception:
                    pass

        status_update(_.t["gui"]["status"]["fetching_inventory"])

        # 1. NAČTENÍ EMOTŮ A ODZNAKŮ Z GQL
        user_emotes: set[str] = await self._fetch_user_emotes()
        user_badges: set[str] = await self._fetch_user_badges()

        # 📌 ULOŽENÍ DO ATRIBUTŮ (Pro přístup z BaseDrop a dalších služeb)
        self._twitch.user_emotes = user_emotes
        self._twitch.user_badges = user_badges
        self.user_emotes = user_emotes
        self.user_badges = user_badges

        logger.info(
            "[Inventory] Synchronizováno %d emotů a %d odznaků do systémového stavu.",
            len(user_emotes),
            len(user_badges),
        )

        # Fetch in-progress campaigns (inventory)
        response = await self._twitch.gql_request(GQL_OPERATIONS["Inventory"])
        data = response.get("data", response) if isinstance(response, dict) else {}
        user_data = data.get("currentUser", data) if isinstance(data, dict) else {}
        inventory: dict[str, Any] = user_data.get("inventory", {}) if isinstance(user_data, dict) else {}

        ongoing_campaigns: list[JsonType] = inventory.get("dropCampaignsInProgress") or []

        # 2. Shromáždíme všechna získaná ID z Twitch inventáře a lokální historie
        claimed_benefits_map: dict[str, datetime] = {
            b["id"]: isoparse(b["lastAwardedAt"])
            for b in (inventory.get("gameEventDrops") or [])
            if isinstance(b, dict) and "id" in b and "lastAwardedAt" in b
        }

        # Načtení lokální historie souboru
        all_claimed_ids: set[str] = {str(item).lower().strip() for item in load_local_history()}
        all_claimed_ids.update(str(k).lower().strip() for k in claimed_benefits_map.keys())
        
        # PROPOJENÍ: Přidáme všechny načtené emoty i odznaky z GQL do celkové množiny
        all_claimed_ids.update(user_emotes)
        all_claimed_ids.update(user_badges)

        # 3. Vytáhneme ID i NÁZVY přímo z gameEventDrops pro Name-Matching v sanitaci
        for drop in (inventory.get("gameEventDrops") or []):
            if not isinstance(drop, dict):
                continue

            # Přidání ID dropu / benefitu
            b_id = drop.get("id") or drop.get("benefitID")
            if b_id:
                all_claimed_ids.add(str(b_id).lower().strip())

            # Přidání ošetřeného názvu dropu
            d_name = (
                str(drop.get("name") or "")
                .lower()
                .replace("emote", "")
                .replace("badge", "")
                .replace("emotes", "")
                .replace("badges", "")
                .strip()
            )
            if len(d_name) > 2:
                all_claimed_ids.add(d_name)

            # Procházení pod-benefitů
            for benefit in (drop.get("benefits") or []):
                if isinstance(benefit, dict):
                    if "id" in benefit:
                        all_claimed_ids.add(str(benefit["id"]).lower().strip())
                    
                    b_name = (
                        str(benefit.get("name") or "")
                        .lower()
                        .replace("emote", "")
                        .replace("badge", "")
                        .replace("emotes", "")
                        .replace("badges", "")
                        .strip()
                    )
                    if len(b_name) > 2:
                        all_claimed_ids.add(b_name)

        inventory_data: dict[str, JsonType] = {
            c["id"]: c for c in ongoing_campaigns if isinstance(c, dict) and "id" in c
        }

        # Fetch general available campaigns data (campaigns)
        response_campaigns = await self._twitch.gql_request(GQL_OPERATIONS["Campaigns"])
        c_data = response_campaigns.get("data", response_campaigns) if isinstance(response_campaigns, dict) else {}
        c_user_data = c_data.get("currentUser", c_data) if isinstance(c_data, dict) else {}
        available_list: list[JsonType] = c_user_data.get("dropCampaigns") or []

        applicable_statuses = ("ACTIVE", "UPCOMING")
        available_campaigns: dict[str, JsonType] = {
            c["id"]: c
            for c in available_list
            if isinstance(c, dict) and c.get("status") in applicable_statuses
        }

        # Fetch detailed data for each campaign, in chunks
        status_update(_.t["gui"]["status"]["fetching_campaigns"])
        fetch_campaigns_tasks: list[asyncio.Task[Any]] = [
            asyncio.create_task(self.fetch_campaigns(campaigns_chunk))
            for campaigns_chunk in chunk(available_campaigns.items(), 20)
        ]
        logger.info("Inventory fetched: %d total campaigns available from Twitch.", len(available_list))

        try:
            for coro in asyncio.as_completed(fetch_campaigns_tasks):
                chunk_campaigns_data = await coro
                # Šetrné sloučení: namísto GQLClient.merge_data chránícího před přepsáním pokroku minut
                for cid, fetched_camp in chunk_campaigns_data.items():
                    if cid in inventory_data:
                        inventory_data[cid] = self._merge_campaign_progress(
                            inventory_data[cid], fetched_camp
                        )
                    else:
                        inventory_data[cid] = fetched_camp
        except Exception:
            for task in fetch_campaigns_tasks:
                task.cancel()
            raise

        # Filter out invalid campaigns and sanitize in-place
        for campaign_id in list(inventory_data.keys()):
            if not isinstance(inventory_data[campaign_id], dict):
                del inventory_data[campaign_id]
                continue

            if inventory_data[campaign_id].get("game") is None:
                inventory_data[campaign_id]["game"] = {
                    "id": "special_event",
                    "name": inventory_data[campaign_id].get("name", "Special Events")
                }

            # VYČIŠTĚNÍ přímo v hlavním objektu před předáním do DropsCampaign
            inventory_data[campaign_id] = self._sanitize_campaign_dict(
                inventory_data[campaign_id], all_claimed_ids
            )

        # Vytvořit instance DropsCampaign z vyčištěných dat
        campaigns: list[DropsCampaign] = [
            DropsCampaign(
                self._twitch,
                campaign_data,
                claimed_benefits_map,
            )
            for campaign_data in inventory_data.values()
        ]

        campaigns.sort(key=lambda c: c.active, reverse=True)
        campaigns.sort(key=lambda c: c.upcoming and c.starts_at or c.ends_at)
        campaigns.sort(key=lambda c: c.eligible, reverse=True)

        self._twitch._drops.clear()
        self._twitch.gui.inv.clear()
        self._twitch.inventory.clear()
        self._twitch._mnt_triggers.clear()
        switch_triggers: set[datetime] = set()
        next_hour = datetime.now(timezone.utc) + timedelta(hours=1)

        # Add the campaigns to the internal inventory
        for campaign in campaigns:
            for drop in campaign.drops:
                drop.sync_minutes(drop.current_minutes)

            self._twitch._drops.update({drop.id: drop for drop in campaign.drops})
            if campaign.can_earn_within(next_hour):
                switch_triggers.update(campaign.time_triggers)
            self._twitch.inventory.append(campaign)
            self._twitch._campaigns[campaign.id] = campaign

        # Concurrently add the campaigns into the GUI
        status_update(
            _.t["gui"]["status"]["adding_campaigns"].format(counter=f"(0/{len(campaigns)})")
        )
        add_campaign_tasks: list[asyncio.Task[None]] = [
            asyncio.create_task(self._twitch.gui.inv.add_campaign(campaign))
            for campaign in campaigns
        ]

        try:
            for i, coro in enumerate(asyncio.as_completed(add_campaign_tasks), start=1):
                await coro
                status_update(
                    _.t["gui"]["status"]["adding_campaigns"].format(
                        counter=f"({i}/{len(campaigns)})"
                    )
                )
                if self._twitch._state == State.EXIT:
                    raise ExitRequest()
        except Exception:
            for task in add_campaign_tasks:
                task.cancel()
            raise

        self._twitch._mnt_triggers.extend(sorted(switch_triggers))

        now = datetime.now(timezone.utc)
        while self._twitch._mnt_triggers and self._twitch._mnt_triggers[0] <= now:
            self._twitch._mnt_triggers.popleft()

        if self._twitch._mnt_task is not None and not self._twitch._mnt_task.done():
            self._twitch._mnt_task.cancel()
        self._twitch._mnt_task = asyncio.create_task(
            self._twitch._maintenance_service.run_maintenance_task()
        )

    def get_active_campaign(self, channel: Channel | None = None) -> DropsCampaign | None:
        """
        Determine the active campaign for a given channel (or watching channel).
        """
        if not self._twitch.wanted_games:
            return None

        watching_channel = self._twitch.watching_channel.get_with_default(channel)
        if watching_channel is None:
            return None

        campaigns: list[DropsCampaign] = []
        for campaign in self._twitch.inventory:
            if campaign.can_earn(watching_channel):
                campaigns.append(campaign)

        if campaigns:
            campaigns.sort(key=lambda c: c.remaining_minutes)
            return campaigns[0]

        return None
