import pytest
from src.models.drop import resolve_drop_status


def test_status_claimed():
    """Už vyzvednutý drop musí vrátit 'claimed'."""
    assert resolve_drop_status(is_claimed=True, can_claim=False, is_mining=False) == "claimed"


def test_status_ready_to_claim():
    """Drop připravený k vyzvednutí musí vrátit 'ready_to_claim'."""
    assert resolve_drop_status(is_claimed=False, can_claim=True, is_mining=False) == "ready_to_claim"


def test_status_stuck():
    """Aktivní těžba s příznakem záseku musí vrátit 'stuck'."""
    assert resolve_drop_status(
        is_claimed=False, can_claim=False, is_mining=True, is_stuck=True
    ) == "stuck"


def test_status_mining():
    """Běžící těžba bez záseku musí vrátit 'mining'."""
    assert resolve_drop_status(
        is_claimed=False, can_claim=False, is_mining=True, is_stuck=False
    ) == "mining"


def test_status_in_progress():
    """Netěží se, ale už je nabraný nějaký progress (>0 min)."""
    assert resolve_drop_status(
        is_claimed=False, can_claim=False, is_mining=False, current_minutes=15
    ) == "in_progress"


def test_status_queued():
    """Nedotčený drop v pořadí (0 min)."""
    assert resolve_drop_status(
        is_claimed=False, can_claim=False, is_mining=False, current_minutes=0
    ) == "queued"
