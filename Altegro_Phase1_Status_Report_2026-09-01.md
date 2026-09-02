# Altegro Phase 1 Status Report

**Date:** 1 September 2026  
**Repository:** `ef_database` at commit `9965715` plus the working changes described below  
**Supersedes:** `Altegro_Phase1_Status_Report_2026-07-30.md`

## Executive summary

Altegro has progressed from an in-memory demonstrator to a broad production-oriented prototype. PostgreSQL persistence, S3-compatible attachments, durable provider jobs, monitoring, TLS deployment overlays, provider bridges, role-scoped operations, support workflows, workforce planning, notifications, reports and an OpenAPI contract now exist.

This update also introduces four focused improvements:

1. simpler progressive navigation and a compact secondary-action menu in the existing portal;
2. an incremental Next.js 16, React 19 and strict TypeScript frontend replacement;
3. vendor-neutral CRM and external service reference adapters, including safe readiness reporting and signed service webhooks;
4. current documentation that distinguishes implemented, partially implemented and externally blocked work.

The platform is still a prototype and must not be presented as an accepted production Phase 1 release. OIDC/SSO, multi-instance database authority, transactional event publication, provider/customer authorization, restore evidence and an external security review remain release blockers.

## Current capability status

| Area | Status | Evidence and remaining gap |
|---|---|---|
| Role-focused portal | Implemented | Backend permissions, role-specific views, progressive primary/secondary navigation and task-oriented actions exist. Formal usability testing remains. |
| Typed frontend | In migration | `frontend/` provides a strict TypeScript Next.js shell, login/session flow, role navigation, fleet priorities, robot list and integration health. Legacy pages remain until parity tests pass. |
| Robot Registry and Passport | Implemented prototype | Canonical robot IDs, External Identities, lifecycle evidence, exports and Passport history exist. Configurable completeness policy and correction references remain. |
| PostgreSQL and Object Storage | Partially production-ready | Durable snapshots, projections, jobs and S3 attachments exist. The domain still keeps a process-local working set and supports one web writer. |
| AutoXing | Implemented, external validation pending | Read-only bridge, status/events/resources, diagnostics and polling exist. Production authorization, contract evidence and customer mapping validation remain. |
| CenoBots | Implemented, external validation pending | Open API bridge, encrypted webhooks, telemetry and diagnostics exist. Production credential, rate-limit and data-right validation remain. Live commands are separately gated and are not part of Phase 1 acceptance. |
| CRM reference adapter | Implemented contract, provider selection pending | Generic HTTPS/Bearer adapter normalizes organizations, sites, Customer IDs and account ownership. A selected CRM endpoint and credentials are still required. |
| Service reference adapter | Implemented contract, provider selection pending | Generic adapter normalizes service cases and maps statuses; signed, replay-window-protected and idempotent webhooks link cases to robots and Passport history. A selected service provider and contract test are still required. |
| API documentation | Implemented baseline | `/openapi.json` and `/docs` include core synchronization and enterprise integration routes. Automatic code-first generation, quotas and deprecation automation remain. |
| Deployment and monitoring | Implemented baseline | Container, TLS proxy, Prometheus configuration, readiness checks and GitHub deployment workflow exist. Managed infrastructure and restore drills remain. |
| Identity | Prototype only | Hashed local passwords and server-side sessions are safer than demo tokens, but binding requirements call for OIDC/SSO, MFA and database memberships. |

## User-experience changes in this update

- Primary workspaces stay visible while tracking, provider diagnostics, reporting and administration are progressively disclosed through **More workspaces**.
- The Overview keeps only the two most important actions visible; exports, provider-specific synchronization, technician access and dashboard customization move to **More actions**.
- Direct URLs and keyboard tab navigation continue to work for disclosed role-authorized pages.
- The typed frontend uses a sidebar with only role-appropriate destinations and shows operational priorities before implementation-level diagnostics.
- Unmigrated typed-frontend pages link to the corresponding stable legacy workspace rather than presenting incomplete controls.

## Enterprise integration contract

### CRM

The reference adapter accepts a JSON array (directly or under `data`, `items`, `records` or `results`) and normalizes:

- external Customer ID,
- organization name and type,
- account owner,
- organization status,
- sites, countries and time zones.

Synchronization is idempotent by tenant plus the generic `crm-reference` External Identity. Provider IDs never become Altegro primary keys.

### External service system

The reference adapter normalizes provider ticket states to `open`, `in_progress`, `waiting`, `resolved` and `closed`. Records link to robots by serial number or existing provider identity. New cases and status changes append Passport and Outbox evidence.

Inbound service webhooks require:

- `x-altegro-event-id`,
- `x-altegro-timestamp`,
- `x-altegro-signature = HMAC-SHA256(secret, "<timestamp>.<raw JSON body>")`.

The server checks freshness, signature integrity, duplicate event IDs and robot matching. Unmatched events return `202` and remain visible as integration warnings.

## Production release blockers

1. Replace local human passwords with an approved OIDC/OAuth 2.1 provider and require MFA for privileged roles.
2. Remove the process-local authoritative working set so multiple web instances can safely write through PostgreSQL.
3. Publish the transactional Outbox through a durable worker with retry and dead-letter handling.
4. Obtain written production authorization, sandbox evidence, credentials, rate limits and data rights for AutoXing and CenoBots.
5. Select the CRM and service providers, map their real payloads and pass provider-specific contract tests.
6. Keep physical robot command capabilities outside Phase 1 acceptance and disabled in customer environments.
7. Complete backup restoration, credential revocation, integration failure and incident-response drills in staging.
8. Complete tenant-isolation testing, external penetration testing and privacy/retention approval.
9. Validate the typed frontend with customer, technician, support and administrator acceptance journeys before replacing the legacy portal.

## Recommended next sequence

1. Confirm the CRM and service-system vendors and provide sandbox credentials.
2. Run adapter contract fixtures against real sanitized payloads.
3. Complete the Registry, Passport and Support journeys in the typed frontend.
4. Add OIDC to backend and typed frontend, followed by MFA and database memberships.
5. Make PostgreSQL authoritative and prove two-instance concurrency.
6. Deploy staging in the approved EU region and run backup/restore and security tests.
7. Pilot read-only synchronization with 30–50 robots and 5–10 customers.

## Verification results for this update

- Root syntax and complete prototype test suite: passed.
- Enterprise adapter unit/contract tests: passed.
- Next.js production build under Node 22: passed.
- Strict frontend TypeScript check: passed.
- Frontend role-navigation unit tests: 3 passed.
- OpenAPI and accessibility contract checks: passed.
- Browser-facing workflow and performance budgets: passed; measured p95 was 143.7 ms against the 1.5-second budget.
- Python CenoBots tests: 27 passed.
- `git diff --check`: passed.

Live CRM, service, AutoXing and CenoBots validation could not be performed without the selected providers' approved endpoints, credentials and data-right authorization.
