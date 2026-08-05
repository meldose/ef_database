#!/usr/bin/env python3
"""Minimal read-only CenoBots Open API v1.0.16 client."""

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
    """Raised when the CenoBots API cannot be read successfully."""


class CenoBotsClient:
    def __init__(self, host: str, access_key: str, secret_key: str, timeout: float = 20.0):
        self.host = host.rstrip('/')
        self.access_key = access_key
        self.secret_key = secret_key
        self.timeout = timeout

    def _request(self, method: str, path: str, *, query: dict | None = None, body: dict | None = None):
        query = query or {}
        request_path = f"{path}?{urlencode(query)}" if query else path
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

    def mission_history(self, device_open_id: str, start_timestamp: int | None = None, end_timestamp: int | None = None, page_index: int = 0, page_length: int = 50):
        request_data = {'deviceOpenId': device_open_id}
        if start_timestamp is not None:
            request_data['startTimestamp'] = start_timestamp
        if end_timestamp is not None:
            request_data['endTimestamp'] = end_timestamp
        return self._request('POST', '/app/openapi/v1/mission/list', body={'pageIndex': page_index, 'pageLength': page_length, 'requestData': request_data})

    @staticmethod
    def response_data(response: dict, operation: str):
        if response.get('success') is not True or response.get('code') not in (0, 200):
            raise CenoBotsError(f"{operation} failed ({response.get('code')}): {response.get('info') or 'unknown provider error'}")
        return response.get('data')

    def snapshot(self):
        devices = self.response_data(self.device_open_ids(), 'Device list') or []
        configured_ids = [value.strip() for value in (os.environ.get('CENOBOTS_ROBOT_OPEN_IDS') or os.environ.get('CENOBOTS_ROBOT_OPEN_ID') or '').split(',') if value.strip()]
        listed_ids = {str(device.get('deviceOpenId') or '').strip() for device in devices}
        devices.extend({'deviceOpenId': device_open_id, 'licensePlate': ''} for device_open_id in configured_ids if device_open_id not in listed_ids)
        robots = []
        warnings = []
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


def from_environment() -> CenoBotsClient:
    load_env_file()
    values = {key: os.environ.get(key, '') for key in ('CENOBOTS_HOST', 'CENOBOTS_ACCESS_KEY', 'CENOBOTS_SECRET_KEY')}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise CenoBotsError('Missing environment variables: ' + ', '.join(missing))
    return CenoBotsClient(values['CENOBOTS_HOST'], values['CENOBOTS_ACCESS_KEY'], values['CENOBOTS_SECRET_KEY'])


if __name__ == '__main__':
    command = sys.argv[1] if len(sys.argv) > 1 else 'status'
    device_open_id = sys.argv[2] if len(sys.argv) > 2 else os.environ.get('CENOBOTS_ROBOT_OPEN_ID', '')
    try:
        client = from_environment()
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
        else:
            raise CenoBotsError(f'Unknown read-only command: {command}')
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except CenoBotsError as error:
        print(json.dumps({'error': str(error)}))
        raise SystemExit(1)
