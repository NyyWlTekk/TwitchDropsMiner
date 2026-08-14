import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from src.config.settings import Settings
from src.models.models import (
    CampaignTreeItem,
    Channel,
    DropTreeItem,
    DropsCampaign,
    Game,
    GameTreeItem,
)

logger = logging.getLogger("TwitchDrops")


class StreamSelector:
    def __init__(
        self,
        channel_service: Any = None,
        watch_service: Any = None,
        twitch: Any = None,
    ) -> None:
        self._channel_service = channel_service
        self._watch_service = watch_service
        self._twitch = twitch
        self.wanted_games: list[Game] = []

    def _get_watch_service(self) -> Any:
        """Pomocná metoda pro bezpečné získání instance WatchService."""
        return self._watch_service or getattr(self._twitch, "watch_service", None)

    # ==========================================================================
    # 1. LOGIKA PRO VÝBĚR KANÁLU (CHANNEL SELECTION)
    # ==========================================================================

    def select_best_channel(self, channels: list[Channel]) -> Channel | None:
        """Vybere nejlepší kanál ke sledování podle priorit a přesahů kampaní."""
        if not channels:
            return None

        def channel_sort_key(channel: Channel) -> tuple[int, Any]:
            earnable_count = sum(
                1
                for campaign in getattr(channel, "campaigns", [])
                if hasattr(campaign, "can_earn_within") and campaign.can_earn_within()
            )

            base_priority = 999_999
            if self._channel_service and hasattr(self._channel_service, "get_priority"):
                base_priority = self._channel_service.get_priority(channel)

            return (-earnable_count, base_priority)

        sorted_channels = sorted(channels, key=channel_sort_key)

        for channel in sorted_channels:
            if self.can_watch(channel) and self.should_switch(channel):
                return channel

        return None

    def can_watch(self, channel: Any) -> bool:
        """Přesměrováno na WatchService.can_watch(channel)."""
        watch_svc = self._get_watch_service()
        if watch_svc and hasattr(watch_svc, "can_watch"):
            return watch_svc.can_watch(channel)

        # Fallback pouze pro případ, že WatchService ještě není dostupná
        return getattr(channel, "online", True) and getattr(channel, "drops_enabled", True)

    def should_switch(self, channel: Any) -> bool:
        """Přesměrováno na WatchService.should_switch(channel)."""
        watch_svc = self._get_watch_service()
        if watch_svc and hasattr(watch_svc, "should_switch"):
            return watch_svc.should_switch(channel)

        return True

    # ==========================================================================
    # 2. SPRÁVA FRONTY HER A NASTAVENÍ (GAME QUEUE MANAGEMENT)
    # ==========================================================================

    def build_wanted_games(
        self,
        settings: Optional[Settings] = None,
        campaigns: Optional[list[DropsCampaign]] = None,
    ) -> list[Game]:
        """Přebuduje seznam požadovaných her podle aktuálního nastavení a inventáře."""
        if settings is None and self._twitch:
            settings = getattr(self._twitch, "settings", None)

        if campaigns is None and self._twitch:
            inventory_svc = getattr(self._twitch, "inventory_service", None)
            if inventory_svc and hasattr(inventory_svc, "get_inventory"):
                campaigns = inventory_svc.get_inventory()
            else:
                campaigns = getattr(self._twitch, "inventory", [])

        if not settings or campaigns is None:
            logger.warning("Cannot build wanted games: missing settings or campaigns.")
            return []

        self.wanted_games = self.get_wanted_games(settings, campaigns)
        return self.wanted_games

    def handle_prioritize_badge_games(
        self,
        settings: Settings,
        campaigns: list[DropsCampaign],
    ) -> bool:
        """Přeřadí settings.games_to_watch tak, aby hry s nezískanými odznaky byly první."""
        if not getattr(settings, "mine_badges_first", False) or not campaigns:
            return False

        filtered_inventory = self.get_filtered_queue(campaigns)
        badge_games: set[str] = set()

        for campaign in filtered_inventory:
            if not getattr(campaign, "active", True):
                continue

            game_obj = getattr(campaign, "game", None)
            game_name = (
                game_obj.name
                if hasattr(game_obj, "name")
                else str(game_obj or "").strip()
            )

            for drop in getattr(campaign, "drops", []):
                is_badge = (
                    getattr(drop, "is_badge", False)
                    or "badge" in getattr(drop, "name", "").lower()
                )
                is_claimed = (
                    getattr(drop, "is_claimed", False)
                    or getattr(drop, "claimed", False)
                    or getattr(drop, "completed", False)
                )

                if is_badge and not is_claimed and game_name:
                    badge_games.add(game_name)
                    break

        if not badge_games:
            return False

        current_games = getattr(settings, "games_to_watch", []) or []
        with_badges = [g for g in current_games if g in badge_games]
        without_badges = [g for g in current_games if g not in badge_games]

        new_queue = with_badges + without_badges

        if new_queue != current_games:
            settings.games_to_watch = new_queue
            settings.save()

            watch_svc = self._get_watch_service()
            if watch_svc and hasattr(watch_svc, "request_reevaluation"):
                watch_svc.request_reevaluation()

            return True

        return False

    def process_auto_add_and_sort(
        self, settings: Settings, queue: list[DropsCampaign]
    ) -> None:
        """Sjednotí auto-add, prioritize-badges a auto-sort her do jedné metody."""
        filtered = self.get_filtered_queue(queue)

        if getattr(settings, "auto_add_all_games", False) and queue:
            ignored = {
                g.strip().lower() for g in getattr(settings, "ignored_games", [])
            }
            existing = {g.strip().lower() for g in settings.games_to_watch}
            newly_added = False

            for c in filtered:
                game_obj = getattr(c, "game", None)
                game_name = (
                    game_obj.name.strip()
                    if hasattr(game_obj, "name")
                    else str(game_obj or "").strip()
                )
                if (
                    game_name
                    and game_name.lower() not in ignored
                    and game_name.lower() not in existing
                ):
                    settings.games_to_watch.append(game_name)
                    existing.add(game_name.lower())
                    newly_added = True

            if newly_added:
                settings.save()

        self.handle_prioritize_badge_games(settings, queue)

        if getattr(settings, "auto_sort_by_end", True):
            if self._sort_games_by_ending_time(settings, filtered):
                settings.save()

    def handle_auto_sort_games(
        self, client: Any, filtered_queue: list[DropsCampaign]
    ) -> None:
        """Přeřadí stávající frontu klienta podle nadcházejících odznaků a konce kampaní."""
        logger.info("Auto-sorting games by pending badges and ending time")

        settings = getattr(client, "settings", None)
        if not settings or not getattr(settings, "games_to_watch", None):
            logger.debug("Skip auto-sorting: games_to_watch is empty.")
            return

        self.handle_prioritize_badge_games(settings, filtered_queue)

        if self._sort_games_by_ending_time(settings, filtered_queue):
            settings.save()

    def get_filtered_queue(
        self, queue: list[DropsCampaign]
    ) -> list[DropsCampaign]:
        """Vrátí pouze nehotové kampaně z queue, které mají sledovatelné dropy."""
        return [
            c
            for c in queue
            if getattr(c, "progress", 0) < 100
            and getattr(c, "has_watchable_drops", False)
        ]

    def _sort_games_by_ending_time(
        self, settings: Settings, filtered_queue: list[DropsCampaign]
    ) -> bool:
        """Pomocná metoda pro seřazení settings.games_to_watch podle konce kampaní."""
        if not settings.games_to_watch:
            return False

        campaign_map: dict[str, list[DropsCampaign]] = {}
        for c in filtered_queue:
            if not getattr(c, "has_watchable_drops", False):
                continue
            c_game = getattr(c, "game", "")
            c_name = c_game.name if hasattr(c_game, "name") else str(c_game)
            if c_name:
                campaign_map.setdefault(c_name.strip().lower(), []).append(c)

        def sort_key(game_name: str) -> tuple[int, datetime]:
            campaigns = campaign_map.get(game_name.strip().lower(), [])
            if not campaigns:
                return (0, datetime.max.replace(tzinfo=timezone.utc))

            dates: list[datetime] = []
            for c in campaigns:
                dt = getattr(c, "end_time", getattr(c, "ends_at", None))
                if isinstance(dt, datetime):
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                    dates.append(dt)

            earliest_end = (
                min(dates) if dates else datetime.max.replace(tzinfo=timezone.utc)
            )
            return (1, earliest_end)

        old_queue = list(settings.games_to_watch)
        settings.games_to_watch.sort(key=sort_key)

        return settings.games_to_watch != old_queue

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

    # ==========================================================================
    # 3. STAVBA NATIVNÍHO STROMU UŽIVATELSKÉ FRONTY (WANTED QUEUE BUILDERS)
    # ==========================================================================

    def get_wanted_game_tree(
        self,
        settings: Settings,
        campaigns: list[DropsCampaign],
        as_json: bool = False,
    ) -> list[GameTreeItem] | list[dict[str, Any]]:
        """Sestaví, seřadí a vyčistí strom požadovaných her a kampaní v jediném kroku."""
        now = datetime.now(timezone.utc)
        watch_service = self._get_watch_service()
        target_game_names = self._get_target_game_names(settings, campaigns)

        logger.debug(
            "🎮 [Tree] Sestavuji strom her (%d cílů, %d kampaní v inventáři)",
            len(target_game_names),
            len(campaigns),
        )

        wanted_games: list[GameTreeItem] = []

        for game_name in target_game_names:
            game_name_lower = game_name.lower()
            matching_campaigns = [
                c for c in campaigns if c.game.name.lower() == game_name_lower
            ]

            if not matching_campaigns:
                continue

            game_obj = matching_campaigns[0].game
            wanted_campaigns: list[CampaignTreeItem] = []

            for campaign in matching_campaigns:
                campaign_item = self._process_campaign(
                    campaign, settings.mining_benefits, watch_service, now
                )
                if campaign_item:
                    wanted_campaigns.append(campaign_item)

            if wanted_campaigns:
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
        final_tree = self._sort_and_clean_queue(wanted_games, auto_sort)

        # Formátování přehledného logu (Top 3 + zbývající)
        top_3 = [game.name for game in final_tree[:3]]
        preview = ", ".join(top_3)
        remaining = len(final_tree) - len(top_3)
        if remaining > 0:
            preview += f" (+{remaining} dalších)"

        logger.info(
            "🎮 [Queue] Načteno %d požadovaných her | Top 3: %s",
            len(final_tree),
            preview if preview else "Žádné",
        )

        if as_json:
            return [game.model_dump(mode="json") for game in final_tree]

        return final_tree

    def _process_campaign(
        self,
        campaign: DropsCampaign,
        mining_benefits: list,
        watch_service: Any,
        now: datetime,
    ) -> CampaignTreeItem | None:
        """Zkontroluje platnost kampaně a sestaví její dropy."""
        if not getattr(campaign, "has_watchable_drops", False):
            return None

        ends_at_dt = getattr(campaign, "ends_at", None)
        if ends_at_dt and isinstance(ends_at_dt, datetime):
            if ends_at_dt.tzinfo is None:
                ends_at_dt = ends_at_dt.replace(tzinfo=timezone.utc)
            if ends_at_dt <= now:
                return None

        wanted_drops: list[DropTreeItem] = []
        for drop in getattr(campaign, "drops", []):
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
            1
            for d in getattr(campaign, "drops", [])
            if getattr(d, "is_claimed", False)
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
            remaining_minutes=getattr(campaign, "remaining_minutes", 0),
            drops=wanted_drops,
        )

    def _process_drop(
        self, drop: Any, mining_benefits: list, watch_service: Any
    ) -> DropTreeItem | None:
        """Zpracuje a vyhodnotí stav jednoho dropu pro strom."""
        if getattr(drop, "is_claimed", False):
            return None

        filtered_benefits = (
            drop.get_wanted_unclaimed_benefits(mining_benefits)
            if hasattr(drop, "get_wanted_unclaimed_benefits")
            else []
        )
        if len(filtered_benefits) <= 0:
            return None

        current_mins = getattr(drop, "current_minutes", 0)
        req_mins = getattr(drop, "required_minutes", 0)
        if req_mins <= 0:
            return None

        is_mining = False
        if watch_service:
            # Volání přesně té metody is_drop_actively_mining ze snímku obrazovky
            if hasattr(watch_service, "is_drop_actively_mining"):
                is_mining = watch_service.is_drop_actively_mining(drop)
            else:
                active_drop = getattr(watch_service, "current_drop", None)
                if active_drop and hasattr(active_drop, "id"):
                    is_mining = str(drop.id) == str(active_drop.id)

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
            status="mining" if is_mining else getattr(drop, "status", "pending"),
            benefits=filtered_benefits,
            is_mining=is_mining,
            is_claimed=getattr(drop, "is_claimed", False),
            can_claim=getattr(drop, "can_claim", False),
            is_stuck=getattr(drop, "is_stuck", False),
            is_in_progress=getattr(drop, "status", "") == "in_progress",
            current_minutes=current_mins,
            required_minutes=req_mins,
            progress=progress_val,
        )

    def _sort_and_clean_queue(
        self, wanted_games: list[GameTreeItem], auto_sort: bool
    ) -> list[GameTreeItem]:
        """Seřadí strom her podle zbývajícího času a konce kampaní a zaloguje stav."""

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

            # Detailní výpis fronty generujeme pouze v DEBUG režimu
            if logger.isEnabledFor(logging.DEBUG):
                queue_log = []
                for g in wanted_games:
                    e_str = "N/A"
                    if g.campaigns:
                        e_times = [str(c.ends_at) for c in g.campaigns if c.ends_at]
                        if e_times:
                            e_str = min(e_times)
                    queue_log.append(f"{g.name} (Ends: {e_str})")

                logger.debug("Wanted games queue: %s", " -> ".join(queue_log))

        return wanted_games
