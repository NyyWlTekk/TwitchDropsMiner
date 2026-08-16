from __future__ import annotations

from typing import Any
from pydantic import BaseModel, Field

from src.config import DEFAULT_LANG, SETTINGS_PATH
from src.utils import json_load, json_save


class InventoryFilters(BaseModel):
    game_name_search: list[str] = Field(default_factory=list)
    show_active: bool = False
    show_benefit_badge: bool = True
    show_benefit_emote: bool = True
    show_benefit_item: bool = True
    show_benefit_other: bool = True
    show_expired: bool = False
    show_finished: bool = False
    show_not_linked: bool = True
    show_upcoming: bool = True


class Settings(BaseModel):
    auto_sort_by_end: bool = False
    auto_add_all_games: bool = False
    mine_badges_first: bool = False
    connection_quality: int = 1
    dark_mode: bool = False
    games_to_watch: list[str] = Field(default_factory=list)
    ignored_games: list[str] = Field(default_factory=list)
    games_available: list[str] = Field(default_factory=list)
    language: str = DEFAULT_LANG
    inventory_filters: InventoryFilters = Field(default_factory=InventoryFilters)
    minimum_refresh_interval_minutes: int = 30
    mining_benefits: dict[str, bool] = Field(
        default_factory=lambda: {
            "BADGE": True,
            "DIRECT_ENTITLEMENT": True,
            "EMOTE": True,
            "UNKNOWN": True,
        }
    )
    proxy: str = ""

    def __init__(self, **data: Any):
        # Pokud při inicializaci nejsou předána data, načteme je ze souboru / výchozích hodnot
        if not data:
            data = json_load(SETTINGS_PATH, self.get_default_dict(), merge=True)
        super().__init__(**data)

    @staticmethod
    def get_default_dict() -> dict[str, Any]:
        return {
            "auto_sort_by_end": False,
            "auto_add_all_games": False,
            "mine_badges_first": False,
            "connection_quality": 1,
            "dark_mode": False,
            "games_to_watch": [],
            "ignored_games": [],
            "games_available": [],
            "language": DEFAULT_LANG,
            "inventory_filters": {
                "game_name_search": [],
                "show_active": False,
                "show_benefit_badge": True,
                "show_benefit_emote": True,
                "show_benefit_item": True,
                "show_benefit_other": True,
                "show_expired": False,
                "show_finished": False,
                "show_not_linked": True,
                "show_upcoming": True,
            },
            "minimum_refresh_interval_minutes": 30,
            "mining_benefits": {
                "BADGE": True,
                "DIRECT_ENTITLEMENT": True,
                "EMOTE": True,
                "UNKNOWN": True,
            },
            "proxy": "",
        }

    def load(self) -> None:
        """Načte nastavení ze souboru a aktualizuje atributy modelu."""
        data = json_load(SETTINGS_PATH, self.get_default_dict(), merge=True)
        for key, value in data.items():
            if hasattr(self, key):
                setattr(self, key, value)

    def save(self) -> None:
        """Uloží aktuální stav modelu do JSON souboru."""
        json_save(SETTINGS_PATH, self.model_dump(mode="json"), sort=True)

    def get_settings(self) -> dict[str, Any]:
        """Vrátí aktuální nastavení jako čistý slovník serializovatelný do JSONu (včetně vnořených modelů)."""
        return self.model_dump(mode="json")
