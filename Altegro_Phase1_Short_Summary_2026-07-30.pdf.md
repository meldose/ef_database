# Altegro Phase 1 - Simple Status Summary

**Date:** 30 July 2026

## Where we are now

The website is a working prototype. It can register and display robots, synchronize read-only AutoXing data, show Robot Passports, create events and incidents, track service cases, store lifecycle evidence, show compatibility information and export data.

It is not ready for real customers yet because the data is stored only in memory. Restarting Node removes newly created data and accounts.

## What is already working

- Every robot receives a unique Altegro Robot ID.
- Users can only see robots allowed for their account.
- AutoXing robots can be synchronized in read-only mode.
- Robot status, battery, errors, tasks, maps and safety states can be displayed when available.
- Robot Passports contain events, documents, certificates, deployments and service history.
- Incidents can become service cases and completed service work is added to the Passport.
- Robot, Passport and tenant information can be exported.
- Robot movement and other remote commands are blocked.
- Automated prototype tests pass.

## What is still missing

- PostgreSQL so information survives server restarts.
- OIDC/SSO login, MFA and real user permissions.
- Secure Object Storage for documents and certificates.
- Durable audit records, Transactional Outbox and background jobs.
- AutoXing WebSocket events and production retry/rate-limit handling.
- Live CenoBots synchronization.
- A real CRM connection for customer information.
- A real service/ticket-system connection.
- OpenAPI documentation, API scopes, quotas and signed webhooks.
- EU staging deployment, backups, monitoring and restore tests.
- Security scans and an external penetration test.

## What we should do next

1. Add PostgreSQL and database migrations.
2. Add OIDC login and database-backed permissions.
3. Move files and certificates to secure Object Storage.
4. Finish AutoXing and connect CenoBots, CRM and service adapters.
5. Deploy to EU staging and complete backup, isolation and security tests.

## When Phase 1 is complete

- 30-50 real robots from AutoXing and CenoBots are registered.
- At least 80 percent of the robots have complete Passports.
- CRM synchronization works without duplicate customers.
- At least 20 real service cases are connected to Robot Passports.
- Tenant separation, export, credential revocation and backup restoration are proven.
- An external security review has no unresolved critical findings.

## Simple conclusion

The website demonstrates the correct idea and main workflows. The next step is not more visual design. The next step is persistent storage, real authentication and secure external integrations so the prototype can become a customer-ready Phase 1 system.
