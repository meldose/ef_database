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

Copy `.env.example` to a protected environment file and provide the official CenoBots access key, secret key, and device open ID. Do not commit credentials.

```bash
cp integrations/cenobots/.env.example integrations/cenobots/.env
python3 integrations/cenobots/client.py status
```

This client is not yet connected to the Node server. The next integration step is to map CenoBots responses into the canonical Robot, Passport, and Event models, then add the adapter behind the existing CenoBots sync route.
