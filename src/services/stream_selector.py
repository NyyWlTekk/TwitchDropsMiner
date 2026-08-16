import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Optional

from src.config.settings import Settings
from src.models.models import (
    CampaignTreeItem,
    Channel,
    DropTreeItem,
    DropsCampaign,
    GameTreeItem,
)

logger = logging.getLogger("TwitchDrops")


def _ensure_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Zajistí, že datetime objekt má nastavenou UTC časovou zónu."""
    if not isinstance(dt, datetime):
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _norm_game_name(name: Optional[str]) -> str:
    """Normalizuje název hry pro konzistentní porovnávání."""
    return name.strip().lower() if name else ""


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
        self.wanted_games: list[GameTreeItem] = []
        self._last_diagnostic_sig = None
        self._last_queue_sig: tuple[int, tuple[str, ...]] | None = None
        self._current_queue: list[GameTreeItem] = []

    def _get_watch_service(self) -> Any:
        if self._watch_service is not None:
            return self._watch_service
        if self._twitch is not None:
            return self._twitch.watch_service
        return None

    # ==========================================================================
    # 1. LOGIKA PRO VÝBĚR KANÁLU (CHANNEL SELECTION)
    # ==========================================================================

    def select_best_channel(self, channels: list[Channel]) -> list[Channel]:
        """Vrátí kandidátské kanály seřazené podle priority her ve frontě,
        času konce kampaně (nejdříve končící první) a rozpracovaného pokroku.
        """
        if not channels:
            return []

        queue = self._current_queue
        if not queue:
            logger.warning("StreamSelector: _current_queue je prázdná, nelze vybrat kanál.")
            return []

        def _extract_game_name(game_obj: Any) -> str | None:
            if not game_obj:
                return None
            if isinstance(game_obj, str):
                return game_obj
            if isinstance(game_obj, dict):
                return game_obj.get("name") or game_obj.get("displayName")
            return getattr(game_obj, "name", None)

        # Mapování názvu hry na její pozici (index) ve frontě
        game_order = {}
        for idx, item in enumerate(queue):
            if g_name := _extract_game_name(getattr(item, "game", item)):
                game_order[_norm_game_name(g_name)] = idx

        games_with_channels: dict[int, list[Channel]] = {}

        for ch in channels:
            if not ch.can_watch_channel:
                continue

            # 1. Zjistíme hru, kterou streamer AKTUÁLNĚ vysílá
            raw_current_game = _extract_game_name(ch.game)
            if not raw_current_game:
                continue
            
            current_game_norm = _norm_game_name(raw_current_game)

            # 2. Ověříme, zda aktuálně vysílaná hra je v našem seznamu přání (Queue)
            if current_game_norm not in game_order:
                continue

            # 3. Ověříme, zda pro tuto AKTUÁLNĚ VYSÍLANOU hru existuje těžitelná kampaň
            has_valid_earnable_campaign = False
            for campaign in ch.campaigns:
                if getattr(campaign, "is_campaign_earnable", False):
                    camp_game = _extract_game_name(getattr(campaign, "game", None))
                    if camp_game and _norm_game_name(camp_game) == current_game_norm:
                        has_valid_earnable_campaign = True
                        break

            if not has_valid_earnable_campaign:
                continue

            # Zařadíme kanál pod index jeho aktuálně vysílané hry
            game_idx = game_order[current_game_norm]
            if game_idx not in games_with_channels:
                games_with_channels[game_idx] = []
            if ch not in games_with_channels[game_idx]:
                games_with_channels[game_idx].append(ch)

        # Pomocná funkce pro řazení kanálů v rámci stejné hry
        def channel_sort_key(channel: Channel) -> tuple[datetime, float, int, int]:
            # Získáme aktivní kampaně pro aktuální hru
            earnable_campaigns = [
                c for c in channel.campaigns if getattr(c, "is_campaign_earnable", False)
            ]
            
            # 1. Nejbližší čas konce kampaně (nejdříve končící má přednost)
            earliest_end = min(
                (getattr(c, "ends_at", datetime.max) or datetime.max for c in earnable_campaigns),
                default=datetime.max
            )
            
            # 2. Aktuální pokrok (vyšší pokrok má přednost -> záporná hodnota)
            max_progress = max(
                (getattr(c, "progress", 0.0) or 0.0 for c in earnable_campaigns),
                default=0.0
            )

            # 3. Počet těžitelných kampaní na kanálu
            earnable_count = len(earnable_campaigns)

            # 4. Vnitřní priority kanálu
            base_priority = 999_999
            if self._channel_service is not None:
                base_priority = self._channel_service.get_priority(channel)

            return (earliest_end, -max_progress, -earnable_count, base_priority)

        # Sestavení finálního seřazeného seznamu
        ordered_candidates: list[Channel] = []
        for game_idx in sorted(games_with_channels.keys()):
            candidates = sorted(games_with_channels[game_idx], key=channel_sort_key)
            for ch in candidates:
                if ch not in ordered_candidates:
                    ordered_candidates.append(ch)

        return ordered_candidates
        
    # ==========================================================================
    # 2. SPRÁVA FRONTY HER A NASTAVENÍ (GAME QUEUE MANAGEMENT)
    # ==========================================================================

    def build_wanted_games(
        self,
        settings: Optional[Settings] = None,
        campaigns: Optional[list[DropsCampaign]] = None,
        as_json: bool = False,
    ) -> list[GameTreeItem] | list[dict[str, Any]]:
        # 1. Ochrana před předčasným výpočtem — dokud koordinátor není ready, vyčkáváme
        if self._twitch is not None:
            coord = getattr(self._twitch, "inventory_coordinator", None)
            if coord is not None and not getattr(coord, "is_ready", False):
                logger.debug("⏳ [StreamSelector] Přeskakuji build_wanted_games — inventář ještě není kompletní.")
                return []

        # 2. Fallback pro settings z instance _twitch
        if settings is None and self._twitch is not None:
            settings = getattr(self._twitch, "settings", None)

        # 3. Fallback pro campaigns z instance _twitch
        if campaigns is None and self._twitch is not None:
            if getattr(self._twitch, "inventory_service", None) is not None:
                campaigns = self._twitch.inventory_service.get_inventory()
            else:
                campaigns = getattr(self._twitch, "inventory", [])

        # 4. Ochrana před chybějícími nastaveními nebo prázdným seznamem kampaní
        if settings is None or not campaigns:
            if settings is None:
                logger.warning("Cannot build wanted games: missing settings.")
            return []

        # 5. Samotný výpočet a uložení stromu
        tree_result = self.get_wanted_game_tree(settings, campaigns, as_json=as_json)

        # Do vnitřního stavu instance si ukladáme objektovou strukturu (pokud nebyl vyžadován JSON)
        if not as_json and isinstance(tree_result, list):
            self.wanted_games = tree_result

        return tree_result

    def handle_prioritize_badge_games(
        self,
        settings: Settings,
        campaigns: list[DropsCampaign],
    ) -> bool:
        """Přeřadí settings.games_to_watch tak, aby hry s nezískanými odznaky byly první."""
        if not settings.mine_badges_first or not campaigns:
            return False

        filtered_inventory = self.get_filtered_queue(campaigns)
        badge_games: set[str] = set()

        for campaign in filtered_inventory:
            if not campaign.active:
                continue

            game_name = _norm_game_name(campaign.game.name if campaign.game else "")

            for drop in campaign.drops:
                is_badge = drop.is_badge or "badge" in drop.name.lower()
                if is_badge and not drop.is_claimed and game_name:
                    badge_games.add(game_name)
                    break

        if not badge_games:
            return False

        current_games = settings.games_to_watch or []
        with_badges = [g for g in current_games if _norm_game_name(g) in badge_games]
        without_badges = [g for g in current_games if _norm_game_name(g) not in badge_games]

        new_queue = with_badges + without_badges

        if new_queue != current_games:
            settings.games_to_watch = new_queue
            settings.save()

            watch_svc = self._get_watch_service()
            if watch_svc is not None:
                watch_svc.request_reevaluation()

            return True

        return False

    def process_auto_add_and_sort(
        self, settings: Settings, queue: list[DropsCampaign]
    ) -> None:
        """Sjednotí auto-add, prioritize-badges a auto-sort her do jedné metody."""
        filtered = self.get_filtered_queue(queue)

        if settings.auto_add_all_games and queue:
            ignored = {_norm_game_name(g) for g in settings.ignored_games}
            existing = {_norm_game_name(g) for g in settings.games_to_watch}
            newly_added = False

            for c in filtered:
                game_raw = c.game.name if c.game else ""
                game_norm = _norm_game_name(game_raw)
                if game_norm and game_norm not in ignored and game_norm not in existing:
                    settings.games_to_watch.append(game_raw.strip())
                    existing.add(game_norm)
                    newly_added = True

            if newly_added:
                settings.save()

        self.handle_prioritize_badge_games(settings, queue)

        if settings.auto_sort_by_end:
            if self._sort_games_by_ending_time(settings, filtered):
                settings.save()

    def handle_auto_sort_games(
        self, client: Any, filtered_queue: list[DropsCampaign]
    ) -> None:
        """Přeřadí stávající frontu klienta podle nadcházejících odznaků a konce kampaní."""
        logger.info("Auto-sorting games by pending badges and ending time")

        settings = client.settings if client is not None else None
        if not settings or not settings.games_to_watch:
            logger.debug("Skip auto-sorting: games_to_watch is empty.")
            return

        self.handle_prioritize_badge_games(settings, filtered_queue)

        if self._sort_games_by_ending_time(settings, filtered_queue):
            settings.save()

    def get_filtered_queue(
        self, queue: list[DropsCampaign]
    ) -> list[DropsCampaign]:
        """Vrátí pouze nehotové kampaně z queue, které jsou těžitelné."""
        return [
            c
            for c in queue
            if c.progress < 100 and c.is_campaign_earnable
        ]

    def _sort_games_by_ending_time(
        self, settings: Settings, filtered_queue: list[DropsCampaign]
    ) -> bool:
        """Pomocná metoda pro seřazení settings.games_to_watch podle konce kampaní."""
        if not settings.games_to_watch:
            return False

        campaign_map: dict[str, list[DropsCampaign]] = defaultdict(list)
        for c in filtered_queue:
            if not c.is_campaign_earnable:
                continue
            c_norm = _norm_game_name(c.game.name if c.game else "")
            if c_norm:
                campaign_map[c_norm].append(c)

        def sort_key(game_name: str) -> tuple[int, datetime]:
            campaigns = campaign_map.get(_norm_game_name(game_name), [])
            if not campaigns:
                return (1, datetime.max.replace(tzinfo=timezone.utc))

            dates: list[datetime] = []
            for c in campaigns:
                dt = _ensure_utc(c.ends_at)
                if dt:
                    dates.append(dt)

            earliest_end = min(dates) if dates else datetime.max.replace(tzinfo=timezone.utc)
            return (0, earliest_end)

        old_queue = list(settings.games_to_watch)
        settings.games_to_watch.sort(key=sort_key)

        return settings.games_to_watch != old_queue

    def _get_target_game_names(
        self, settings: Settings, campaigns: list[DropsCampaign]
    ) -> list[str]:
        """Určí seznam her, které se mají sledovat podle nastavení."""
        if settings.auto_add_all_games or not settings.games_to_watch:
            ignored_lower = {_norm_game_name(g) for g in settings.ignored_games}
            target_game_names: list[str] = []
            seen_lower: set[str] = set()

            for campaign in campaigns:
                g_name = campaign.game.name if campaign.game else ""
                g_norm = _norm_game_name(g_name)
                if g_norm and g_norm not in ignored_lower and g_norm not in seen_lower:
                    target_game_names.append(g_name)
                    seen_lower.add(g_norm)
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

        # Pojistka 1: Ochrana před spuštěním nad prázdnými kampaněmi nebo než je koordinátor ready
        if self._twitch is not None:
            coord = getattr(self._twitch, "inventory_coordinator", None)
            if coord is not None and not getattr(coord, "is_ready", False):
                return [] if not as_json else []

        if not campaigns:
            return [] if not as_json else []

        now = datetime.now(timezone.utc)

        # Uložení pro background/state machine kontext
        self._last_settings = settings
        self._last_campaigns = campaigns

        watch_service = self._get_watch_service()

        # Kampaně už jsou seznam, takže stačí přímé zpracování bez zbytečných if/else větví
        campaigns_list = campaigns if isinstance(campaigns, list) else list(campaigns.values())

        valid_campaigns = [c for c in campaigns_list if c.is_campaign_earnable]
        target_game_names = self._get_target_game_names(settings, valid_campaigns)

        # Kontrola a logování diagnostiky pouze při interním výpočtu (ne GUI polling) a změně dat
        if not as_json:
            diag_sig = (len(campaigns_list), len(valid_campaigns), tuple(sorted(target_game_names)))
            if getattr(self, "_last_diagnostic_sig", None) != diag_sig:
                self._last_diagnostic_sig = diag_sig
                logger.info(
                    "🎮 [Tree Diagnostic] Vstupní kampaně: %d | Těžitelné (can_earn): %d | Cílové hry (%d): %s",
                    len(campaigns_list),
                    len(valid_campaigns),
                    len(target_game_names),
                    ", ".join(target_game_names[:5]) if target_game_names else "Žádné",
                )

        campaigns_by_game: dict[str, list[DropsCampaign]] = defaultdict(list)
        for campaign in valid_campaigns:
            if campaign.game and campaign.game.name:
                campaigns_by_game[_norm_game_name(campaign.game.name)].append(campaign)

        wanted_games: list[GameTreeItem] = []

        for game_name in target_game_names:
            matching_campaigns = campaigns_by_game.get(_norm_game_name(game_name))
            if not matching_campaigns:
                continue

            game_obj = matching_campaigns[0].game
            wanted_campaigns: list[CampaignTreeItem] = []

            for campaign in matching_campaigns:
                # Přímý přístup k benefitům díky Pydantic modelu
                campaign_item = self._process_campaign(
                    campaign, settings.mining_benefits, watch_service, now
                )
                if campaign_item:
                    wanted_campaigns.append(campaign_item)

            if wanted_campaigns and game_obj is not None:
                icon_url = game_obj.box_art_url or getattr(game_obj, "icon_url", None)
                wanted_games.append(
                    GameTreeItem(
                        id=game_obj.id,
                        name=game_obj.name,
                        icon_url=icon_url,
                        game_obj=game_obj,
                        campaigns=wanted_campaigns,
                    )
                )

        # Přímý přístup k nastavení řazení
        final_tree = self._sort_and_clean_queue(wanted_games, settings.auto_sort_by_end, settings)

        # Kontrola a logování fronty pouze při interním výpočtu (ne GUI polling) a změně dat
        if not as_json:
            top_3 = [game.name for game in final_tree[:3]]
            preview = ", ".join(top_3)
            remaining = len(final_tree) - len(top_3)
            if remaining > 0:
                preview += f" (+{remaining} dalších)"

            queue_sig = (len(final_tree), tuple(top_3))
            if getattr(self, "_last_queue_sig", None) != queue_sig:
                self._last_queue_sig = queue_sig
                logger.info(
                    "🎮 [Queue] Načteno %d požadovaných her | Top 3: %s",
                    len(final_tree),
                    preview if preview else "Žádné",
                )

        if as_json:
            return [game.model_dump(mode="json") for game in final_tree]

        self._current_queue = final_tree
        return final_tree

    def _process_campaign(
        self,
        campaign: DropsCampaign,
        mining_benefits: list,
        watch_service: Any,
        now: datetime,
    ) -> CampaignTreeItem | None:
        """Zkontroluje platnost kampaně a sestaví její dropy."""
        if not campaign.is_campaign_earnable:
            return None

        ends_at_dt = _ensure_utc(campaign.ends_at)
        if ends_at_dt and ends_at_dt <= now:
            return None

        wanted_drops: list[DropTreeItem] = []
        for drop in campaign.drops:
            drop_item = self._process_drop(drop, mining_benefits, watch_service)
            if drop_item:
                wanted_drops.append(drop_item)

        if not wanted_drops:
            return None

        # Přímý přístup k atributům Pydantic modelu
        campaign_url = campaign.campaign_url or "#"
        total_drops = len(campaign.drops)
        claimed_drops = sum(1 for d in campaign.drops if d.is_claimed)

        starts_at_val = campaign.starts_at.isoformat() if campaign.starts_at else ""
        ends_at_val = campaign.ends_at.isoformat() if campaign.ends_at else ""

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

    def _process_drop(
        self, drop: Any, mining_benefits: list, watch_service: Any
    ) -> DropTreeItem | None:
        """Zpracuje a vyhodnotí stav jednoho dropu pro strom."""
        if drop.is_claimed:
            return None

        filtered_benefits = drop.get_wanted_unclaimed_benefits(mining_benefits)
        if not filtered_benefits:
            return None

        current_mins = drop.current_minutes
        req_mins = drop.required_minutes
        if req_mins <= 0:
            return None

        is_mining = False
        if watch_service is not None:
            is_mining = watch_service.is_drop_actively_mining(drop)

        if drop.progress is not None:
            progress_val = (
                round(drop.progress * 100)
                if drop.progress <= 1.0
                else round(drop.progress)
            )
        else:
            progress_val = int((current_mins / req_mins) * 100)

        return DropTreeItem(
            id=drop.id,
            name=drop.name,
            image_url=drop.image_url,
            status="mining" if is_mining else drop.status,
            benefits=filtered_benefits,
            is_mining=is_mining,
            is_claimed=drop.is_claimed,
            can_claim=drop.can_claim,
            is_stuck=drop.is_stuck,
            is_in_progress=drop.status == "in_progress",
            current_minutes=current_mins,
            required_minutes=req_mins,
            progress=progress_val,
        )

    def _sort_and_clean_queue(
        self,
        wanted_games: list[GameTreeItem],
        auto_sort: bool,
        settings: Optional[Settings] = None,
    ) -> list[GameTreeItem]:
        """Seřadí strom her podle konce kampaní a pořadí v nastavení."""
        order_map: dict[str, int] = {}
        if settings is not None and settings.games_to_watch:
            order_map = {
                _norm_game_name(game_name): idx
                for idx, game_name in enumerate(settings.games_to_watch)
            }

        def get_game_sort_key(game_item: GameTreeItem) -> tuple[int, datetime, int]:
            end_times: list[datetime] = []
            for c in game_item.campaigns:
                raw_end = _ensure_utc(c.raw_ends_at)
                if raw_end:
                    end_times.append(raw_end)

            earliest_end = (
                min(end_times)
                if end_times
                else datetime.max.replace(tzinfo=timezone.utc)
            )
            total_game_remaining = sum(
                c.remaining_minutes for c in game_item.campaigns
            )
            config_index = order_map.get(_norm_game_name(game_item.name), 999)

            if auto_sort:
                return (0, earliest_end, total_game_remaining)
            return (config_index, earliest_end, total_game_remaining)

        wanted_games.sort(key=get_game_sort_key)
        return wanted_games


