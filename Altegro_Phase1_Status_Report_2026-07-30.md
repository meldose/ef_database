# Altegro Phase 1 Status Report

**Date:** 30 July 2026  
**Scope:** Current `ef_database` prototype compared with the binding developer briefing and Phase 1 technical specification.

## Executive summary

The current Altegro website is a functional demonstrator of the intended Phase 1 domain. It proves immutable Altegro Robot IDs, a manufacturer-neutral Registry, basic Passport history, normalized events, read-only OEM synchronization, robot-scoped access, incident and service workflows, lifecycle evidence, compatibility records, controlled exports, and a visible command safety boundary.

It is not yet a production-ready Phase 1 release. The largest gap is the technical foundation: all business data and credentials remain in memory, authentication is demo-only, attachments are not stored in Object Storage, and audit/Outbox records are not durable. Live CenoBots, CRM and external service-system adapters are also incomplete. Public API contracts, staging, backup/restore evidence, and the required security review remain outstanding.

## Source documents

- `Altegro_Projektbriefing_Entwickler.md`, dated 27 July 2026.
- `Altegro_Technisches_Lastenheft_Phase_1.md`, dated 23 July 2026.
- `Altegro_Business_Model_Platform_2037.md`, dated 21 July 2026.

## Changes implemented in the current prototype

### Robot Registry and identity

- Generates a non-reused UUID as the Altegro Robot ID.
- Stores serial number, model, tenant, customer organization, operator and site.
- Keeps OEM IDs as generic External Identities rather than primary keys.
- Supports manual registration and adapter-based registration.
- Provides robot search and status filtering.
- Provides robot-scoped logins so assigned users only see their permitted robots.
- Keeps commands disabled at the backend boundary.

### AutoXing integration

- Connects to the separate AutoXing Python wrapper through a read-only bridge.
- Synchronizes robot identity, serial number, model, online status and battery.
- Maps charging state, position, speed, emergency stop, obstruction and detailed errors when supplied.
- Can synchronize POIs, areas, maps, task history and task status as optional resources.
- Creates canonical status, mission, error and safety events.
- Shows adapter status, last synchronization and provider errors.
- Supports configured business-to-organization/site mapping.
- Keeps all movement, navigation, mission and control capabilities disabled.

### Robot Passport and lifecycle evidence

- Shows current robot identity, owner, operator, site and external identity.
- Maintains append-only prototype Passport entries.
- Creates configuration snapshots during synchronization.
- Supports manual technical events with title, description, severity and timestamp.
- Supports optional event attachments with file size and SHA-256 hash.
- Supports lifecycle documents, certificate issuer/expiry records and deployment evidence.
- Records deployment version, verification state and rollback version.
- Calculates a prototype Passport-completeness score.
- Exports an individual Passport as JSON.

### Incident and service workflow

- Opens an incident against a selected robot.
- Creates a linked service case and Passport evidence.
- Supports open, in-progress, waiting, resolved and closed states.
- Records cause, corrective action, assigned party and replaced parts through the API.
- Creates a service-completion Passport entry when a case closes.
- Creates a normalized service-completed event.

### Compatibility, operations and proof reporting

- Stores model/capability/version compatibility records.
- Marks command compatibility as blocked for Phase 1.
- Shows online robots, open service cases, Passport completeness and certificates due.
- Shows recent canonical technical events and adapter capabilities.
- Provides Robot Registry CSV, Passport JSON and tenant JSON exports.
- Audits export requests.
- Includes a read-only auditor account for Passport, certificate and service evidence.
- Creates prototype Outbox records for lifecycle and service changes.

### Frontend and verification

- Provides a responsive operations portal and login page.
- Uses a pink-and-black visual theme while preserving semantic green, amber and red states.
- Includes frontend forms for robot registration, technical events, incidents and lifecycle evidence.
- Includes automated tests for authentication, robot isolation, command rejection, lifecycle records, service completion, compatibility, exports, auditor restrictions and Outbox creation.
- The current automated test suite passes.

## Phase 1 requirements still missing

### 1. Production architecture and persistence

- Replace plain JavaScript prototype structure with the approved strict TypeScript modular-monolith structure using Next.js and NestJS.
- Introduce PostgreSQL as the transactional system of record.
- Create versioned migrations, constraints, foreign keys, indexes and optimistic-locking fields.
- Persist tenants, organizations, sites, users, memberships, robots, External Identities, Passport entries, events, service cases, compatibility, deployments, documents, audit and Outbox records.
- Introduce S3-compatible Object Storage for documents and certificates.
- Implement encrypted backups and prove restoration in a separate environment.

### 2. Identity and access management

- IAM-001: replace demo passwords with OIDC/SSO; Altegro must not store human passwords.
- IAM-002: bind every request to a verified user/service account and tenant.
- IAM-003/004/006/008: implement and automatically test the full role/permission matrix with organization, site, robot and service-assignment scope.
- IAM-005: create service accounts with scopes, expiry, revocation and rotation.
- IAM-009: implement justified, time-limited support access with automatic expiry and customer-visible audit.
- Enable MFA for privileged users through the selected Identity Provider.

### 3. Registry and Passport completion

