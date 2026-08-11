from __future__ import annotations

import logging
import re
import asyncio
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from dateutil.parser import isoparse

from src.config.constants import MAX_EXTRA_MINUTES
from src.config.operations import GQL_OPERATIONS
from src.exceptions import GQLException
from src.i18n import _
from src.models.benefit import Benefit


if TYPE_CHECKING:
    from src.config.constants import JsonType
    from src.core.client import Twitch
    from src.models.campaign import DropsCampaign
    from src.models.channel import Channel


logger = logging.getLogger("TwitchDrops")
DIMS_PATTERN = re.compile(r"-\d+x\d+(?=\.(?:jpg|png|gif)$)", re.I)
FAILED_DROP_IDS = set()


def remove_dimensions(url: str) -> str:
    """Remove dimension suffix from Twitch image URLs (e.g., -285x380.jpg)."""
    return DIMS_PATTERN.sub("", url)

def resolve_drop_status(
    is_claimed: bool,
    can_claim: bool,
    is_mining: bool,
    is_stuck: bool = False,
    current_minutes: int = 0,
) -> str:
    """Čistá funkce pro unifikované vyhodnocení stavu dropu."""
    if is_claimed:
        return "claimed"
    if can_claim:
        return "ready_to_claim"
    if is_mining:
        return "stuck" if is_stuck else "mining"
    if current_minutes > 0:
        return "in_progress"
    return "queued"


