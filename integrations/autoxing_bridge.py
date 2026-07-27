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
from pathlib import Path


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


def canonical_robot(row: dict) -> dict:
    external_id = str(row_value(row, "robotId", "robot_id", "id") or "")
    online = row_value(row, "isOnLine", "isOnline", "online")
    return {
        "externalId": external_id,
        "serialNumber": str(row_value(row, "robotSn", "robotSN", "serialNumber", "sn", "robotId") or external_id),
        "manufacturer": "AutoXing",
        "model": row_value(row, "model", "modelName", "robotModel"),
        "online": bool(online) if online is not None else None,
        "battery": row_value(row, "battery", "batteryLevel", "power"),
        "businessId": row_value(row, "businessId", "business_id"),
        "businessName": row_value(row, "business_name", "businessName"),
        "areaId": row_value(row, "areaId", "area_id"),
        "raw": json_value(row),
    }


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
    # setup at import time. Keep that temporary file outside the repository.
    with tempfile.TemporaryDirectory(prefix="altegro-autoxing-") as temp_dir:
        temp_env = Path(temp_dir) / ".env"
        temp_env.write_text("".join(f"{key}={value}\n" for key, value in credentials.items()), encoding="utf-8")
        old_cwd = Path.cwd()
        os.chdir(temp_dir)
        sys.path.insert(0, str(lib_path))
        try:
            with contextlib.redirect_stdout(sys.stderr):
                module = importlib.import_module("api_lib")
            return module, old_cwd
        except Exception:
            os.chdir(old_cwd)
            raise


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
            rows = [canonical_robot(row.to_dict()) for _, row in dataframe.iterrows()]
            if robot_id:
                rows = [row for row in rows if row["externalId"] == robot_id]
            output({
                "ok": True,
                "provider": "autoxing",
                "wrapper": "autoxing/lib/api_lib.py",
                "command": command,
                "robots": rows,
                "capabilities": {"read": ["identity", "model", "status", "battery"], "event": ["status", "alerts"], "command": []},
            })
        finally:
            os.chdir(old_cwd)
    except Exception as error:
        output({"ok": False, "provider": "autoxing", "code": "AUTOXING_BRIDGE_FAILED", "message": str(error)})
        sys.exit(0)


if __name__ == "__main__":
    main()
