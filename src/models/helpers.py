from __future__ import annotations

import json
import logging
import re
from base64 import b64encode
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Callable, Dict, Optional

import aiohttp
from yarl import URL

logger = logging.getLogger("TwitchDrops")

# --- REGEX VZORY ---
DIMS_PATTERN = re.compile(r"-\d+x\d+(?=\.(?:jpg|png|gif)$)", re.I)
SETTINGS_PATTERN = r'src="(https://[\w.]+/config/settings\.[0-9a-f]{32}\.js)"'
SPADE_PATTERN = r'"beacon_?url": ?"(https://[^"]+)"'


# ==============================================================================
# 1. STRINGOVÉ A REGEX HELPERY
# ==============================================================================

def remove_image_dimensions(url: str) -> str:
    """Odstraní rozměrový sufix z URL obrázků Twitchi (např. -285x380.jpg)."""
    if not url:
        return ""
    return DIMS_PATTERN.sub("", url)

def resolve_campaign_eligibility(linked: bool, valid: bool) -> bool:
    """Určuje, zda je kampaň způsobilá (dostupná pro získávání dropů)."""
    return bool(linked and valid)


def resolve_campaign_active(starts_at: datetime, ends_at: datetime) -> bool:
    """Určuje, zda kampaň právě probíhá na základě UTC času."""
    now = datetime.now(timezone.utc)
    start = starts_at if starts_at.tzinfo else starts_at.replace(tzinfo=timezone.utc)
    end = ends_at if ends_at.tzinfo else ends_at.replace(tzinfo=timezone.utc)
    return start <= now <= end

def slugify_game_name(name: str, override: Optional[str] = None) -> str:
    """Převede název hry na slug použitelný pro Twitch GQL API."""
    if override:
        return override
    if not name:
        return ""
    slug_text = re.sub(r"\'", "", name.lower())
    slug_text = re.sub(r"\W+", "-", slug_text)
    return re.sub(r"-{2,}", "-", slug_text.strip("-"))


def extract_spade_url_from_text(html_or_js: str) -> Optional[str]:
    """Extrahuje Spade beacon URL z obsahu HTML nebo JS pomocí regexu."""
    match = re.search(SPADE_PATTERN, html_or_js, re.I)
    return match.group(1) if match else None


def extract_settings_js_url(html_text: str) -> Optional[str]:
    """Extrahuje URL JS konfigurace ze stránky streamera."""
    match = re.search(SETTINGS_PATTERN, html_text, re.I)
    return match.group(1) if match else None


# ==============================================================================
# 2. JSON & DATA PARSING HELPERS
# ==============================================================================

def preprocess_benefit_json(data: Any, benefit_type_enum: type[Enum]) -> Dict[str, Any]:
    """Předzpracuje zanořenou Twitch GraphQL strukturu odměny do plochého slovníku."""
    if not isinstance(data, dict):
        return data

    benefit_data: Dict[str, Any] = data.get("benefit", data)
    if not isinstance(benefit_data, dict):
        benefit_data = {}

    dist_type = benefit_data.get("distributionType")

    if dist_type and dist_type in benefit_type_enum.__members__:
        b_type = benefit_type_enum(dist_type)
    else:
        b_type = getattr(benefit_type_enum, "UNKNOWN", None)

    return {
        "id": benefit_data.get("id", ""),
        "name": benefit_data.get("name", ""),
        "type": b_type,
        "imageAssetURL": (
            benefit_data.get("imageAssetURL")
            or benefit_data.get("imageURL")
            or ""
        ),
    }


def extract_drop_image_url(edges: list[Dict[str, Any]], benefits: list[Any]) -> str:
    """Sjednocená logika pro vytažení URL obrázku dropu z benefitEdges nebo objektů benefitů."""
    if edges and isinstance(edges, list):
        first_edge = edges[0] or {}
        if isinstance(first_edge, dict):
            benefit_sub = first_edge.get("benefit")
            benefit_dict = benefit_sub if isinstance(benefit_sub, dict) else {}

            image_url = (
                first_edge.get("imageAssetURL")
                or first_edge.get("imageURL")
                or benefit_dict.get("imageAssetURL")
                or benefit_dict.get("imageURL")
            )
            if image_url:
                return image_url

    if benefits:
        first_benefit = benefits[0]
        if isinstance(first_benefit, dict):
            return (
                first_benefit.get("image_url")
                or first_benefit.get("imageAssetURL")
                or first_benefit.get("image_asset_url")
                or ""
            )
        return (
            getattr(first_benefit, "image_url", "")
            or getattr(first_benefit, "image_asset_url", "")
            or getattr(first_benefit, "icon_url", "")
            or ""
        )

    return ""


