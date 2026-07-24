from datetime import datetime, timedelta, timezone

from src.config.settings import Settings
from src.models.campaign import DropsCampaign
from src.models.game import Game


class StreamSelector:
    def _get_wanted_game_tree(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[dict]:
        """
        Get the hierarchical tree of wanted items (Games -> Campaigns -> Drops -> Benefits).
        Ignoring 'can earn within' time constraint.
        """
        wanted_games = []
        games_to_watch = settings.games_to_watch
        mining_benefits = settings.mining_benefits
        next_hour = datetime.now(timezone.utc) + timedelta(hours=1)

        for game_name in games_to_watch:
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

                    # Získání a zformátování datumu startu a konce
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
                            "drops": wanted_drops,
                            "claimed_drops_count": claimed_count,
                            "total_drops_count": total_count,
                        }
                    )

            if len(wanted_campaigns) > 0:
                # Zbývající čas hry je MAXIMÁLNÍ zbývající čas z dropů
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

        return wanted_games

    def get_wanted_game_tree(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[dict]:
        return [
            {**game, "game_obj": None} for game in self._get_wanted_game_tree(settings, campaigns)
        ]

    def get_wanted_games(self, settings: Settings, campaigns: list[DropsCampaign]) -> list[Game]:
        return [game["game_obj"] for game in self._get_wanted_game_tree(settings, campaigns)]
