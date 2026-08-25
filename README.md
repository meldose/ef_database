# Altegro Phase 1 server prototype

This is a dependency-free Node.js prototype for testing the first Altegro thin slice described in:

- `Altegro_Projektbriefing_Entwickler.md`
- `Altegro_Technisches_Lastenheft_Phase_1.md`

It demonstrates the domain boundaries and API flow with PostgreSQL-backed persistence, S3-compatible attachments, durable background jobs, and hardened prototype authentication. OIDC/SSO and managed cloud operations remain future production work.

## Run

Requires Node.js 18 or newer.

```bash
npm start
```

The server listens on `http://localhost:3000`.

Open `http://127.0.0.1:3000/` in a browser for the included operations frontend. Dashboard URLs such as `/dashboard/reports` and `/dashboard/workforce` are refresh-safe and preserve the selected workspace.

The frontend starts with a login page. Standard prototype accounts use password `efrobotics`:

- `admin@demo.altegro.local` — Platform Admin
- `technician@demo.altegro.local` — Technician
- `owner@demo.altegro.local` — Owner
- `data@demo.altegro.local` — Data Admin
- `support@demo.altegro.local` — Support Admin
- `auditor@demo.altegro.local` — read-only Passport, certificate, service evidence, and export access

The role is assigned by the backend after login; it is no longer selected from the dashboard.

## Authentication sessions

Login uses the account email and password only. Passwords are stored as salted scrypt hashes, never as recoverable plaintext. A random server-side session token is created after a successful login; only its SHA-256 digest is stored. Browsers also receive an `HttpOnly`, `SameSite=Strict` session cookie. Logout revokes the session. Sessions expire after eight hours by default; set `AUTH_SESSION_TTL_SECONDS` to change that duration. Set `COOKIE_SECURE=true` when the site is served through HTTPS.

Robot-scoped prototype accounts use separate credentials and can only see their assigned robot:

- `robot-ax-001@demo.altegro.local` / `AX-robot-001-demo` — `AX-DEMO-001`
- `robot-cb-001@demo.altegro.local` / `CB-robot-001-demo` — `CB-DEMO-001`
- `robot-se52512706922ne@demo.altegro.local` / `SE-robot-001-demo` — `SE52512706922NE`

Robot accounts are read-only. The third account will show data after the AutoXing sync has registered a robot with serial `SE52512706922NE`. These are local prototype credentials only. At runtime they are converted to password hashes; real deployments should replace them with OIDC/SSO and database-backed memberships.

Every additional robot returned by an adapter synchronization automatically receives a new robot-scoped prototype account. Passwords are shown only once when an administrator manually creates an account; the account-list API never returns stored passwords.

## PostgreSQL persistence and object storage

The default Docker deployment now uses PostgreSQL for durable application state and sync jobs, plus S3-compatible MinIO for attachment bytes. Database migrations in `migrations/` run during application startup and can also be applied explicitly:

```bash
npm run migrate
docker compose up -d --build
```

`ALTEGRO_PERSISTENCE_DRIVER=postgres` and `OBJECT_STORAGE_DRIVER=s3` are mandatory when `NODE_ENV=production`. PostgreSQL stores the durable application snapshot together with queryable projections for users, sessions, robots, Passport entries, events, audits, provider tasks, attachments, and sync jobs. Attachment metadata stays in PostgreSQL while bytes are stored under tenant/robot-scoped object keys.

The previous JSON/inline implementation remains available only for local tests or migration work:

```bash
ALTEGRO_PERSISTENCE_DRIVER=file OBJECT_STORAGE_DRIVER=inline ALTEGRO_SYNC_MODE=inline npm test
```

Create coordinated database and object-storage backups with `npm run backup`; restore them with `npm run restore -- BACKUP_DIRECTORY`. The scripts require PostgreSQL client tools and the AWS CLI. Test restoration regularly in an isolated environment before relying on a backup.

