from __future__ import annotations

import json
from pydantic import BaseModel

# debug
import pprint

import asyncio
import logging
from pathlib import Path
from typing import TYPE_CHECKING

import socketio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

if TYPE_CHECKING:
    import uvicorn

    from src.core.client import Twitch
    from src.web.gui_manager import WebGUIManager


logger = logging.getLogger("TwitchDrops")

# Create FastAPI app
app = FastAPI(title="Twitch Drops Miner Web", version="1.0.0")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify exact origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create Socket.IO server with CustomJSONModule wrapper
sio = socketio.AsyncServer(
    async_mode="asgi", 
    cors_allowed_origins="*", 
    logger=False, 
    engineio_logger=False,
)

# Wrap with ASGI app
socket_app = socketio.ASGIApp(sio, app)

# Global references (set by main.py)
gui_manager: WebGUIManager | None = None
twitch_client: Twitch | None = None
_server_instance: uvicorn.Server | None = None


def set_managers(gui: WebGUIManager, twitch: Twitch):
    """Called by main.py to set up references"""
    global gui_manager, twitch_client
    gui_manager = gui
    twitch_client = twitch
    gui.set_socketio(sio)


# Pydantic models for API
class LoginRequest(BaseModel):
    username: str
    password: str
    token: str = ""


class ChannelSelectRequest(BaseModel):
    channel_id: int


class SettingsUpdate(BaseModel):
    games_to_watch: list[str] | None = None
    ignored_games: list[str] | None = None
    dark_mode: bool | None = None
    auto_sort_by_end: bool | None = None
    mine_badges_first: bool | None = None
    auto_add_all_games: bool | None = None 
    language: str | None = None
    proxy: str | None = None
    connection_quality: int | None = None
    minimum_refresh_interval_minutes: int | None = None
    inventory_filters: dict | None = None
    mining_benefits: dict[str, bool] | None = None


class ProxyVerifyRequest(BaseModel):
    proxy: str


# ==================== REST API Endpoints ====================


@app.get("/", response_class=HTMLResponse)
async def serve_index():
    """Serve the main web interface"""
    web_dir = Path(__file__).parent.parent.parent / "web"
    index_file = web_dir / "index.html"
    logger.debug(
        f"Looking for web files: __file__={__file__}, web_dir={web_dir}, index_file={index_file}, exists={index_file.exists()}"
    )
    if index_file.exists():
        return FileResponse(index_file)
    return HTMLResponse(
        content=f"<h1>Twitch Drops Miner</h1><p>Web interface files not found. Please check installation.</p><p>Debug: Looking for {index_file}</p>",
        status_code=500,
    )


@app.get("/api/status")
async def get_status():
    """Get current application status"""
    if not gui_manager or not twitch_client:
        raise HTTPException(status_code=503, detail="GUI not initialized")

    watch_service = getattr(twitch_client, "_watch_service", None)
    manual_mode = (
        watch_service.get_manual_mode_info()
        if watch_service and hasattr(watch_service, "get_manual_mode_info")
        else {"active": False, "channel": None}
    )

    state_dict = gui_manager.state.to_dict()
    return {
        "status": state_dict.get("status"),
        "login": state_dict.get("login"),
        "manual_mode": manual_mode,
    }


@app.get("/api/channels")
async def get_channels():
    """Get list of tracked channels"""
    if not gui_manager:
        raise HTTPException(status_code=503, detail="GUI not initialized")

    state_dict = gui_manager.state.to_dict()
    return {"channels": state_dict.get("channels", [])}