class BaseDrop:
    _failed_claims: dict[str, datetime] = {}

    def __init__(
        self, campaign: DropsCampaign, data: JsonType, claimed_benefits: dict[str, datetime]
    ):
        self._twitch: Twitch = campaign._twitch
        self.id: str = data["id"]
        self.name: str = data["name"]
        self.campaign: DropsCampaign = campaign
        self.benefits: list[Benefit] = [Benefit(b) for b in (data["benefitEdges"] or [])]

        # 🖼️ Extrakce URL obrázku přímo do atributu dropu
        self.image_url: str = ""
        edges = data.get("benefitEdges") or []
        if edges and isinstance(edges, list):
            first_edge = edges[0] or {}
            # Twitch GraphQL posílá URL obrázku v různých klíčích podle verze API
            self.image_url = (
                first_edge.get("imageAssetURL")
                or first_edge.get("imageURL")
                or (first_edge.get("benefit") and first_edge["benefit"].get("imageAssetURL"))
                or (first_edge.get("benefit") and first_edge["benefit"].get("imageURL"))
                or ""
            )

        # Záloha: Pokud by adresa nebyla v raw JSONu, zkusíme ji vytáhnout z prvního vytvořeného Benefit objektu
        if not self.image_url and self.benefits:
            first_benefit = self.benefits[0]
            self.image_url = (
                getattr(first_benefit, "image_url", "")
                or getattr(first_benefit, "image_asset_url", "")
                or getattr(first_benefit, "icon_url", "")
                or ""
            )

        self.starts_at: datetime = isoparse(data["startAt"])
        self.ends_at: datetime = isoparse(data["endAt"])
        self.claim_id: str | None = None
        self.is_claimed: bool = False
        self._is_processing_claim = False
        self.failed_claim = False
        self.claimed_count = 0
        self.is_stuck: bool = False

        # 1. Základní vyhodnocení stavu přímo z odpovedi kampaně
        if "self" in data and data["self"]:
            self.claim_id = data["self"].get("dropInstanceID")
            self.is_claimed = data["self"].get("isClaimed", False)
        else:
            matched_benefits = [
                bid for benefit in self.benefits 
                if (bid := benefit.id) in claimed_benefits
            ]

            if matched_benefits:
                self.is_claimed = True

        # 2. 🔍 Křížová kontrola vůči vlastněným odznakům (788) i emotům (1226)
        if not self.is_claimed:
            # Načteme uložené množiny z _twitch nebo z inventory_service
            user_badges: set[str] = (
                getattr(self._twitch, "user_badges", None)
                or getattr(getattr(self._twitch, "inventory_service", None), "user_badges", None)
                or set()
            )
            user_emotes: set[str] = (
                getattr(self._twitch, "user_emotes", None)
                or getattr(getattr(self._twitch, "inventory_service", None), "user_emotes", None)
                or set()
            )

            # Spojení do jedné kolekce pro bleskové vyhledávání
            owned_items = user_badges | user_emotes

            if owned_items:
                candidates: set[str] = set()

                if self.id:
                    candidates.add(str(self.id).lower().strip())
                if self.name:
                    candidates.add(str(self.name).lower().strip())

                for benefit in self.benefits:
                    b_id = getattr(benefit, "id", None)
                    b_name = getattr(benefit, "name", None)
                    b_code = getattr(benefit, "code", None)

                    if b_id:
                        candidates.add(str(b_id).lower().strip())
                    if b_name:
                        candidates.add(str(b_name).lower().strip())
                    if b_code:
                        candidates.add(str(b_code).lower().strip())

                # Pokud cokoliv z identifikátorů dropu/benefitu už vlastníš, označíme jako vyzvednuté
                if any(cand in owned_items for cand in candidates if cand):
                    self.is_claimed = True

        self.precondition_drops: list[str] = [d["id"] for d in (data["preconditionDrops"] or [])]

    @property
    def can_claim(self) -> bool:
        """Výchozí stav pro obecný drop."""
        return False

    @property
    def current_minutes(self) -> int:
        """Výchozí stav pro obecný drop."""
        return 0

    @property
    def status(self) -> str:
        """Vrací unifikovaný stav dropu pro UI a WebSocket payload."""
        return resolve_drop_status(
            is_claimed=self.is_claimed,
            can_claim=self.can_claim,
            is_mining=self.is_mining,
            is_stuck=self.is_stuck,
            current_minutes=self.current_minutes,
        )

    @property
    def is_mining(self) -> bool:
        """
        ⛏️ Vrací True, pokud aktuálně sledovaný streamer pokrývá kampaň tohoto dropu.
        """
        try:
            tw = self._twitch
            if not tw or self.is_claimed or self.can_claim:
                return False

            campaign = getattr(self, "campaign", None)
            if not campaign or not getattr(campaign, "active", False):
                return False

            # Zjištění aktuálně sledovaného kanálu
            progress = getattr(getattr(tw, "gui", None), "progress", None) or getattr(tw, "progress", None)
            raw_channel = (
                getattr(progress, "_current_channel", None)
                or getattr(tw, "_current_channel", None)
                or getattr(tw, "watching_channel", None)
            )

            current_channel = None
            if raw_channel:
                if hasattr(raw_channel, "_value"):
                    current_channel = raw_channel._value
                elif hasattr(raw_channel, "get_with_default"):
                    current_channel = raw_channel.get_with_default(None)
                else:
                    current_channel = raw_channel

            if not current_channel:
                return False

            # Ověření, zda streamer dává progress do kampaně
            is_eligible = bool(campaign.can_earn(current_channel))
            
            if is_eligible:
                ch_name = getattr(current_channel, "name", None) or getattr(current_channel, "login", None) or str(current_channel)
                logger.info("[MINING] Drop '%s' (ID: %s) is eligible via channel '%s'", self.name, self.id, ch_name)

            return is_eligible

        except Exception as e:
            logger.error("[MINING] Error evaluating drop %s: %s", getattr(self, 'id', 'UNKNOWN'), e)
            return False
        
    @property
    def preconditions_met(self) -> bool:
        campaign = self.campaign
        return all(campaign.timed_drops[pid].is_claimed for pid in self.precondition_drops)

    def _on_state_changed(self) -> None:
        raise NotImplementedError

    def _base_earn_conditions(self) -> bool:
        failed_at = BaseDrop._failed_claims.get(self.id)
        if failed_at:
            if datetime.now(timezone.utc) - failed_at < timedelta(minutes=1):
                return False
            else:
                BaseDrop._failed_claims.pop(self.id, None)

        return (
            self.preconditions_met
            and not self.is_claimed
            and (bool(self.benefits) or self.id in self.campaign.preconditions_chain())
        )

    def _base_can_earn(self) -> bool:
        return (
            self._base_earn_conditions()
            and self.starts_at <= datetime.now(timezone.utc) < self.ends_at
        )

    def _can_earn_within(self, stamp: datetime) -> bool:
        now = datetime.now(timezone.utc)

        # Kampaň/drop musí být aktivní nebo začínat před vypršením limitu (stamp)
        if not (self.starts_at < stamp and self.ends_at > now):
            return False

        time_left_minutes = (self.ends_at - now).total_seconds() / 60
        
        # Výpočet REÁLNĚ zbývajících minut (zohledňuje již získaný progress)
        total_needed = getattr(self, "needed_minutes", 1)
        current_progress = getattr(self, "current_minutes", 0)
        remaining_needed = max(1, total_needed - current_progress)

        # Pokud do konce zbývá méně času, než kolik REÁLNĚ potřebujeme k dokončení, vyřadit
        if time_left_minutes < remaining_needed:
            return False

        return self._base_earn_conditions()

    def can_earn(self, channel: Channel | None = None, ignore_channel_status: bool = False) -> bool:
        return self._base_can_earn() and self.campaign._base_can_earn(
            channel, ignore_channel_status
        )

    @property
    def can_claim(self) -> bool:
        if self.claim_id in FAILED_DROP_IDS:
            return False

        if self.is_claimed or self._is_processing_claim:
            return False
            
        current = getattr(self, "current_minutes", 0)
        required = getattr(self, "required_minutes", 0)
        
        if required <= 0:
            return False

        is_completed = current >= required
        return (
            is_completed
            and self.claim_id is not None
            and datetime.now(timezone.utc) < self.campaign.ends_at + timedelta(hours=24)
        )

    async def generate_claim(self) -> None:
        auth_state = await self.campaign._twitch.get_auth()
        self.claim_id = f"{auth_state.user_id}#{self.campaign.id}#{self.id}"

    def rewards_text(self, delim: str = ", ") -> str:
        return delim.join(benefit.name for benefit in self.benefits)

    def has_wanted_unclaimed_benefits(self, allowed_benefits: dict[str, bool]) -> bool:
        return len(self.get_wanted_unclaimed_benefits(allowed_benefits)) > 0
        
    def get_wanted_unclaimed_benefits(self, allowed_benefits: dict[str, bool]) -> list[str]:
        campaign = getattr(self, "campaign", None)
        if campaign and not getattr(campaign, "linked", True):
            return []
    
        if self.is_claimed:
            return []
        
        return [benefit.name for benefit in self.benefits if benefit.is_wanted(allowed_benefits)]

    async def _claim(self) -> bool:
        """
        API call to claim the drop. Returns True if successful.
        """
        try:
            response = await self._twitch.gql_request(
                GQL_OPERATIONS["ClaimDrop"].with_variables(
                    {"input": {"dropInstanceID": self.claim_id}}
                )
            )
            logger.debug(f"Twitch response for {self.id}: {response}")
        except GQLException as e:
            logger.error(f"GQL exception for drop {self.id}: {e}")
            return False

        if "errors" in response and response["errors"]:
            logger.error(f"Twitch API error for drop {self.id}: {response['errors']}")
            return False

        data = response.get("data") or {}
        if "claimDropRewards" in data and data["claimDropRewards"]:
            status = data["claimDropRewards"].get("status")
            if status in ("ELIGIBLE_FOR_ALL", "DROP_INSTANCE_ALREADY_CLAIMED"):
                return True
            else:
                logger.warning(f"Unsuccessful claim status: {status} for drop {self.id}")

        return False

    async def claim(self) -> bool:
        if self.is_claimed or getattr(self, "_is_processing_claim", False):
            return False

        if not self.can_claim:
            return False

        if self.claim_id is None:
            await self.generate_claim()

        self._is_processing_claim = True
        try:
            success = await self._claim()
            if success:
                self.is_claimed = True

                # 1. Okamžité vyvolání aktualizace stavu pro web/websocket
                self._on_state_changed()

                # Refresh inventory immediately after successful claim
                try:
                    await self._twitch.fetch_inventory()
                except Exception as e:
                    logger.error(f"Failed to refresh inventory after claim: {e}")

                # 2. Bezpečné získání počtu vybraných a celkových dropů (podpora pro metodu i property)
                claimed_count = (
                    self.campaign.claimed_drops() 
                    if callable(getattr(self.campaign, "claimed_drops", None)) 
                    else getattr(self.campaign, "claimed_drops", 0)
                )
                total_count = (
                    self.campaign.total_drops() 
                    if callable(getattr(self.campaign, "total_drops", None)) 
                    else getattr(self.campaign, "total_drops", 0)
                )

                claim_text = f"{self.campaign.game.name}\n{self.rewards_text()} ({claimed_count}/{total_count})"
                self._twitch.print(_.t["status"]["claimed_drop"].format(drop=claim_text.replace("\n", " ")))
                
                BaseDrop._failed_claims.pop(self.id, None)
                return True
            else:
                BaseDrop._failed_claims[self.id] = datetime.now(timezone.utc)
                return False
        except Exception as e:
            logger.error(f"Critical error while claiming drop {self.id}: {e}")
            return False
        finally:
            self._is_processing_claim = False