To migrate the existing JSON state and its embedded attachments after PostgreSQL and object storage are configured, stop the Altegro web process and run:

```bash
npm run import:legacy -- ./data/altegro-state.json
```

The importer runs migrations, uploads event/document attachment bytes, replaces them with object metadata, and writes the resulting snapshot and relational projections. Keep the source JSON as a rollback backup until the imported site has been verified.

## Legacy local persistence

In explicit `ALTEGRO_PERSISTENCE_DRIVER=file` mode, runtime state is atomically saved to `data/altegro-state.json`. This mode exists for the dependency-light test suite and one-instance migration support; it is rejected in production.

Use `ALTEGRO_DATA_FILE` to choose another location in legacy file mode, or `ALTEGRO_PERSISTENCE_DRIVER=memory` for an intentionally ephemeral test run. PostgreSQL and Object Storage are the supported production targets.

## Notifications

The dashboard alert button summarizes visible offline robots, error and critical events, predictive-maintenance risks, expiring certificates, open service cases, and failed integrations. `GET /api/v1/notifications` exposes the same tenant- and role-scoped view. Browsers receive live changes through the authenticated WebSocket endpoint `/api/v1/notifications/stream`; read receipts remain per user.

## Operations intelligence and access control

- `GET /api/v1/maintenance/predictions` scores visible robots from errors, connectivity, battery, consumable life, and scheduled-maintenance state.
- `GET /api/v1/customer-dashboard` provides customer- and site-scoped fleet, service, provider, and maintenance summaries.
- `GET /api/v1/permissions` exposes the authenticated role's server-enforced capability set and the role matrix.
- `GET /api/v1/audit` supports search, action, result, actor, object type, and date filters. `GET /api/v1/audit.csv` exports the filtered evidence.

Permissions are checked by capability (`robot.write`, `notification.manage`, `work_order.manage`, `audit.export`, and similar) instead of relying only on UI role labels.

## Technician qualifications

The dedicated **Technicians → Technician qualification matrix** compares technicians with the required skills and certificates for each visible robot model. Valid certificates may be restricted to specific models. Assignments are rejected when a required skill or valid certificate is missing, while certificates expiring within 60 days produce a warning. Assignment and removal actions are written to the Robot Passport, audit history, Outbox, and persistent state.

Workforce endpoints:

```text
GET    /api/v1/workforce/matrix
GET    /api/v1/technicians
POST   /api/v1/technicians
POST   /api/v1/technicians/:id/qualifications
POST   /api/v1/robot-assignments
DELETE /api/v1/robot-assignments/:id
GET    /api/v1/work-orders
POST   /api/v1/work-orders
PATCH  /api/v1/work-orders/:id
```

Platform, data, and support administrators can schedule qualified, conflict-checked work orders. Linked technicians may update only their assigned orders. Work-order completion is recorded in the Robot Passport and audit history.

Run the smoke tests in a second command:

```bash
npm test
```

## Demo tokens

The public static demo-token endpoint is disabled. Use the browser login or `POST /api/v1/auth/login` with an account email and password to obtain a temporary session token.

Available demo roles are `owner`, `technician`, `platform_admin`, `data_admin`, `support_admin`, and `auditor`.

## Useful test calls

Set `SESSION_TOKEN` to the token returned by `POST /api/v1/auth/login`, then use it for API requests:

List adapters and their capabilities:

```bash
curl -H "Authorization: Bearer $SESSION_TOKEN" \
  http://localhost:3000/api/v1/adapters
```

Read a Passport after obtaining a robot ID from the Registry:

```bash
curl -H "Authorization: Bearer $SESSION_TOKEN" \
  http://localhost:3000/api/v1/robots/ROBOT_ID/passport
```

Run the mock OEM adapter:

