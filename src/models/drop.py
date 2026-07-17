from __future__ import annotations

import logging
import re
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


def remove_dimensions(url: str) -> str:
    """Remove dimension suffix from Twitch image URLs (e.g., -285x380.jpg)."""
    return DIMS_PATTERN.sub("", url)


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
        self.starts_at: datetime = isoparse(data["startAt"])
        self.ends_at: datetime = isoparse(data["endAt"])
        self.claim_id: str | None = None
        self.is_claimed: bool = False
        self._is_processing_claim = False
        
        if "self" in data:
            self.claim_id = data["self"]["dropInstanceID"]
            self.is_claimed = data["self"]["isClaimed"]
        else:
            # 1. Try to find benefits in the history
            dts = [
                claimed_benefits[bid]
                for benefit in self.benefits
                if (bid := benefit.id) in claimed_benefits
            ]
            
            # 2. If found and the timeframe matches, mark as claimed
            if dts and all(self.starts_at <= dt < self.ends_at for dt in dts):
                self.is_claimed = True
                logger.debug(f"Drop {self.id} marked as claimed (found in claimed_benefits).")

        self.precondition_drops: list[str] = [d["id"] for d in (data["preconditionDrops"] or [])]

    def __repr__(self) -> str:
        if self.is_claimed:
            additional = ", claimed=True"
        elif self.can_earn():
            additional = ", can_earn=True"
        else:
            additional = ""
        return f"Drop({self.rewards_text()}{additional})"

    @property
    def preconditions_met(self) -> bool:
        campaign = self.campaign
        return all(campaign.timed_drops[pid].is_claimed for pid in self.precondition_drops)

    def _on_state_changed(self) -> None:
        raise NotImplementedError

    def _base_earn_conditions(self) -> bool:
        # Check if this drop is currently in a 1-minute cooldown due to a failed claim
        failed_at = BaseDrop._failed_claims.get(self.id)
        if failed_at:
            if datetime.now(timezone.utc) - failed_at < timedelta(minutes=1):
                return False
            else:
                BaseDrop._failed_claims.pop(self.id, None)

        # Define when a drop can be earned or not
        return (
            self.preconditions_met  # Preconditions are met
            and not self.is_claimed  # Isn't already claimed
            # Has at least one benefit, or participates in a preconditions chain
            and (bool(self.benefits) or self.id in self.campaign.preconditions_chain())
        )

    def _base_can_earn(self) -> bool:
        # Cross-participates in can_earn and can_earn_within handling, where a timeframe is added
        return (
            self._base_earn_conditions()
            # Is within the timeframe
            and self.starts_at <= datetime.now(timezone.utc) < self.ends_at
        )

    def _can_earn_within(self, stamp: datetime) -> bool:
        # NOTE: This does not check the campaign's eligibility or active status
        return (
            self._base_earn_conditions()
            and self.ends_at > datetime.now(timezone.utc)
            and self.starts_at < stamp
        )

    def can_earn(self, channel: Channel | None = None, ignore_channel_status: bool = False) -> bool:
        return self._base_can_earn() and self.campaign._base_can_earn(
            channel, ignore_channel_status
        )

    @property
    def can_claim(self) -> bool:
        # Pokud je již vyclaimováno nebo se zpracovává, neřešíme
        if self.is_claimed or self._is_processing_claim:
            return False
            
        # Kontrola, zda jsme dosáhli 100 %
        is_completed = False
        if hasattr(self, "current_minutes") and hasattr(self, "required_minutes"):
            is_completed = self.current_minutes >= self.required_minutes

        # STRIKTNÍ PODMÍNKA: 100 % musí být hotovo A zároveň musíme mít claim_id
        return (
            is_completed
            and self.claim_id is not None
            and datetime.now(timezone.utc) < self.campaign.ends_at + timedelta(hours=24)
        )

    async def generate_claim(self) -> None:
        # Claim IDs now appear to be constructed from other IDs we have access to
        # Format: UserID#CampaignID#DropID
        # NOTE: This marks a drop as a ready-to-claim, so we may want to later ensure
        # its mining progress is finished first
        auth_state = await self.campaign._twitch.get_auth()
        self.claim_id = f"{auth_state.user_id}#{self.campaign.id}#{self.id}"

    def rewards_text(self, delim: str = ", ") -> str:
        return delim.join(benefit.name for benefit in self.benefits)

    def has_wanted_unclaimed_benefits(self, allowed_benefits: dict[str, bool]) -> bool:
        return len(self.get_wanted_unclaimed_benefits(allowed_benefits)) > 0
        
    def get_wanted_unclaimed_benefits(self, allowed_benefits: dict[str, bool]) -> list[str]:
        campaign = getattr(self, "campaign", None)
        # Jen vracíme prázdný seznam, pokud není linknuto
        if campaign and not getattr(campaign, "linked", True):
            return []
    
        if self.is_claimed:
            return []
        
        return [benefit.name for benefit in self.benefits if benefit.is_wanted(allowed_benefits)]

    async def claim(self) -> bool:
        # 1. Guard: If already being processed or already claimed, do not try again
        if self.is_claimed:
            return False

        if getattr(self, "_is_processing_claim", False):
            logger.debug(f"Drop {self.id} is already in claiming process, skipping.")
            return False
        
        # 2. Basic validation
        if not self.can_claim:
            logger.debug(f"Drop {self.id} is not ready for claim (can_claim=False).")
            return False

        current_min = getattr(self, "current_minutes", 0)
        req_min = getattr(self, "required_minutes", 0)
        if current_min < req_min:
            logger.warning(f"Drop {self.id} claimed prematurely? Progress: {current_min}/{req_min}")
            return False

        if self.claim_id is None:
            await self.generate_claim()

        # 3. Process with locking protection
        self._is_processing_claim = True
        try:
            result = await self._claim()
            
            # SUCCESS check strictly against string return value
            if result == "SUCCESS":
                # Success: Update state in memory
                self.is_claimed = True
                
                claim_text = (
                    f"{self.campaign.game.name}\n"
                    f"{self.rewards_text()} "
                    f"({self.campaign.claimed_drops}/{self.campaign.total_drops})"
                )
                self._twitch.print(
                    _.t["status"]["claimed_drop"].format(drop=claim_text.replace("\n", " "))
                )
                # Clear from failed claims on successful claim
                BaseDrop._failed_claims.pop(self.id, None)
                return True
            else:
                logger.error(f"Drop claim failed with status: {result}! Drop ID: {self.id}")
                # Record the failure timestamp to trigger the 1-minute cooldown
                BaseDrop._failed_claims[self.id] = datetime.now(timezone.utc)
                return False

        except Exception as e:
            logger.error(f"Critical error while claiming drop {self.id}: {e}")
            return False
            
        finally:
            # 4. Always unlock so bot can retry on next interval if it failed
            self._is_processing_claim = False
        
    async def _claim(self) -> str:
        """
        Returns the claim status as a string.
        """
        if self.is_claimed:
            return "ALREADY_CLAIMED"
        if not self.can_claim:
            return "CANNOT_CLAIM"
        try:
            response = await self._twitch.gql_request(
                GQL_OPERATIONS["ClaimDrop"].with_variables(
                    {"input": {"dropInstanceID": self.claim_id}}
                )
            )
        except GQLException:
            # Regardless of the error, we have to assume
            # the claiming operation has potentially failed
            return "GQL_ERROR"
            
        data = response.get("data")
        if not data:
            return "NO_DATA"
            
        if "errors" in data and data["errors"]:
            # Check if Twitch returned a specific error about missing connection
            # Often contains messages like "AccountNotLinked" or "ExternalAccountNotLinked"
            err_msg = str(data["errors"]).lower()
            if "link" in err_msg or "connect" in err_msg:
                return "ACCOUNT_NOT_LINKED"
            return "TWITCH_ERROR"
            
        elif "claimDropRewards" in data:
            result_data = data["claimDropRewards"]
            if not result_data:
                return "NO_REWARDS_DATA"
                
            status = result_data.get("status")
            if status in ("ELIGIBLE_FOR_ALL", "DROP_INSTANCE_ALREADY_CLAIMED"):
                return "SUCCESS"
            elif status == "DROP_INSTANCE_NOT_ELIGIBLE":
                # This is the exact error Twitch returns when account is not linked!
                return "ACCOUNT_NOT_LINKED"
            elif status:
                return f"TWITCH_STATUS_{status}"
                
        return "UNKNOWN_FAILURE"


