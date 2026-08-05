#!/usr/bin/env python3
"""List the CenoBots robots available to the configured API account."""

from __future__ import annotations

import json
import sys

from client import CenoBotsError, from_environment


def main() -> int:
    try:
        client = from_environment()
        response = client.device_open_ids()
        devices = client.response_data(response, 'Device list') or []
        print(json.dumps({
            'ok': True,
            'count': len(devices),
            'devices': devices,
            'requestId': response.get('rid'),
        }, indent=2, ensure_ascii=False))
        return 0
    except CenoBotsError as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
