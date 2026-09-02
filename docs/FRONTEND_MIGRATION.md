# Frontend migration plan

The `frontend/` Next.js application replaces the legacy `public/` portal one accepted journey at a time. Running both during migration avoids a high-risk all-at-once rewrite.

## Journey order

1. Authentication shell and role navigation — implemented.
2. Fleet overview and provider health — implemented.
3. Registry search, pagination and Passport detail.
4. Technical events, service cases and customer support.
5. Technician qualifications and work orders.
6. Reports, controlled exports and audit.
7. Provider diagnostics and administration.

Each migrated journey requires API types, loading/empty/error states, keyboard coverage, responsive behavior and acceptance tests for every allowed role. Backend permission checks remain authoritative.

## Cutover rule

Do not remove a legacy page until the typed equivalent passes the existing end-to-end journey, accessibility checks and the JavaScript performance budget. Robot commands are excluded from the Phase 1 frontend.
