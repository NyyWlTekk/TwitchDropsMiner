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

                    # Vrácena filtrace podle chtěných/nevybraných benefitů
                    filtered_benefits = drop.get_wanted_unclaimed_benefits(mining_benefits)
                    if len(filtered_benefits) <= 0:
                        continue

                    current_mins = getattr(drop, "current_minutes", 0)
                    req_mins = getattr(drop, "required_minutes", 0)

                    # Přeskočit dropy, které nevyžadují žádný čas (sub-dropy, badge s 0m atd.)
                    if req_mins <= 0:
                        continue

                    is_mining = getattr(drop, "is_mining", False)
                    is_claimed = getattr(drop, "is_claimed", False)
                    can_claim = getattr(drop, "can_claim", False)

                    # Bezpečný výpočet progressu (podpora pro desetiná čísla 0.0–1.0 i přímá %)
                    raw_progress = getattr(drop, "progress", None)
                    if raw_progress is not None:
                        progress_val = round(raw_progress * 100) if raw_progress <= 1.0 else round(raw_progress)
                    elif req_mins > 0:
                        progress_val = int((current_mins / req_mins) * 100)
                    else:
                        progress_val = 0

                    # Určení, zda je drop rozpracovaný (má načtené minuty, ale zrovna se netěží ani není hotový)
                    is_in_progress = current_mins > 0 and not is_claimed and not can_claim and not is_mining

                    wanted_drops.append(
                        {
                            "id": getattr(drop, "id", None),
                            "name": drop.name,
                            "image_url": getattr(drop, "image_url", ""),
                            "benefits": filtered_benefits,
                            "is_mining": is_mining,
                            "is_claimed": is_claimed,
                            "can_claim": can_claim,
                            "is_in_progress": is_in_progress,
                            "current_minutes": current_mins,
                            "required_minutes": req_mins,
                            "progress": progress_val,
                        }
                    )

                if wanted_drops:
                    campaign_url = getattr(campaign, "url", getattr(campaign, "campaign_url", "#"))
                    total_drops = len(getattr(campaign, "drops", []))
                    claimed_drops = sum(1 for d in getattr(campaign, "drops", []) if getattr(d, "is_claimed", False))

                    wanted_campaigns.append(
                        {
                            "id": campaign.id,
                            "name": campaign.name,
                            "url": campaign_url,
                            "total_drops_count": total_drops,
                            "claimed_drops_count": claimed_drops,
                            "starts_at": campaign.starts_at.isoformat() if hasattr(campaign.starts_at, "isoformat") else str(campaign.starts_at),
                            "ends_at": campaign.ends_at.isoformat() if hasattr(campaign.ends_at, "isoformat") else str(campaign.ends_at),
                            "remaining_minutes": campaign.remaining_minutes,
                            "drops": wanted_drops,
                        }
                    )

            if wanted_campaigns and game_obj:
                icon_url = getattr(game_obj, "box_art_url", getattr(game_obj, "icon_url", None))
                wanted_games.append(
                    {
                        "id": getattr(game_obj, "id", None),
                        "name": game_obj.name,
                        "icon_url": icon_url,
                        "_game_obj": game_obj,
                        "campaigns": wanted_campaigns,
                    }
                )

        return wanted_games

        # 3. Řazení fronty her podle zbývajícího času a konce kampaní
        def get_game_sort_key(game_item):
            total_game_remaining = sum(c.get("remaining_minutes", 0) for c in game_item["campaigns"])
            
            end_times = []
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

            earliest_end = min(end_times) if end_times else datetime.max.replace(tzinfo=timezone.utc)
            return (total_game_remaining, earliest_end)

        if getattr(settings, "auto_sort_by_end", True):
            wanted_games.sort(key=get_game_sort_key)

            queue_log = []
            for g in wanted_games:
                e_str = "N/A"
                if g["campaigns"]:
                    e_times = [c.get("ends_at") for c in g["campaigns"] if c.get("ends_at")]
                    if e_times:
                        e_str = min(e_times)
                queue_log.append(f"{g['name']} (Ends: {e_str})")

            logger.info("Wanted games queue: %s", " -> ".join(queue_log))

        # Úklid pomocného klíče _raw_ends_at před vrácením
        for g in wanted_games:
            for c in g["campaigns"]:
                c.pop("_raw_ends_at", None)

        return wanted_games

    def get_wanted_game_tree(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[dict]:
        """Vrací kompletní strom struktur pro GUI / API bez ne-serializovatelných objektů."""
        tree = self._get_wanted_game_tree(settings, campaigns)
        clean_tree = []
        for game in tree:
            game_copy = game.copy()
            game_copy.pop("_game_obj", None)  # Odstraníme objekt Game před odesláním do JSON/GUI
            clean_tree.append(game_copy)
        return clean_tree

    def get_wanted_games(self, settings: Settings, campaigns: list[DropsCampaign]) -> list[Game]:
        """Vrací čistý seznam objektů Game pro plánovač těžby."""
        tree = self._get_wanted_game_tree(settings, campaigns)
        return [game["_game_obj"] for game in tree if "_game_obj" in game and game["_game_obj"] is not None]
