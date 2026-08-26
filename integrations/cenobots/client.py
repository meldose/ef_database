#!/usr/bin/env python3
"""CenoBots Open API v1.0.16 client with command calls disabled by default."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class CenoBotsError(RuntimeError):
    """Raised when a CenoBots API operation cannot be completed safely."""


class CenoBotsClient:
    def __init__(
        self,
        host: str,
        access_key: str,
        secret_key: str,
        timeout: float = 20.0,
        min_request_interval: float | None = None,
        commands_enabled: bool | None = None,
    ):
        self.host = host.rstrip('/')
        self.access_key = access_key
        self.secret_key = secret_key
        self.timeout = timeout
        self.commands_enabled = commands_enabled
        configured_interval = os.environ.get('CENOBOTS_MIN_REQUEST_INTERVAL_SECONDS', '1.05')
        self.min_request_interval = max(
            0.0,
            float(configured_interval) if min_request_interval is None else float(min_request_interval),
        )
        self._last_request_at = 0.0

    def _request(self, method: str, path: str, *, query: dict | None = None, body: dict | None = None):
        query = query or {}
        request_path = f"{path}?{urlencode(query)}" if query else path
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < self.min_request_interval:
            time.sleep(self.min_request_interval - elapsed)
        timestamp = str(int(time.time() * 1000))
        signature_input = f"{method.upper()}{timestamp}{request_path}".encode('utf-8')
        signature = hmac.new(self.secret_key.encode('utf-8'), signature_input, hashlib.sha256).hexdigest()
        data = json.dumps(body, separators=(',', ':')).encode('utf-8') if body is not None else None
        headers = {
            'X-Api-Key': self.access_key,
            'X-Api-timestamp': timestamp,
            'X-Api-signature': signature,
            'Accept': 'application/json',
        }
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = Request(f"{self.host}{request_path}", data=data, headers=headers, method=method.upper())
        try:
            self._last_request_at = time.monotonic()
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode('utf-8')
        except HTTPError as error:
            detail = error.read().decode('utf-8', errors='replace')
            raise CenoBotsError(f"CenoBots HTTP {error.code}: {detail[:1000]}") from error
        except URLError as error:
            raise CenoBotsError(f"CenoBots connection failed: {error.reason}") from error
        try:
            return json.loads(raw)
        except json.JSONDecodeError as error:
            raise CenoBotsError(f"CenoBots returned non-JSON data: {raw[:500]}") from error

    def device_status(self, device_open_id: str):
        return self._request('GET', f'/app/openapi/v1/device/status/{device_open_id}')

    def robot_info(self, device_open_id: str):
        return self._request('GET', f'/app/openapi/v1/device/info/{device_open_id}')

    def maintenance_detail(self, device_open_id: str):
        return self._request('GET', f'/app/openapi/v1/device/maintenance-detail/{device_open_id}')

    def robot_setting(self, device_open_id: str):
        return self._request('GET', f'/app/openapi/v1/device/setting/{device_open_id}')

    def system_errors(self, device_open_id: str):
        return self._request('GET', f'/app/openapi/v1/device/{device_open_id}/sys-error/list')

    def device_open_ids(self):
        return self._request('GET', '/app/openapi/v1/device/deviceOpenIds')

    def maps(self, device_open_id: str):
        return self._request('GET', '/app/openapi/v1/map', query={'deviceOpenId': device_open_id})

    def areas(self, device_open_id: str, map_id: int | str):
        return self._request('GET', '/app/openapi/v1/map/area', query={'deviceOpenId': device_open_id, 'mapId': map_id})

    def mission_history(
        self,
        device_open_id: str,
        start_timestamp: int | None = None,
        end_timestamp: int | None = None,
        page_index: int = 0,
        page_length: int = 50,
        include_navigation: bool = False,
    ):
        request_data = {'deviceOpenId': device_open_id}
        if start_timestamp is not None:
            request_data['startTimestamp'] = start_timestamp
        if end_timestamp is not None:
            request_data['endTimestamp'] = end_timestamp
        request_data['isShowNavigationMission'] = include_navigation
        return self._request('POST', '/app/openapi/v1/mission/list', body={'pageIndex': page_index, 'pageLength': page_length, 'requestData': request_data})

    def mission_summary(
        self,
        device_open_id: str,
        start_timestamp: int | None = None,
        end_timestamp: int | None = None,
    ):
        body = {'deviceOpenId': device_open_id}
        if start_timestamp is not None:
            body['startTimestamp'] = start_timestamp
        if end_timestamp is not None:
            body['endTimestamp'] = end_timestamp
        return self._request('POST', '/app/openapi/v1/mission/summary', body=body)

    def schedules(self, device_open_id: str):
        return self._request('GET', f'/app/openapi/v1/schedule/list/{device_open_id}')

    def _command_request(self, path: str, *, method: str = 'POST', body: dict | None = None):
        commands_enabled = self.commands_enabled
        if commands_enabled is None:
            commands_enabled = os.environ.get('CENOBOTS_COMMANDS_ENABLED', '').strip().lower() == 'true'
        if not commands_enabled:
            raise CenoBotsError(
                'CenoBots commands are disabled. Set CENOBOTS_COMMANDS_ENABLED=true only when live robot control is intended.'
            )
        return self._request(method, path, body=body)

    def create_temporary_mission(self, mission: dict):
        """Start a validated mission payload prepared by the task wrapper."""
        return self._command_request('/app/openapi/v1/mission', body=mission)

    def create_schedule(self, schedule: dict):
        return self._command_request('/app/openapi/v1/schedule', body=schedule)

    def update_schedule(self, schedule: dict):
        return self._command_request('/app/openapi/v1/schedule', method='PUT', body=schedule)

    def set_schedule_active(self, schedule_id: int, device_open_id: str, enable: bool):
        return self._command_request('/app/openapi/v1/schedule/active', body={
            'id': schedule_id,
            'deviceOpenId': device_open_id,
            'enable': bool(enable),
        })

    def delete_schedule(self, schedule_id: int):
        return self._command_request(f'/app/openapi/v1/schedule/delete/{schedule_id}', method='DELETE')

    def go_home(self, device_open_id: str):
        return self._command_request(f'/app/openapi/v1/mission/home/{device_open_id}')

    def stop_current_mission(self, device_open_id: str):
        return self._command_request(f'/app/openapi/v1/mission/current/stop/{device_open_id}')

    def pause_current_mission(self, device_open_id: str):
        return self._command_request(f'/app/openapi/v1/mission/current/pause/{device_open_id}')

    def continue_current_mission(self, device_open_id: str):
        return self._command_request(f'/app/openapi/v1/mission/current/continue/{device_open_id}')

    @staticmethod
    def response_data(response: dict, operation: str):
        if response.get('success') is not True or response.get('code') not in (0, 200):
            raise CenoBotsError(f"{operation} failed ({response.get('code')}): {response.get('info') or 'unknown provider error'}")
        return response.get('data')

    def snapshot(self, device_ids: list[str] | None = None):
        if device_ids is None:
            devices = list(self.response_data(self.device_open_ids(), 'Device list') or [])
            configured_ids = configured_device_open_ids()
            listed_ids = {str(device.get('deviceOpenId') or '').strip() for device in devices}
            devices.extend({'deviceOpenId': device_open_id, 'licensePlate': ''} for device_open_id in configured_ids if device_open_id not in listed_ids)
        else:
            devices = [{'deviceOpenId': value, 'licensePlate': ''} for value in dict.fromkeys(device_ids) if value]
        robots = []
        warnings = []
        if not devices:
            warnings.append({
                'operation': 'device-list',
                'message': 'No robots are assigned to this CenoBots Open API account. Assign a robot in the CenoBots operation platform, then synchronize again.',
            })
        for device in devices:
            device_open_id = str(device.get('deviceOpenId') or '').strip()
            if not device_open_id:
                warnings.append({'operation': 'device-list', 'message': 'CenoBots returned a device without deviceOpenId'})
                continue
            robot = {'deviceOpenId': device_open_id, 'licensePlate': device.get('licensePlate') or ''}
            for field, operation in (
                ('status', self.device_status),
                ('info', self.robot_info),
                ('maintenance', self.maintenance_detail),
                ('errors', self.system_errors),
            ):
                try:
                    robot[field] = self.response_data(operation(device_open_id), field.title())
                except CenoBotsError as error:
                    robot[field] = None
                    warnings.append({'deviceOpenId': device_open_id, 'operation': field, 'message': str(error)})
            if robot.get('status') is None and robot.get('info') is None:
                warnings.append({'deviceOpenId': device_open_id, 'operation': 'snapshot', 'message': 'Device is not accessible to this API account'})
                continue
            robots.append(robot)
        return {'ok': True, 'provider': 'cenobots', 'version': 'open-api-v1.0.16', 'robots': robots, 'count': len(robots), 'warnings': warnings}


def configured_device_open_ids() -> list[str]:
    """Return unique configured fallback IDs without embedding device values in code."""
    values = []
    for name in ('CENOBOTS_ROBOT_OPEN_IDS', 'CENOBOTS_ROBOT_OPEN_ID'):
        values.extend(value.strip() for value in os.environ.get(name, '').split(',') if value.strip())
    return list(dict.fromkeys(values))


def load_env_file():
    env_path = Path(os.environ.get('CENOBOTS_ENV_FILE') or Path(__file__).resolve().parents[2] / '.env')
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding='utf-8').splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def secret_value(name: str) -> str:
    value = os.environ.get(name, '')
    if value:
        return value
    file_path = os.environ.get(f'{name}_FILE', '')
    if not file_path:
        return ''
    try:
        return Path(file_path).read_text(encoding='utf-8').strip()
    except OSError as error:
        raise CenoBotsError(f'Could not read managed secret {name}: {error}') from error


def from_environment(*, commands_enabled: bool | None = None) -> CenoBotsClient:
    load_env_file()
    values = {
        'CENOBOTS_HOST': os.environ.get('CENOBOTS_HOST', ''),
        'CENOBOTS_ACCESS_KEY': secret_value('CENOBOTS_ACCESS_KEY'),
        'CENOBOTS_SECRET_KEY': secret_value('CENOBOTS_SECRET_KEY'),
    }
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise CenoBotsError('Missing environment variables: ' + ', '.join(missing))
    return CenoBotsClient(
        values['CENOBOTS_HOST'],
        values['CENOBOTS_ACCESS_KEY'],
        values['CENOBOTS_SECRET_KEY'],
        commands_enabled=commands_enabled,
    )


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else 'status'
    try:
        client = from_environment()
        device_open_id = sys.argv[2] if len(sys.argv) > 2 else next(iter(configured_device_open_ids()), '')
        if command == 'snapshot':
            result = client.snapshot()
        elif command == 'open-ids':
            result = client.device_open_ids()
        elif not device_open_id:
            raise CenoBotsError('Provide a device open ID or set CENOBOTS_ROBOT_OPEN_ID')
        elif command == 'status':
            result = client.device_status(device_open_id)
        elif command == 'info':
            result = client.robot_info(device_open_id)
        elif command == 'maintenance':
            result = client.maintenance_detail(device_open_id)
        elif command == 'errors':
            result = client.system_errors(device_open_id)
        elif command == 'maps':
            result = client.maps(device_open_id)
        elif command == 'schedules':
            result = client.schedules(device_open_id)
        else:
            raise CenoBotsError(f'Unknown read-only command: {command}')
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except CenoBotsError as error:
        print(json.dumps({'error': str(error)}))
        raise SystemExit(1)
