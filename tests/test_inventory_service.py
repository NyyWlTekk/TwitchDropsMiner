import pytest
from unittest.mock import MagicMock

# Importuj funkce z tvého modulu (uprav cestu podle struktury projektu)
# Pokud máš _normalize_str na úrovni modulu:
from src.services.inventory_service import InventoryService, _normalize_str


class TestInventoryMatching:

    @pytest.fixture
    def service(self):
        """Vytvoří mockovanou instanci InventoryService pro testování."""
        twitch_mock = MagicMock()
        # Pokud metoda vyžaduje self._twitch
        svc = InventoryService(twitch_mock)
        return svc

    # ==========================================
    # 1. TESTY NORMALIZACE
    # ==========================================
    @pytest.mark.parametrize(
        "input_str, expected",
        [
            ("Bop2bop Emote", "bop2bopemote"),
            ("EWC 2026 (Bronze)", "ewc2026bronze"),
            ("hype_train_lvl5!", "hypetrainlvl5"),
            ("", ""),
            (None, ""),
        ],
    )
    def test_normalize_str(self, input_str, expected):
        assert _normalize_str(input_str) == expected

    # ==========================================
    # 2. TEST EMOTE PAROVANI (8.08 / Bop2bop)
    # ==========================================
    def test_sanitize_campaign_808_emote_match(self, service):
        # Na účtu máme uložený token "bop2bop" z EmotePicker_UserEmotes
        owned_ids = {"emotesv2_12345"}
        owned_names = {"bop2bop"}

        # Simulovaná kampaň 8.08 z GQL
        campaign_data = {
            "name": "8.08 Week",
            "isClaimed": False,
            "timeBasedDrops": [
                {
                    "id": "drop-uuid-808",
                    "name": "Bop2bop Emote Drop",
                    "isClaimed": False,
                    "requiredMinutesWatched": 120,
                    "benefitEdges": [
                        {
                            "benefit": {
                                "id": "benefit-uuid-1",
                                "name": "Bop2bop Emote",
                                "emote": {
                                    "id": "12345",
                                    "token": "bop2bop",
                                },
                            }
                        }
                    ],
                }
            ],
        }

        res = service._sanitize_campaign_dict(campaign_data, owned_ids, owned_names)

        # Očekáváme, že drop i kampaň budou vyhodnoceny jako vybrané (isClaimed = True)
        assert res["isClaimed"] is True
        assert res["timeBasedDrops"][0]["isClaimed"] is True
        assert res["timeBasedDrops"][0]["self"]["isClaimed"] is True
        assert res["timeBasedDrops"][0]["self"]["currentMinutesWatched"] == 120

    # ==========================================
    # 3. TEST BADGE PAROVANI (EWC 2026)
    # ==========================================
    def test_sanitize_campaign_ewc_badge_match(self, service):
        # Na účtu máme např. "ewc2026bronze" z titulu/setID badge
        owned_ids = set()
        owned_names = {"ewc2026bronze", "ewc-2026"}

        campaign_data = {
            "name": "EWC 2026",
            "isClaimed": False,
            "timeBasedDrops": [
                {
                    "id": "ewc-drop-1",
                    "name": "EWC Bronze",
                    "isClaimed": False,
                    "benefitEdges": [
                        {
                            "benefit": {
                                "id": "benefit-ewc-1",
                                "name": "EWC 2026 (Bronze)",
                                "badge": {
                                    "setID": "ewc-2026",
                                    "title": "EWC 2026 Bronze",
                                },
                            }
                        }
                    ],
                }
            ],
        }

        res = service._sanitize_campaign_dict(campaign_data, owned_ids, owned_names)

        assert res["isClaimed"] is True
        assert res["timeBasedDrops"][0]["isClaimed"] is True

    # ==========================================
    # 4. TEST CHYBĚJÍCÍHO (NEVLASTNĚNÉHO) DROPŮ
    # ==========================================
    def test_sanitize_campaign_unowned_item(self, service):
        owned_ids = {"some_other_id"}
        owned_names = {"random_item"}

        campaign_data = {
            "name": "EWC 2026",
            "isClaimed": False,
            "timeBasedDrops": [
                {
                    "id": "ewc-drop-gold",
                    "name": "EWC Gold",
                    "isClaimed": False,
                    "benefitEdges": [
                        {
                            "benefit": {
                                "id": "benefit-gold",
                                "name": "EWC Gold Badge",
                            }
                        }
                    ],
                }
            ],
        }

        res = service._sanitize_campaign_dict(campaign_data, owned_ids, owned_names)

        # Kampaň i drop musí zůstat NEvybrané (isClaimed = False)
        assert res["isClaimed"] is False
        assert res["timeBasedDrops"][0].get("isClaimed") is False


    # ==========================================
    # 5. TEST: Běžný herní předmět (Nesmí se nechtěně spárovat!)
    # ==========================================
    def test_sanitize_campaign_regular_ingame_drop_unowned(self, service):
        # Na účtu máme nějaké jiné věci
        owned_ids = {"some_other_id"}
        owned_names = {"bop2bop", "other_skin"}

        # Kampaň s běžným herním dropem (např. WoW)
        campaign_data = {
            "name": "World of Warcraft Drop",
            "isClaimed": False,
            "timeBasedDrops": [
                {
                    "id": "wow-drop-1",
                    "name": "Ensemble: Sorcerer's Grassy Garb",
                    "isClaimed": False,
                    "benefitEdges": [
                        {
                            "benefit": {
                                "id": "benefit-wow-1",
                                "name": "Sorcerer's Grassy Garb",
                                "distributionType": "GAME_ITEM",  # Není to BADGE!
                            }
                        }
                    ],
                }
            ],
        }

        res = service._sanitize_campaign_dict(
            campaign_data, owned_ids, owned_names
        )

        # Očekáváme, že kampaň ZŮSTANE k těžení (isClaimed = False)
        assert res["isClaimed"] is False
        assert res["timeBasedDrops"][0]["isClaimed"] is False


    def test_sanitize_campaign_regex_overcleaning_prevention(self, service):
        """Ověří, že ořezávání slov 'drop/badge/emote' nerozbije názvy herních předmětů."""
        owned_ids = set()
        # Na účtu máme předmět "drop" nebo "emote", ale ne tento konkrétní skin
        owned_names = {"drop", "emote"}

        campaign_data = {
            "name": "Roblox Egg Hunt",
            "isClaimed": False,
            "timeBasedDrops": [
                {
                    "id": "rblx-1",
                    "name": "RBLXpip Emote Drop",
                    "isClaimed": False,
                    "benefitEdges": [
                        {
                            "benefit": {
                                "id": "b-rblx-1",
                                "name": "RBLXpip Emote",
                                "distributionType": "GAME_ITEM",
                            }
                        }
                    ],
                }
            ],
        }

        res = service._sanitize_campaign_dict(
            campaign_data, owned_ids, owned_names
        )

        # Pokud ho nemáme na účtu pod "rblxpip", nesmí se označit jako vlastněný!
        assert res["isClaimed"] is False