- ORG-001 to ORG-004: implement real organization/site administration and idempotent CRM ownership synchronization.
- REG-003/005/006: enforce required assignments, duplicate-review workflow and controlled status transitions.
- REG-007: add pagination and prove search performance against 100,000 synthetic robots.
- REG-008: add repeatable CSV import with row-level error reporting.
- PAS-002/003: persist append-only history and make corrections reference the original record.
- PAS-004/005: implement real document versioning, access control, Object Storage and certificate notifications.
- PAS-006: make Passport-completeness rules configurable and tested.
- PAS-007: add controlled PDF export with export timestamp and verification statement.

### 4. OEM adapters

- INT-001 to INT-009: formalize the shared pull/webhook/import adapter contract, idempotency, retries, rate-limit handling, dead-letter processing, capability manifests, synthetic fixtures and contract tests.
- INT-010: add AutoXing WebSocket events behind the same canonical interface as REST polling.
- INT-011: connect the existing CenoBots client to the server and validate official credentials, sandbox, rate limits, version policy and data rights.
- INT-012: continue to keep all command capabilities separate and disabled.

### 5. CRM and service-system adapters

- Connect one approved CRM reference adapter for Customer ID, organization and account ownership.
- Make CRM changes idempotent and prevent duplicate customer records.
- Connect one approved external service-system adapter.
- Map provider ticket states to open, in-progress, waiting, resolved and closed.
- Process signed, replay-protected and idempotent service webhooks.
- Prove that a second mock service provider passes the same contract tests without Passport-core changes.

### 6. Events, audit and jobs

- EVT-001/002: validate all canonical event envelopes against versioned schemas.
- EVT-003: implement a real PostgreSQL Transactional Outbox so business changes and events commit together.
- EVT-004/005: store immutable, tamper-resistant audit records outside normal user modification paths.
- Add persistent background workers, exponential backoff, retry controls and dead-letter handling.
- Add tenant/site filters and data-freshness monitoring to the operations dashboard.

### 7. Public API and developer experience

- API-001: publish versioned Registry, Passport, Provider, Adapter and Event APIs.
- API-002: implement client scopes, quotas, expiry and rate limits.
- API-003: add backward-compatibility contract tests and a deprecation policy.
- API-004: implement signed, replay-protected and idempotent webhooks.
- API-005: provide Developer documentation, changelog, status and sandbox access.
- API-006: provide an Adapter SDK, schemas, test harness, example adapter and certification test.
- API-007: meter usage by client, tenant, provider and endpoint.
- API-008: translate provider failures into stable Altegro error codes while protecting original diagnostics.
- API-009: add controlled API-key creation and rotation if capacity permits.

### 8. Security, privacy and operations

- Meet OWASP ASVS 5.0 Level 2 for the web/API core.
- Apply the NIST SSDF development controls and maintain the implementation threat model.
- Require HTTPS/TLS externally and encryption at rest.
- Store secrets in an approved Secret Manager and apply automatic credential rotation.
- Add dependency, secret, SAST and container scans as release gates.
- Produce an SBOM and signed release artifact for every release.
- Complete incident, credential-revocation, restore and integration-failure runbooks.
- Define retention, export, deletion, legal-hold and data-right rules for every data class.
- Deploy in an approved EU cloud region with documented subprocessors.
- Complete an external security review and penetration test before a customer pilot.

## Required organizational decisions

- Name the Product Owner and technical lead.
- Select the first real AutoXing and CenoBots models.
- Select the initial 10-15 robots and five pilot customers.
- Select the first CRM and service-system adapters.
- Approve the formal role/permission matrix.
- Define required Passport documents and certificates.
- Select cloud provider, EU region and OIDC Identity Provider.
- Confirm Git/CI, container hosting and staging ownership.
- Confirm OEM credentials, sandbox access, rate limits and data rights.
- Assign pilot support, Incident Commander, Data Owner and liability responsibilities.

## Recommended implementation sequence

1. Freeze the canonical database/API schemas and approved role matrix.
2. Introduce PostgreSQL, migrations, durable audit and Transactional Outbox.
3. Introduce OIDC, MFA, memberships and service accounts.
4. Move documents and certificates to S3-compatible Object Storage.
5. Complete Registry administration, duplicate handling and Passport rules.
6. Harden AutoXing with persistent jobs, contract tests, rate limits and WebSocket events.
7. Connect and validate live CenoBots read-only synchronization.
8. Implement CRM and external service-system reference adapters.
9. Publish OpenAPI/AsyncAPI, API client controls, signed webhooks and the Adapter SDK.
10. Deploy staging, run load/restore/isolation tests and complete the external security review.

## Phase 1 pilot acceptance still to prove

- Register 30-50 real robots from AutoXing and CenoBots.
- Ensure no active robot lacks an Altegro Robot ID or tenant assignment.
- Achieve at least 80 percent complete Passports across the proof fleet.
- Synchronize CRM Customer ID and Altegro tenant without manual duplicates.
- Link at least 20 real external service cases to Robot Passports.
- Demonstrate comparable normalized events from two OEM sources.
- Prove tenant isolation with automated negative tests.
- Demonstrate restore, tenant export and credential revocation.
- Complete an external security review with no unresolved critical findings.
- Onboard an already supported robot in under four engineering hours.
- Certify a third mock OEM using only the Adapter SDK, without changing the Altegro core.

## Current conclusion

The current implementation is a strong functional prototype and demonstrates the correct product direction. It must not yet be treated as a production Phase 1 release because persistence, identity, external adapters, durable audit/event processing, API governance, operational recovery and security assurance are incomplete. The immediate next milestone should be a PostgreSQL- and OIDC-backed staging thin slice using real pilot organizations, sites and robots.
