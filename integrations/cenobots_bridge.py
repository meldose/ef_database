#!/usr/bin/env python3
"""Read-only normalization bridge from CenoBots Open API to Altegro.

The low-level signed HTTP implementation lives in cenobots/client.py.
This bridge converts provider-specific responses into the same canonical
robot snapshot shape used by the AutoXing bridge. It never exposes robot
movement, mission creation, cancellation, or other control operations.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

try:
    from .cenobots.client import CenoBotsError, from_environment
except ImportError:
    from cenobots.client import CenoBotsError, from_environment


CAPABILITIES = {
    "read": [
        "identity",
        "model",
        "status",
        "battery",
        "position",
        "emergency_stop",
        "maintenance",
        "detailed_errors",
        "maps",
        "areas",
        "mission_history",
    ],
    "event": ["status", "alerts", "mission_status", "maintenance"],
    "command": [],
}


def output(payload: dict[str, Any]) -> None:
    json.dump(payload, sys.stdout, separators=(",", ":"), default=str)
    sys.stdout.write("\n")


def enabled(name: str, default: str = "false") -> bool:
    return str(os.environ.get(name, default)).lower() in {"1", "true", "yes"}


def json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def normalized_maintenance(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    items = source.get("maintenanceItems")
    if not isinstance(items, list):
        return {"maintenanceItems": []}
    history_limit = max(0, int(os.environ.get("CENOBOTS_MAINTENANCE_HISTORY_LIMIT", "10")))
    normalized_items = []
    for raw_item in items:
        if not isinstance(raw_item, dict):
            continue
        item = json_value(raw_item)
        history = item.get("history")
        if isinstance(history, list):
            item["history"] = history[:history_limit] if history_limit else []
            item["historyTruncated"] = len(history) > len(item["history"])
            item["historyTotal"] = len(history)
        normalized_items.append(item)
    result = json_value(source)
    result["maintenanceItems"] = normalized_items
    return result


def normalize_robot(raw_robot: dict[str, Any], warnings: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    status = raw_robot.get("status") if isinstance(raw_robot.get("status"), dict) else {}
    info = raw_robot.get("info") if isinstance(raw_robot.get("info"), dict) else {}
    external_id = str(raw_robot.get("deviceOpenId") or "").strip()
    license_plate = str(raw_robot.get("licensePlate") or status.get("licensePlate") or info.get("licensePlate") or "").strip()
    serial_number = str(info.get("serialNumber") or license_plate or f"CB-{external_id}").strip()
    device_warnings = [
        json_value(item)
        for item in (warnings or [])
        if str(item.get("deviceOpenId") or "") == external_id
    ]
    robot = {
        "externalId": external_id,
        "serialNumber": serial_number,
        "licensePlate": license_plate or None,
        "manufacturer": "CenoBots",
        "model": info.get("model") or info.get("modelName") or info.get("deviceModel"),
        "online": status.get("online"),
        "battery": status.get("soc"),
        "version": info.get("softwareVersion"),
        "charging": status.get("charging"),
        "chargingMode": status.get("chargingMode"),
        "position": json_value(status.get("pose")),
        "speed": status.get("speed"),
        "emergencyStop": status.get("isEmergency"),
        "manualMode": status.get("isManual"),
        "docked": (status.get("dockingStationDetail") or {}).get("isDocked")
        if isinstance(status.get("dockingStationDetail"), dict)
        else None,
        "statusDetails": json_value(status),
        "task": json_value(status.get("missionTaskDetail")),
        "errors": json_value(raw_robot.get("errors") or []),
        "maintenance": normalized_maintenance(raw_robot.get("maintenance")),
        "activated": info.get("activated"),
        "buildingName": info.get("buildingName"),
        "remark": info.get("remark") or status.get("remark"),
        "mapId": status.get("currentMapId"),
        "mapName": status.get("currentMapName"),
        "mapVersion": status.get("currentMapVersion"),
        "stateErrors": device_warnings,
    }
    if enabled("CENOBOTS_INCLUDE_RAW"):
        robot["raw"] = json_value(raw_robot)
    return robot


def response_items(value: Any) -> list[Any]:
    if isinstance(value, list):
        return json_value(value)
    if not isinstance(value, dict):
        return [] if value is None else [json_value(value)]
    for key in ("items", "records", "list", "maps", "areas", "missions"):
        if isinstance(value.get(key), list):
            return json_value(value[key])
    return [json_value(value)] if value else []


def collect_resources(client, robots: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    resources: dict[str, Any] = {"maps": [], "areas": [], "missions": []}
    warnings: list[dict[str, Any]] = []
    if not enabled("CENOBOTS_RESOURCE_SYNC"):
        return resources, warnings
    mission_sync = enabled("CENOBOTS_MISSION_SYNC", "true")
    mission_page_length = max(1, min(100, int(os.environ.get("CENOBOTS_MISSION_PAGE_LENGTH", "25"))))
    for robot in robots:
        external_id = robot["externalId"]
        try:
            maps = response_items(client.response_data(client.maps(external_id), "Maps"))
            resources["maps"].append({"externalRobotId": external_id, "items": maps})
            for map_item in maps:
                if not isinstance(map_item, dict):
                    continue
                map_id = map_item.get("mapId") or map_item.get("id")
                if map_id is None:
                    continue
                try:
                    areas = response_items(client.response_data(client.areas(external_id, map_id), "Areas"))
                    resources["areas"].append({"externalRobotId": external_id, "mapId": map_id, "items": areas})
                except CenoBotsError as error:
                    warnings.append({"deviceOpenId": external_id, "operation": "areas", "message": str(error)})
        except CenoBotsError as error:
            warnings.append({"deviceOpenId": external_id, "operation": "maps", "message": str(error)})
        if mission_sync:
            try:
                missions = client.response_data(
                    client.mission_history(external_id, page_length=mission_page_length),
                    "Mission history",
                )
                resources["missions"].append({"externalRobotId": external_id, "items": json_value(missions)})
            except CenoBotsError as error:
                warnings.append({"deviceOpenId": external_id, "operation": "mission_history", "message": str(error)})
    return resources, warnings


def build_snapshot(device_open_id: str | None = None) -> dict[str, Any]:
    client = from_environment()
    provider_snapshot = client.snapshot([device_open_id] if device_open_id else None)
    warnings = list(provider_snapshot.get("warnings") or [])
    robots = [
        normalize_robot(item, warnings)
        for item in provider_snapshot.get("robots") or []
        if isinstance(item, dict)
    ]
    resources, resource_warnings = collect_resources(client, robots)
    warnings.extend(resource_warnings)
    return {
        "ok": True,
        "provider": "cenobots",
        "wrapper": "integrations/cenobots/client.py",
        "command": "snapshot",
        "version": "open-api-v1.0.16",
        "robots": robots,
        "count": len(robots),
        "resources": resources,
        "resourceErrors": warnings,
        "warnings": warnings,
        "resourcesDisabled": not enabled("CENOBOTS_RESOURCE_SYNC"),
        "capabilities": CAPABILITIES,
    }


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "snapshot"
    device_open_id = sys.argv[2] if len(sys.argv) > 2 else None
    try:
        if command not in {"snapshot", "list"}:
            raise CenoBotsError(f"Unknown read-only bridge command: {command}")
        payload = build_snapshot(device_open_id)
        payload["command"] = command
        if command == "list":
            for robot in payload["robots"]:
                robot.pop("maintenance", None)
                robot.pop("errors", None)
                robot.pop("statusDetails", None)
        output(payload)
    except Exception as error:
        output(
            {
                "ok": False,
                "provider": "cenobots",
                "code": "CENOBOTS_BRIDGE_FAILED",
                "message": str(error),
            }
        )


if __name__ == "__main__":
    main()