```bash
curl -X POST -H "Authorization: Bearer $SESSION_TOKEN" \
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
export AUTOXING_TASK_SYNC=true
export AUTOXING_TASK_DETAIL_LIMIT=25
# The robot snapshot is reliable by default. Optional POI/area/map/task
# endpoints are disabled by default because some provider responses are slow
# or do not use the wrapper's expected `data` shape.
# export AUTOXING_RESOURCE_SYNC=true
# export AUTOXING_BRIDGE_TIMEOUT_MS=300000
# Optional: include binary base-map images in the fleet snapshot
# export AUTOXING_INCLUDE_BASE_MAP=true
npm start
```

Use **Sync all robots** for the normal operator workflow. AutoXing and CenoBots run independently, so one provider can succeed even when the other reports an error. The provider-specific **Sync AutoXing** and **Sync CenoBots** buttons remain available for diagnostics. To synchronize only AutoXing by API, call:

```bash
curl -X POST -H "Authorization: Bearer $SESSION_TOKEN" \
  http://127.0.0.1:3000/api/v1/adapters/autoxing/sync
```

With PostgreSQL-backed `ALTEGRO_SYNC_MODE=async`, this endpoint returns `202 Accepted` with a durable job instead of waiting for the provider. The dashboard polls until completion. API clients can do the same through:

```text
GET /api/v1/sync-jobs
GET /api/v1/sync-jobs/:jobId
```

Jobs move through `queued`, `running`, `succeeded`, or `failed`. PostgreSQL prevents two active jobs for the same tenant/provider, workers claim work with row locking, and abandoned running jobs can be reclaimed after `SYNC_JOB_STALE_SECONDS`. Both AutoXing and CenoBots scheduled polling enqueue through this same path.

The bridge imports the vendor wrapper in a separate Python process, normalizes robot identity/model/online state/battery, position, safety status, POIs, areas, maps, task history/status, and detailed errors into Altegro records, creates read-only technical events, and keeps command capabilities empty. Base-map images are omitted by default to keep fleet snapshots small; set `AUTOXING_INCLUDE_BASE_MAP=true` when they are needed. It does not expose AutoXing task creation, navigation, cancel, or control methods.

Read-only resource endpoints after synchronization:

```text
GET /api/v1/robots/:id/autoxing
GET /api/v1/autoxing/tasks
GET /api/v1/autoxing/tasks/:taskId
GET /api/v1/autoxing/operations
PATCH /api/v1/autoxing/alerts/:alertId
GET|POST /api/v1/autoxing/maintenance-schedules
PATCH /api/v1/autoxing/maintenance-schedules/:id
GET /api/v1/autoxing/diagnostic-reports/:robotId
GET|POST /api/v1/autoxing/escalation-rules
PATCH /api/v1/autoxing/escalation-rules/:id
POST /api/v1/autoxing/escalations/evaluate
GET /api/v1/adapters/autoxing/resources
```

The AutoXing tab automatically refreshes locally cached fleet telemetry every 30 seconds. The live fleet has search, status/battery/alert filters, and 12-card pagination. Task rows open a normalized detail view with the protected provider response. Alerts can be acknowledged, assigned to an eligible technician, and converted into a linked service case. The server performs provider synchronization at `AUTOXING_POLL_INTERVAL_MS`. The operations endpoint supplies live fleet cards, task KPIs, actionable error guidance, synchronization history, and seven-day trends. `AUTOXING_TASK_SYNC=true` collects task history even when the slower POI, area, and map resource synchronization is disabled.

Maintenance schedules support recurring intervals, due/overdue status, qualified technician assignment, pause/resume, and completion. Completing maintenance advances the next due date and writes immutable event and Passport evidence.

Remote diagnostic reports are read-only JSON support bundles containing current telemetry, provider errors, alerts, task summary, recent events, maintenance schedules, qualified assignments, adapter health, and synchronized robot resources. Reports never invoke a movement or robot-control command and are tenant/robot scoped.

Alert escalation rules match alert type, minimum severity, and elapsed minutes. A rule can send email, create a service case, or do both. Rules run after successful AutoXing synchronization and once per minute. Each rule/alert pair is executed once; inactive rules and resolved alerts are skipped. Preferred technicians are assigned only when their current skills and certificates qualify them for the affected robot.

