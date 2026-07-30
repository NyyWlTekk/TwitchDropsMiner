"""Settings manager for application configuration."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from src.i18n.translator import _
from src.models.game import Game


logger = logging.getLogger("TwitchDrops")


if TYPE_CHECKING:
    from src.config.settings import Settings
    from src.web.managers.broadcaster import WebSocketBroadcaster
    from src.web.managers.console import ConsoleOutputManager


# ==============================================================================
# 1. SETTINGS MANAGER CLASS (Zpětně kompatibilní API rozhraní)
# ==============================================================================

class SettingsManager:
    """Manages application settings in the web interface.

    Provides access to and modification of user preferences including
    game priorities, proxy configuration, and UI preferences.
    """

    def __init__(
        self,
        broadcaster: WebSocketBroadcaster,
        settings: Settings,
        console: ConsoleOutputManager,
        on_change: Callable[[], None] | None = None,
    ):
        self._broadcaster = broadcaster
        self._settings = settings
        self._console = console
        self._on_change = on_change
        self._available_games: list[str] = []
        self._last_logged_games_count: int | None = None

    def get_settings(self) -> dict[str, Any]:
        """Get current settings for display."""
        return vars(self._settings).copy()

    def get_languages(self) -> dict[str, Any]:
        """Get available languages and current selection."""
        return {
            "available": _.get_languages(),
            "current": _.current_language,
        }

    # --- Veřejné API delegované na ploché funkce ---
    def update_settings(self, settings_data: dict[str, Any]) -> None:
        update_settings(self, settings_data)

    def check_and_update_setting(
        self,
        key: str,
        new_value: Any,
        should_trigger_update: bool = False,
        action: Callable[[Any], None] = lambda x: None,
    ) -> bool:
        return check_and_update_setting(self, key, new_value, should_trigger_update, action)

    def set_games(self, games: set[Game]) -> None:
        set_games(self, games)

    # --- ZPĚTNÁ KOMPATIBILITA: Metody, které aplikace vyžaduje a volá napřímo ---
    def _log_change(self, message: str) -> None:
        log_setting_change(self, message)

    def _set_language(self, language: str) -> None:
        set_language_handler(self, language)


# ==============================================================================
# 2. PLOCHÉ FUNKCE (Samotná logika na úrovni modulu)
# ==============================================================================

def log_setting_change(manager: SettingsManager, message: str) -> None:
    """Log setting change to both console and system logger."""
    manager._console.print(message)


def set_language_handler(manager: SettingsManager, language: str) -> None:
    """Apply the language change and notify the frontend."""
    _.set_language(language)
    asyncio.create_task(manager._broadcaster.emit("language_changed", {"language": language}))


def set_games(manager: SettingsManager, games: set[Game]) -> None:
    """Update the list of available games for settings panel."""
    game_names = sorted([g.name for g in games])
    manager._available_games = game_names
    manager._settings.games_available = game_names
    manager._settings.save()
    asyncio.create_task(manager._broadcaster.emit("games_available", {"games": game_names}))


def update_settings(manager: SettingsManager, settings_data: dict[str, Any]) -> None:
    """Update settings from user input."""
    should_trigger_update = False

    should_trigger_update |= check_and_update_setting(
        manager, "games_to_watch", settings_data.get("games_to_watch"), True
    )
    should_trigger_update |= check_and_update_setting(
        manager, "dark_mode", settings_data.get("dark_mode")
    )
    should_trigger_update |= check_and_update_setting(
        manager, "auto_sort_by_end", settings_data.get("auto_sort_by_end")
    )
    should_trigger_update |= check_and_update_setting(
        manager, "mine_badges_first", settings_data.get("mine_badges_first")
    )
    should_trigger_update |= check_and_update_setting(
        manager, "auto_add_all_games", settings_data.get("auto_add_all_games")
    )
    should_trigger_update |= check_and_update_setting(
        manager, "language", settings_data.get("language"), False, manager._set_language
    )
    should_trigger_update |= check_and_update_setting(
        manager, "connection_quality", settings_data.get("connection_quality")
    )

    if "proxy" in settings_data:
        proxy_value = settings_data["proxy"]
        should_trigger_update |= check_and_update_setting(
            manager,
            "proxy",
            str(proxy_value).strip() if proxy_value else "",
            True,
            lambda proxy: manager._log_change("Proxy cleared") if proxy == "" else None,
        )

    should_trigger_update |= check_and_update_setting(
        manager,
        "minimum_refresh_interval_minutes",
        settings_data.get("minimum_refresh_interval_minutes"),
    )
    should_trigger_update |= check_and_update_setting(
        manager, "inventory_filters", settings_data.get("inventory_filters")
    )
    should_trigger_update |= check_and_update_setting(
        manager, "mining_benefits", settings_data.get("mining_benefits"), True
    )

    manager._settings.save()
    asyncio.create_task(manager._broadcaster.emit("settings_updated", manager.get_settings()))

    if should_trigger_update and manager._on_change:
        manager._on_change()


def check_and_update_setting(
    manager: SettingsManager,
    key: str,
    new_value: Any,
    should_trigger_update: bool = False,
    action: Callable[[Any], None] = lambda x: None,
) -> bool:
    """Compare and commit a single settings change, then log and trigger callbacks."""
    old_value = getattr(manager._settings, key, None)

    if new_value is None or old_value == new_value:
        return False

    setattr(manager._settings, key, new_value)

    # 1. Log added and removed games for games_to_watch
    if key == "games_to_watch" and isinstance(new_value, list):
        old_list = old_value if isinstance(old_value, list) else []
        old_set = {g.strip().lower() for g in old_list}
        new_set = {g.strip().lower() for g in new_value}

        added_games = [g for g in new_value if g.strip().lower() not in old_set]
        removed_games = [g for g in old_list if g.strip().lower() not in new_set]

        if added_games:
            manager._log_change(f"Games added: {', '.join(added_games)}")
        if removed_games:
            manager._log_change(f"Games removed: {', '.join(removed_games)}")
            
        manager._last_logged_games_count = len(new_value)

    # 2. Log changes in inventory filters
    elif key == "inventory_filters" and isinstance(old_value, dict) and isinstance(new_value, dict):
        changes = []
        all_keys = sorted(set(old_value.keys()) | set(new_value.keys()))
        for k in all_keys:
            old_val = old_value.get(k)
            new_val = new_value.get(k)
            if old_val != new_val:
                changes.append(f"{k}: {old_val} -> {new_val}")

        if changes:
            manager._log_change(f"Setting changed: inventory_filters updated -> " + ", ".join(changes))
        else:
            manager._log_change(f"Setting changed: {key} = {new_value}")

    # 3. Fallback for standard settings
    else:
        manager._log_change(f"Setting changed: {key} = {new_value}")

    action(new_value)
    return should_trigger_update
