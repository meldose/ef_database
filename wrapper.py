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

    def get_robot_info(self) -> dict[str, Any]:
        """Return identity, serial number, software version, and building."""
        response = self._client.robot_info(self.device_open_id)
        return self._require_success(response, 'Get robot information') or {}

    def get_maintenance(self) -> dict[str, Any]:
        """Return consumable life and maintenance history."""
        response = self._client.maintenance_detail(self.device_open_id)
        return self._require_success(response, 'Get maintenance details') or {}

    def get_settings(self) -> dict[str, Any]:
        response = self._client.robot_setting(self.device_open_id)
        return self._require_success(response, 'Get robot settings') or {}

    def get_errors(self) -> list[dict[str, Any]]:
        """Return the robot's current system errors."""
        response = self._client.system_errors(self.device_open_id)
        return self._require_success(response, 'Get system errors') or []

    def get_maps(self) -> list[dict[str, Any]]:
        response = self._client.maps(self.device_open_id)
        return self._require_success(response, 'Get maps') or []

    def get_areas(self, map_id: int | None = None) -> list[dict[str, Any]]:
        """Return cleaning areas for a map, defaulting to the current map."""
        if map_id is None:
            map_id, _map_version = self._current_map()
        response = self._client.areas(self.device_open_id, map_id)
        return self._require_success(response, 'Get map areas') or []

    def get_current_task(self) -> dict[str, Any]:
        """Return current mission progress from live robot status."""
        return self.get_status().get('missionTaskDetail') or {}

    def get_task_history(
        self,
        *,
        start_timestamp: int | None = None,
        end_timestamp: int | None = None,
        page: int = 0,
        page_size: int = 50,
        include_navigation: bool = False,
    ) -> Any:
        response = self._client.mission_history(
            self.device_open_id,
            start_timestamp=start_timestamp,
            end_timestamp=end_timestamp,
            page_index=page,
            page_length=page_size,
            include_navigation=include_navigation,
        )
        return self._require_success(response, 'Get task history')

    def get_task_summary(
        self,
        *,
        start_timestamp: int | None = None,
        end_timestamp: int | None = None,
    ) -> dict[str, Any]:
        response = self._client.mission_summary(
            self.device_open_id,
            start_timestamp=start_timestamp,
            end_timestamp=end_timestamp,
        )
        return self._require_success(response, 'Get task summary') or {}

    def battery_level(self) -> int | None:
        """Return battery percentage, or None when the provider omits it."""
        value = self.get_status().get('soc')
        return int(value) if value is not None else None

    def is_online(self) -> bool:
        return bool(self.get_status().get('online'))

    def is_running(self) -> bool:
        return bool(self.get_status().get('running'))

    def is_charging(self) -> bool:
        return bool(self.get_status().get('charging'))

    def is_docked(self) -> bool:
        docking = self.get_status().get('dockingStationDetail') or {}
        return bool(docking.get('isDocked'))

    def go_home(self) -> dict[str, Any]:
        """Tell the robot to return to its charging station."""
        return self._command_result(self._client.go_home(self.device_open_id), 'Go home')

    def return_home(self) -> dict[str, Any]:
        """Alias for go_home()."""
        return self.go_home()

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

    def start_area_cleaning_task(
        self,
        area_ids: Iterable[str],
        **options: Any,
    ) -> dict[str, Any]:
        """Start a cleaning mission restricted to the supplied area IDs."""
        selected_areas = list(area_ids)
        if not selected_areas:
            raise CenoBotsError('start_area_cleaning_task requires at least one area ID')
        return self.start_cleaning_task(area_ids=selected_areas, **options)

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

    def resume_task(self) -> dict[str, Any]:
        """Alias for continue_task()."""
        return self.continue_task()

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

        return self._current_map()

    def _current_map(self) -> tuple[int, str]:
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
