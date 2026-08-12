# CenoBots integration

This folder is based on `CenoBots Open API v1.0.16.pdf` in Downloads.

## API facts

- Base URL format: `{HOST}/app`
- EU host: `https://app-server-eu.cz-robots.com`
- Authentication uses HMAC-SHA256 headers: `X-Api-Key`, `X-Api-timestamp`, and `X-Api-signature`.
- The signature input is `HTTP_METHOD + timestamp + request_path`.
- The robot identifier is the CenoBots `deviceOpenId`.

## Altegro read-only surface

The low-level client covers device status, robot information, maintenance details, settings read, system errors, device open IDs, current maps, map areas, and mission history. The separate `integrations/cenobots_bridge.py` process normalizes those provider responses into Altegro's canonical robot snapshot.

The Altegro website and its CenoBots bridge remain read-only. Robot-control operations are available only through the separate, safety-gated `tasks.py` command wrapper described below; they are not exposed by a dashboard button or server route.

## Usage

Configure the official CenoBots host, access key, and secret key in the repository's ignored `.env` file. The client loads that file automatically. Do not commit credentials.

```bash
python3 integrations/cenobots/client.py open-ids
python3 integrations/cenobots_bridge.py snapshot
python3 integrations/cenobots_bridge.py snapshot AUGCEMZK85
```

For only the device-list endpoint, run the dedicated helper:

```bash
python3 integrations/cenobots/list_devices.py
```

It calls `GET /app/openapi/v1/device/deviceOpenIds`, prints the available `deviceOpenId` and license-plate values as JSON, and never prints the configured API credentials.

The Open API cannot register or attach a robot to an account. If this endpoint returns an empty list, assign the robot to the same API account in the CenoBots operation platform (or ask CenoBots support to bind it), confirm that the API keys and robot use the same regional host, and run the helper again. `CENOBOTS_ROBOT_OPEN_ID` and the optional comma-separated `CENOBOTS_ROBOT_OPEN_IDS` are fallback IDs for querying already-authorized robots; they cannot grant account access.

When `CENOBOTS_LIVE=true`, the Node server invokes the bridge behind the existing **Sync CenoBots** button. The live sync imports device identity, status, battery, position, maintenance, and system-error data into canonical Robots, Passports, and Events. Control operations remain disabled.

## Robot task wrapper

The wrapper supports an L50 `SWEEP` cleaning mission plus `go-home`, `pause`, `continue`, and `stop`. Every command is a dry-run preview by default and does not contact CenoBots:

```bash
python3 integrations/cenobots/tasks.py clean \
  --device-open-id AUGCEMZK85 \
  --map-id YOUR_MAP_ID \
  --map-version YOUR_MAP_VERSION \
  --everywhere \
  --intensity MEDIUM

python3 integrations/cenobots/tasks.py go-home \
  --device-open-id AUGCEMZK85
```

Area cleaning uses one or more `--area-id` arguments instead of `--everywhere`. Cleaning returns to the station by default; use `--stop-after` to stop at the end or `--back-point-id ID` for a configured custom return point.

A live command is sent only when all three conditions are met:

1. Set `CENOBOTS_COMMANDS_ENABLED=true` in the ignored local `.env` file.
2. Add `--execute`.
3. Add `--confirm-device` with exactly the same Open ID as `--device-open-id`.

For example, the final live-only arguments are `--execute --confirm-device AUGCEMZK85`. First inspect the dry-run JSON and ensure the map ID, map version, area, target robot, and physical surroundings are correct. The wrapper never prints API keys.

## Python `Robot` wrapper

Application code can import the root-level `Robot` class. It loads `CENOBOTS_HOST`, `CENOBOTS_ACCESS_KEY`, and `CENOBOTS_SECRET_KEY` from the ignored `.env` file, so credentials are not passed in application code:

```python
from wrapper import Robot

robot = Robot("KK93DZ0Q37")
robot.go_home()
robot.start_cleaning_task()
```

The method calls require parentheses. `start_cleaning_task()` reads the robot's current map automatically, cleans the full map once at `MEDIUM` intensity, and returns to the station. It can also target selected areas or override the map:

```python
robot.start_cleaning_task(area_ids=["3", "8"], intensity="HIGH")
robot.pause_task()
robot.continue_task()
robot.stop_task()
```

Useful monitoring and reporting methods are also available:

```python
robot.get_status()
robot.get_current_task()
robot.battery_level()
robot.is_online()
robot.is_running()
robot.is_charging()
robot.is_docked()

robot.get_robot_info()
robot.get_maintenance()
robot.get_errors()
robot.get_settings()
robot.get_maps()
robot.get_areas()                 # current map
robot.get_task_history()
robot.get_task_summary()

robot.start_area_cleaning_task(["3", "8"])
robot.resume_task()               # alias for continue_task()
robot.return_home()               # alias for go_home()
```

`continue_task()` resumes a paused mission. `stop_task()` ends the mission and cannot be undone. When `go_home()` reports provider code `35002` (`Another mission in progress`), stop the active mission first and then send the robot home:

```python
robot.stop_task()
robot.go_home()
```

These Python methods are intentional live commands, so creating `Robot(...)` enables commands for that object without requiring `CENOBOTS_COMMANDS_ENABLED`. The environment switch remains required for the low-level client and command-line executor. Provider errors raise `CenoBotsError`; successful commands return a dictionary containing `success`, provider `data`, and the trace `rid`.

The API account currently enforces less than one request per second. The client therefore spaces calls by `CENOBOTS_MIN_REQUEST_INTERVAL_SECONDS` (default `1.05`). Set `CENOBOTS_RESOURCE_SYNC=true` only when map, area, and mission-history resources are needed because those resources require additional provider calls.

Maintenance reset history is capped at ten records per item by default to prevent a fleet snapshot and local state file from growing without limit. Change this with `CENOBOTS_MAINTENANCE_HISTORY_LIMIT`. Set `CENOBOTS_INCLUDE_RAW=true` only for protected diagnostics.
