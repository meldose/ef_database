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

    def test_status_helpers_return_provider_values(self):
        client = self.create_client()
        client.device_status.return_value = successful({
            'soc': 73,
            'online': True,
            'running': False,
            'charging': True,
            'dockingStationDetail': {'isDocked': True},
            'missionTaskDetail': {'taskStatus': 'PAUSED', 'taskProgress': 25},
        })
        robot = Robot('KK93DZ0Q37', client=client)

        self.assertEqual(robot.battery_level(), 73)
        self.assertTrue(robot.is_online())
        self.assertFalse(robot.is_running())
        self.assertTrue(robot.is_charging())
        self.assertTrue(robot.is_docked())
        self.assertEqual(robot.get_current_task()['taskStatus'], 'PAUSED')

    def test_maps_areas_diagnostics_and_history_are_unwrapped(self):
        client = self.create_client()
        client.maps.return_value = successful([{'mapId': 42}])
        client.areas.return_value = successful([{'areaId': '3'}])
        client.robot_info.return_value = successful({'serialNumber': 'L50-10041'})
        client.maintenance_detail.return_value = successful({'maintenanceItems': []})
        client.robot_setting.return_value = successful({'runDebug': False})
        client.system_errors.return_value = successful([])
        client.mission_history.return_value = successful({'data': []})
        client.mission_summary.return_value = successful({'totalJobs': 12})
        robot = Robot('KK93DZ0Q37', client=client)

        self.assertEqual(robot.get_maps(), [{'mapId': 42}])
        self.assertEqual(robot.get_areas(42), [{'areaId': '3'}])
        self.assertEqual(robot.get_robot_info()['serialNumber'], 'L50-10041')
        self.assertEqual(robot.get_maintenance(), {'maintenanceItems': []})
        self.assertEqual(robot.get_settings(), {'runDebug': False})
        self.assertEqual(robot.get_errors(), [])
        self.assertEqual(robot.get_task_history(), {'data': []})
        self.assertEqual(robot.get_task_summary()['totalJobs'], 12)

    def test_area_cleaning_requires_an_area_and_uses_aliases(self):
        client = self.create_client()
        client.create_temporary_mission.return_value = successful('mission-1')
        client.continue_current_mission.return_value = successful({})
        client.go_home.return_value = successful({})
        robot = Robot('KK93DZ0Q37', client=client)

        with self.assertRaisesRegex(CenoBotsError, 'at least one area ID'):
            robot.start_area_cleaning_task([])
        robot.start_area_cleaning_task(['3'], map_id=42, map_version='v7')
        robot.resume_task()
        robot.return_home()

        self.assertEqual(client.create_temporary_mission.call_args.args[0]['areaIds'], ['3'])
        client.continue_current_mission.assert_called_once_with('KK93DZ0Q37')
        client.go_home.assert_called_once_with('KK93DZ0Q37')

    def test_water_level_and_station_helpers_preserve_provider_readings(self):
        client = self.create_client()
        client.device_status.return_value = successful({
            'waterBox': [82, 79],
            'dirtyBox': [18],
            'dockingStationDetail': {
                'isDocked': True,
                'type': 'CWS_01',
                'cleanWaterStatus': 'ADDING_WATER',
                'dirtyWaterStatus': 'DRAINING_SEWAGE',
            },
        })
        robot = Robot('KK93DZ0Q37', client=client)

        self.assertEqual(robot.get_water_levels(), {
            'cleanWater': [82, 79],
            'dirtyWater': [18],
        })
        self.assertEqual(robot.get_clean_water_levels(), [82, 79])
        self.assertEqual(robot.get_dirty_water_levels(), [18])
        self.assertEqual(robot.get_water_station_status(), {
            'isDocked': True,
            'stationType': 'CWS_01',
            'cleanWaterStatus': 'ADDING_WATER',
            'dirtyWaterStatus': 'DRAINING_SEWAGE',
        })
        self.assertTrue(robot.is_adding_clean_water())
        self.assertFalse(robot.is_adding_cleaning_solution())
        self.assertTrue(robot.is_draining_dirty_water())

    def test_water_usage_uses_mission_summary(self):
        client = self.create_client()
        client.mission_summary.return_value = successful({
            'totalWater': 12.5,
            'totalCleaningSolution': 240,
            'totalJobs': 7,
            'totalWorkingTime': 93,
            'totalCleanedArea': 840.5,
        })
        robot = Robot('KK93DZ0Q37', client=client)

        usage = robot.get_water_usage(start_timestamp=1000, end_timestamp=2000)

        self.assertEqual(usage['waterLiters'], 12.5)
        self.assertEqual(usage['cleaningSolutionMilliliters'], 240)
        self.assertEqual(usage['totalJobs'], 7)
        client.mission_summary.assert_called_once_with(
            'KK93DZ0Q37',
            start_timestamp=1000,
            end_timestamp=2000,
        )


if __name__ == '__main__':
    unittest.main()