@app.post("/api/channels/select")
async def select_channel(request: ChannelSelectRequest):
    """Select a channel to watch"""
    if not gui_manager or not twitch_client:
        raise HTTPException(status_code=503, detail="GUI not initialized")

    channel = twitch_client.channels.get(request.channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    if not channel.game:
        raise HTTPException(status_code=400, detail="Channel is not playing any game")

    if not any(campaign.can_earn(channel) for campaign in twitch_client.inventory):
        logger.warning(f"User selected channel {channel.name} but it has no available drops")

    gui_manager.select_channel(request.channel_id)

    from src.config import State
    twitch_client.change_state(State.CHANNEL_SWITCH)

    return {"success": True}


@app.get("/api/console")
async def get_console_history():
    """Get console output history"""
    if not gui_manager:
        raise HTTPException(status_code=503, detail="GUI not initialized")

    state_dict = gui_manager.state.to_dict()
    return {"lines": state_dict.get("console", [])}


@app.get("/api/settings")
async def get_settings():
    """Get current settings"""
    if not twitch_client:
        raise HTTPException(status_code=503, detail="GUI not initialized")

    return twitch_client.settings.get_settings()


@app.get("/api/languages")
async def get_languages():
    """Get available languages"""
    if not twitch_client:
        raise HTTPException(status_code=503, detail="GUI not initialized")

    return twitch_client.settings.get_languages()


@app.get("/api/translations")
async def get_translations():
    """Get translations for current language"""
    from src.i18n.translator import _
    return _.t


@app.post("/api/settings")
async def update_settings(settings: SettingsUpdate):
    """Update application settings"""
    if not twitch_client:
        raise HTTPException(status_code=503, detail="GUI not initialized")

    settings_dict = settings.dict(exclude_unset=True)
    twitch_client.settings.update_settings(settings_dict)
    return {"success": True, "settings": twitch_client.settings.get_settings()}


@app.post("/api/settings/verify-proxy")
async def verify_proxy(request: ProxyVerifyRequest):
    """Verify proxy connectivity"""
    import time
    import aiohttp

    proxy_url = request.proxy.strip()
    if not proxy_url:
        return {"success": False, "message": "Proxy URL is empty"}

    try:
        start_time = time.time()
        async with (
            aiohttp.ClientSession() as session,
            session.get("https://www.twitch.tv", proxy=proxy_url, timeout=10) as response,
        ):
            if response.status < 500:
                latency = round((time.time() - start_time) * 1000)
                return {
                    "success": True,
                    "message": f"Connected! ({latency}ms)",
                    "latency": latency,
                }
            else:
                return {
                    "success": False,
                    "message": f"Proxy reachable but returned {response.status}",
                }
    except Exception as e:
        return {"success": False, "message": f"Connection failed: {str(e)}"}


@app.get("/api/version")
async def get_version():
    """Get current application version and check for updates"""
    import aiohttp
    from src.version import __version__

    current_version = __version__
    latest_version = None
    update_available = False
    download_url = None

    try:
        async with (
            aiohttp.ClientSession() as session,
            session.get(
                "https://api.github.com/repos/rangermix/TwitchDropsMiner/releases/latest", timeout=5
            ) as response,
        ):
            if response.status == 200:
                data = await response.json()
                latest_version = data.get("tag_name", "").lstrip("v")
                download_url = data.get("html_url")

                if latest_version and latest_version > current_version:
                    update_available = True
    except Exception as e:
        logger.warning(f"Failed to check for updates: {str(e)}")

    return {
        "current_version": current_version,
        "latest_version": latest_version,
        "update_available": update_available,
        "download_url": download_url or "https://github.com/rangermix/TwitchDropsMiner/releases",
    }


@app.post("/api/login")
async def submit_login(login_data: LoginRequest):
    """Submit login credentials"""
    if not gui_manager:
        raise HTTPException(status_code=503, detail="GUI not initialized")

    gui_manager.state.set_login_status("Logging in...")
    return {"success": True}


@app.post("/api/oauth/confirm")
async def confirm_oauth():
    """Confirm OAuth code has been entered by user"""
    if not gui_manager:
        raise HTTPException(status_code=503, detail="GUI not initialized")

    return {"success": True}


@app.post("/api/reload")
async def trigger_reload():
    """Trigger application reload"""
    if not twitch_client:
        raise HTTPException(status_code=503, detail="Twitch client not initialized")

    from src.config import State
    twitch_client.change_state(State.INVENTORY_FETCH)
    return {"success": True}


@app.post("/api/close")
async def trigger_close():
    """Trigger application shutdown"""
    if not twitch_client:
        raise HTTPException(status_code=503, detail="Twitch client not initialized")

    twitch_client.close()
    return {"success": True}


@app.post("/api/mode/exit-manual")
async def exit_manual_mode():
    """Exit manual mode and return to automatic channel selection"""
    if not twitch_client:
        raise HTTPException(status_code=503, detail="Twitch client not initialized")

    if not twitch_client.is_manual_mode():
        return {"success": False, "message": "Not in manual mode"}

    twitch_client.exit_manual_mode("User requested")
    return {"success": True}


# ==================== Socket.IO Events ====================


@sio.event
async def state(sid, data=None):
    if not gui_manager or not twitch_client:
        return

    try:
        watch_service = getattr(twitch_client, "_watch_service", None)

        payload = {
            "status": getattr(gui_manager, "_status", "Idle"),
            "login": getattr(gui_manager, "_login_status", None),
            
            "channels": [
                c.model_dump(mode="json") if hasattr(c, "model_dump") else c 
                for c in getattr(twitch_client, "channels", {}).values()
            ],
            "inventory": [
                item.model_dump(mode="json") if hasattr(item, "model_dump") else item 
                for item in getattr(twitch_client, "inventory", [])
            ],
            "console": getattr(gui_manager, "console_logs", []),
            "settings": twitch_client.settings.get_settings() if hasattr(twitch_client, "settings") else {},
            
            # --- ZMĚNA ZDE: volání z watch_service ---
            "manual_mode": (
                watch_service.get_manual_mode_info()
                if watch_service and hasattr(watch_service, "get_manual_mode_info")
                else {"active": False, "channel": None}
            ),
            
            "current_drop": (
                drop_info.model_dump(mode="json")
                if (watch_service and (drop_info := watch_service.get_current_drop_info()))
                else None
            ),
            "wanted_items": (
                gui_manager.get_wanted_items_tree()
                if hasattr(gui_manager, "get_wanted_items_tree")
                else []
            ),
        }

        await sio.emit("state", payload, room=sid)

    except Exception as e:
        logger.error(f"❌ Chyba odeslání stavu: {e}", exc_info=True)
        
        
@sio.event
async def connect(sid, environ, *args):
    """Klient se připojil"""
    logger.info(f"Web client connected: {sid}")
    await state(sid)


@sio.event
async def disconnect(sid):
    """Client disconnected"""
    logger.info(f"Web client disconnected: {sid}")


@sio.event
async def request_login(sid):
    """Client requested login form submission"""
    logger.info(f"Login request from client: {sid}")


@sio.event
async def request_reload(sid):
    """Client requested application reload"""
    logger.info("Received request_reload event from sid=%s", sid)
    if twitch_client:
        from src.config import State
        twitch_client.change_state(State.INVENTORY_FETCH)

# Mount static directories (CSS, JS, icons)
web_dir = Path(__file__).parent.parent.parent / "web"
if web_dir.exists():
    for folder in ("css", "js", "icons"):
        folder_path = web_dir / folder
        if folder_path.exists():
            app.mount(f"/{folder}", StaticFiles(directory=folder_path), name=folder)


@sio.event
async def message(sid, data):
    logger.debug(f"Received message from {sid}: {data}")
    await sio.emit("response", {"status": "ok"}, room=sid)

@sio.event
async def ping(sid):
    await sio.emit("pong", room=sid)


async def run_server(host: str = "0.0.0.0", port: int = 8080):
    """Run the web server (used for development/testing)"""
    global _server_instance
    import uvicorn

    config = uvicorn.Config(socket_app, host=host, port=port, log_level="info", access_log=False)
    server = uvicorn.Server(config)
    _server_instance = server
    try:
        await server.serve()
    finally:
        _server_instance = None


async def shutdown_server():
    """Gracefully shutdown the web server"""
    if _server_instance:
        logger.info("Setting server.should_exit = True")
        _server_instance.should_exit = True
        await asyncio.sleep(0.1)


if __name__ == "__main__":
    asyncio.run(run_server())