class TimedDrop(BaseDrop):
    def __init__(
        self, campaign: DropsCampaign, data: JsonType, claimed_benefits: dict[str, datetime]
    ):
        super().__init__(campaign, data, claimed_benefits)
        
        # Získání reálných minut z dat, s ošetřením chybějícího objektu "self"
        self.real_current_minutes: int = (
            data.get("self") and data["self"].get("currentMinutesWatched") or 0
        )
        self.required_minutes: int = data["requiredMinutesWatched"]
        self.extra_current_minutes: int = 0
        
        # Pokud je drop již označen jako claimnutý (např. nalezen v historii),
        # nastavíme rovnou plný počet minut, aby se v aplikaci zobrazil jako hotový (100 %)
        if self.is_claimed:
            self.real_current_minutes = self.required_minutes
            logger.debug(f"[DEBUG TIMED DROP] Forcing real_current_minutes to required ({self.required_minutes}) for claimed drop: {self.name}")

    def __repr__(self) -> str:
        if self.is_claimed:
            additional = ", claimed=True"
        elif self.can_earn():
            additional = ", can_earn=True"
        else:
            additional = ""
        if 0 < self.current_minutes < self.required_minutes:
            minutes = f", {self.current_minutes}/{self.required_minutes}"
        else:
            minutes = ""
        return f"Drop({self.rewards_text()}{minutes}{additional})"

    @property
    def current_minutes(self) -> int:
        return self.real_current_minutes + self.extra_current_minutes

    @property
    def remaining_minutes(self) -> int:
        return self.required_minutes - self.current_minutes

    @property
    def progress(self) -> float:
        if self.current_minutes <= 0 or self.required_minutes <= 0:
            return 0.0
        elif self.current_minutes >= self.required_minutes:
            return 1.0
        return self.current_minutes / self.required_minutes

    @property
    def availability(self) -> float:
        import math
        now = datetime.now(timezone.utc)
        if self.required_minutes > 0 and self.total_remaining_minutes > 0 and now < self.ends_at:
            return ((self.ends_at - now).total_seconds() / 60) / self.total_remaining_minutes
        return math.inf

    def _base_earn_conditions(self) -> bool:
        return (
            super()._base_earn_conditions()
            and self.required_minutes > 0
            and self.extra_current_minutes < MAX_EXTRA_MINUTES
        )

    def _on_state_changed(self) -> None:
        self._twitch.gui.inv.update_drop(self)

    def _update_real_minutes(self, delta: int) -> None:
        if delta == 0 or self.real_current_minutes + delta < 0 or not self.can_earn():
            return
        if self.real_current_minutes + delta < self.required_minutes:
            self.real_current_minutes += delta
        else:
            self.real_current_minutes = self.required_minutes
        self.extra_current_minutes = 0
        self._on_state_changed()

        # ⚡ OKAMŽITÝ CLAIM PŘI DOSAŽENÍ 100 % (z Reálných minut od Twitche)
        if self.can_claim:
            logger.info(f"🎯 Drop {self.name} dosáhl 100 %! Spouštím okamžitý claim...")
            asyncio.create_task(self.claim())

    def _bump_minutes(self, channel: Channel | None) -> bool:
        if self.can_earn(channel):
            self.extra_current_minutes += 1
            self._on_state_changed()

            # ⚡ OKAMŽITÝ CLAIM PŘI DOSAŽENÍ 100 % (z lokálního časovače)
            if self.can_claim:
                logger.info(f"🎯 Drop {self.name} dosáhl 100 % (přes bump)! Spouštím okamžitý claim...")
                asyncio.create_task(self.claim())

            if self.extra_current_minutes >= MAX_EXTRA_MINUTES:
                return True
        return False

    @property
    def can_claim(self) -> bool:
        return super().can_claim and self.current_minutes >= self.required_minutes

    def display(self, *, countdown: bool = True, subone: bool = False) -> None:
        self._twitch.gui.display_drop(self, countdown=countdown, subone=subone)

    def update_minutes(self, new_minutes: int) -> None:
        delta: int = new_minutes - self.real_current_minutes
        if delta == 0:
            return
        elif self.real_current_minutes + delta < 0:
            delta = -self.real_current_minutes
        elif self.real_current_minutes + delta > self.required_minutes:
            delta = self.required_minutes - self.real_current_minutes
        self.campaign._update_real_minutes(delta)

    def sync_minutes(self, new_minutes: int) -> None:
        if self.real_current_minutes != new_minutes:
            logger.debug(f"Syncing {self.name}: {self.real_current_minutes} -> {new_minutes}")
            self.real_current_minutes = new_minutes
            self.extra_current_minutes = 0
            self._on_state_changed()

    def sync_state_with_history(self, claimed_benefits: dict[str, datetime]) -> None:
        for benefit in self.benefits:
            if benefit.id in claimed_benefits:
                self.is_claimed = True
                logger.debug(f"State forced to Claimed: {self.name} (found in history).")
                return
