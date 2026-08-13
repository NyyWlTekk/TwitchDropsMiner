#!/usr/bin/env python3
import sys
import asyncio
from pathlib import Path

# Přidání adresáře src do python path
sys.path.insert(0, str(Path(__file__).parent / "src"))

print("[INFO] Spouštím upravený diagnostický skript...")

# Mock třídy pro obcházení závislosti na GUI v headless režimu
class DummyLogin:
    pass

class DummyGui:
    def __init__(self):
        self.login = DummyLogin()

async def main():
    try:
        import src.core.client as client_mod
        from src.config.settings import Settings

        client_class = getattr(client_mod, "Twitch", None)
        if not client_class:
            print("[ERROR] Třída Twitch nebyla nalezena.")
            return

        settings = Settings()
        client_instance = client_class(settings)

        # Ošetření chybějícího GUI, aby validace tokenu nepadala na NoneType
        if getattr(client_instance, "gui", None) is None:
            client_instance.gui = DummyGui()

        print(f"[SUCCESS] Instance klienta vytvořena a ošetřena mockem GUI.")

        # Stažení inventáře a kampaní
        if hasattr(client_instance, "fetch_inventory"):
            print("[INFO] Spouštím fetch_inventory()...")
            await client_instance.fetch_inventory()

        campaigns = getattr(client_instance, "campaigns", []) or []
        print(f"[INFO] Celkový počet načtených kampaní v paměti: {len(campaigns)}")

        target_found = False
        for camp in campaigns:
            game_obj = getattr(camp, "game", None)
            game_name = getattr(game_obj, "name", str(game_obj)) if game_obj else ""
            camp_name = getattr(camp, "name", "")

            if "rainbow six" in game_name.lower() or "siege" in game_name.lower() or "jynxzi" in camp_name.lower():
                target_found = True
                print("\n--------------------------------------------------------")
                print(f"[SUCCESS] NALEZENA CÍLOVÁ KAMPAŇ: {camp_name}")
                print("--------------------------------------------------------")
                print(f" * ID kampaně:          {getattr(camp, 'id', 'N/A')}")
                print(f" * Hra:                 {game_name}")
                print(f" * Atribut self.linked: {getattr(camp, 'linked', 'N/A')}")
                print(f" * Property eligible:   {getattr(camp, 'eligible', 'N/A')}")
                print(f" * Has badge/emote:     {getattr(camp, 'has_badge_or_emote', 'N/A')}")
                print(f" * Kampaň isClaimed:    {getattr(camp, 'isClaimed', 'N/A')}")
                print("\n Detaily jednotlivých dropů:")
                
                for idx, drop in enumerate(getattr(camp, "drops", []) or []):
                    d_name = getattr(drop, "name", f"Drop #{idx+1}")
                    curr = getattr(drop, "current_minutes", getattr(drop, "currentMinutesWatched", 0))
                    req = getattr(drop, "required_minutes", getattr(drop, "requiredMinutesWatched", 0))
                    claimed = getattr(drop, "is_claimed", getattr(drop, "isClaimed", False))
                    print(f"   [{idx+1}] {d_name}")
                    print(f"       -> Pokrok: {curr} / {req} minut")
                    print(f"       -> Nárokováno (is_claimed): {claimed}")
                print("--------------------------------------------------------\n")

        if not target_found:
            print("\n[WARNING] Kampaň pro Rainbow Six Siege / Jynxzi nebyla v načtených kampaních nalezena.")
            print(f"[INFO] Celkem kampaní v paměti: {len(campaigns)}")
            for camp in campaigns:
                g = getattr(camp, "game", None)
                g_name = getattr(g, "name", g) if g else "Neznámá hra"
                print(f"   -> Hra: '{g_name}' | Kampaň: {getattr(camp, 'name', 'N/A')}")

    except Exception as e:
        print(f"[ERROR] Diagnostika selhala s výjimkou: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(main())
