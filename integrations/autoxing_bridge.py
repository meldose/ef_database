#!/usr/bin/env python3
"""Read-only bridge from Altegro to the AutoXing Python wrapper.

The vendor wrapper is intentionally kept in the separate autoxing repository.
This process imports autoxing/lib/api_lib.py and returns JSON to the Node API.
No task, navigation, cancel, or control method is exposed here.
"""

from __future__ import annotations

import contextlib
import importlib
import json
import os
import sys
import tempfile
import base64
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace


def output(payload: dict) -> None:
    json.dump(payload, sys.stdout, separators=(",", ":"), default=str)
    sys.stdout.write("\n")


def load_simple_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


def json_value(value):
    if value is None:
        return None
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    try:
        value = value.item()
    except AttributeError:
        pass
    if isinstance(value, float) and value != value:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def row_value(row, *names):
    for name in names:
        try:
            if name in row and row[name] is not None:
                return json_value(row[name])
        except Exception:
            continue
    return None


def frame_records(value):
    """Convert pandas/DataFrame or JSON-like API responses into safe records."""
    if value is None:
        return []
    if isinstance(value, str):
        return {"raw": value}
    try:
        if hasattr(value, "to_dict"):
            records = value.to_dict(orient="records")
            return json_value(records)
    except Exception:
        pass
    if isinstance(value, dict):
        return json_value(value)
    if isinstance(value, (list, tuple)):
        return json_value(value)
    return json_value(value)


def canonical_robot(row: dict) -> dict:
    external_id = str(row_value(row, "robotId", "robot_id", "id") or "")
    state = row.get("_state") if isinstance(row.get("_state"), dict) else {}
    online = state.get("isOnLine", row_value(row, "isOnLine", "isOnline", "online"))
    battery = state.get("battery", row_value(row, "battery", "batteryLevel", "power"))
    return {
        "externalId": external_id,
        "serialNumber": str(row_value(row, "robotSn", "robotSN", "serialNumber", "sn", "robotId") or external_id),
        "manufacturer": "AutoXing",
        "model": row_value(row, "model", "modelName", "robotModel"),
        "online": bool(online) if online is not None else None,
        "battery": battery,
        "version": state.get("version"),
        "charging": state.get("isCharging", row_value(row, "isCharging", "charging")),
        "position": {
            "x": state.get("x", row_value(row, "x")),
            "y": state.get("y", row_value(row, "y")),
            "yaw": state.get("yaw", row_value(row, "yaw")),
        },
        "speed": state.get("speed"),
        "emergencyStop": state.get("isEmergencyStop"),
        "obstruction": state.get("hasObstruction"),
        "statusDetails": state,
        "task": json_value(state.get("task", state.get("taskObj"))),
        "errors": json_value(state.get("errors", state.get("error"))),
        "businessId": row_value(row, "businessId", "business_id"),
        "businessName": row_value(row, "business_name", "businessName"),
        "areaId": row_value(row, "areaId", "area_id"),
        "raw": json_value(row),
    }


def non_empty(value):
    return value is not None and value != "" and value != [] and value != {}


def task_id(row):
    if not isinstance(row, dict):
        return None
    return row_value(row, "taskId", "task_id", "id")


def encode_base_map(image, max_bytes):
    if image is None or isinstance(image, str):
        return None, image if isinstance(image, str) else None
    try:
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        content = buffer.getvalue()
        if len(content) > max_bytes:
            return {"available": True, "omitted": True, "size": len(content), "reason": "map exceeds configured size limit"}, None
        return {"available": True, "contentType": "image/png", "size": len(content), "contentBase64": base64.b64encode(content).decode("ascii")}, None
    except Exception as error:
        return None, str(error)


