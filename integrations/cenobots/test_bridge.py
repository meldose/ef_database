import os
import unittest
from unittest.mock import patch

from integrations import cenobots_bridge


RAW_ROBOT = {
    "deviceOpenId": "AUGCEMZK85",
    "licensePlate": "L50-10041",
    "status": {
        "online": True,
        "soc": 100,
        "charging": False,
        "speed": 0.0,
        "isEmergency": False,
        "isManual": False,
        "pose": {"x": -0.02, "y": 0.07, "yaw": 0.05},
        "currentMapId": 3100411755077988,
        "currentMapName": "Verallia Bad Wurzach",
        "currentMapVersion": "map-version",
        "dockingStationDetail": {"isDocked": True},
        "missionTaskDetail": {"taskStatus": "DONE"},
    },
    "info": {
        "serialNumber": "L50-10041",
        "softwareVersion": "v1.0.97.100",
        "buildingName": "Verallia",
        "activated": True,
    },
    "maintenance": {
        "maintenanceItems": [
            {
                "name": "Disk Brushes",
                "history": [{"id": 1}, {"id": 2}, {"id": 3}],
            }
        ]
    },
    "errors": [],
}


class FakeClient:
    def snapshot(self, device_ids=None):
        return {
            "ok": True,
            "robots": [RAW_ROBOT],
            "warnings": [
                {
                    "deviceOpenId": "AUGCEMZK85",
                    "operation": "info",
                    "message": "example warning",
                }
            ],
        }


class CenoBotsBridgeTests(unittest.TestCase):
    def test_normalizes_provider_fields(self):
        robot = cenobots_bridge.normalize_robot(RAW_ROBOT)
        self.assertEqual(robot["externalId"], "AUGCEMZK85")
        self.assertEqual(robot["serialNumber"], "L50-10041")
        self.assertEqual(robot["version"], "v1.0.97.100")
        self.assertEqual(robot["battery"], 100)
        self.assertTrue(robot["docked"])
        self.assertEqual(robot["task"]["taskStatus"], "DONE")
        self.assertNotIn("raw", robot)

    def test_caps_maintenance_history(self):
        with patch.dict(os.environ, {"CENOBOTS_MAINTENANCE_HISTORY_LIMIT": "2"}):
            maintenance = cenobots_bridge.normalized_maintenance(RAW_ROBOT["maintenance"])
        item = maintenance["maintenanceItems"][0]
        self.assertEqual(len(item["history"]), 2)
        self.assertEqual(item["historyTotal"], 3)
        self.assertTrue(item["historyTruncated"])

    def test_builds_server_facing_snapshot(self):
        with (
            patch.object(cenobots_bridge, "from_environment", return_value=FakeClient()),
            patch.dict(os.environ, {"CENOBOTS_RESOURCE_SYNC": "false"}),
        ):
            payload = cenobots_bridge.build_snapshot("AUGCEMZK85")
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["provider"], "cenobots")
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["robots"][0]["externalId"], "AUGCEMZK85")
        self.assertEqual(payload["capabilities"]["command"], [])
        self.assertEqual(payload["resourceErrors"][0]["operation"], "info")


if __name__ == "__main__":
    unittest.main()
