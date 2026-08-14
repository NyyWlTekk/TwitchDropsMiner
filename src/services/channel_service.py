"""
Channel service for managing channel discovery, online status checks, and priority sorting.

This service handles all channel-related operations including fetching live streams
from directories, bulk online status verification, and channel priority determination.
"""

from __future__ import annotations

import asyncio
import logging
from collections import abc
from typing import TYPE_CHECKING

from src.config import GQL_OPERATIONS, MAX_INT
from src.exceptions import GQLException, MinerException
from src.models.models import Channel
from src.utils import chunk

if TYPE_CHECKING:
    from src.config import GQLRequest, JsonType
    from src.core.client import Twitch
    from src.models.models import Game


logger = logging.getLogger("TwitchDrops")


class ChannelService:
    """
    Service responsible for channel management operations.

    Handles:
    - Channel priority calculation
    - Live stream discovery from game directories
    - Bulk online status checks for ACL channels
    - Channel sorting by viewers and priority
    """

    def __init__(self, twitch: Twitch) -> None:
        """
        Initialize the channel service.

        Args:
            twitch: The Twitch client instance
        """
        self._twitch = twitch

    def get_priority(self, channel: Channel) -> int:
        """
        Return a priority number for a given channel based on games_to_watch order.

        Priority is determined by the position of the channel's game in the
        wanted_games list. Lower numbers indicate higher priority.
        """
        if (
            (game := channel.game) is None  # None when OFFLINE or no game set
            or game not in self._twitch.wanted_games  # We don't care about the played game
        ):
            return MAX_INT
        return self._twitch.wanted_games.index(game)

    @staticmethod
    def get_viewers_key(channel: Channel) -> int:
        """
        Sort key for channels by viewer count (descending).
        """
        if (viewers := channel.viewers) is not None:
            return viewers
        return -1

    async def get_live_streams(
        self, game: Game, *, limit: int = 20, drops_enabled: bool = True
    ) -> list[Channel]:
        """
        Fetch live streams for a specific game from Twitch directory.
        """
        filters: list[str] = []
        if drops_enabled:
            filters.append("DROPS_ENABLED")

        try:
            response = await self._twitch.gql_request(
                GQL_OPERATIONS["GameDirectory"].with_variables(
                    {
                        "limit": limit,
                        "slug": game.slug,
                        "options": {
                            "includeRestricted": ["SUB_ONLY_LIVE"],
                            "systemFilters": filters,
                        },
                    }
                )
            )
        except GQLException as exc:
            raise MinerException(f"Game: {game.slug}") from exc

        # Defenzivní kontrola obsahu odpovědi
        if isinstance(response, dict) and response.get("data"):
            game_data = response["data"].get("game")
            if game_data and "streams" in game_data and game_data["streams"]:
                edges = game_data["streams"].get("edges", [])
                return [
                    Channel.from_directory(
                        self._twitch, stream_channel_data["node"], drops_enabled=drops_enabled
                    )
                    for stream_channel_data in edges
                    if isinstance(stream_channel_data, dict) and stream_channel_data.get("node", {}).get("broadcaster") is not None
                ]
        return []

    async def bulk_check_online(self, channels: abc.Iterable[Channel]) -> None:
        """
        Utilize batch GQL requests to check ONLINE status for multiple channels at once.
        """
        channel_list = list(channels)
        acl_streams_map: dict[int, JsonType] = {}
        stream_gql_ops: list[GQLRequest] = [channel.stream_gql for channel in channel_list]

        if not stream_gql_ops:
            return

        stream_gql_tasks: list[asyncio.Task[JsonType | list[JsonType]]] = [
            asyncio.create_task(self._twitch.gql_request(stream_gql_chunk))
            for stream_gql_chunk in chunk(stream_gql_ops, 20)
        ]

        try:
            for coro in asyncio.as_completed(stream_gql_tasks):
                response = await coro
                # Normalizace odpovědi na list
                response_list: list[JsonType] = response if isinstance(response, list) else [response]
                
                for response_json in response_list:
                    if not isinstance(response_json, dict):
                        continue
                    
                    data = response_json.get("data")
                    if isinstance(data, dict):
                        user_data = data.get("user")
                        if isinstance(user_data, dict) and "id" in user_data:
                            acl_streams_map[int(user_data["id"])] = user_data
                            
        except Exception:
            for task in stream_gql_tasks:
                task.cancel()
            raise

        # Aktualizace jednotlivých kanálů nalezenými daty
        for channel in channel_list:
            channel_id = channel.id
            if channel_id not in acl_streams_map:
                continue
            
            channel_data = acl_streams_map[channel_id]
            if channel_data.get("stream") is None:
                continue
                
            channel.external_update(channel_data, [])
