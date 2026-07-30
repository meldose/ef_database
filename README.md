# Altegro Phase 1 server prototype

This is a dependency-free Node.js prototype for testing the first Altegro thin slice described in:

- `Altegro_Projektbriefing_Entwickler.md`
- `Altegro_Technisches_Lastenheft_Phase_1.md`

It demonstrates the domain boundaries and API flow, not production security or persistence.

## Run

Requires Node.js 18 or newer.

```bash
npm start
```

The server listens on `http://localhost:3000`.

Open `http://127.0.0.1:3000/` in a browser for the included operations frontend. It provides a login page, robot registry table, search and status filters, Passport inspection, adapter sync buttons, event and capability panels, logged-in user display, logout, a robot-registration form, and a robot-specific event form.

The frontend starts with a login page. Prototype accounts use password `demo`:

- `admin@demo.altegro.local` — Platform Admin
- `technician@demo.altegro.local` — Technician
- `owner@demo.altegro.local` — Owner
- `data@demo.altegro.local` — Data Admin
- `support@demo.altegro.local` — Support Admin
- `auditor@demo.altegro.local` — read-only Passport, certificate, service evidence, and export access

The role is assigned by the backend after login; it is no longer selected from the dashboard.

Robot-scoped prototype accounts use separate credentials and can only see their assigned robot:

- `robot-ax-001@demo.altegro.local` / `AX-robot-001-demo` — `AX-DEMO-001`
- `robot-cb-001@demo.altegro.local` / `CB-robot-001-demo` — `CB-DEMO-001`
- `robot-se52512706922ne@demo.altegro.local` / `SE-robot-001-demo` — `SE52512706922NE`

Robot accounts are read-only. The third account will show data after the AutoXing sync has registered a robot with serial `SE52512706922NE`. These are local prototype credentials only; they are stored in server source code and must be replaced by OIDC/SSO and database-backed memberships before deployment.

Every additional robot returned by an adapter synchronization automatically receives a new robot-scoped prototype account. Platform, data, or support administrators can view the generated credentials in the **Robot accounts** section of the Integration plane, or through `GET /api/v1/robot-accounts`.

Run the smoke tests in a second command:

```bash
npm test
```

## Demo tokens

```bash
curl http://localhost:3000/api/v1/demo/tokens
```

Use a token with API calls:

```bash
curl -H "Authorization: Bearer demo-platform-admin" \
  http://localhost:3000/api/v1/robots
```

Available demo roles are `owner`, `technician`, `platform_admin`, `data_admin`, and `support_admin`.

## Useful test calls

List adapters and their capabilities:

```bash
curl -H "Authorization: Bearer demo-platform-admin" \
  http://localhost:3000/api/v1/adapters
```

Read a Passport after obtaining a robot ID from the Registry:

```bash
curl -H "Authorization: Bearer demo-platform-admin" \
  http://localhost:3000/api/v1/robots/ROBOT_ID/passport
```

Run the mock OEM adapter:

```bash
curl -X POST -H "Authorization: Bearer demo-platform-admin" \
  http://localhost:3000/api/v1/adapters/mock-oem/sync
```

## AutoXing wrapper integration

The AutoXing adapter can use the read-only functions in the separate `autoxing/lib/api_lib.py` wrapper. Live calls are disabled by default and the local mock adapter remains active.

Configure the credentials in the AutoXing repository `.env` file or as environment variables. The wrapper expects `APPID`, `APPSECRET`, and `APPCODE`.

From WSL:

```bash
export AUTOXING_LIVE=true
export AUTOXING_REPO_PATH=/mnt/c/Users/meldo/Downloads/autoxing
export AUTOXING_ENV_FILE=/mnt/c/Users/meldo/Downloads/autoxing/.env
export PYTHON_BIN=/mnt/c/Users/meldo/Downloads/autoxing/.venv/bin/python
export AUTOXING_POLL_INTERVAL_MS=300000
# The robot snapshot is reliable by default. Optional POI/area/map/task
# endpoints are disabled by default because some provider responses are slow
# or do not use the wrapper's expected `data` shape.
# export AUTOXING_RESOURCE_SYNC=true
# export AUTOXING_BRIDGE_TIMEOUT_MS=300000
# Optional: include binary base-map images in the fleet snapshot
# export AUTOXING_INCLUDE_BASE_MAP=true
npm start
```

