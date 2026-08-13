"""Main web GUI manager coordinating application state and broadcasting."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    field_serializer,
    field_validator,
)

from src.services.stream_selector import StreamSelector

if TYPE_CHECKING:
    from socketio import AsyncServer
    from src.core.client import Twitch
    from src.models.models import Game, TimedDrop

logger = logging.getLogger("TwitchDrops")


# ============================================================================
# Pydantic v2 Serialization Helper
# ============================================================================

_json_adapter = TypeAdapter(Any)


def serialize_item(item: Any) -> Any:
    """Nativní a bezpečná Pydantic v2 serializace doménových objektů a struktur."""
    if item is None:
        return None
    if isinstance(item, (int, float, str, bool)):
        return item
    try:
        return _json_adapter.dump_python(item, mode="json")
    except Exception:
        # Fallback pro nestandardní doménové objekty
        if hasattr(item, "model_dump") and callable(item.model_dump):
            try:
                return item.model_dump(mode="json")
            except Exception:
                pass
        if hasattr(item, "to_dict") and callable(item.to_dict):
            try:
                return item.to_dict()
            except Exception:
                pass
        if isinstance(item, dict):
            return {str(k): serialize_item(v) for k, v in item.items()}
        if isinstance(item, (list, tuple, set)):
            return [serialize_item(v) for v in item]
        if hasattr(item, "__dict__"):
            return {
                k: serialize_item(v)
                for k, v in item.__dict__.items()
                if not k.startswith("_")
            }
        return str(item)


# Alias pro zpětnou kompatibilitu
_serialize_item = serialize_item


# ============================================================================
# Pydantic v2 Models & Schemas
# ============================================================================

class ChannelState(BaseModel):
    """Pydantic model reprezentující stav kanálu pro frontend."""

    id: Union[str, int]
    name: Optional[str] = None
    display_name: Optional[str] = Field(default=None, alias="displayName")
    game: Optional[str] = None
    viewers: Optional[int] = 0
    is_watching: bool = False

    model_config = ConfigDict(
        extra="allow",
        populate_by_name=True,
        arbitrary_types_allowed=True,
    )


class CurrentDropState(BaseModel):
    """Pydantic model reprezentující probíhající drop."""

    id: Optional[str] = None
    name: Optional[str] = None
    game: Optional[str] = None
    progress: Optional[float] = 0.0
    remaining_minutes: Optional[int] = 0

    model_config = ConfigDict(extra="allow", arbitrary_types_allowed=True)


class ManualModeState(BaseModel):
    """Pydantic model reprezentující stav manuálního režimu."""

    manual_mode: bool = False
    channel_id: Optional[Union[str, int]] = None
    channel_name: Optional[str] = None

    model_config = ConfigDict(extra="allow", arbitrary_types_allowed=True)


class GUIStatePayload(BaseModel):
    """Kompletní Pydantic v2 schéma stavu aplikace posílaného přes WebSocket."""

    status: str = "Idle"
    channels: Dict[str, Union[ChannelState, Dict[str, Any], Any]] = Field(default_factory=dict)
    inventory: List[Any] = Field(default_factory=list)
    console: List[str] = Field(default_factory=list)
    login: Optional[str] = None
    current_drop: Optional[Union[CurrentDropState, Dict[str, Any], Any]] = None
    manual_mode: Union[ManualModeState, Dict[str, Any]] = Field(default_factory=dict)
    wanted_items: List[Any] = Field(default_factory=list)
    settings: Dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(
        extra="allow",
        arbitrary_types_allowed=True,
        validate_assignment=True,
    )

    @field_validator("status", mode="before")
    @classmethod
    def validate_status(cls, v: Any) -> str:
        if v is None:
            return "Idle"
        return str(v)

    @field_serializer("channels", "inventory", "current_drop", "wanted_items", "settings", mode="wrap")
    def serialize_complex_fields(self, value: Any, handler: Any) -> Any:
        return serialize_item(value)


# ============================================================================
# Legacy Handlers & Compatibility Layers
# ============================================================================

class BroadcasterHandler:
    """Kompatibilní vrstva pro emitter/broadcaster volaný ze starého kódu."""

    def __init__(self, gui_manager: WebGUIManager):
        self.gui_manager = gui_manager

    async def emit(self, event: str, data: Any = None):
        if self.gui_manager._sio:
            try:
                if data is not None:
                    serialized_data = serialize_item(data)
                    await self.gui_manager._sio.emit(event, serialized_data)
                else:
                    await self.gui_manager._sio.emit(event)
            except Exception as e:
                logger.error(f"Failed to emit socket event {event}: {e}")


class LoginFormHandler:
    """Kompatibilní vrstva pro starý LoginForm, který volá .update()"""

    def __init__(self, gui_manager: WebGUIManager):
        self.gui_manager = gui_manager

    def update(self, *args, **kwargs):
        logger.debug(
            f"LoginFormHandler.update called with args={args}, kwargs={kwargs}"
        )
        if args and args[0] is not None:
            self.gui_manager._login_status = str(args[0])


class StatusHandler:
    """Kompatibilní vrstva pro stavový řádek, který volá .update()"""

    def __init__(self, gui_manager: WebGUIManager):
        self.gui_manager = gui_manager

    def update(self, *args, **kwargs):
        logger.debug(
            f"StatusHandler.update called with args={args}, kwargs={kwargs}"
        )
        if args and args[0] is not None:
            text = str(args[0])
            self.gui_manager._status = text
            self.gui_manager.log(text)
            try:
                asyncio.create_task(self.gui_manager.broadcast_state())
            except RuntimeError:
                pass


class InventoryHandler:
    """Kompletní třída pro správu a uchování inventáře dropů a kampaní."""

    def __init__(self, gui_manager: WebGUIManager):
        self.gui_manager = gui_manager
        self._items: List[Any] = []

    def _extract_items(self, raw_input: Any) -> List[Any]:
        """Rozbalí kampaně z předaného objektu, z CampaignService nebo z Twitch bota."""
        if raw_input is not None:
            if hasattr(raw_input, "campaigns"):
                raw_input = getattr(raw_input, "campaigns")
                if callable(raw_input):
                    raw_input = raw_input()

        if not raw_input:
            twitch = getattr(self.gui_manager, "_twitch", None)
            if twitch:
                campaign_service = getattr(
                    twitch,
                    "campaign_service",
                    getattr(twitch, "_campaign_service", None),
                )
                if campaign_service:
                    for attr in (
                        "campaigns",
                        "_campaigns",
                        "inventory",
                        "_inventory",
                    ):
                        if hasattr(campaign_service, attr):
                            val = getattr(campaign_service, attr)
                            if val:
                                raw_input = val
                                break
                    if not raw_input and hasattr(
                        campaign_service, "get_campaigns"
                    ):
                        raw_input = campaign_service.get_campaigns()

                if not raw_input and hasattr(twitch, "campaigns"):
                    raw_input = twitch.campaigns
                if not raw_input and hasattr(twitch, "inventory"):
                    raw_input = twitch.inventory

        if callable(raw_input):
            raw_input = raw_input()

        if isinstance(raw_input, dict):
            return list(raw_input.values())
        elif hasattr(raw_input, "values") and callable(raw_input.values):
            return list(raw_input.values())
        elif isinstance(raw_input, (list, tuple, set)):
            return list(raw_input)
        elif raw_input is not None:
            return [raw_input]

        return []

    def update(self, *args, **kwargs):
        arg_type = type(args[0]).__name__ if args else "None"
        raw = args[0] if args else kwargs.get("inventory", kwargs.get("campaigns", None))

        extracted = self._extract_items(raw)

        if extracted or not self._items:
            self._items = extracted

        logger.debug(
            f"[InventoryHandler.update] Called with type={arg_type}, extracted {len(self._items)} items"
        )

    def batch_update(self, items=None):
        self.update(items)

    def display(self, items=None):
        if items is not None:
            self.update(items)
        else:
            if not self._items:
                self._items = self._extract_items(None)

    def append(self, item):
        self._items.append(item)

    def clear(self):
        self._items.clear()

    def __iter__(self):
        return iter(self._items)

    def __len__(self):
        return len(self._items)

    def __getitem__(self, index):
        return self._items[index]

    def to_dict(self) -> List[Any]:
        return [serialize_item(i) for i in self._items]


class ChannelsHandler:
    """Kompatibilní vrstva pro správu kanálů v paměti."""

    def __init__(self, gui_manager: WebGUIManager):
        self.gui_manager = gui_manager
        self._channels: Dict[Any, Any] = {}

    def batch_update(self, channels):
        """Hromadná aktualizace seznamu kanálů."""
        self._channels.clear()
        items = (
            channels
            if isinstance(channels, (list, tuple))
            else (channels.values() if isinstance(channels, dict) else [channels])
        )

        for ch in items:
            ch_id = getattr(ch, "id", None) or (
                ch.get("id") if isinstance(ch, dict) else id(ch)
            )
            self._channels[ch_id] = ch

        logger.debug(
            f"Batch updated {len(self._channels)} channels successfully"
        )

    def clear_watching(self):
        for ch in self._channels.values():
            if hasattr(ch, "is_watching"):
                ch.is_watching = False
            elif isinstance(ch, dict):
                ch["is_watching"] = False

    def set_watching(self, channel):
        ch_id = getattr(channel, "id", None) or (
            channel.get("id") if isinstance(channel, dict) else None
        )
        for cid, ch in self._channels.items():
            is_match = cid == ch_id
            if hasattr(ch, "is_watching"):
                ch.is_watching = is_match
            elif isinstance(ch, dict):
                ch["is_watching"] = is_match

    def display(self, channel, add: bool = True):
        ch_id = getattr(channel, "id", None) or (
            channel.get("id") if isinstance(channel, dict) else None
        )
        if not ch_id:
            return

        if add or ch_id in self._channels:
            self._channels[ch_id] = channel

    def get_channels(self) -> List[Any]:
        """Vrátí seznam plnohodnotných doménových objektů Channel pro core bota."""
        return list(self._channels.values())

    def get_selection(self) -> Any:
        """Vrátí reálný doménový objekt Channel pro vybraný kanál."""
        selected_id = self.gui_manager._selected_channel_id
        channels = self.get_channels()
        if not channels:
            return None
        if selected_id is not None:
            for ch in channels:
                cid = getattr(ch, "id", None) or (
                    ch.get("id") if isinstance(ch, dict) else None
                )
                if cid == selected_id:
                    return ch
        return channels[0]

    def to_dict(self) -> Dict[str, Any]:
        """Vrátí kanály jako slovník {channel_id: channel_data} pro frontend."""
        return {str(k): serialize_item(v) for k, v in self._channels.items()}

    def __iter__(self):
        return iter(self._channels.values())

    def __len__(self):
        return len(self._channels)


class WebsocketsHandler:
    """Kompatibilní vrstva pro sledování stavu websocketů."""

    def __init__(self, gui_manager: WebGUIManager):
        self.gui_manager = gui_manager

    def update(self, *args, **kwargs):
        pass


# ============================================================================
# Main WebGUIManager Implementation
# ============================================================================

class WebGUIManager:
    """Unified Web GUI manager managing application state and broadcasts directly."""

    def __init__(self, twitch: Twitch):
        self._twitch: Twitch = twitch
        self._sio: AsyncServer | None = None

        self.console_logs: List[str] = []
        self._status: str = "Idle"
        self._login_status: str | None = None
        self._watching_channel_id: int | None = None
        self._selected_channel_id: int | None = None

        # Příznaky pro throttling/debouncing WebSocket zpráv
        self._state_update_task: asyncio.Task | None = None
        self._pending_state_update: bool = False

        self._stream_selector = StreamSelector()

        self._broadcaster = BroadcasterHandler(self)
        self._login_handler = LoginFormHandler(self)
        self._status_handler = StatusHandler(self)
        self._inventory_handler = InventoryHandler(self)
        self._channels_handler = ChannelsHandler(self)
        self._websockets_handler = WebsocketsHandler(self)

        if hasattr(twitch, "settings") and twitch.settings:
            settings_cls = type(twitch.settings)
            if not hasattr(settings_cls, "get_settings"):
                setattr(
                    settings_cls,
                    "get_settings",
                    lambda self: {
                        k: v
                        for k, v in self.__dict__.items()
                        if not k.startswith("_")
                    },
                )
            if not hasattr(settings_cls, "get_languages"):
                setattr(
                    settings_cls,
                    "get_languages",
                    lambda self: ["English", "Czech"],
                )

            if not hasattr(settings_cls, "update_settings"):

                def _update_settings(self, data: dict):
                    for k, v in data.items():
                        if hasattr(self, k):
                            setattr(self, k, v)
                    if hasattr(self, "save") and callable(self.save):
                        self.save()

                setattr(settings_cls, "update_settings", _update_settings)

        logger.info("Web GUI Manager initialized successfully")

    def log(self, message: str):
        self.console_logs.append(message)
        if len(self.console_logs) > 200:
            self.console_logs.pop(0)

    def set_socketio(self, sio: AsyncServer):
        """Set the Socket.IO instance for real-time communication."""
        self._sio = sio

    async def broadcast_state(self):
        """
        Naplánuje odeslání aktuálního stavu s debounce oknem 500 ms.
        Zamezuje zahlcení WebSocket bufferu při kaskádových úpravách stavu.
        """
        self._pending_state_update = True
        if self._state_update_task is None or self._state_update_task.done():
            self._state_update_task = asyncio.create_task(
                self._throttled_broadcast()
            )

    async def _throttled_broadcast(self):
        """Interní coroutine pro konstrukci a export Pydantic V2 stavového schématu."""
        await asyncio.sleep(0.5)
        if self._pending_state_update:
            self._pending_state_update = False
            if self._sio:
                try:
                    watch_service = (
                        getattr(self._twitch, "_watch_service", None)
                        if self._twitch
                        else None
                    )

                    # 1. Získání kanálů výhradně jako dict {channel_id: channel_obj}
                    channels_source = (
                        getattr(self._twitch, "channels", self._channels_handler)
                        if self._twitch
                        else self._channels_handler
                    )
                    channels_dict: Dict[str, Any] = {}
                    if hasattr(channels_source, "_channels") and isinstance(
                        channels_source._channels, dict
                    ):
                        channels_dict = {
                            str(k): v
                            for k, v in channels_source._channels.items()
                        }
                    elif hasattr(channels_source, "to_dict") and callable(
                        channels_source.to_dict
                    ):
                        res = channels_source.to_dict()
                        if isinstance(res, dict):
                            channels_dict = res
                        elif isinstance(res, list):
                            channels_dict = {
                                str(getattr(ch, "id", i)): ch
                                for i, ch in enumerate(res)
                            }
                    elif isinstance(channels_source, dict):
                        channels_dict = {
                            str(k): v
                            for k, v in channels_source.items()
                        }

                    # 2. Inventář
                    inventory_source = (
                        getattr(self._twitch, "inventory", self._inventory_handler)
                        if self._twitch
                        else self._inventory_handler
                    )
                    if hasattr(inventory_source, "to_dict") and callable(
                        inventory_source.to_dict
                    ):
                        inventory_data = inventory_source.to_dict()
                    else:
                        inventory_data = inventory_source

                    if inventory_data is None:
                        inventory_list: List[Any] = []
                    elif isinstance(inventory_data, list):
                        inventory_list = inventory_data
                    else:
                        inventory_list = [inventory_data]

                    # 3. Drop info
                    drop_info = (
                        watch_service.get_current_drop_info()
                        if (
                            watch_service
                            and hasattr(watch_service, "get_current_drop_info")
                        )
                        else None
                    )

                    # 4. Settings
                    settings_data = {}
                    if (
                        self._twitch
                        and hasattr(self._twitch, "settings")
                        and self._twitch.settings
                    ):
                        if hasattr(
                            self._twitch.settings, "get_settings"
                        ) and callable(self._twitch.settings.get_settings):
                            settings_data = self._twitch.settings.get_settings()
                        elif hasattr(self._twitch.settings, "__dict__"):
                            settings_data = {
                                k: v
                                for k, v in self._twitch.settings.__dict__.items()
                                if not k.startswith("_")
                            }

                    # Konstrukce a validace skrze Pydantic v2
                    state_model = GUIStatePayload(
                        status=self._status,
                        channels=channels_dict,
                        inventory=inventory_list,
                        console=self.console_logs,
                        login=self._login_status,
                        current_drop=drop_info,
                        manual_mode=(
                            getattr(
                                self._twitch,
                                "get_manual_mode_info",
                                lambda: {},
                            )()
                            if self._twitch
                            else {}
                        ),
                        wanted_items=self.get_wanted_items_tree(),
                        settings=settings_data,
                    )

                    # Nativní export z Pydanticu do JSON-ready dictu
                    payload = state_model.model_dump(mode="json")
                    await self._sio.emit("state", payload)
                except Exception as e:
                    logger.error(f"Failed to broadcast state update: {e}", exc_info=True)

    def print(self, message: str):
        """Print message to console output buffer."""
        self.log(message)
        try:
            asyncio.create_task(self.broadcast_state())
        except RuntimeError:
            pass

    def set_games(self, games: set[Game]):
        """Set available games for settings panel."""
        pass

    def display_drop(
        self, drop: TimedDrop, *, countdown: bool = True, subone: bool = False
    ):
        """Display drop mining progress with countdown."""
        remaining = drop.remaining_minutes * 60
        if subone:
            remaining -= 60
        asyncio.create_task(self.broadcast_state())

    def clear_drop(self):
        """Clear the drop progress display."""
        asyncio.create_task(self.broadcast_state())

    def grab_attention(self, *, sound: bool = True):
        """Get user's attention via notification."""
        if self._sio:
            asyncio.create_task(
                self._sio.emit("attention_required", {"sound": sound})
            )

    def select_channel(self, channel_id: int):
        """Select a channel."""
        self._selected_channel_id = channel_id
        self._watching_channel_id = channel_id

    def get_selected_channel_id(self) -> int | None:
        """Get the currently selected channel ID and clear the selection."""
        result = self._selected_channel_id
        self._selected_channel_id = None
        return result

    def apply_theme(self, dark_mode: bool):
        """Apply UI theme."""
        if self._sio:
            asyncio.create_task(
                self._sio.emit("theme_change", {"dark_mode": dark_mode})
            )

    def broadcast_manual_mode_change(self, manual_mode_info: dict):
        """Broadcast manual mode status change."""
        if self._sio:
            asyncio.create_task(
                self._sio.emit(
                    "manual_mode_update", serialize_item(manual_mode_info)
                )
            )

    def get_wanted_items_tree(self) -> list[dict]:
        settings = (
            getattr(self._twitch, "settings", None) if self._twitch else None
        )
        inventory = (
            getattr(self._twitch, "inventory", None) if self._twitch else None
        )
        try:
            return self._stream_selector.get_wanted_game_tree(
                settings, inventory
            )
        except Exception as e:
            logger.warning(f"Failed to get wanted game tree: {e}")
            return []

    def broadcast_wanted_items(self):
        """Broadcast the list of wanted items."""
        tree = self.get_wanted_items_tree()
        if self._sio:
            asyncio.create_task(
                self._sio.emit("wanted_items_update", serialize_item(tree))
            )

    @property
    def login(self):
        return self._login_handler

    @property
    def status(self):
        return self._status_handler

    @property
    def inventory(self):
        return self._inventory_handler

    @property
    def channels(self):
        return self._channels_handler

    @property
    def websockets(self):
        return self._websockets_handler

    @property
    def campaigns(self):
        return self._inventory_handler


# Zpětná kompatibilita pro staré importy
GUIManager = WebGUIManager
