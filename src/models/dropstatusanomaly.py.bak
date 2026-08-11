import logging
from datetime import datetime, timedelta
from typing import Any

logger = logging.getLogger("TwitchDropsMiner.DropStatus")


def _safe_int(val: Any, default: int = 0) -> int:
    """Safely convert any value to int without raising exceptions."""
    if val is None:
        return default
    try:
        return int(val)
    except (ValueError, TypeError):
        return default


class DropStatusAnomaly:
    """
    Reconciles inconsistent Twitch Drop states between GQL API session data,
    inventory benefits cache, and local in-memory lockouts.
    """

    def __init__(self, lockout_ttl_minutes: int = 5, skip_ttl_minutes: int = 15) -> None:
        self._lockout_ttl: timedelta = timedelta(minutes=lockout_ttl_minutes)
        self._skip_ttl: timedelta = timedelta(minutes=skip_ttl_minutes)
        self._claimed_locks: dict[str, datetime] = {}
        self._skipped_drops: dict[str, datetime] = {}  # Cache for skipped drops
        self._failed_claim_attempts: dict[str, int] = {}  # Track real claim failure attempts
        self._permanent_blacklist: set[str] = set()  # Permanent blacklist
        self._known_progress: dict[str, int] = {}  # Persistence of reached minutes

    def mark_claimed_locally(self, drop_id: str, drop_name: str = "Unknown") -> None:
        now = datetime.now()
        self._claimed_locks[drop_id] = now
        logger.info(
            "Reconciler Lock: Drop '%s' (ID: %s) locked in memory at %s",
            drop_name,
            drop_id,
            now.strftime("%H:%M:%S"),
        )

    def mark_skipped(self, drop_id: str, drop_name: str = "Unknown", reason: str = "") -> None:
        """
        Marks a drop as skipped (e.g. when campaign requirements fail or progress errors occur)
        so that the engine does not cycle it endlessly.
        """
        now = datetime.now()
        self._skipped_drops[drop_id] = now
        logger.info(
            "DropStatus: Drop '%s' (ID: %s) marked as SKIPPED in memory (%s) at %s",
            drop_name,
            drop_id,
            reason or "No reason",
            now.strftime("%H:%M:%S"),
        )

    def mark_claim_failed(self, drop_id: str, drop_name: str = "Unknown", max_retries: int = 3) -> None:
        """
        Call exclusively from claim worker if the Twitch API claim mutation returns an error.
        """
        attempts = self._failed_claim_attempts.get(drop_id, 0) + 1
        self._failed_claim_attempts[drop_id] = attempts
        logger.warning(
            "Drop '%s' (ID: %s) claim failure attempt %d/%d",
            drop_name,
            drop_id,
            attempts,
            max_retries,
        )
        if attempts >= max_retries:
            self._permanent_blacklist.add(drop_id)
            logger.error(
                "Drop '%s' (ID: %s) exceeded max claim retries. Added to PERMANENT BLACKLIST.",
                drop_name,
                drop_id,
            )

    def reconcile(
        self,
        drop: Any,
        raw_gql_data: dict[str, Any] | None,
        claimed_benefits: dict[str, datetime],
    ) -> dict[str, Any]:
        """
        Evaluates incoming raw payload against internal state and claimed benefits.
        Returns a sanitized dictionary with actionable drop state.
        """
        now = datetime.now()
        drop_id: str = getattr(drop, "id", "Unknown") or "Unknown"
        drop_name: str = getattr(drop, "name", "Unknown") or "Unknown"
        required_mins: int = _safe_int(getattr(drop, "required_minutes", 0))

        # STEP 0: Permanent blacklist check
        if drop_id in self._permanent_blacklist:
            return {
                "is_claimed": True,
                "current_minutes": required_mins,
                "can_earn": False,
                "can_claim": False,
                "decision_reason": "WRONG_API_STATUS",
            }

        # STEP 0.5: Temporary skip lockout check
        if drop_id in self._skipped_drops:
            skip_time = self._skipped_drops[drop_id]
            if now - skip_time < self._skip_ttl:
                logger.info(
                    "Reconcile Decision [%s]: SKIPPED in memory (%s ago). Skipping earn/claim.",
                    drop_name,
                    str(now - skip_time).split(".")[0],
                )
                return {
                    "is_claimed": False,
                    "current_minutes": _safe_int(getattr(drop, "current_minutes", 0)),
                    "can_earn": False,
                    "can_claim": False,
                    "decision_reason": "MEMORY_SKIPPED_ACTIVE",
                }
            else:
                del self._skipped_drops[drop_id]

        logger.debug(
            "=== RECONCILE START [%s | ID: %s] ===",
            drop_name,
            drop_id,
        )

        # Log Raw Incoming States securely
        raw_gql_mins = None
        raw_gql_claimed = None
        if isinstance(raw_gql_data, dict):
            raw_gql_mins = raw_gql_data.get("currentMinutesWatched")
            raw_gql_claimed = raw_gql_data.get("isClaimed")

        # Step 1: Check memory lockout (Post-Claim Lock)
        if drop_id in self._claimed_locks:
            lock_time = self._claimed_locks[drop_id]
            if now - lock_time < self._lockout_ttl:
                logger.info(
                    "Reconcile Decision [%s]: LOCKED (Claimed recently at %s). Overriding API.",
                    drop_name,
                    lock_time.strftime("%H:%M:%S"),
                )
                return {
                    "is_claimed": True,
                    "current_minutes": required_mins,
                    "can_earn": False,
                    "can_claim": False,
                    "decision_reason": "MEMORY_LOCKOUT_ACTIVE",
                }
            else:
                del self._claimed_locks[drop_id]

        # Step 2: Check Benefit IDs in Account Inventory
        matched_benefits = []
        if hasattr(drop, "benefits") and isinstance(getattr(drop, "benefits"), (list, tuple)):
            matched_benefits = [
                b.id for b in drop.benefits if getattr(b, "id", None) in claimed_benefits
            ]

        has_claimed_benefit = len(matched_benefits) > 0
        if has_claimed_benefit:
            logger.debug(
                "Reconcile Decision [%s]: BENEFIT MATCHED in Inventory (%s). Drop is CLAIMED.",
                drop_name,
                matched_benefits,
            )

        # Step 3: Determine real current minutes with persistence protection
        local_mins: int = _safe_int(getattr(drop, "current_minutes", 0))
        cached_mins: int = _safe_int(self._known_progress.get(drop_id, 0))

        candidate_mins = max(local_mins, cached_mins)
        if raw_gql_mins is not None:
            candidate_mins = max(candidate_mins, _safe_int(raw_gql_mins))

        sanitized_mins = min(candidate_mins, required_mins) if required_mins > 0 else candidate_mins

        if sanitized_mins > cached_mins:
            self._known_progress[drop_id] = sanitized_mins

        # Step 4: Final Flag Evaluation
        is_claimed = (
            bool(getattr(drop, "is_claimed", False))
            or bool(raw_gql_claimed)
            or has_claimed_benefit
        )

        is_completed = (sanitized_mins >= required_mins) if required_mins > 0 else False
        can_claim = is_completed and not is_claimed

        decision_reason = "OK"
        if is_claimed:
            decision_reason = "CLAIMED_CONFIRMED"
        elif can_claim:
            decision_reason = "READY_TO_CLAIM"
        elif is_completed:
            decision_reason = "PROGRESS_100_PERCENT"

        logger.debug(
            "Reconcile Decision [%s] -> Final Mins: %s/%s | Is Claimed: %s | Reason: %s",
            drop_name,
            sanitized_mins,
            required_mins,
            is_claimed,
            decision_reason,
        )

        return {
            "is_claimed": is_claimed,
            "current_minutes": sanitized_mins,
            "can_earn": not is_claimed and not is_completed,
            "can_claim": can_claim,
            "decision_reason": decision_reason,
        }

    def reconcile_campaign(
        self,
        campaign: Any,
        raw_gql_data: Any | None = None,
        claimed_benefits: dict[str, datetime] | None = None,
    ) -> list[Any]:
        if claimed_benefits is None:
            claimed_benefits = {}

        def safe_set(obj: Any, name: str, value: Any) -> None:
            """Safely write attribute even to objects with read-only properties."""
            priv_name = f"_{name}"
            if hasattr(obj, priv_name):
                try:
                    setattr(obj, priv_name, value)
                    return
                except AttributeError:
                    pass

            try:
                setattr(obj, name, value)
                return
            except AttributeError:
                pass

            if hasattr(obj, "__dict__"):
                obj.__dict__[name] = value

        updated_drops = []
        for drop in getattr(campaign, "drops", []):
            drop_id = getattr(drop, "id", None)
            gql_payload = None

            if isinstance(raw_gql_data, dict):
                if raw_gql_data.get("dropID") == drop_id:
                    gql_payload = raw_gql_data
            elif isinstance(raw_gql_data, list):
                for item in raw_gql_data:
                    if isinstance(item, dict) and item.get("dropID") == drop_id:
                        gql_payload = item
                        break

            reconciled = self.reconcile(
                drop=drop,
                raw_gql_data=gql_payload,
                claimed_benefits=claimed_benefits,
            )

            safe_set(drop, "current_minutes", reconciled["current_minutes"])

            if reconciled["is_claimed"]:
                safe_set(drop, "is_claimed", True)

            safe_set(drop, "decision_reason", reconciled["decision_reason"])
            safe_set(drop, "can_claim", reconciled["can_claim"])

            updated_drops.append(drop)

        return updated_drops

    def is_drop_blocked(self, drop_id: str) -> bool:
        """Returns True if the drop is permanently blacklisted or currently locked/skipped."""
        if drop_id in self._permanent_blacklist:
            return True

        now = datetime.now()
        if drop_id in self._skipped_drops:
            if now - self._skipped_drops[drop_id] < self._skip_ttl:
                return True
            else:
                del self._skipped_drops[drop_id]

        if drop_id in self._claimed_locks:
            if now - self._claimed_locks[drop_id] < self._lockout_ttl:
                return True
            else:
                del self._claimed_locks[drop_id]

        return False
