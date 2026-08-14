from __future__ import annotations

import asyncio
import logging
import inspect
from datetime import datetime, timezone
from enum import Enum
from typing import TYPE_CHECKING, Any, ClassVar, Dict, Optional, SupportsInt

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    computed_field,
    model_validator,
)

# Importy pomocných funkcí z helpers.py
from .helpers import (
    build_channel_stream_gql,
    build_spade_payload,
    calculate_campaign_remaining_minutes,
    calculate_remaining_minutes,
    check_drop_can_claim,
    check_watchable_drops,
    extract_campaign_time_triggers,
    extract_drop_image_url,
    filter_wanted_unclaimed_benefits,
    is_campaign_earnable_within,
    preprocess_benefit_json,
    resolve_campaign_active,
    resolve_campaign_eligibility,
    resolve_drop_status,
    slugify_game_name,
    update_drop_minutes,
)

if TYPE_CHECKING:
    from src.config.constants import JsonType, URLType
    from src.core.client import Twitch
    from src.web.gui_manager import ChannelList

logger = logging.getLogger("TwitchDrops")


# ==============================================================================
# 1. BENEFIT
# ==============================================================================

class BenefitType(str, Enum):
    """Type of drop benefit (reward)."""

    UNKNOWN = "UNKNOWN"
    BADGE = "BADGE"
    EMOTE = "EMOTE"
    DIRECT_ENTITLEMENT = "DIRECT_ENTITLEMENT"

    def is_badge_or_emote(self) -> bool:
        return self in (BenefitType.BADGE, BenefitType.EMOTE)


class Benefit(BaseModel):
    """Represents a reward/benefit from a completed drop."""

    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        populate_by_name=True,
        use_enum_values=False,
    )

    id: str = ""
    name: str = ""
    type: BenefitType = BenefitType.UNKNOWN
    image_url: str = Field(default="", alias="imageAssetURL")

    def to_dict(self):
        return self.model_dump() if hasattr(self, "model_dump") else self.dict()

    @model_validator(mode="before")
    @classmethod
    def _preprocess(cls, data: Any) -> Any:
        return preprocess_benefit_json(data, BenefitType)


# ==============================================================================
# 2. GAME
# ==============================================================================

class Game(BaseModel):
    """Represents a Twitch game/category."""

    id: int | str
    name: str
    slug_override: Optional[str] = Field(default=None, exclude=True)
    box_art_url: Optional[str] = Field(
        default=None, validation_alias=AliasChoices("box_art_url", "boxArtURL")
    )

    model_config = ConfigDict(
        populate_by_name=True,
        arbitrary_types_allowed=True,
    )

    @model_validator(mode="before")
    @classmethod
    def _preprocess_game(cls, data: Any) -> Any:
        if isinstance(data, dict):
            g_data = dict(data)
            if "displayName" in g_data and "name" not in g_data:
                g_data["name"] = g_data["displayName"]
            if "slug" in g_data and "slug_override" not in g_data:
                g_data["slug_override"] = g_data["slug"]
            return g_data
        return data

    def __str__(self) -> str:
        return self.name

    def __repr__(self) -> str:
        return f"Game({self.id}, {self.name})"

    def __eq__(self, other: object) -> bool:
        if isinstance(other, self.__class__):
            return self.id == other.id
        return NotImplemented

    def __hash__(self) -> int:
        return hash(self.id)

    @computed_field
    @property
    def slug(self) -> str:
        return slugify_game_name(self.name, self.slug_override)


# ==============================================================================
# 3. CHANNEL
# ==============================================================================

