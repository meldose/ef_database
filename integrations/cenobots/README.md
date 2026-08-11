# CenoBots read-only integration

This folder is based on `CenoBots Open API v1.0.16.pdf` in Downloads.

## API facts

- Base URL format: `{HOST}/app`
- EU host: `https://app-server-eu.cz-robots.com`
- Authentication uses HMAC-SHA256 headers: `X-Api-Key`, `X-Api-timestamp`, and `X-Api-signature`.
- The signature input is `HTTP_METHOD + timestamp + request_path`.
- The robot identifier is the CenoBots `deviceOpenId`.

## Phase 1 read-only surface

The low-level client covers device status, robot information, maintenance details, settings read, system errors, device open IDs, current maps, map areas, and mission history. The separate `integrations/cenobots_bridge.py` process normalizes those provider responses into Altegro's canonical robot snapshot.

The PDF also documents schedules, audio, mission control, map changes, back points, and favorite missions. Those mutating/control operations are deliberately not implemented in this Phase 1 scaffold.

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

The API account currently enforces less than one request per second. The client therefore spaces calls by `CENOBOTS_MIN_REQUEST_INTERVAL_SECONDS` (default `1.05`). Set `CENOBOTS_RESOURCE_SYNC=true` only when map, area, and mission-history resources are needed because those resources require additional provider calls.

Maintenance reset history is capped at ten records per item by default to prevent a fleet snapshot and local state file from growing without limit. Change this with `CENOBOTS_MAINTENANCE_HISTORY_LIMIT`. Set `CENOBOTS_INCLUDE_RAW=true` only for protected diagnostics.