Then use the existing **Sync AutoXing** button or call:

```bash
curl -X POST -H "Authorization: Bearer demo-platform-admin" \
  http://127.0.0.1:3000/api/v1/adapters/autoxing/sync
```

The bridge imports the vendor wrapper in a separate Python process, normalizes robot identity/model/online state/battery, position, safety status, POIs, areas, maps, task history/status, and detailed errors into Altegro records, creates read-only technical events, and keeps command capabilities empty. Base-map images are omitted by default to keep fleet snapshots small; set `AUTOXING_INCLUDE_BASE_MAP=true` when they are needed. It does not expose AutoXing task creation, navigation, cancel, or control methods.

Read-only resource endpoints after synchronization:

```text
GET /api/v1/robots/:id/autoxing
GET /api/v1/autoxing/tasks
GET /api/v1/adapters/autoxing/resources
```

For real customer/site assignment, configure a JSON business mapping before the pilot. The keys can be an AutoXing business ID or business name:

```bash
export AUTOXING_BUSINESS_MAP='{"AUTOXING_BUSINESS_ID":{"organizationId":"org-demo","operatorOrganizationId":"org-service","siteId":"site-berlin"}}'
export AUTOXING_REQUIRE_MAPPING=true
```

Optional model mapping is supported with `AUTOXING_MODEL_MAP`. When live mode is enabled, the server polls AutoXing at `AUTOXING_POLL_INTERVAL_MS`, records last-sync status/errors, retries a failed bridge call once, and imports online/offline, battery, version, mission, and error events when the wrapper provides them.

The Python environment must have the wrapper dependencies installed. If credentials or dependencies are missing, the live sync returns a clear `503` error; it does not silently create fake live data.

Append an immutable Passport entry:

```bash
curl -X POST -H "Authorization: Bearer demo-technician" \
  -H "Content-Type: application/json" \
  -d '{"type":"maintenance","source":"service-demo","data":{"note":"Filter replaced"}}' \
  http://localhost:3000/api/v1/robots/ROBOT_ID/passport-entries
```

Create a robot-specific technical event:

```bash
curl -X POST -H "Authorization: Bearer demo-technician" \
  -H "Content-Type: application/json" \
  -d '{"title":"Battery inspection completed","description":"Battery and charging dock inspected.","eventType":"inspection","sourceSystem":"manual-portal","severity":"info","occurredAt":"2026-07-27T14:00:00.000Z"}' \
  http://localhost:3000/api/v1/robots/ROBOT_ID/events
```

The browser form also accepts an optional attachment up to 2 MB. In this prototype, attachment content is held in memory; production should store it in S3-compatible Object Storage.

Attempting a robot command returns `403`; Phase 1 command capabilities are intentionally disabled.

## Implemented prototype surface

- Tenant-aware demo authentication and role checks
- Robot Registry with immutable generated Robot IDs
- Organization, Site, Model, and External Identity relationships
- Robot Passport with append-only entries and completeness status
- Canonical technical events with duplicate protection
- Audit records
- AutoXing, CenoBots, and third mock OEM adapter manifests
- Idempotent mock adapter sync
- Service-case linkage and Passport history
- Incident-to-service workflow with controlled status progression and service-completion evidence
- Passport documents with hashes, certificate expiry records, and deployment/rollback evidence
- Model/capability compatibility catalog with an explicit Phase 1 command block
- Operations and 2027-proof metrics for online robots, open cases, Passport completeness, and expiring certificates
- Controlled Robot CSV, Passport JSON, and tenant JSON exports with audit records
- Read-only auditor role
- Prototype Outbox records for lifecycle and service changes
- Robot-specific event creation with title, description, date/time, type, severity, source, and optional attachment metadata/content
- Basic search/filtering
- Stable JSON error responses

## Intentionally not production-ready

The prototype uses in-memory state and demo bearer tokens. Its Outbox is illustrative and not transactionally durable. Attachments are kept in memory rather than Object Storage. It does not yet implement PostgreSQL, OIDC, real Secret Management, Object Storage, OpenAPI generation, signed Webhooks, rate limiting, or migrations. AutoXing can run through the configured wrapper; CenoBots remains a mock until its new client is connected to the server. Those are the next implementation steps for the production-oriented Phase 1 build.
