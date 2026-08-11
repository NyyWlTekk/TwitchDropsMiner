import json
from pathlib import Path
from src.services.inventory_service import sanitize_raw_campaign_data


def test_sanitize_campaign_logic():
    """
    Unit test overujici spravne chovani sanitace u rozdilnych typů kampani:
    - Emoty/Předměty již vlastněné ze STARŠÍCH kampaní (např. DJs) -> CLAIMED
    - Opakované odměny v RÁMCI TÉŽE kampaně (např. Kakele) -> NOT CLAIMED
    """
    mock_inventory = {
        "data": {
            "currentUser": {
                # 1. Historie ziskanych dropu na ucet (gameEventDrops)
                "gameEventDrops": [
                    {
                        "id": "event_drop_djs_old",
                        "benefitID": "DJS_EMOTE_BOP2BOP",
                        "campaign": {"id": "DJS_CAMPAIGN_WEEK_1"}  # Získáno v minulé kampani
                    },
                    {
                        "id": "event_drop_kakele_1",
                        "benefitID": "KAKELE_COINS_100",
                        "campaign": {"id": "KAKELE_CAMPAIGN_2026"}  # Získáno v Dropu #1
                    }
                ],
                # 2. Probíhající kampaně
                "dropCampaignsInProgress": [
                    # Kampaň A: DJs (Nová týdenní kampaň nabízející STEJNÝ emot ze starší kampaně)
                    {
                        "id": "DJS_CAMPAIGN_WEEK_2",
                        "name": "DJs - 8.08 Week",
                        "timeBasedDrops": [
                            {
                                "id": "djs_drop_2",
                                "name": "Bop2bop Emote",
                                "requiredMinutesWatched": 120,
                                "isClaimed": False,
                                "self": {"isClaimed": False, "currentMinutesWatched": 0},
                                "benefitEdges": [
                                    {
                                        "claimCount": 0,
                                        "entitlementLimit": 1,
                                        "benefit": {"id": "DJS_EMOTE_BOP2BOP"}
                                    }
                                ]
                            }
                        ]
                    },
                    # Kampaň B: Kakele (Série dropů v jedné kampani recyklující coins)
                    {
                        "id": "KAKELE_CAMPAIGN_2026",
                        "name": "Kakele Online - August",
                        "timeBasedDrops": [
                            {
                                "id": "kakele_drop_5",
                                "name": "Coins Stream Drop #5",
                                "requiredMinutesWatched": 60,
                                "isClaimed": False,
                                "self": {"isClaimed": False, "currentMinutesWatched": 0},
                                "benefitEdges": [
                                    {
                                        "claimCount": 0,  # 0/1 v probíhající kampani
                                        "entitlementLimit": 1,
                                        "benefit": {"id": "KAKELE_COINS_100"}
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        }
    }

    # Spustíme sanitaci
    sanitized = sanitize_raw_campaign_data(mock_inventory)
    campaigns = sanitized["data"]["currentUser"]["dropCampaignsInProgress"]

    djs_campaign = next(c for c in campaigns if c["id"] == "DJS_CAMPAIGN_WEEK_2")
    kakele_campaign = next(c for c in campaigns if c["id"] == "KAKELE_CAMPAIGN_2026")

    djs_drop = djs_campaign["timeBasedDrops"][0]
    kakele_drop = kakele_campaign["timeBasedDrops"][0]

    print("\n" + "=" * 50)
    print("🧪 VÝSLEDKY UNIT TESTU SANITACE")
    print("=" * 50)
    print(f"1. DJs (Emote z jiné kampaně)   -> isClaimed: {djs_drop['isClaimed']} (Očekáváno: True)")
    print(f"2. Kakele (0/1 v téže kampani) -> isClaimed: {kakele_drop['isClaimed']} (Očekáváno: False)")
    print("=" * 50)

    # Validace
    assert djs_drop["isClaimed"] is True, "❌ DJs drop měl být přeskočen (CLAIMED)!"
    assert djs_drop["self"]["isClaimed"] is True

    assert kakele_drop["isClaimed"] is False, "❌ Kakele Drop #5 neměl být přeskočen!"
    assert kakele_drop["self"]["isClaimed"] is False

    print("✅ UNIT TEST PASSED!\n")


def test_debug_real_file(filename: str = "ewc_raw.json"):
    """
    Volitelná analýza reálného JSON dumpu z disku, pokud existuje.
    """
    raw_file = Path(filename)
    if not raw_file.exists():
        print(f"ℹ️  Soubor {filename} neexistuje, přeskakuji analýzu reálných dat.")
        return

    with open(raw_file, "r", encoding="utf-8") as f:
        real_data = json.load(f)

    sanitized = sanitize_raw_campaign_data(real_data)
    
    print(f"\n🔍 ANALÝZA REÁLNÉHO SOUBORU: {filename}")
    
    # Podpora pro celou strukturu inventáře i jednotlivou kampaň
    user = sanitized.get("data", {}).get("currentUser", {}) if isinstance(sanitized, dict) else {}
    campaigns = user.get("dropCampaignsInProgress", []) if user else [sanitized]

    for camp in campaigns:
        print(f"\n📋 Kampaň: {camp.get('name', 'Neznámá')}")
        for drop in camp.get("timeBasedDrops", []):
            status = "✅ CLAIMED (SKIPPED)" if drop.get("isClaimed") else "⛏️ MINING (ACTIVE)"
            print(f"  └─ Drop: '{drop.get('name')}' -> Status: {status}")


if __name__ == "__main__":
    # 1. Spustíme simulovaný test logiky
    test_sanitize_campaign_logic()
    
    # 2. Pokud máš na disku reálný dump, otestujeme i ten
    test_debug_real_file("ewc_raw.json")
