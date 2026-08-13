import logging
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field

from src.config.settings import Settings
from src.models.models import DropsCampaign, Game

from src.models.models import (
    CampaignTreeItem,
    DropTreeItem,
    GameTreeItem,
)
import logging

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)

# ==============================================================================
# StreamSelector
# ==============================================================================


class StreamSelector:
    def _get_target_game_names(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[str]:
        """Určí seznam her, které se mají sledovat podle nastavení."""
        auto_add = getattr(settings, "auto_add_all_games", False)
        if auto_add or not settings.games_to_watch:
            ignored_games_lower = {
                g.lower() for g in getattr(settings, "ignored_games", [])
            }
            target_game_names = []
            for campaign in campaigns:
                g_name = (
                    campaign.game.name
                    if hasattr(campaign.game, "name")
                    else str(campaign.game)
                )
                if (
                    g_name.lower() not in ignored_games_lower
                    and g_name not in target_game_names
                ):
                    target_game_names.append(g_name)
            return target_game_names

        return settings.games_to_watch

    def _process_drop(
        self, drop: Any, mining_benefits: list, watch_service: Any
    ) -> DropTreeItem | None:
        """Zpracuje a vyhodnotí stav jednoho dropu. Vrací None, pokud drop nevyhovuje."""
        if drop.is_claimed:
            return None

        filtered_benefits = drop.get_wanted_unclaimed_benefits(mining_benefits)
        if len(filtered_benefits) <= 0:
            return None

        current_mins = drop.current_minutes
        req_mins = getattr(drop, "required_minutes", 0)
        if req_mins <= 0:
            return None

        # Vyhodnocení těžby
        is_mining = False
        if watch_service:
            if hasattr(watch_service, "is_drop_actively_mining"):
                is_mining = watch_service.is_drop_actively_mining(drop)
            else:
                active_drop = getattr(watch_service, "current_drop", None)
                if active_drop and hasattr(active_drop, "id"):
                    is_mining = str(drop.id) == str(active_drop.id)

        # Výpočet progressu
        raw_progress = getattr(drop, "progress", None)
        if raw_progress is not None:
            progress_val = (
                round(raw_progress * 100)
                if raw_progress <= 1.0
                else round(raw_progress)
            )
        elif req_mins > 0:
            progress_val = int((current_mins / req_mins) * 100)
        else:
            progress_val = 0

        return DropTreeItem(
            id=drop.id,
            name=drop.name,
            image_url=getattr(drop, "image_url", None),
            status="mining" if is_mining else drop.status,
            benefits=filtered_benefits,
            is_mining=is_mining,
            is_claimed=drop.is_claimed,
            can_claim=drop.can_claim,
            is_stuck=getattr(drop, "is_stuck", False),
            is_in_progress=drop.status == "in_progress",
            current_minutes=current_mins,
            required_minutes=req_mins,
            progress=progress_val,
        )

    def _process_campaign(
        self,
        campaign: DropsCampaign,
        mining_benefits: list,
        watch_service: Any,
        now: datetime,
    ) -> CampaignTreeItem | None:
        """Zkontroluje platnost kampaně a sestaví její dropy."""
        if not campaign.has_watchable_drops:
            return None

        ends_at_dt = getattr(campaign, "ends_at", None)
        if ends_at_dt and isinstance(ends_at_dt, datetime):
            if ends_at_dt.tzinfo is None:
                ends_at_dt = ends_at_dt.replace(tzinfo=timezone.utc)
            if ends_at_dt <= now:
                return None

        wanted_drops: list[DropTreeItem] = []
        for drop in campaign.drops:
            drop_item = self._process_drop(drop, mining_benefits, watch_service)
            if drop_item:
                wanted_drops.append(drop_item)

        if not wanted_drops:
            return None

        campaign_url = getattr(
            campaign, "url", getattr(campaign, "campaign_url", "#")
        )
        total_drops = len(getattr(campaign, "drops", []))
        claimed_drops = sum(
            1 for d in getattr(campaign, "drops", []) if getattr(d, "is_claimed", False)
        )

        starts_at_val = (
            campaign.starts_at.isoformat()
            if hasattr(campaign.starts_at, "isoformat")
            else str(campaign.starts_at)
        )
        ends_at_val = (
            campaign.ends_at.isoformat()
            if hasattr(campaign.ends_at, "isoformat")
            else str(campaign.ends_at)
        )

        return CampaignTreeItem(
            id=campaign.id,
            name=campaign.name,
            url=campaign_url,
            total_drops_count=total_drops,
            claimed_drops_count=claimed_drops,
            starts_at=starts_at_val,
            ends_at=ends_at_val,
            raw_ends_at=ends_at_dt,
            remaining_minutes=campaign.remaining_minutes,
            drops=wanted_drops,
        )

    def _sort_and_clean_queue(
        self, wanted_games: list[GameTreeItem], auto_sort: bool
    ) -> list[GameTreeItem]:
        """Seřadí frontu her podle zbývajícího času a konce kampaní a zaloguje stav."""

        def get_game_sort_key(game_item: GameTreeItem) -> tuple[int, datetime]:
            total_game_remaining = sum(
                c.remaining_minutes for c in game_item.campaigns
            )
            end_times: list[datetime] = []
            for c in game_item.campaigns:
                raw_end = c.raw_ends_at
                if raw_end and isinstance(raw_end, datetime):
                    if raw_end.tzinfo is None:
                        raw_end = raw_end.replace(tzinfo=timezone.utc)
                    end_times.append(raw_end)
                elif c.ends_at:
                    try:
                        dt = (
                            c.ends_at
                            if isinstance(c.ends_at, datetime)
                            else datetime.fromisoformat(str(c.ends_at))
                        )
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        end_times.append(dt)
                    except Exception:
                        pass

            earliest_end = (
                min(end_times)
                if end_times
                else datetime.max.replace(tzinfo=timezone.utc)
            )
            return (total_game_remaining, earliest_end)

        if auto_sort:
            wanted_games.sort(key=get_game_sort_key)

            queue_log = []
            for g in wanted_games:
                e_str = "N/A"
                if g.campaigns:
                    e_times = [str(c.ends_at) for c in g.campaigns if c.ends_at]
                    if e_times:
                        e_str = min(e_times)
                queue_log.append(f"{g.name} (Ends: {e_str})")

            logger.info("Wanted games queue: %s", " -> ".join(queue_log))

        return wanted_games

    def _get_wanted_game_tree(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[GameTreeItem]:
        """Sestaví hierarchický strom požadovaných položek jako Pydantic objekty."""
        wanted_games: list[GameTreeItem] = []
        now = datetime.now(timezone.utc)
        watch_service = getattr(self, "_watch_service", None) or getattr(
            getattr(self, "_twitch", None), "_watch_service", None
        )

        target_game_names = self._get_target_game_names(settings, campaigns)

        for game_name in target_game_names:
            game_name_lower = game_name.lower()
            wanted_campaigns: list[CampaignTreeItem] = []
            game_obj = None

            for campaign in campaigns:
                if campaign.game.name.lower() != game_name_lower:
                    continue

                if game_obj is None:
                    game_obj = campaign.game

                campaign_item = self._process_campaign(
                    campaign, settings.mining_benefits, watch_service, now
                )
                if campaign_item:
                    wanted_campaigns.append(campaign_item)

            if wanted_campaigns and game_obj:
                icon_url = getattr(
                    game_obj,
                    "box_art_url",
                    getattr(game_obj, "icon_url", None),
                )
                wanted_games.append(
                    GameTreeItem(
                        id=getattr(game_obj, "id", None),
                        name=game_obj.name,
                        icon_url=icon_url,
                        game_obj=game_obj,
                        campaigns=wanted_campaigns,
                    )
                )

        auto_sort = getattr(settings, "auto_sort_by_end", True)
        return self._sort_and_clean_queue(wanted_games, auto_sort)

    def get_wanted_game_tree(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[dict[str, Any]]:
        """Vrací kompletní strom struktur pro GUI / WebSocket API bez ne-serializovatelných objektů."""
        tree = self._get_wanted_game_tree(settings, campaigns)
        # model_dump(mode="json") automaticky vynechá pole s Field(exclude=True) tj. game_obj a raw_ends_at
        return [game.model_dump(mode="json") for game in tree]

    def get_wanted_games(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[Game]:
        """Vrací čistý seznam objektů Game pro plánovač těžby."""
        tree = self._get_wanted_game_tree(settings, campaigns)
        return [
            game.game_obj
            for game in tree
            if game.game_obj is not None
        ]