def collect_resources(module, rows):
    """Fetch read-only AutoXing resources without invoking Robot.get_state()."""
    resources = {"businesses": [], "buildings": [], "pois": [], "areas": [], "maps": [], "tasks": []}
    errors = []
    for name, value in (("businesses", getattr(module, "business_df", None)), ("buildings", getattr(module, "buildings_df", None))):
        try:
            result = frame_records(value)
            resources[name] = result if isinstance(result, list) else []
        except Exception as error:
            errors.append({"resource": name, "message": str(error)})

    # POIs and areas are usually shared by a business/area. Cache that scope
    # while retaining a robot reference in the returned payload.
    poi_cache = {}
    area_cache = {}
    for row in rows:
        external_id = row["externalId"]
        raw = row.get("raw") or {}
        if not external_id or not isinstance(raw, dict):
            continue
        # The wrapper's POI/area helpers use attribute access (robot.businessId)
        # even though the bridge serializes robot rows as JSON dictionaries.
        robot_context = SimpleNamespace(**{str(key): value for key, value in raw.items() if str(key).isidentifier()})
        scope_key = (str(row.get("businessId") or ""), str(row.get("areaId") or ""))
        try:
            if hasattr(module, "get_pois"):
                if scope_key not in poi_cache:
                    poi_cache[scope_key] = frame_records(module.get_pois(robot_context))
                pois = poi_cache[scope_key]
                resources["pois"].append({"externalRobotId": external_id, "businessId": row.get("businessId"), "areaId": row.get("areaId"), "items": pois if isinstance(pois, list) else []})
        except Exception as error:
            errors.append({"resource": "pois", "externalRobotId": external_id, "message": str(error)})
        try:
            if hasattr(module, "get_areas"):
                if scope_key not in area_cache:
                    area_cache[scope_key] = frame_records(module.get_areas(robot_context))
                areas = area_cache[scope_key]
                resources["areas"].append({"externalRobotId": external_id, "businessId": row.get("businessId"), "areaId": row.get("areaId"), "items": areas if isinstance(areas, list) else []})
        except Exception as error:
            errors.append({"resource": "areas", "externalRobotId": external_id, "message": str(error)})

    # Maps are fetched once per area/robot combination. The base map is capped
    # because it is binary data; metadata and GeoJSON layers remain available.
    seen_maps = set()
    max_map_bytes = int(os.environ.get("AUTOXING_MAX_MAP_BYTES", str(8 * 1024 * 1024)))
    include_base_map = str(os.environ.get("AUTOXING_INCLUDE_BASE_MAP", "false")).lower() in {"1", "true", "yes"}
    for row in rows:
        area_id = row.get("areaId")
        external_id = row.get("externalId")
        if not area_id or not external_id or str(area_id) in seen_maps:
            continue
        seen_maps.add(str(area_id))
        item = {"externalRobotId": external_id, "areaId": area_id, "robotSerialNumber": row.get("serialNumber"), "meta": None, "features": None, "baseMap": None, "errors": []}
        try:
            if hasattr(module, "get_map_meta"):
                item["meta"] = json_value(module.get_map_meta(str(area_id), str(row.get("serialNumber") or external_id)))
        except Exception as error:
            item["errors"].append({"resource": "map_meta", "message": str(error)})
        try:
            if hasattr(module, "get_map_features"):
                item["features"] = json_value(module.get_map_features(str(area_id), str(row.get("serialNumber") or external_id)))
        except Exception as error:
            item["errors"].append({"resource": "map_features", "message": str(error)})
        if include_base_map:
            try:
                if hasattr(module, "get_base_map_image_by_area"):
                    base_map, map_error = encode_base_map(module.get_base_map_image_by_area(str(area_id)), max_map_bytes)
                    item["baseMap"] = base_map
                    if map_error:
                        item["errors"].append({"resource": "base_map", "message": map_error})
            except Exception as error:
                item["errors"].append({"resource": "base_map", "message": str(error)})
        else:
            item["baseMap"] = {"available": True, "omitted": True, "reason": "base-map image sync disabled; set AUTOXING_INCLUDE_BASE_MAP=true to include it"}
        resources["maps"].append(item)

    try:
        task_frame = module.get_tasks() if hasattr(module, "get_tasks") else []
        task_rows = frame_records(task_frame)
        if not isinstance(task_rows, list):
            task_rows = []
        detail_limit = max(0, int(os.environ.get("AUTOXING_TASK_DETAIL_LIMIT", "25")))
        for index, raw_task in enumerate(task_rows):
            if not isinstance(raw_task, dict):
                continue
            item = {"taskId": task_id(raw_task), "raw": raw_task, "details": None, "status": None, "errors": []}
            if item["taskId"] and index < detail_limit:
                try:
                    if hasattr(module, "get_task_details"):
                        item["details"] = frame_records(module.get_task_details(str(item["taskId"])))
                except Exception as error:
                    item["errors"].append({"resource": "task_details", "message": str(error)})
                try:
                    if hasattr(module, "get_task_status"):
                        item["status"] = frame_records(module.get_task_status(str(item["taskId"])))
                except Exception as error:
                    item["errors"].append({"resource": "task_status", "message": str(error)})
            resources["tasks"].append(item)
    except Exception as error:
        errors.append({"resource": "tasks", "message": str(error)})
    return resources, errors


