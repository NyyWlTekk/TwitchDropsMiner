import logging
from datetime import datetime, timedelta, timezone

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
        Ignoring 'can earn within' time constraint.
        """
        wanted_games = []
        mining_benefits = settings.mining_benefits
        next_hour = datetime.now(timezone.utc) + timedelta(hours=1)

        auto_add = getattr(settings, "auto_add_all_games", False)
        # Determine target games based on auto_add_all_games setting
        if auto_add:
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

            # Find all campaigns for this game
            for campaign in campaigns:
                if campaign.game.name.lower() != game_name_lower:
                    continue

                if game_obj is None:
                    game_obj = campaign.game

                if not campaign.can_earn_within(next_hour):
                    continue

                wanted_drops = []
                for drop in campaign.drops:
                    # Skip if already claimed
                    if drop.is_claimed:
                        continue

                    # Skip if fully watched but stuck/unclaimed (e.g. 30/30 minutes)
                    if hasattr(drop, "current_minutes") and hasattr(drop, "required_minutes"):
                        if drop.current_minutes >= drop.required_minutes:
                            continue

                    filtered_benefits = drop.get_wanted_unclaimed_benefits(mining_benefits)

                    if len(filtered_benefits) > 0:
                        current_mins = getattr(drop, "current_minutes", 0)
                        req_mins = getattr(drop, "required_minutes", 0)

                        # Calculate progress percentage safely
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
                    # Calculate real campaign statistics from all drops in campaign
                    claimed_count = sum(1 for d in campaign.drops if getattr(d, "is_claimed", False))
                    total_count = len(campaign.drops)

                    # Get and format start and end dates
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
                            "_raw_ends_at": ends_at,  # Internal raw datetime object for sorting
                            "drops": wanted_drops,
                            "claimed_drops_count": claimed_count,
                            "total_drops_count": total_count,
                        }
                    )

            if len(wanted_campaigns) > 0:
                # Remaining time is MAX remaining time from drops
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

        # --- SORT WANTED GAMES QUEUE ---
        def get_game_sort_key(game_item):
            end_times = []
            max_progress = 0
            for c in game_item["campaigns"]:
                raw_end = c.get("_raw_ends_at")
                if raw_end and isinstance(raw_end, datetime):
                    end_times.append(raw_end)
                elif c.get("ends_at"):
                    try:
                        end_times.append(datetime.fromisoformat(c["ends_at"]))
                    except Exception:
                        pass

                for d in c["drops"]:
                    prog = d.get("progress", 0)
                    if 0 < prog < 100 and prog > max_progress:
                        max_progress = prog

            # Default to max datetime if no campaign end date is found
            earliest_end = min(end_times) if end_times else datetime.max.replace(tzinfo=timezone.utc)

            # Primary sort: Earliest ending campaign
            # Secondary sort: Highest active progress (negative value to sort descending)
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

        # Clean up internal raw datetimes before returning payload
        for g in wanted_games:
            for c in g["campaigns"]:
                c.pop("_raw_ends_at", None)

        return wanted_games

    def get_wanted_game_tree(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[dict]:
        return [
            {**game, "game_obj": None} for game in self._get_wanted_game_tree(settings, campaigns)
        ]

    def get_wanted_games(self, settings: Settings, campaigns: list[DropsCampaign]) -> list[Game]:
        return [game["game_obj"] for game in self._get_wanted_game_tree(settings, campaigns)]
