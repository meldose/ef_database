# CenoBots integration scaffold

This folder is based on `CenoBots Open API v1.0.16.pdf` in Downloads.

## API facts

- Base URL format: `{HOST}/app`
- EU host: `https://app-server-eu.cz-robots.com`
- Authentication uses HMAC-SHA256 headers: `X-Api-Key`, `X-Api-timestamp`, and `X-Api-signature`.
- The signature input is `HTTP_METHOD + timestamp + request_path`.
- The robot identifier is the CenoBots `deviceOpenId`.

## Phase 1 read-only surface

The client scaffold covers device status, robot information, maintenance details, settings read, system errors, device open IDs, current maps, map areas, and mission history.

The PDF also documents schedules, audio, mission control, map changes, back points, and favorite missions. Those mutating/control operations are deliberately not implemented in this Phase 1 scaffold.

## Usage

Configure the official CenoBots host, access key, and secret key in the repository's ignored `.env` file. The client loads that file automatically. Do not commit credentials.

```bash
python3 integrations/cenobots/client.py open-ids
python3 integrations/cenobots/client.py snapshot
```

For only the device-list endpoint, run the dedicated helper:

```bash
python3 integrations/cenobots/list_devices.py
```

It calls `GET /app/openapi/v1/device/deviceOpenIds`, prints the available `deviceOpenId` and license-plate values as JSON, and never prints the configured API credentials.

When `CENOBOTS_LIVE=true`, the Node server uses this client behind the existing **Sync CenoBots** button. The live sync imports device identity, status, battery, position, maintenance, and system-error data into canonical Robots, Passports, and Events. Control operations remain disabled.