For production, mount credentials as protected files and set `APPID_FILE`, `APPSECRET_FILE`, and `APPCODE_FILE` instead of placing secret values in `.env`. The same pattern is available for `CENOBOTS_ACCESS_KEY_FILE` and `CENOBOTS_SECRET_KEY_FILE`. Set `ALTEGRO_REQUIRE_MANAGED_SECRETS=true` to make startup fail safely when an enabled live provider uses direct values or has an incomplete secret mount. Docker secrets, Kubernetes Secrets mounted as volumes, and systemd credentials can all use this interface. The API and browser expose only counts and configuration mode, never credential values or secret paths.

Use `compose.production.yaml` as a production override after creating the external Docker secrets it references for providers, monitoring, PostgreSQL, and object storage. Provision the production object-storage bucket before startup because automatic bucket creation is disabled there. Rotate a provider credential by creating a new secret version, updating the deployment secret mount, restarting one instance, verifying `/ready` and a read-only synchronization, then rolling the remaining instances. Revoke the previous provider credential only after the new version succeeds. Do not commit secret files or copy their values into Compose.

## Monitoring

The server exposes four monitoring surfaces:

```text
GET /health                 process liveness
GET /ready                  persistence and secret-policy readiness
GET /metrics                Prometheus text metrics
GET /api/v1/monitoring      authenticated dashboard summary
```

Set `METRICS_TOKEN_FILE` to protect `/metrics` with a bearer token when it is not restricted to a private monitoring network. The metrics include request/error counts, active requests, uptime, robot count, open service cases, and last adapter-sync success. The AutoXing tab shows the authenticated monitoring summary. Configure alerts for `altegro_up == 0`, increasing `altegro_http_errors_total`, and `altegro_adapter_last_sync_success == 0`.

## Email alert notifications

Altegro can email error and critical robot events and provider synchronization failures. Delivery is disabled by default. Configure `EMAIL_ALERTS_ENABLED=true`, `EMAIL_ALERT_FROM`, `EMAIL_ALERT_RECIPIENTS`, and the `EMAIL_SMTP_*` settings from `.env.example`. Multiple recipients are comma-separated. `EMAIL_ALERT_MIN_SEVERITY` accepts `info`, `warning`, `error`, or `critical`; `EMAIL_ALERT_COOLDOWN_MINUTES` prevents repeated delivery of the same alert.

Authenticated SMTP should use direct TLS (`EMAIL_SMTP_SECURE=true`, normally port 465). Plain SMTP is supported for trusted local relays without authentication. In production, mount the password through `EMAIL_SMTP_PASSWORD_FILE`; direct password values are rejected by the managed-secret policy. The Administration tab provides safe configuration status, delivery history, test delivery, and retry controls without exposing credentials.

For a Docker deployment, create the external `altegro_smtp_password` secret and apply the optional email override:

```bash
docker compose -f compose.yaml -f compose.production.yaml -f compose.email.yaml up -d --build
```

Email delivery history and retry state are persisted. Failed messages retry every minute, up to three attempts. A successful provider synchronization does not generate email. The `capture` transport exists only for automated tests and is rejected when `NODE_ENV=production`.

## SMS alert notifications

Urgent notifications can also be sent through an external SMS provider webhook. Configure `SMS_ALERTS_ENABLED=true`, E.164 numbers in `SMS_ALERT_RECIPIENTS`, an HTTPS `SMS_ALERT_WEBHOOK_URL`, and optionally `SMS_ALERT_WEBHOOK_TOKEN_FILE`. `SMS_ALERT_MIN_SEVERITY` defaults to `critical`, and cooldown/retry behavior prevents repeated delivery. Platform and support administrators can send a test message and inspect delivery status in **Administration → SMS alert notifications**. The `capture` transport is test-only and rejected in production.