def build_spade_payload(
    broadcast_id: Any,
    channel_id: Any,
    channel_login: str,
    game_name: str,
    game_id: Any,
    user_id: Any,
) -> Dict[str, str]:
    """Sestaví a zakóduje Base64 payload pro Spade tracking beacon (1 minuta sledování)."""
    try:
        parsed_user_id = int(user_id) if user_id else 0
    except (ValueError, TypeError):
        parsed_user_id = 0

    payload = [
        {
            "event": "minute-watched",
            "properties": {
                "broadcast_id": str(broadcast_id),
                "channel_id": str(channel_id),
                "channel": channel_login,
                "client_time": datetime.now(timezone.utc).isoformat(),
                "game": game_name,
                "game_id": str(game_id),
                "hidden": False,
                "is_live": True,
                "live": True,
                "location": "channel",
                "logged_in": True,
                "minutes_logged": 1,
                "muted": False,
                "player": "site",
                "user_id": parsed_user_id,
            },
        }
    ]
    minified_json = json.dumps(payload, separators=(",", ":"))
    return {"data": b64encode(minified_json.encode("utf8")).decode("utf8")}


# ==============================================================================
# 3. VÝPOČTY & STAVY
# ==============================================================================

def _ensure_utc(dt: datetime) -> datetime:
    """Ošetří datetime tak, aby vždy obsahoval UTC časovou zónu."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def calculate_progress(current_minutes: int, required_minutes: int) -> float:
    """Vypočítá procentuální průběh (0.0 až 1.0)."""
    if current_minutes <= 0 or required_minutes <= 0:
        return 0.0
    if current_minutes >= required_minutes:
        return 1.0
    return current_minutes / required_minutes


def calculate_availability(ends_at: datetime, remaining_minutes: int, required_minutes: int) -> float:
    """Vypočítá koeficient časové dostupnosti dropu."""
    now = datetime.now(timezone.utc)
    ends_at_utc = _ensure_utc(ends_at)

    if required_minutes > 0 and remaining_minutes > 0 and now < ends_at_utc:
        return ((ends_at_utc - now).total_seconds() / 60) / remaining_minutes
    return float("inf")


def resolve_drop_status(
    is_claimed: bool,
    can_claim: bool,
    is_mining: bool = False,
    is_stuck: bool = False,
    current_minutes: int = 0,
) -> str:
    """Čistá funkce pro unifikované vyhodnocení stavu dropu."""
    if is_claimed:
        return "claimed"
    if can_claim:
        return "ready_to_claim"
    if is_stuck:
        return "stuck"
    if is_mining:
        return "mining"
    if current_minutes > 0:
        return "in_progress"
    return "queued"


# ==============================================================================
# 4. SÍŤOVÉ A API POMOCNÉ FUNKCE
# ==============================================================================

async def fetch_spade_url(twitch_client: Any, channel_url: URL | str) -> URL:
    """Dvoukroková extrakce Spade URL ze stránek kanálu přes HTTP klient."""
    async with twitch_client.request("GET", channel_url) as response1:
        streamer_html: str = await response1.text(encoding="utf8")

    spade_url = extract_spade_url_from_text(streamer_html)
    if not spade_url:
        settings_url = extract_settings_js_url(streamer_html)
        if not settings_url:
            raise RuntimeError("Error while spade_url extraction: step #1")

        async with twitch_client.request("GET", settings_url) as response2:
            settings_js: str = await response2.text(encoding="utf8")

        spade_url = extract_spade_url_from_text(settings_js)
        if not spade_url:
            raise RuntimeError("Error while spade_url extraction: step #2")

    return URL(spade_url)


async def fetch_stream_hls_url(
    twitch_client: Any,
    channel_login: str,
    gql_operations: Dict[str, Any],
    on_offline_callback: Optional[Callable[[], None]] = None,
) -> Optional[URL]:
    """Získá M3U8 HLS URL adresu streamu přes GQL AccessToken a Usher API."""
    gql_op = gql_operations["PlaybackAccessToken"].with_variables({"login": channel_login})
    playback_token_response = await twitch_client.gql_request(gql_op)

    token_data = (
        playback_token_response.get("data", {}).get("streamPlaybackAccessToken")
        if isinstance(playback_token_response, dict)
        else None
    )
    if not token_data or not isinstance(token_data, dict):
        if on_offline_callback:
            on_offline_callback()
        return None

    token_value = token_data.get("value")
    token_signature = token_data.get("signature")

    if not token_value or not token_signature:
        if on_offline_callback:
            on_offline_callback()
        return None

    available_qualities = ""
    usher_url = URL("https://usher.ttvnw.net/api/channel/hls").with_path(
        f"/api/channel/hls/{channel_login}.m3u8"
    ).with_query({"sig": token_signature, "token": token_value})

    try:
        async with twitch_client.request("GET", usher_url) as response:
            available_qualities = await response.text()
            try:
                available_json = json.loads(available_qualities)
            except json.JSONDecodeError:
                pass
            else:
                if isinstance(available_json, list) and available_json:
                    available_json = available_json[0]
                if isinstance(available_json, dict) and "error" in available_json:
                    logger.error(f'Stream URL get error: "{available_json["error"]}"')
                    if on_offline_callback:
                        on_offline_callback()
                    return None

            # Extrakce poslední platné URL z M3U8 playlistu (přeskočí prázdné řádky a M3U8 tagy #)
            m3u8_lines = [
                line.strip()
                for line in available_qualities.splitlines()
                if line.strip() and not line.strip().startswith("#")
            ]
            if m3u8_lines:
                return URL(m3u8_lines[-1])

            return None
    except (aiohttp.InvalidURL, ValueError):
        if hasattr(twitch_client, "print"):
            twitch_client.print(available_qualities)
        raise


async def execute_gql_claim(
    twitch_client: Any,
    claim_id: str,
    gql_operations: Dict[str, Any],
) -> bool:
    """Odesle požadavek na vyzvednutí (Claim) dropu přes GQL API."""
    if not claim_id:
        return False

    try:
        gql_op = gql_operations["ClaimDrop"].with_variables(
            {"input": {"dropInstanceID": claim_id}}
        )
        response = await twitch_client.gql_request(gql_op)
        logger.debug(f"Twitch claim response: {response}")
    except Exception as e:
        logger.error(f"GQL Exception during claim: {e}")
        return False

    if isinstance(response, dict) and response.get("errors"):
        logger.error(f"Twitch API error during claim: {response['errors']}")
        return False

    data = response.get("data") if isinstance(response, dict) else {}
    if data and "claimDropRewards" in data and data["claimDropRewards"]:
        status = data["claimDropRewards"].get("status")
        if status in ("ELIGIBLE_FOR_ALL", "DROP_INSTANCE_ALREADY_CLAIMED"):
            return True
        logger.warning(f"Unsuccessful claim status: {status}")

    return False

def update_drop_minutes(current_minutes: int, required_minutes: int, new_minutes: int) -> int:
    """Synchronizuje odehrané minuty a omezí je do rozmezí 0 až required_minutes."""
    if new_minutes < 0:
        return current_minutes
    return min(new_minutes, required_minutes)

def extract_campaign_time_triggers(starts_at: datetime, ends_at: datetime) -> set[datetime]:
    """Vrátí časové body (začátek a konec), které slouží jako spouštěče přepnutí kampaně."""
    triggers = set()
    if starts_at:
        triggers.add(starts_at)
    if ends_at:
        triggers.add(ends_at)
    return triggers

def check_watchable_drops(drops: list) -> bool:
    """Vrátí True, pokud kampaň obsahuje alespoň jeden zatím nevyzvednutý drop."""
    return any(not getattr(d, "is_claimed", False) for d in drops)

def filter_wanted_unclaimed_benefits(benefits: list, is_claimed: bool, mining_benefits: list | None = None) -> list:
    """Vrátí nevyzvednuté výhody (rewards/benefits) odpovídající nastavení miningu."""
    if is_claimed or not benefits:
        return []
    if not mining_benefits:
        return list(benefits)
    # Pokud jsou zadány filtrovací preference (např. typy výhod)
    return [b for b in benefits if getattr(b, "type", None) in mining_benefits or getattr(b, "id", None) in mining_benefits]

def check_drop_can_claim(current_minutes: int, required_minutes: int, is_claimed: bool) -> bool:
    """Vrátí True, pokud jsou splněny minuty sledování a drop ještě nebyl vyzvednut."""
    if is_claimed:
        return False
    return current_minutes >= required_minutes and required_minutes > 0

def calculate_remaining_minutes(end_time: datetime | str | None) -> int:
    """Vypočítá počet zbývajících minut do konce kampaně."""
    if not end_time:
        return 0
    
    if isinstance(end_time, str):
        try:
            end_time = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
        except ValueError:
            return 0

    now = datetime.now(timezone.utc)
    if end_time.tzinfo is None:
        end_time = end_time.replace(tzinfo=timezone.utc)
        
    diff = end_time - now
    return max(0, int(diff.total_seconds() // 60))
    
def calculate_campaign_remaining_minutes(campaign) -> int:
    """Vrátí zbývající čas k odsedění (watch time) – maximum z nehotových paralelních dropů."""
    if not hasattr(campaign, "drops") or not campaign.drops:
        return 0
    
    def safe_val(obj, name, default=0):
        val = getattr(obj, name, default)
        return val() if callable(val) else (val if val is not None else default)

    remaining_drop_times = [
        max(0, safe_val(drop, "required_minutes") - safe_val(drop, "current_minutes"))
        for drop in campaign.drops
        if not safe_val(drop, "claimed", False)
    ]
    
    if not remaining_drop_times:
        return 0
        
    return max(remaining_drop_times)

def build_channel_stream_gql(channel_name: str | None, channel_id: int | str | None) -> dict:
    """Vytvoří GQL dotaz/payload pro zjištění živého vysílání daného kanálu pomocí inline dotazu (obejití PersistedQueryNotFound)."""
    query = """
        query UserQuery($login: String!) {
            user(login: $login) {
                id
                displayName
                stream {
                    id
                    viewersCount
                    type
                    createdAt
                    game {
                        id
                        name
                    }
                }
            }
        }
    """
    return {
        "operationName": "UserQuery",
        "query": query,
        "variables": {
            "login": channel_name or "",
        }
    }
