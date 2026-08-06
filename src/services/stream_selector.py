import logging

from datetime import datetime, timezone

from src.config.settings import Settings
from src.models.campaign import DropsCampaign
from src.models.game import Game

logger = logging.getLogger(__name__)


class StreamSelector:
    def _get_wanted_game_tree(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[dict]:
        """
        Get the hierarchical tree of wanted items (Games -> Campaigns -> Drops -> Benefits).
        Ignoring strict 'can earn within' time constraint to preserve short/ending campaigns.
        """
        wanted_games = []
        mining_benefits = settings.mining_benefits
        now = datetime.now(timezone.utc)

        auto_add = getattr(settings, "auto_add_all_games", False)
        
        # 1. Určení cílových her
        if auto_add or not settings.games_to_watch:
            ignored_games_lower = {g.lower() for g in getattr(settings, "ignored_games", [])}
            target_game_names = []
            for campaign in campaigns:
                g_name = campaign.game.name if hasattr(campaign.game, "name") else str(campaign.game)
                if g_name.lower() not in ignored_games_lower and g_name not in target_game_names:
                    target_game_names.append(g_name)
        else:
            target_game_names = settings.games_to_watch

        for game_name in target_game_names:
            wanted_campaigns = []
            game_obj = None
            game_name_lower = game_name.lower()

            # Vyhledání kampaní pro danou hru
            for campaign in campaigns:
                if campaign.game.name.lower() != game_name_lower:
                    continue

                # Rychlé vyřazení kampaní, které nemají žádné sledovatelné dropy (> 0 minut)
                if not campaign.has_watchable_drops:
                    continue

                if game_obj is None:
                    game_obj = campaign.game

                # 2. Kontrola platnosti kampaně: Musí projít probíhající (i ty co brzy končí)
                ends_at_dt = getattr(campaign, "ends_at", None)
                if ends_at_dt and isinstance(ends_at_dt, datetime):
                    if ends_at_dt.tzinfo is None:
                        ends_at_dt = ends_at_dt.replace(tzinfo=timezone.utc)
                    if ends_at_dt <= now:
                        continue

                wanted_drops = []
                for drop in campaign.drops:
                    # Přeskočit pouze pokud už je odměna vybraná (claimed)
                    if getattr(drop, "is_claimed", False):
                        continue

                    filtered_benefits = drop.get_wanted_unclaimed_benefits(mining_benefits)

                    if len(filtered_benefits) > 0:
                        current_mins = getattr(drop, "current_minutes", 0)
                        req_mins = getattr(drop, "required_minutes", 0)

                        # Přeskočit dropy, které nevyžadují žádný čas (sub-dropy, badge s 0m atd.)
                        if req_mins <= 0:
                            continue

                        progress_val = getattr(drop, "progress", 0)
                        if not progress_val and req_mins > 0:
                            progress_val = int((current_mins / req_mins) * 100)

                        wanted_drops.append(
                            {
                                "name": drop.name,
                                "benefits": filtered_benefits,
                                "is_claimed": getattr(drop, "is_claimed", False),
                                "can_claim": getattr(drop, "can_claim", False),
                                "current_minutes": current_mins,
                                "required_minutes": req_mins,
                                "progress": progress_val,
                            }
                        )

                if len(wanted_drops) > 0:
                    claimed_count = sum(1 for d in campaign.drops if getattr(d, "is_claimed", False))
                    total_count = len(campaign.drops)

                    starts_at = getattr(campaign, "starts_at", None)
                    ends_at = getattr(campaign, "ends_at", None)
                    starts_at_str = starts_at.isoformat() if hasattr(starts_at, "isoformat") else (str(starts_at) if starts_at else None)
                    ends_at_str = ends_at.isoformat() if hasattr(ends_at, "isoformat") else (str(ends_at) if ends_at else None)

                    wanted_campaigns.append(
                        {
                            "id": campaign.id,
                            "name": campaign.name,
                            "url": campaign.campaign_url,
                            "starts_at": starts_at_str,
                            "ends_at": ends_at_str,
                            "_raw_ends_at": ends_at,
                            "drops": wanted_drops,
                            "claimed_drops_count": claimed_count,
                            "total_drops_count": total_count,
                        }
                    )

            if len(wanted_campaigns) > 0:
                all_remaining_mins = [
                    max(0, d["required_minutes"] - d["current_minutes"])
                    for c in wanted_campaigns
                    for d in c["drops"]
                ]
                game_remaining_mins = max(all_remaining_mins, default=0)

                wanted_games.append(
                    {
                        "game_id": game_obj.id if game_obj else None,
                        "game_name": game_name,
                        "game_icon": game_obj.box_art_url if game_obj else None,
                        "game_obj": game_obj,
                        "campaigns": wanted_campaigns,
                        "total_remaining_minutes": game_remaining_mins,
                    }
                )

        # 3. Řazení fronty her s bezpečným ošetřením časových pásem
        def get_game_sort_key(game_item):
            end_times = []
            max_progress = 0
            for c in game_item["campaigns"]:
                raw_end = c.get("_raw_ends_at")
                if raw_end and isinstance(raw_end, datetime):
                    if raw_end.tzinfo is None:
                        raw_end = raw_end.replace(tzinfo=timezone.utc)
                    end_times.append(raw_end)
                elif c.get("ends_at"):
                    try:
                        dt = datetime.fromisoformat(c["ends_at"])
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        end_times.append(dt)
                    except Exception:
                        pass

                for d in c["drops"]:
                    prog = d.get("progress", 0)
                    if 0 < prog < 100 and prog > max_progress:
                        max_progress = prog

            earliest_end = min(end_times) if end_times else datetime.max.replace(tzinfo=timezone.utc)
            return (earliest_end, -max_progress)

        if getattr(settings, "auto_sort_by_end", True):
            wanted_games.sort(key=get_game_sort_key)

            queue_log = []
            for g in wanted_games:
                e_str = "N/A"
                if g["campaigns"]:
                    e_times = [c.get("ends_at") for c in g["campaigns"] if c.get("ends_at")]
                    if e_times:
                        e_str = min(e_times)
                queue_log.append(f"{g['game_name']} (Ends: {e_str})")

            logger.info("Wanted games queue: %s", " -> ".join(queue_log))

        for g in wanted_games:
            for c in g["campaigns"]:
                c.pop("_raw_ends_at", None)

        return wanted_games

    def get_wanted_game_tree(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[dict]:
        tree = [
            {**game, "game_obj": None} for game in self._get_wanted_game_tree(settings, campaigns)
        ]
        
        return tree

    def get_wanted_games(self, settings: Settings, campaigns: list[DropsCampaign]) -> list[Game]:
        return [game["game_obj"] for game in self._get_wanted_game_tree(settings, campaigns)]