For real customer/site assignment, configure a JSON business mapping before the pilot. The keys can be an AutoXing business ID or business name:

```bash
export AUTOXING_BUSINESS_MAP='{"AUTOXING_BUSINESS_ID":{"organizationId":"org-demo","operatorOrganizationId":"org-service","siteId":"site-berlin"}}'
export AUTOXING_REQUIRE_MAPPING=true
```

Optional model mapping is supported with `AUTOXING_MODEL_MAP`. When live mode is enabled, the server polls AutoXing at `AUTOXING_POLL_INTERVAL_MS`, records last-sync status/errors, retries a failed bridge call once, and imports online/offline, battery, version, mission, and error events when the wrapper provides them.

The Python environment must have the wrapper dependencies installed. If credentials or dependencies are missing, the live sync returns a clear `503` error; it does not silently create fake live data.

## CenoBots Open API integration

The CenoBots adapter supports live synchronization through Open API v1.0.16. Put the region host and credentials in the ignored root `.env`, set `CENOBOTS_LIVE=true`, and start the server normally. The server loads `.env` automatically and invokes `integrations/cenobots_bridge.py`, which converts provider responses into the same canonical robot boundary used by the AutoXing integration.

Use **Sync all robots**, the provider-specific **Sync CenoBots** button, or call `POST /api/v1/adapters/cenobots/sync`. The adapter discovers permitted device open IDs and imports robot information, online state, battery, position, mission status, maintenance details, and system errors. Mission scheduling and go-home/pause/continue/stop controls are separately restricted to platform/support administrators and remain disabled unless `CENOBOTS_COMMANDS_ENABLED=true`. Every live action requires exact robot confirmation and creates Passport/audit evidence.

CenoBots has its own dashboard tab with fleet totals, online/offline and charging KPIs, searchable live robot cards, version/map/mission status, maintenance and system-error attention items, and connector synchronization diagnostics. The tenant-scoped data is supplied by `GET /api/v1/cenobots/operations`.

The encrypted CenoBots webhook receiver is `POST /api/v1/webhooks/cenobots`. Configure the separate `CENOBOTS_WEBHOOK_SECRET`, publish the callback over HTTPS, and verify it in the CZ Robots company-administrator portal. Error, task, maintenance, and door-assistance messages are freshness-checked, AES-GCM authenticated, deduplicated, persisted, and added to the matching Robot Passport. The CenoBots workspace displays webhook readiness and receipt activity.

The browser includes a three-step robot onboarding wizard, searchable and actionable notification workflows, role-focused landing dashboards, English/German navigation, and operational reports with JSON/CSV export. The **Live Tracking** tab refreshes the unified, tenant-scoped AutoXing and CenoBots position feed every ten seconds, marks stale data, plots relative provider coordinates, and shows connection, movement, battery and task state. Robot-specific maintenance and compliance reports download as PDFs. The Support tab lets customer and robot accounts open tickets, follow the conversation, and add updates while service staff manage ticket status. Labour and parts pricing remains explicitly unavailable until cost fields are captured.

The fleet report now includes a composite health score, attention and low-battery counts, provider distribution, service-case closure rate, average resolution time, incidents per robot, and technician availability. The technician workspace includes availability status, working days, shift windows, daily capacity and estimated assignment load. Technicians on leave or off duty cannot receive new assignments.

Accessibility preferences are stored in the browser and provide larger text, extra-large text, high contrast and reduced motion. The interface also includes a skip link, visible focus indication, keyboard tab navigation, live-region updates, accessible chart summaries and responsive table alternatives.

Run `npm run test:e2e` for the automated browser-facing customer journey and performance budgets. It verifies login, static assets, support-ticket creation/replies, PDF download, concurrent API responses, a 1.5-second p95 response budget, and JavaScript/CSS size budgets. The same check is included in `npm test`.

