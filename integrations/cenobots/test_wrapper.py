#!/usr/bin/env python3
"""Unit tests for the object-oriented CenoBots wrapper (no network)."""

from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from integrations.cenobots.client import CenoBotsClient, CenoBotsError
from wrapper import Robot


def successful(data=None, rid='trace-1'):
    return {'success': True, 'code': 0, 'data': data, 'rid': rid}


class RobotWrapperTests(unittest.TestCase):
    def create_client(self):
        client = Mock(spec=CenoBotsClient)
        client.response_data.side_effect = lambda response, _operation: response['data']
        return client

    def test_initialization_uses_environment_client_without_api_key_arguments(self):
        client = self.create_client()
        with patch('wrapper.from_environment', return_value=client) as factory:
            robot = Robot('KK93DZ0Q37')

        self.assertEqual(robot.open_id, 'KK93DZ0Q37')
        factory.assert_called_once_with(commands_enabled=True)

    def test_go_home_targets_initialized_robot(self):
        client = self.create_client()
        client.go_home.return_value = successful('')

        result = Robot('KK93DZ0Q37', client=client).go_home()

        client.go_home.assert_called_once_with('KK93DZ0Q37')
        self.assertTrue(result['success'])

    def test_start_cleaning_uses_current_map_and_l50_sweep_defaults(self):
        client = self.create_client()
        client.device_status.return_value = successful({
            'currentMapId': 42,
            'currentMapVersion': 'map.version.7',
        })
        client.create_temporary_mission.return_value = successful('mission-123')

        result = Robot('KK93DZ0Q37', client=client).start_cleaning_task()

        client.create_temporary_mission.assert_called_once_with({
            'mapId': 42,
            'mapVersion': 'map.version.7',
            'cleanEveryWhere': True,
            'sweepMode': 'SWEEP',
            'subSweepMode': 'MEDIUM',
            'backPointId': '',
            'deviceOpenId': 'KK93DZ0Q37',
            'fixedLaps': 1,
        })
        self.assertEqual(result['data'], 'mission-123')

    def test_selected_areas_and_explicit_map_do_not_fetch_status(self):
        client = self.create_client()
        client.create_temporary_mission.return_value = successful('mission-456')

        Robot('KK93DZ0Q37', client=client).start_cleaning_task(
            map_id=42,
            map_version='map.version.7',
            area_ids=['3', '8'],
            intensity='HIGH',
            return_to_station=False,
        )

        client.device_status.assert_not_called()
        payload = client.create_temporary_mission.call_args.args[0]
        self.assertFalse(payload['cleanEveryWhere'])
        self.assertEqual(payload['areaIds'], ['3', '8'])
        self.assertEqual(payload['subSweepMode'], 'HIGH')
        self.assertEqual(payload['backPointId'], '-1')

    def test_cleaning_requires_both_explicit_map_values(self):
        client = self.create_client()
        with self.assertRaisesRegex(CenoBotsError, 'provided together'):
            Robot('KK93DZ0Q37', client=client).start_cleaning_task(map_id=42)

    def test_short_task_control_methods_call_provider(self):
        client = self.create_client()
        client.pause_current_mission.return_value = successful({})
        client.continue_current_mission.return_value = successful({})
        client.stop_current_mission.return_value = successful({})
        robot = Robot('KK93DZ0Q37', client=client)

        robot.pause_task()
        robot.continue_task()
        robot.stop_task()

        client.pause_current_mission.assert_called_once_with('KK93DZ0Q37')
        client.continue_current_mission.assert_called_once_with('KK93DZ0Q37')
        client.stop_current_mission.assert_called_once_with('KK93DZ0Q37')


if __name__ == '__main__':
    unittest.main()
