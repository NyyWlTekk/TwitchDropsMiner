import json
import os
import re
import urllib.error
import urllib.request
from http.cookiejar import LWPCookieJar, MozillaCookieJar

CLIENT_ID = "kimne78kx3ncx6br8h4mv6wki5h1ko"
GQL_URL = "https://gql.twitch.tv/gql"


def _find_token_in_dict(obj):
    """Rekurzivně prohledá slovník/seznam a najde klíč s tokenem."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.lower() in [
                "auth_token",
                "authtoken",
                "auth-token",
                "token",
                "oauth_token",
            ] and isinstance(v, str):
                return v
            res = _find_token_in_dict(v)
            if res:
                return res
    elif isinstance(obj, list):
        for item in obj:
            res = _find_token_in_dict(item)
            if res:
                return res
    return None


import json
import os
import pickle
import re


def _find_token(data):
    """Rekurzivně vyhledá klíč auth-token v JSON struktuře."""
    if isinstance(data, dict):
        for k, v in data.items():
            if k == "auth-token" and isinstance(v, str):
                return v
            if k.lower() in ["auth_token", "authtoken", "token"] and isinstance(v, str):
                return v
            res = _find_token(v)
            if res:
                return res
    elif isinstance(data, list):
        for item in data:
            res = _find_token(item)
            if res:
                return res
    return None


def get_auth_token() -> str:
    # 1. Zkontrolovat env proměnnou
    token = os.environ.get("AUTH_TOKEN", "").strip()
    if token:
        print("[+] Token načten z prostředí (AUTH_TOKEN).")
        return token

    cookies_path = os.path.join("data", "cookies.jar")

    # 2. Pokus načíst cookies.jar jako JSON (když začíná na '{')
    if os.path.exists(cookies_path):
        try:
            with open(cookies_path, "r", encoding="utf-8") as f:
                cdata = json.load(f)
                token = _find_token(cdata)
                if token:
                    print(f"[+] Token načten z '{cookies_path}' (jako JSON).")
                    return token
        except Exception:
            pass

        # Pokus o pickle (kdyby to byl přece jen binární pickle)
        try:
            with open(cookies_path, "rb") as f:
                jar = pickle.load(f)
                for cookie in jar:
                    if getattr(cookie, "name", "") == "auth-token":
                        print(f"[+] Token načten z '{cookies_path}' (přes pickle).")
                        return cookie.value
        except Exception:
            pass

        # Pokus o regex scan textu
        try:
            with open(cookies_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
                match = re.search(r'["\']?auth-token["\']?\s*[:=]\s*["\']?([a-zA-Z0-9]{25,40})["\']?', content)
                if match:
                    print(f"[+] Token načten z '{cookies_path}' (regex).")
                    return match.group(1)
        except Exception:
            pass

    # 3. Pokus o data/settings.json
    settings_path = os.path.join("data", "settings.json")
    if os.path.exists(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                sdata = json.load(f)
                token = _find_token(sdata)
                if token:
                    print(f"[+] Token načten z '{settings_path}'.")
                    return token
        except Exception:
            pass

    return ""


AUTH_TOKEN = get_auth_token()

# ==============================================================================
# GQL DOTAZY
# ==============================================================================
QUERY_CURRENT_USER_BADGES = """
query GetUserBadges {
  currentUser {
    id
    login
    displayName
    badges {
      id
      setID
      version
    }
  }
}
"""

QUERY_INVENTORY = """
query GetUserInventory {
  currentUser {
    inventory {
      dropCampaigns {
        id
        name
        status
      }
    }
  }
}
"""


def send_gql_request(query: str, operation_name: str):
    headers = {
        "Client-Id": CLIENT_ID,
        "Authorization": f"OAuth {AUTH_TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    }

    payload = json.dumps({"query": query, "operationName": operation_name}).encode("utf-8")
    req = urllib.request.Request(GQL_URL, data=payload, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"[!] HTTP Chyba {e.code}: {e.read().decode('utf-8')}")
        return None
    except Exception as e:
        print(f"[!] Chyba při odesílání požadavku: {e}")
        return None


def main():
    if not AUTH_TOKEN:
        print("[!] Token se nepodařilo automaticky vyhledat v data/settings.json ani v data/cookies.jar.")
        return

    print("=" * 60)
    print(" 1. TEST: Načítání currentUser.badges (Aktuálně dostupné odznaky)")
    print("=" * 60)

    res1 = send_gql_request(QUERY_CURRENT_USER_BADGES, "GetUserBadges")

    if res1 and "data" in res1 and res1["data"].get("currentUser"):
        user_data = res1["data"]["currentUser"]
        badges = user_data.get("badges", [])

        print(f"Přihlášen jako: {user_data.get('displayName')} ({user_data.get('login')})")
        print(f"Počet vracených odznaků přes currentUser.badges: {len(badges)}\n")

        for idx, badge in enumerate(badges, start=1):
            print(f"  {idx}. ID: {badge.get('id')} | setID: {badge.get('setID')} | Version: {badge.get('version')}")
    else:
        print("[!] Nepodařilo se načíst data z currentUser.badges. Zkontroluj platnost tokenu.")

    print("\n" + "=" * 60)
    print(" 2. TEST: Načítání drop kampaní z inventáře")
    print("=" * 60)

    res2 = send_gql_request(QUERY_INVENTORY, "GetUserInventory")

    if res2 and "data" in res2 and res2["data"].get("currentUser"):
        inventory = res2["data"]["currentUser"].get("inventory", {})
        campaigns = inventory.get("dropCampaigns", [])

        print(f"Počet kampaní v inventáři: {len(campaigns)}\n")
        for idx, camp in enumerate(campaigns[:10], start=1):
            print(f"  {idx}. {camp.get('name')} (Status: {camp.get('status')})")


if __name__ == "__main__":
    main()