class Channel(BaseModel):
    """Represents a Twitch Channel."""

    id: int | str = 0
    name: str = ""
    login: str = ""
    viewers: int = 0
    acl_based: bool = False
    drops_enabled: bool = True
    game: Any | None = None
    
    # 🔹 Připojené relace pro StreamSelector
    stream: Any | None = None  # Instance třídy Stream, pokud je online
    campaigns: list[Any] = Field(default_factory=list)  # Seznam dostupných kampaní
    
    # 🔹 Privátní atributy
    _is_online: bool = PrivateAttr(default=True)
    _twitch: Any = PrivateAttr(default=None)

    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        populate_by_name=True,
    )

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Channel):
            return (self.id, self.login, self.name) == (other.id, other.login, other.name)
        return False

    def __hash__(self) -> int:
        return hash((self.id, self.login, self.name))

    @property
    def twitch(self) -> Any:
        return self._twitch

    @twitch.setter
    def twitch(self, value: Any) -> None:
        self._twitch = value

    @property
    def stream_gql(self) -> Any:
        """Vrátí GQL request pro ověření stavu streamu kanálu."""
        target = self.login or self.name
        return build_channel_stream_gql(target, self.id)

    @property
    def online(self) -> bool:
        """Vrátí stav, zda je kanál online."""
        return self._is_online

    @online.setter
    def online(self, value: bool) -> None:
        self._is_online = value

    def check_online(self) -> bool:
        return self.online

    @classmethod
    def from_acl(cls, twitch: Any, data: dict[str, Any]) -> Channel:
        """Vytvoří instanci Channel z ACL dat kampaně."""
        if not isinstance(data, dict):
            return cls()

        channel = cls(
            id=data.get("id", 0),
            name=data.get("displayName") or data.get("name", ""),
            login=data.get("login", ""),
            acl_based=True,
            drops_enabled=True,
        )
        channel._twitch = twitch
        return channel

    @classmethod
    def from_directory(
        cls,
        twitch: Any,
        data: dict[str, Any],
        drops_enabled: bool = True,
        **kwargs: Any,
    ) -> Channel:
        """Vytvoří instanci Channel z dat z adresáře / vyhledávání streamů."""
        if not isinstance(data, dict):
            return cls()

        target_data = data.get("broadcaster") or data.get("channel") or data

        channel = cls(
            id=target_data.get("id", 0),
            name=target_data.get("displayName") or target_data.get("name", ""),
            login=target_data.get("login", ""),
            acl_based=False,
            drops_enabled=drops_enabled,
        )
        channel._twitch = twitch
        return channel


# ==============================================================================
# 4. TIMED DROP
# ==============================================================================