class TimedDrop(BaseDrop):
    def __init__(
        self, campaign: DropsCampaign, data: JsonType, claimed_benefits: dict[str, datetime]
    ):
        super().__init__(campaign, data, claimed_benefits)
        self.real_current_minutes: int = (
            "self" in data and data["self"]["currentMinutesWatched"] or 0
        )
        self.required_minutes: int = data["requiredMinutesWatched"]
        self.extra_current_minutes: int = 0
        if self.is_claimed:
            # Claimed drops may report inconsistent current minutes, so we need to overwrite them
            self.real_current_minutes = self.required_minutes

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
    def total_required_minutes(self) -> int:
        return self.required_minutes + max(
            (
                self.campaign.timed_drops[pid].total_required_minutes
                for pid in self.precondition_drops
            ),
            default=0,
        )

    @property
    def total_remaining_minutes(self) -> int:
        return self.remaining_minutes + max(
            (
                self.campaign.timed_drops[pid].total_remaining_minutes
                for pid in self.precondition_drops
            ),
            default=0,
        )

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
            # NOTE: This may be a bad idea, as it invalidates the can_earn status
            # and provides no way to recover from this state until the next reload.
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

    def _bump_minutes(self, channel: Channel | None) -> bool:
        if self.can_earn(channel):
            self.extra_current_minutes += 1
            self._on_state_changed()
            if self.extra_current_minutes >= MAX_EXTRA_MINUTES:
                return True
        return False
        
    async def claim(self) -> bool:
        # Získáme výsledek (očekáváme string z tvé funkce _claim)
        result = await super().claim()
        
        # 1. Kontrola úspěchu (pouze pokud je výsledek "SUCCESS")
        if result == "SUCCESS":
            self.real_current_minutes = self.required_minutes
            self.extra_current_minutes = 0
            self._on_state_changed()
            return True
        
        # 2. Ošetření CANNOT_CLAIM bez spamování logů
        elif result == "CANNOT_CLAIM":
            # Toto je v pořádku, Twitch jen není ready, žádná chyba
            return False
            
        # 3. Ostatní chyby (GQL_ERROR, TWITCH_ERROR atd.)
        else:
            # Zde můžeš logovat jen pokud chceš vědět o skutečných problémech
            # logger.error(f"Claim failed with status: {result}") 
            return False

    def display(self, *, countdown: bool = True, subone: bool = False) -> None:
        """Display this drop in the GUI with progress information."""
        self._twitch.gui.display_drop(self, countdown=countdown, subone=subone)

    def update_minutes(self, new_minutes: int) -> None:
        """Update the current watched minutes for this drop."""
        delta: int = new_minutes - self.real_current_minutes
        if delta == 0:
            return
        elif self.real_current_minutes + delta < 0:
            delta = -self.real_current_minutes
        elif self.real_current_minutes + delta > self.required_minutes:
            delta = self.required_minutes - self.real_current_minutes
        self.campaign._update_real_minutes(delta)
        
    def sync_minutes(self, new_minutes: int) -> None:
        """
        Force update of minutes from API response.
        This ignores delta logic and sets the state to the absolute value 
        provided by the Twitch API.
        """
        if self.real_current_minutes != new_minutes:
            logger.debug(f"Syncing {self.name}: {self.real_current_minutes} -> {new_minutes}")
            self.real_current_minutes = new_minutes
            self.extra_current_minutes = 0  # Reset extra minutes on full sync
            self._on_state_changed()
            
    def sync_state_with_history(self, claimed_benefits: dict[str, datetime]) -> None:
        """
        Force state to claimed if benefits are tracked in the local history.
        This ignores conflicting reports from 'dropCampaignsInProgress'.
        """
        for benefit in self.benefits:
            if benefit.id in claimed_benefits:
                self.is_claimed = True
                logger.debug(f"State forced to Claimed: {self.name} (found in history).")
                return
