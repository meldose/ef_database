#!/usr/bin/env python3
"""Small object-oriented wrapper for controlling one CenoBots robot.

Credentials are loaded from the repository's ignored .env file by the existing
CenoBots client. Application code only needs to provide the deviceOpenId.
"""

from __future__ import annotations

from typing import Any, Iterable

from integrations.cenobots.client import CenoBotsClient, CenoBotsError, from_environment
from integrations.cenobots.tasks import build_clean_plan, validate_device_open_id


class Robot:
    """A CenoBots robot identified by its deviceOpenId."""

    def __init__(self, device_open_id: str, *, client: CenoBotsClient | None = None):
        self.device_open_id = validate_device_open_id(device_open_id)
        # Constructing this high-level control object is explicit authorization
        # for its methods to send robot commands. Credentials still come from
        # the ignored .env file and are never supplied by application code.
        self._client = client or from_environment(commands_enabled=True)

    @property
    def open_id(self) -> str:
        return self.device_open_id

    def get_status(self) -> dict[str, Any]:
        response = self._client.device_status(self.device_open_id)
        return self._require_success(response, 'Get robot status') or {}

    def go_home(self) -> dict[str, Any]:
        """Tell the robot to return to its charging station."""
        return self._command_result(self._client.go_home(self.device_open_id), 'Go home')

    def start_cleaning_task(
        self,
        *,
        map_id: int | None = None,
        map_version: str | None = None,
        area_ids: Iterable[str] | None = None,
        intensity: str = 'MEDIUM',
        duration: int | None = None,
        fixed_laps: int = 1,
        return_to_station: bool = True,
    ) -> dict[str, Any]:
        """Start an L50 SWEEP mission, using the current map by default.

        With no arguments the entire current map is cleaned once at MEDIUM
        intensity, then the robot returns to its station. Pass area_ids to clean
        only selected map areas.
        """
        resolved_map_id, resolved_map_version = self._resolve_map(map_id, map_version)
        normalized_area_ids = list(area_ids) if area_ids is not None else []
        plan = build_clean_plan(
            self.device_open_id,
            resolved_map_id,
            resolved_map_version,
            clean_everywhere=not normalized_area_ids,
            area_ids=normalized_area_ids,
            intensity=intensity,
            duration=duration,
            fixed_laps=fixed_laps,
            back_point_id='' if return_to_station else '-1',
        )
        return self._command_result(
            self._client.create_temporary_mission(plan.payload or {}),
            'Start cleaning task',
        )

    def pause_current_task(self) -> dict[str, Any]:
        return self._command_result(
            self._client.pause_current_mission(self.device_open_id),
            'Pause current task',
        )

    def pause_task(self) -> dict[str, Any]:
        """Pause the robot's active task."""
        return self.pause_current_task()

    def continue_current_task(self) -> dict[str, Any]:
        return self._command_result(
            self._client.continue_current_mission(self.device_open_id),
            'Continue current task',
        )

    def continue_task(self) -> dict[str, Any]:
        """Continue the robot's paused task."""
        return self.continue_current_task()

    def stop_current_task(self) -> dict[str, Any]:
        return self._command_result(
            self._client.stop_current_mission(self.device_open_id),
            'Stop current task',
        )

    def stop_task(self) -> dict[str, Any]:
        """Permanently stop the robot's active or paused task."""
        return self.stop_current_task()

    def _resolve_map(
        self,
        map_id: int | None,
        map_version: str | None,
    ) -> tuple[int, str]:
        if (map_id is None) != (map_version is None):
            raise CenoBotsError('map_id and map_version must be provided together')
        if map_id is not None and map_version is not None:
            return int(map_id), str(map_version)

        status = self.get_status()
        current_map_id = status.get('currentMapId')
        current_map_version = str(status.get('currentMapVersion') or '').strip()
        try:
            current_map_id = int(current_map_id)
        except (TypeError, ValueError) as error:
            raise CenoBotsError(
                'The robot did not report a valid currentMapId; provide map_id and map_version explicitly'
            ) from error
        if current_map_id <= 0 or not current_map_version:
            raise CenoBotsError(
                'The robot has no current map; provide map_id and map_version explicitly'
            )
        return current_map_id, current_map_version

    def _require_success(self, response: dict[str, Any], operation: str) -> Any:
        return self._client.response_data(response, operation)

    def _command_result(self, response: dict[str, Any], operation: str) -> dict[str, Any]:
        data = self._require_success(response, operation)
        return {
            'success': True,
            'data': data,
            'rid': response.get('rid', ''),
        }


__all__ = ['Robot', 'CenoBotsError']