class Drop(BaseModel):
    """Model reprezentující časovaný Twitch Drop."""

    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        populate_by_name=True,
    )

    _failed_claims: ClassVar[dict[str, datetime]] = {}

    id: str
    name: str
    starts_at: datetime = Field(validation_alias=AliasChoices("starts_at", "startAt"))
    ends_at: datetime = Field(validation_alias=AliasChoices("ends_at", "endAt"))
    required_minutes: int = Field(
        default=0, validation_alias=AliasChoices("required_minutes", "requiredMinutesWatched")
    )
    real_current_minutes: int = 0
    extra_current_minutes: int = 0
    image_url: str = ""
    claim_id: Optional[str] = None
    is_claimed: bool = False
    precondition_drops: list[str] = Field(default_factory=list)
    benefits: list[Benefit] = Field(default_factory=list)

    campaign: Any = Field(default=None, exclude=True)
    failed_claim: bool = False
    claimed_count: int = 0
    is_stuck: bool = False

    _twitch: Any = PrivateAttr(default=None)
    _is_processing_claim: bool = PrivateAttr(default=False)

    @model_validator(mode="before")
    @classmethod
    def _flatten_twitch_json(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data

        flat_data = dict(data)

        # 1. Extrakce ze zanořeného objektu "self"
        self_data = flat_data.get("self")
        if isinstance(self_data, dict):
            flat_data.setdefault("claim_id", self_data.get("dropInstanceID"))
            flat_data.setdefault("is_claimed", self_data.get("isClaimed", False))
            flat_data.setdefault("real_current_minutes", self_data.get("currentMinutesWatched", 0))

        # 2. Extrakce závislostí
        if "preconditionDrops" in flat_data and "precondition_drops" not in flat_data:
            preconditions = flat_data.get("preconditionDrops") or []
            flat_data["precondition_drops"] = [
                p["id"] for p in preconditions if isinstance(p, dict) and "id" in p
            ]

        # 3. Zpracování benefitů a obrázku
        if "benefitEdges" in flat_data:
            edges = flat_data.get("benefitEdges") or []
            benefits = [Benefit.model_validate(b) for b in edges]
            flat_data.setdefault("benefits", benefits)
            flat_data.setdefault("image_url", extract_drop_image_url(edges, benefits))

        return flat_data

    def model_post_init(self, __context: Any) -> None:
        if self.campaign and not self._twitch:
            self._twitch = getattr(self.campaign, "_twitch", None)

        if self.is_claimed:
            self.real_current_minutes = self.required_minutes

    def update_progress(self, progress_data: dict[str, Any]) -> None:
        """Bezpečně aktualizuje pokrok dropu z dat z dropCampaignsInProgress."""
        self_data = progress_data.get("self") if isinstance(progress_data.get("self"), dict) else {}

        # 1. Aktualizace claimu
        if progress_data.get("isClaimed") or self_data.get("isClaimed"):
            self.is_claimed = True
            self.real_current_minutes = self.required_minutes

        # 2. Aktualizace napozorovaných minut
        inc_minutes = self_data.get("currentMinutesWatched")
        if inc_minutes is not None:
            self.real_current_minutes = max(self.real_current_minutes, int(inc_minutes))

        # 3. Aktualizace ID instance pro claim
        claim_id = self_data.get("dropInstanceID")
        if claim_id:
            self.claim_id = claim_id

    def apply_desync_sanitization(
        self,
        claimed_tokens: set[str],
        desync_log: list[dict] | None = None,
        campaign_name: str = "Neznámá kampaň",
    ) -> bool:
        """Porovná stav dropu s již získanými odměnami a opraví desynchronizaci."""
        if self.is_claimed:
            return False

        check_targets: list[tuple[str, str]] = [
            (b.id, b.name) for b in self.benefits
        ]
        if not check_targets and self.name:
            check_targets.append(("", self.name))

        drop_should_be_claimed = False
        matched_reason = ""

        for b_id, b_name in check_targets:
            clean_b_id = b_id.lower().strip()
            clean_name = (
                b_name.lower()
                .replace("emote", "")
                .replace("badge", "")
                .replace("emotes", "")
                .replace("badges", "")
                .strip()
            )

            if clean_b_id and clean_b_id in claimed_tokens:
                drop_should_be_claimed = True
                matched_reason = "ID v historii"
                break

            if clean_name:
                for token in claimed_tokens:
                    if len(token) <= 2:
                        continue

                    clean_token = (
                        token.lower()
                        .replace("emote", "")
                        .replace("badge", "")
                        .replace("emotes", "")
                        .replace("badges", "")
                        .strip()
                    )

                    if (
                        clean_name == clean_token
                        or clean_name in clean_token
                        or clean_token in clean_name
                    ):
                        drop_should_be_claimed = True
                        matched_reason = f"Match názvu: '{clean_name}' vs '{clean_token}'"
                        break

            if drop_should_be_claimed:
                break

        if drop_should_be_claimed:
            if desync_log is not None:
                desync_log.append({
                    "campaign": campaign_name,
                    "drop_name": self.name,
                    "drop_id": self.id,
                    "api_claimed": False,
                    "api_progress": f"{self.real_current_minutes}/{self.required_minutes}m",
                    "reason": matched_reason,
                })

            self.is_claimed = True
            self.real_current_minutes = self.required_minutes
            if not self.claim_id:
                self.claim_id = "SANITIZED_CLAIMED"

            logger.debug(
                f"Desync resolved: Drop '{self.name}' ({self.id}) "
                f"marked as claimed [{matched_reason}]"
            )
            return True

        return False

    def sync_minutes(self, minutes: int) -> None:
        self.real_current_minutes = update_drop_minutes(
            self.real_current_minutes, self.required_minutes, minutes
        )
        if self.real_current_minutes >= self.required_minutes and self.required_minutes > 0:
            self.is_claimed = True

    @property
    def status(self) -> str:
        return resolve_drop_status(
            is_claimed=self.is_claimed,
            can_claim=bool(self.claim_id and not self.is_claimed),
            is_stuck=self.is_stuck,
            current_minutes=self.real_current_minutes,
        )

    @property
    def remaining_minutes(self) -> int:
        return max(0, self.required_minutes - self.current_minutes)

    @property
    def current_minutes(self) -> int:
        return self.real_current_minutes

    @property
    def can_claim(self) -> bool:
        return check_drop_can_claim(self.current_minutes, self.required_minutes, self.is_claimed)

    def get_wanted_unclaimed_benefits(self, mining_benefits: list | None = None) -> list:
        rewards = getattr(self, "benefits", []) or getattr(self, "rewards", [])
        return filter_wanted_unclaimed_benefits(rewards, self.is_claimed, mining_benefits)

    def __repr__(self) -> str:
        additional = ", claimed=True" if self.is_claimed else ""
        minutes = (
            f", {self.real_current_minutes}/{self.required_minutes}"
            if 0 < self.real_current_minutes < self.required_minutes
            else ""
        )
        return f"TimedDrop({self.name}{minutes}{additional})"


# ==============================================================================
# 5. CAMPAIGN
# ==============================================================================

class Campaign(BaseModel):
    """Model reprezentující Twitch Drop kampaň."""

    id: str = Field(validation_alias=AliasChoices("id", "campaign_id"))
    campaign_url: str = ""
    name: str = ""
    game: Game
    link_url: str = Field(default="", validation_alias=AliasChoices("link_url", "accountLinkURL"))
    linked: bool = True
    starts_at: datetime = Field(validation_alias=AliasChoices("starts_at", "startAt"))
    ends_at: datetime = Field(validation_alias=AliasChoices("ends_at", "endAt"))
    valid: bool = True
    allowed_channels: list[Channel] = Field(default_factory=list)
    timed_drops: dict[str, Drop] = Field(default_factory=dict)

    _twitch: Any = PrivateAttr(default=None)

    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        populate_by_name=True,
    )

    @model_validator(mode="before")
    @classmethod
    def _preprocess_campaign(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data

        c_data = dict(data)

        if "accountLinkURL" in c_data or "self" in c_data:
            link_url = c_data.get("accountLinkURL", "")
            self_data = c_data.get("self") or {}
            is_connected = (
                self_data.get("isAccountConnected", False)
                if isinstance(self_data, dict)
                else False
            )

            fake_link_domains = ("twitch.tv", "help.twitch.tv")
            has_real_link = bool(link_url) and not any(
                domain in link_url for domain in fake_link_domains
            )
            c_data.setdefault("linked", not has_real_link or bool(is_connected))

        if "status" in c_data:
            c_data.setdefault("valid", c_data.get("status") != "EXPIRED")

        if "id" in c_data and not c_data.get("campaign_url"):
            c_data["campaign_url"] = (
                f"https://www.twitch.tv/drops/campaigns?dropID={c_data['id']}"
            )

        return c_data

    @classmethod
    def from_json(
        cls,
        twitch: Any,
        data: dict[str, Any],
        claimed_benefits: dict[str, datetime],
        desync_log: list[dict] | None = None,
    ) -> Campaign:
        """Konstruktor pro načtení kampaně ze surového JSONu s automatickou sanitací desynchronizace."""
        allowed: dict[str, Any] = data.get("allow", {})
        allowed_channels = (
            [Channel.from_acl(twitch, ch) for ch in allowed.get("channels", [])]
            if allowed.get("channels") and allowed.get("isEnabled", True)
            else []
        )

        game_data = data.get("game")
        game_name = data.get("name") or "Unknown Event"
        game = (
            Game.model_validate(game_data)
            if game_data
            else Game(id="special_event", name=game_name)
        )

        campaign = cls.model_validate(
            {**data, "game": game, "allowed_channels": allowed_channels}
        )
        campaign._twitch = twitch

        claimed_tokens = (
            {token.lower().strip() for token in claimed_benefits.keys() if token}
            if claimed_benefits
            else set()
        )

        timed_drops_dict = {}
        for drop_data in data.get("timeBasedDrops", []):
            drop_instance = Drop.model_validate(drop_data)
            drop_instance.campaign = campaign
            drop_instance._twitch = twitch

            if claimed_tokens:
                drop_instance.apply_desync_sanitization(
                    claimed_tokens=claimed_tokens,
                    desync_log=desync_log,
                    campaign_name=campaign.name,
                )

            timed_drops_dict[drop_instance.id] = drop_instance

        campaign.timed_drops = timed_drops_dict
        return campaign

    def update_progress_from_gql(self, progress_data: dict[str, Any]) -> None:
        """Aktualizuje pokrok kampaně a všech jejích dropů z dat dropCampaignsInProgress."""
        incoming_drops = progress_data.get("timeBasedDrops", []) or []

        for inc_drop in incoming_drops:
            if not isinstance(inc_drop, dict):
                continue

            drop_id = str(inc_drop.get("id") or "")
            if drop_id in self.timed_drops:
                self.timed_drops[drop_id].update_progress(inc_drop)

    def can_earn_on(self, channel: Any) -> bool:
        if self.allowed_channels:
            ch_id = getattr(channel, "id", None)
            ch_name = getattr(channel, "name", None)
            return any(
                (getattr(c, "id", None) == ch_id) or (getattr(c, "name", None) == ch_name)
                for c in self.allowed_channels
            )

        ch_game = getattr(channel, "game", None)
        if self.game and ch_game:
            cg_id = getattr(self.game, "id", None)
            chg_id = getattr(ch_game, "id", None)
            if cg_id and chg_id:
                return cg_id == chg_id
            return getattr(self.game, "name", None) == getattr(ch_game, "name", None)

        return True

    def can_earn(self, channel: Any) -> bool:
        return self.can_earn_on(channel)

    def can_earn_within(self, timestamp: datetime | None = None) -> bool:
        return is_campaign_earnable_within(
            self.starts_at, self.ends_at, self.eligibility, timestamp
        )

    @property
    def drops(self) -> list[Drop]:
        return list(self.timed_drops.values())

    @property
    def first_drop(self) -> Drop | None:
        for drop in self.drops:
            if not drop.is_claimed:
                return drop
        return self.drops[0] if self.drops else None

    @property
    def progress(self) -> float:
        if not self.drops:
            return 0.0
        if all(d.is_claimed for d in self.drops):
            return 100.0

        total_required = sum(getattr(d, "required_minutes", 0) for d in self.drops)
        if total_required == 0:
            return 100.0 if all(d.is_claimed for d in self.drops) else 0.0

        total_current = sum(getattr(d, "current_minutes", 0) for d in self.drops)
        return min(100.0, (total_current / total_required) * 100.0)

    @property
    def remaining_minutes(self) -> int:
        return calculate_campaign_remaining_minutes(self)

    @property
    def eligible(self) -> bool:
        return self.linked and self.valid

    @property
    def eligibility(self) -> bool:
        linked = getattr(self, "linked", True)
        valid = getattr(self, "valid", True)
        return resolve_campaign_eligibility(linked, valid)

    @property
    def active(self) -> bool:
        return resolve_campaign_active(self.starts_at, self.ends_at)

    @property
    def upcoming(self) -> bool:
        now = datetime.now(timezone.utc)
        start = (
            self.starts_at
            if self.starts_at.tzinfo
            else self.starts_at.replace(tzinfo=timezone.utc)
        )
        return now < start

    @property
    def expired(self) -> bool:
        now = datetime.now(timezone.utc)
        end = (
            self.ends_at
            if self.ends_at.tzinfo
            else self.ends_at.replace(tzinfo=timezone.utc)
        )
        return now > end

    @property
    def has_watchable_drops(self) -> bool:
        return check_watchable_drops(self.drops)

    @property
    def time_triggers(self) -> set[datetime]:
        return extract_campaign_time_triggers(self.starts_at, self.ends_at)


# ==============================================================================
# 6. STREAM
# ==============================================================================

class Stream(BaseModel):
    channel: Channel = Field(exclude=True)
    broadcast_id: int
    viewers: int = 0
    drops_enabled: bool = True
    game: Game | None = None
    title: str = ""
    _stream_url: URLType | None = PrivateAttr(default=None)

    model_config = ConfigDict(
        arbitrary_types_allowed=True,
        populate_by_name=True,
        extra="allow",
    )

    def __init__(
        self,
        channel: Channel,
        *,
        id: SupportsInt,
        game: JsonType | None,
        viewers: int,
        title: str,
        **kwargs,
    ):
        super().__init__(
            channel=channel,
            broadcast_id=int(id),
            viewers=viewers,
            game=Game.model_validate(game) if isinstance(game, dict) else game,
            title=title,
            **kwargs,
        )

    @property
    def _spade_payload(self) -> JsonType:
        user_id = getattr(getattr(self.channel, "_twitch", None), "_auth_state", None)
        return build_spade_payload(
            broadcast_id=self.broadcast_id,
            channel_id=self.channel.id,
            channel_login=getattr(self.channel, "login", ""),
            game_name=self.game.name if self.game else "",
            game_id=self.game.id if self.game else "",
            user_id=getattr(user_id, "user_id", 0) if user_id else 0,
        )

    @classmethod
    def from_get_stream(cls, channel: Channel, channel_data: JsonType) -> Stream:
        stream = channel_data["stream"]
        settings = channel_data["broadcastSettings"]
        return cls(
            channel,
            id=stream["id"],
            game=settings["game"],
            viewers=stream["viewersCount"],
            title=settings["title"],
        )


# ==============================================================================
# 7. GUI / TREE STRUCTURES
# ==============================================================================

class CurrentDropInfo(BaseModel):
    """Snímek aktuálně těženého dropu pro GUI/WebSocket."""

    id: str
    name: str
    game_name: str
    status: str = "Mining"
    current_minutes: int = 0
    required_minutes: int = 0
    progress: int = 0
    image_url: Optional[str] = None

    model_config = ConfigDict(arbitrary_types_allowed=True)


class CurrentDropSession(BaseModel):
    """Payload z Twitch GraphQL pro aktuálně sledovaný drop."""
    drop_id: str = Field(validation_alias=AliasChoices("dropID", "drop_id"))
    current_minutes_watched: int = Field(
        default=0,
        validation_alias=AliasChoices("currentMinutesWatched", "current_minutes_watched"),
    )


class DropTreeItem(BaseModel):
    """Reprezentace jednoho dropu v hierarchii."""

    id: str | int
    name: str
    image_url: Optional[str] = None
    status: str
    benefits: list[Any] = Field(default_factory=list)
    is_mining: bool = False
    is_claimed: bool = False
    can_claim: bool = False
    is_stuck: bool = False
    is_in_progress: bool = False
    current_minutes: int = 0
    required_minutes: int = 0
    progress: int = 0

    model_config = ConfigDict(arbitrary_types_allowed=True)


class CampaignTreeItem(BaseModel):
    """Reprezentace kampaňového uzlu v hierarchii."""

    id: str | int
    name: str
    url: str = "#"
    total_drops_count: int = 0
    claimed_drops_count: int = 0
    starts_at: str | datetime
    ends_at: str | datetime
    remaining_minutes: int = 0
    drops: list[DropTreeItem] = Field(default_factory=list)

    raw_ends_at: Optional[datetime] = Field(default=None, exclude=True)

    model_config = ConfigDict(arbitrary_types_allowed=True)


class GameTreeItem(BaseModel):
    """Reprezentace herního uzlu v hierarchii."""

    id: Optional[str | int] = None
    name: str
    icon_url: Optional[str] = None
    campaigns: list[CampaignTreeItem] = Field(default_factory=list)

    game_obj: Optional[Game] = Field(default=None, exclude=True)

    model_config = ConfigDict(arbitrary_types_allowed=True)


# Aliasy pro zpětnou kompatibilitu
DropsCampaign = Campaign
BaseDrop = Drop
TimedDrop = Drop

# Rebuild Pydantic schémat pro rozlišení dopředných odkazů
Channel.model_rebuild()
TimedDrop.model_rebuild()
Campaign.model_rebuild()
