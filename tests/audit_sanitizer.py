#!/usr/bin/env python3
"""
Diagnostic Suite for Twitch Drops Sanitization Logic.
Tests for false positives, substring collisions, and asset verification.
"""

import re
from dataclasses import dataclass, field
from typing import Dict, List, Set, Tuple


# ==========================================
# TEST DATA (Jedovaté prostředí s kolizemi)
# ==========================================

MOCK_CLAIMED_IDS = {
    "claim-uuid-overwatch-spray-01",
    "claim-uuid-rust-skin-99",
}

# Emoty a odznaky v účtu (často obsahují krátká nebo obecná slova!)
MOCK_CLAIMED_EMOTES_BADGES = {
    "ow",           # Krátký emote - riziko pro Overwatch
    "overwatch",    # Emote s přesným názvem hry
    "wow",          # Krátký emote pro World of Warcraft
    "rust",         # Badge pro Rust
    "drop",         # Extremně obecné slovo
    "spray",        # Obecný typ odměny
}

MOCK_CAMPAIGNS = [
    {
        "id": "camp-ow2-01",
        "name": "Overwatch 2 Season Launch Drops",
        "game": {"name": "Overwatch 2"},
        "timeBasedDrops": [
            {
                "id": "drop-ow2-spray",
                "name": "Overwatch Spray Option A",
                "requiredMinutesWatched": 60,
                "benefitEdges": [{"benefit": {"id": "benefit-ow2-spray-id", "name": "Overwatch Spray"}}]
            },
            {
                "id": "drop-ow2-skin",
                "name": "Overwatch Epic Skin",
                "requiredMinutesWatched": 120,
                "benefitEdges": [{"benefit": {"id": "benefit-ow2-skin-id", "name": "Epic Skin"}}]
            }
        ]
    },
    {
        "id": "camp-wow-01",
        "name": "World of Warcraft Expansion Drop",
        "game": {"name": "World of Warcraft"},
        "timeBasedDrops": [
            {
                "id": "drop-wow-mount",
                "name": "WoW Dragon Mount",
                "requiredMinutesWatched": 240,
                "benefitEdges": [{"benefit": {"id": "claim-uuid-wow-mount", "name": "Dragon Mount"}}]
            }
        ]
    },
    {
        "id": "camp-rust-01",
        "name": "Rust Twitch Rivals",
        "game": {"name": "Rust"},
        "timeBasedDrops": [
            {
                "id": "drop-rust-bandana",
                "name": "Rust Bandana Skin",
                "requiredMinutesWatched": 180,
                "benefitEdges": [{"benefit": {"id": "claim-uuid-rust-skin-99", "name": "Rust Bandana"}}]
            }
        ]
    }
]


# ==========================================
# ALGORITMY PRO AUDIT
# ==========================================

def clean_token(text: str) -> str:
    """Normalizace textu pro bezpečné porovnání."""
    if not text:
        return ""
    text = text.lower()
    for word in ["emote", "badge", "emotes", "badges", "spray", "skin", "drop"]:
        text = text.replace(word, "")
    text = re.sub(r'[^a-z0-9\s]', ' ', text)
    return " ".join(text.split()).strip()


def run_sanitization_audit(campaigns: List[Dict], claimed_ids: Set[str], claimed_tokens: Set[str]):
    print("=" * 70)
    print(" 🛠️  RUNNING SANITIZATION AUDIT & COLLISION DETECTION")
    print("=" * 70)

    total_campaigns = len(campaigns)
    total_drops = 0
    false_positives = []
    valid_id_matches = []
    
    clean_history_tokens = {clean_token(t) for t in claimed_tokens if clean_token(t)}

    for campaign in campaigns:
        camp_name = campaign.get("name", "Unknown")
        game_name = campaign.get("game", {}).get("name", "Unknown Game")
        drops = campaign.get("timeBasedDrops", [])
        
        camp_had_false_positive = False

        for drop in drops:
            total_drops += 1
            drop_name = drop.get("name", "")
            benefits = drop.get("benefitEdges", [])

            for edge in benefits:
                benefit = edge.get("benefit", {})
                b_id = str(benefit.get("id", "")).lower().strip()
                b_name = str(benefit.get("name", "")).lower().strip()
                clean_b_name = clean_token(b_name)

                # 1. OK MATCH: Přesná shoda ID
                if b_id and b_id in claimed_ids:
                    valid_id_matches.append((camp_name, drop_name, f"ID Match: {b_id}"))
                    continue

                # 2. RISKY SUBSTRING MATCH (Stará nebezpečná logika)
                # Testujeme, zda by starý kód udělal chybu
                for token in clean_history_tokens:
                    if len(token) > 0 and (token == clean_b_name or token in clean_b_name or clean_b_name in token):
                        # Pokud to není přesný Match ID, ale jen podřetězec textu, je to FALSE POSITIVE!
                        false_positives.append({
                            "campaign": camp_name,
                            "game": game_name,
                            "drop": drop_name,
                            "collided_with_token": token,
                            "benefit_name": b_name
                        })
                        camp_had_false_positive = True
                        break

    # ==========================================
    # VÝSTUPNÍ REPORT
    # ==========================================
    
    print(f"\n📊 SUMMARY:")
    print(f"  • Total Campaigns Checked : {total_campaigns}")
    print(f"  • Total Drops Analyzed    : {total_drops}")
    print(f"  • Valid ID Matches (OK)   : {len(valid_id_matches)}")
    print(f"  • 🚨 False Positives      : {len(false_positives)}\n")

    if false_positives:
        print("🚨 DETECTED FALSE POSITIVES (Hry, které by neprávem zmizely!):")
        print("-" * 70)
        for fp in false_positives:
            print(f" ❌ Game: [{fp['game']}] | Campaign: '{fp['campaign']}'")
            print(f"    └── Drop: '{fp['drop']}'")
            print(f"    └── Collision: Token '{fp['collided_with_token']}' matched benefit '{fp['benefit_name']}'")
            print("-" * 70)
    else:
        print("✅ SUCCESS: Žádné falešné shody nebyly detekovány!")

if __name__ == "__main__":
    run_sanitization_audit(MOCK_CAMPAIGNS, MOCK_CLAIMED_IDS, MOCK_CLAIMED_EMOTES_BADGES)