def import_wrapper():
    default_repo = Path(__file__).resolve().parents[2] / "autoxing"
    repo_path = Path(os.environ.get("AUTOXING_REPO_PATH", str(default_repo))).expanduser()
    lib_path = Path(os.environ.get("AUTOXING_LIB_PATH", repo_path / "lib")).expanduser()
    if not lib_path.exists():
        raise RuntimeError(f"AutoXing wrapper path does not exist: {lib_path}")

    env_file = Path(os.environ.get("AUTOXING_ENV_FILE", repo_path / ".env")).expanduser()
    file_values = load_simple_env(env_file)
    credentials = {}
    for key in ("APPID", "APPSECRET", "APPCODE"):
        value = os.environ.get(key) or file_values.get(key)
        if value:
            credentials[key] = value
    missing = [key for key in ("APPID", "APPSECRET", "APPCODE") if not credentials.get(key)]
    if missing:
        raise RuntimeError("AutoXing credentials are not configured; missing " + ", ".join(missing))

    # api_lib.py expects .env in the current directory and performs its auth/list
    # setup at import time. Use the user's AutoXing .env directly when available;
    # only use a temporary file for an explicitly different env-file path.
    old_cwd = Path.cwd()
    temp_context = None
    if env_file.resolve() == (repo_path / ".env").resolve():
        import_cwd = repo_path
    else:
        temp_context = tempfile.TemporaryDirectory(prefix="altegro-autoxing-")
        temp_env = Path(temp_context.name) / ".env"
        temp_env.write_text("".join(f"{key}={value}\n" for key, value in credentials.items()), encoding="utf-8")
        import_cwd = Path(temp_context.name)
    os.chdir(import_cwd)
    sys.path.insert(0, str(lib_path))
    try:
        with contextlib.redirect_stdout(sys.stderr):
            module = importlib.import_module("api_lib")
        return module, old_cwd
    except Exception:
        os.chdir(old_cwd)
        if temp_context:
            temp_context.cleanup()
        raise


def normalize_status_frame(frame) -> dict:
    """Convert api_lib.get_robot_status() output without invoking Robot.get_state()."""
    if isinstance(frame, str):
        return {"raw": frame}
    try:
        if "data" in frame.columns:
            return {str(index): json_value(value) for index, value in frame["data"].items()}
        return json_value(frame.to_dict())
    except Exception:
        return json_value(frame)


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "list"
    robot_id = sys.argv[2] if len(sys.argv) > 2 else None
    try:
        module, old_cwd = import_wrapper()
        try:
            with contextlib.redirect_stdout(sys.stderr):
                dataframe = module.get_robots()
            if isinstance(dataframe, str):
                raise RuntimeError(dataframe)
            rows = []
            fetch_status = str(os.environ.get("AUTOXING_FETCH_STATUS", "true")).lower() not in {"0", "false", "no"}
            for _, row in dataframe.iterrows():
                raw_row = row.to_dict()
                external_id = str(row_value(raw_row, "robotId", "robot_id", "id") or "")
                is_online = row_value(raw_row, "isOnLine", "isOnline", "online")
                if fetch_status and external_id and is_online is not False and hasattr(module, "get_robot_status"):
                    try:
                        with contextlib.redirect_stdout(sys.stderr):
                            raw_row["_state"] = normalize_status_frame(module.get_robot_status(row))
                    except Exception as state_error:
                        raw_row["_stateError"] = str(state_error)
                item = canonical_robot(raw_row)
                item["stateError"] = raw_row.get("_stateError")
                rows.append(item)
            if robot_id:
                rows = [row for row in rows if row["externalId"] == robot_id]
            payload = {
                "ok": True,
                "provider": "autoxing",
                "wrapper": "autoxing/lib/api_lib.py",
                "command": command,
                "robots": rows,
                "capabilities": {"read": ["identity", "model", "status", "battery", "position", "emergency_stop", "obstruction", "detailed_errors", "pois", "areas", "maps", "task_history", "task_status"], "event": ["status", "alerts", "task_status"], "command": []},
            }
            if command == "snapshot":
                resource_rows = rows
                resource_limit = max(0, int(os.environ.get("AUTOXING_SNAPSHOT_ROBOT_LIMIT", "0")))
                if resource_limit:
                    resource_rows = rows[:resource_limit]
                try:
                    payload["resources"], payload["resourceErrors"] = collect_resources(module, resource_rows)
                except Exception as resource_error:
                    payload["resources"] = {"businesses": [], "buildings": [], "pois": [], "areas": [], "maps": [], "tasks": []}
                    payload["resourceErrors"] = [{"resource": "snapshot", "message": str(resource_error)}]
            # Raw provider rows are useful while collecting resources but can
            # make a fleet snapshot unnecessarily large. Keep them opt-in.
            if str(os.environ.get("AUTOXING_INCLUDE_RAW", "false")).lower() not in {"1", "true", "yes"}:
                for item in payload["robots"]:
                    item.pop("raw", None)
            output(payload)
        finally:
            os.chdir(old_cwd)
    except Exception as error:
        output({"ok": False, "provider": "autoxing", "code": "AUTOXING_BRIDGE_FAILED", "message": str(error)})
        sys.exit(0)


if __name__ == "__main__":
    main()