CenoBots limits this account to less than one request per second, so calls are paced by `CENOBOTS_MIN_REQUEST_INTERVAL_SECONDS` (default `1.05`). Optional map, area, and mission-history collection is enabled with `CENOBOTS_RESOURCE_SYNC=true`; it is off by default to keep normal fleet synchronization fast.

Append an immutable Passport entry:

```bash
curl -X POST -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"maintenance","source":"service-demo","data":{"note":"Filter replaced"}}' \
  http://localhost:3000/api/v1/robots/ROBOT_ID/passport-entries
```

Create a robot-specific technical event:

```bash
curl -X POST -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Battery inspection completed","description":"Battery and charging dock inspected.","eventType":"inspection","sourceSystem":"manual-portal","severity":"info","occurredAt":"2026-07-27T14:00:00.000Z"}' \
  http://localhost:3000/api/v1/robots/ROBOT_ID/events
```

The browser form also accepts an optional attachment up to 2 MB. In PostgreSQL mode, attachment metadata is persisted in the database and content is stored in S3-compatible Object Storage.

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
- Server-side Robot Registry sorting and pagination with live-status filters
- Event filtering by robot, severity, type, and date, plus controlled attachment downloads
- Synchronization progress, elapsed time, partial/error feedback, and retry controls
- Automatic expired-session handling and duplicate robot validation
- Login throttling, upload allow-listing, request-size limits, safe public errors, and baseline HTTP security headers
- Production HTTPS enforcement, trusted-proxy handling, Host/Origin allow-lists, HSTS, cross-origin isolation headers, and mounted-secret validation
- Keyboard-accessible metric filters and responsive mobile layouts
- Stable JSON error responses
- PostgreSQL persistence with migrations and queryable core projections
- S3-compatible attachment storage with controlled downloads
- Durable PostgreSQL synchronization and email job queues
- Salted scrypt password hashes and hashed server-side session tokens
- HttpOnly SameSite session cookies with optional HTTPS-only mode
- Role-scoped operational notifications and SMTP email alerts
- Critical SMS webhook alerts with delivery history, cooldown and retries
- Container build, health check, persistent volume, and graceful shutdown
- Fleet-level AutoXing resource explorer and role-scoped task history
- Platform robot-account administration without password disclosure
- Robot Registry CSV export from the dashboard
- Role-controlled compatibility record editor
- Responsive role-scoped dashboard with keyboard navigation and remembered selection
- English/German language switch, customer support portal, and PDF maintenance/compliance exports
- Safety-gated CenoBots schedules and mission controls with exact-target confirmation
- Automated end-to-end workflow and performance budgets
- Unified ten-second fleet tracking and advanced operational analytics
- Technician skill/certificate matching with enforced robot assignment eligibility
- Technician shift, leave, availability and capacity planning
- Remembered text-size, contrast and reduced-motion accessibility controls
- Workforce assignment evidence in Robot Passports, audit history, notifications, and Outbox

## Container deployment

For a local container deployment:

```bash
docker compose up --build
```

The Compose configuration mounts a named volume for `/app/data`. For an internet-facing deployment, terminate TLS at a reverse proxy and set `ALTEGRO_ALLOWED_HOSTS` and `ALTEGRO_ALLOWED_ORIGINS` to the real public domain before applying `compose.production.yaml`. Production startup requires secure cookies, mounted secrets, PostgreSQL, object storage, Host/Origin allow-lists and HTTPS forwarding. Restrict network access and replace the prototype identity system before public launch.

## Intentionally not production-ready

PostgreSQL now stores durable state and queryable core projections, but the domain layer still maintains a process-local working set and currently supports a single web writer. The Outbox is persisted but does not yet have a transactional external publisher. The platform also does not yet implement OIDC, OpenAPI generation, signed Webhooks, distributed login throttling, or automatic object-retention policies. AutoXing and CenoBots can run through their configured read-only bridges, but production deployment still requires provider authorization, managed PostgreSQL/object storage, monitored backups, and restore drills.
