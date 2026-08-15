from datetime import datetime, timedelta, timezone
from pydantic import BaseModel, Field

from src.models.models import Campaign

# IMPORTUJ REÁLNÉ MODELY ZE SVÉHO PROJEKTU:
# např.: from models import Campaign, Drop, Game, Channel
# Pokud testuješ izolovaně, můžeš importovat přímo třídu Campaign ze souboru, kde leží.

def create_base_campaign(**kwargs):
    now = datetime.now(timezone.utc)
    
    # Vytvoření jednoho aktivního dropu, který ještě není splněný
    dummy_drop = TimedDrop(
        id="drop_123",
        name="Test Drop",
        required_minutes=60,
        current_minutes=0,
        is_claimed=False,
        # pokud TimedDrop vyžaduje časové rozmezí, nastav podle potřeby:
        starts_at=now - timedelta(hours=1),
        ends_at=now + timedelta(hours=1),
    )

    default_kwargs = {
        "id": "camp_123",
        "name": "Test Campaign",
        "starts_at": now - timedelta(hours=1),
        "ends_at": now + timedelta(hours=1),
        "account_connected": True,
        "valid": True,
        "allowed_channels": [],
        "timed_drops": {dummy_drop.id: dummy_drop},  # Přidán aktivní drop
    }
    default_kwargs.update(kwargs)
    return Campaign(**default_kwargs)


def test_is_earnable_positive():
    """1. Aktivní, propojená a nehotová kampaň MUSÍ být earnable."""
    campaign = create_base_campaign()
    # Sem doplň testovací dropy podle tvé implementace Dropu
    assert campaign.is_earnable is True


def test_is_earnable_negative_when_expired():
    """2. Vypršená kampaň NESMÍ být earnable."""
    now = datetime.now(timezone.utc)
    campaign = create_base_campaign(
        starts_at=now - timedelta(hours=5),
        ends_at=now - timedelta(hours=1)
    )
    assert campaign.is_earnable is False


def test_can_earn_on_this_channel_gateway():
    """3. Hlavní metoda can_earn_on_this_channel."""
    campaign = create_base_campaign()
    # Test se zadaným kanálem
    assert campaign.can_earn_on_this_channel(None) is True
