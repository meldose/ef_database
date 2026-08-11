#!/usr/bin/env python3
"""Unit tests for CenoBots task planning and execution gates (no network)."""

from __future__ import annotations

import os
import unittest
from unittest.mock import Mock, patch

from integrations.cenobots.client import CenoBotsClient, CenoBotsError
from integrations.cenobots.tasks import build_clean_plan, build_control_plan, run_plan


class CenoBotsTaskTests(unittest.TestCase):
    def test_clean_everywhere_builds_l50_sweep_payload(self):
        plan = build_clean_plan(
            'AUGCEMZK85',
            3100411755077988,
            'local.map.version',
            clean_everywhere=True,
            intensity='HIGH',
            fixed_laps=2,
        )

        self.assertEqual(plan.endpoint, '/app/openapi/v1/mission')
        self.assertEqual(plan.payload, {
            'mapId': 3100411755077988,
            'mapVersion': 'local.map.version',
            'cleanEveryWhere': True,
            'sweepMode': 'SWEEP',
            'subSweepMode': 'HIGH',
            'backPointId': '',
            'deviceOpenId': 'AUGCEMZK85',
            'fixedLaps': 2,
        })

    def test_area_clean_requires_at_least_one_area(self):
        with self.assertRaisesRegex(CenoBotsError, 'at least one areaId'):
            build_clean_plan('AUGCEMZK85', 1, 'version', clean_everywhere=False)

    def test_duration_replaces_fixed_laps_and_area_ids_are_deduplicated(self):
        plan = build_clean_plan(
            'AUGCEMZK85',
            1,
            'version',
            clean_everywhere=False,
            area_ids=['0', '3', '0'],
            duration=60,
        )

        self.assertEqual(plan.payload['areaIds'], ['0', '3'])
        self.assertEqual(plan.payload['duration'], 60)
        self.assertNotIn('fixedLaps', plan.payload)

    def test_default_run_is_preview_only(self):
        client = Mock(spec=CenoBotsClient)
        result = run_plan(build_control_plan('go-home', 'AUGCEMZK85'), client=client)

        self.assertTrue(result['dryRun'])
        self.assertIn('No API request was sent', result['message'])
        client.go_home.assert_not_called()

    def test_live_run_requires_exact_device_confirmation(self):
        client = Mock(spec=CenoBotsClient)
        with self.assertRaisesRegex(CenoBotsError, '--confirm-device AUGCEMZK85'):
            run_plan(
                build_control_plan('go-home', 'AUGCEMZK85'),
                execute=True,
                confirm_device='DIFFERENT',
                client=client,
            )
        client.go_home.assert_not_called()

    def test_live_run_dispatches_after_confirmation(self):
        client = Mock(spec=CenoBotsClient)
        client.go_home.return_value = {'success': True, 'code': 0, 'data': '', 'rid': 'trace-1'}
        client.response_data.return_value = ''

        result = run_plan(
            build_control_plan('go-home', 'AUGCEMZK85'),
            execute=True,
            confirm_device='AUGCEMZK85',
            client=client,
        )

        self.assertFalse(result['dryRun'])
        client.go_home.assert_called_once_with('AUGCEMZK85')
        self.assertEqual(result['result']['rid'], 'trace-1')

    def test_low_level_commands_are_disabled_by_default(self):
        client = CenoBotsClient('https://example.test', 'access', 'secret')
        with patch.dict(os.environ, {'CENOBOTS_COMMANDS_ENABLED': ''}, clear=False), self.assertRaisesRegex(
            CenoBotsError, 'commands are disabled'
        ), patch('integrations.cenobots.client.urlopen') as urlopen:
            client.go_home('AUGCEMZK85')
        urlopen.assert_not_called()

    def test_explicitly_enabled_client_can_send_a_command(self):
        client = CenoBotsClient(
            'https://example.test',
            'access',
            'secret',
            commands_enabled=True,
        )
        expected = {'success': True, 'code': 0, 'data': ''}
        with patch.object(client, '_request', return_value=expected) as request:
            response = client.go_home('KK93DZ0Q37')

        self.assertEqual(response, expected)
        request.assert_called_once_with(
            'POST',
            '/app/openapi/v1/mission/home/KK93DZ0Q37',
            body=None,
        )


if __name__ == '__main__':
    unittest.main()
