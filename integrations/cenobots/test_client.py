#!/usr/bin/env python3
"""Unit tests for the read-only CenoBots client (no network calls)."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import unittest
from unittest.mock import patch

from integrations.cenobots import client as client_module

CenoBotsClient = client_module.CenoBotsClient
configured_device_open_ids = client_module.configured_device_open_ids


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode('utf-8')


class CenoBotsClientTests(unittest.TestCase):
    def test_request_signs_method_timestamp_and_exact_query_path(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured['request'] = request
            captured['timeout'] = timeout
            return FakeResponse({'success': True, 'code': 0, 'data': []})

        client = CenoBotsClient('https://example.test/', 'access', 'secret', timeout=12)
        with patch.object(client_module.time, 'time', return_value=1_700_000_000.123), patch.object(client_module, 'urlopen', side_effect=fake_urlopen):
            response = client.areas('robot 1', 42)

        request_path = '/app/openapi/v1/map/area?deviceOpenId=robot+1&mapId=42'
        signature_input = f'GET1700000000123{request_path}'.encode('utf-8')
        expected_signature = hmac.new(b'secret', signature_input, hashlib.sha256).hexdigest()
        headers = {key.lower(): value for key, value in captured['request'].header_items()}

        self.assertTrue(response['success'])
        self.assertEqual(captured['timeout'], 12)
        self.assertEqual(captured['request'].full_url, f'https://example.test{request_path}')
        self.assertEqual(headers['x-api-key'], 'access')
        self.assertEqual(headers['x-api-timestamp'], '1700000000123')
        self.assertEqual(headers['x-api-signature'], expected_signature)

    def test_configured_device_ids_support_plural_and_remove_duplicates(self):
        with patch.dict(os.environ, {
            'CENOBOTS_ROBOT_OPEN_IDS': 'robot-a, robot-b,robot-a',
            'CENOBOTS_ROBOT_OPEN_ID': 'robot-b',
        }, clear=False):
            self.assertEqual(configured_device_open_ids(), ['robot-a', 'robot-b'])

    def test_empty_account_returns_actionable_snapshot_warning(self):
        client = CenoBotsClient('https://example.test', 'access', 'secret')
        with patch.dict(os.environ, {'CENOBOTS_ROBOT_OPEN_IDS': '', 'CENOBOTS_ROBOT_OPEN_ID': ''}, clear=False), patch.object(
            client, 'device_open_ids', return_value={'success': True, 'code': 0, 'data': []}
        ):
            snapshot = client.snapshot()

        self.assertEqual(snapshot['count'], 0)
        self.assertIn('No robots are assigned', snapshot['warnings'][0]['message'])


if __name__ == '__main__':
    unittest.main()
