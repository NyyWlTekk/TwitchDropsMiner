"""Campaign progress manager for tracking active drop mining progress."""

from __future__ import annotations

__all__ = ["CampaignProgressManager"]

import asyncio
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from src.models import TimedDrop
    from src.web.managers.broadcaster import WebSocketBroadcaster


class CampaignProgressManager:
    """Manages active drop mining progress display and countdown timer.

    Tracks the currently mined drop and broadcasts real-time progress updates
    including remaining time and completion percentage to the web interface.
    """

    def __init__(self, broadcaster: WebSocketBroadcaster) -> None:
        self._broadcaster = broadcaster
        self._current_drop: TimedDrop | None = None
        self._remaining_seconds: int = 0

    def update(self, drop: TimedDrop | None, remaining_seconds: int) -> None:
        """Update the current drop progress and remaining time.

        Args:
            drop: The drop currently being mined, or None if no active drop
            remaining_seconds: Seconds remaining until the next progress minute
        """
        self._current_drop = drop
        self._remaining_seconds = remaining_seconds
        if drop:
            total_rem = getattr(drop.campaign, "remaining_minutes", 0)
            asyncio.create_task(
                self._broadcaster.emit(
                    "drop_progress",
                    {
                        "drop_id": drop.id,
                        "drop_name": drop.name,
                        "campaign_name": drop.campaign.name,
                        "campaign_id": drop.campaign.id,
                        "game_name": drop.campaign.game.name,
                        "current_minutes": drop.current_minutes,
                        "required_minutes": drop.required_minutes,
                        "progress": drop.progress,
                        "remaining_seconds": remaining_seconds,
                        "total_remaining_minutes": total_rem,
                    },
                )
            )

    def stop_timer(self) -> None:
        """Stop the progress timer and clear the current drop."""
        self._current_drop = None
        asyncio.create_task(self._broadcaster.emit("drop_progress_stop", {}))

    def minute_almost_done(self) -> bool:
        """Check if the current progress minute is almost complete.

        Returns:
            True if remaining seconds is at or below zero
        """
        return self._remaining_seconds <= 0

    def get_current_drop(self) -> dict[str, Any] | None:
        """Get the current drop progress data for sending to newly connected clients.

        Returns:
            Dictionary with drop progress data, or None if no active drop
        """
        if self._current_drop is None:
            return None

        drop = self._current_drop

        pct = int(drop.progress * 100) if drop.progress <= 1.0 else int(drop.progress)
        is_in_progress = drop.current_minutes > 0 and not drop.is_claimed and not drop.can_claim
        total_rem = getattr(drop.campaign, "remaining_minutes", 0)

        return {
            "id": drop.id,
            "name": drop.name,
            "campaign_name": drop.campaign.name,
            "campaign_id": drop.campaign.id,
            "game_name": drop.campaign.game.name,
            "image_url": getattr(drop, "image_url", ""),
            "current_minutes": drop.current_minutes,
            "required_minutes": drop.required_minutes,
            "progress": drop.progress,
            "pct": pct,
            "remaining_seconds": getattr(self, "_remaining_seconds", 0),
            "total_remaining_minutes": total_rem,
            "is_mining": drop.is_mining,
            "is_in_progress": is_in_progress,
            "is_claimed": drop.is_claimed,
            "can_claim": drop.can_claim,
        }
