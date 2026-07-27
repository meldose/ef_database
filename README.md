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

Append an immutable Passport entry:

```bash
curl -X POST -H "Authorization: Bearer demo-technician" \
  -H "Content-Type: application/json" \
  -d '{"type":"maintenance","source":"service-demo","data":{"note":"Filter replaced"}}' \
  http://localhost:3000/api/v1/robots/ROBOT_ID/passport-entries
```

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
- Basic search/filtering
- Stable JSON error responses

## Intentionally not production-ready

The prototype uses in-memory state and demo bearer tokens. It does not yet implement PostgreSQL, OIDC, real Secret Management, Object Storage, OpenAPI generation, signed Webhooks, rate limiting, migrations, or a real AutoXing/CenoBots connection. Those are the next implementation steps for the production-oriented Phase 1 build.
