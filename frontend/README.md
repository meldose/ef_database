# Altegro typed frontend

This is the incremental Next.js/React/TypeScript replacement for the legacy `public/` operations portal. It includes the authenticated shell, role-scoped navigation, fleet priorities, Registry and provider summaries, advanced operational analytics, predictive-maintenance insights, automatic failure alerts, recurring maintenance scheduling, and searchable/exportable audit evidence. Unmigrated pages link back to the existing portal until parity and acceptance tests are complete.

```bash
npm install
npm test
npm run dev
```

The frontend listens on port `3001` and proxies `/api/*` to `http://127.0.0.1:3000`. Set `ALTEGRO_API_ORIGIN` when the backend uses another internal address.

The production build requires Node.js 20.9 or newer. A Node 22 multi-stage `Dockerfile` is included so the build does not depend on an older host Node installation.

Migration rules:

- Keep API types in `lib/types.ts`; do not read provider-specific payloads in UI components.
- Enforce authorization on the backend; role-scoped navigation is only progressive disclosure.
- Migrate one complete user journey at a time and retain a link to the legacy page until acceptance tests pass.
- Do not add robot command controls to the Phase 1 frontend.

Implemented operational journeys:

- **Reports:** 7/30/90-day fleet, task, service and workforce analytics, daily event trends, predictive risk, and CSV/JSON export.
- **Events & service:** automatically refreshed failure notifications with read, acknowledge and resolve workflows.
- **Robot Passport:** searchable complete registry, identity/configuration, lifecycle timeline, documents and safe downloads, certificates, deployments, service cases, workforce requirements, compatibility and PDF/JSON reports.
- **Support:** role-controlled ticket creation, searchable tickets, conversations, staff status changes and attachments (maximum 2 MB) with authorized downloads.
- **Technicians:** seven-day calendar, qualified visit scheduling, conflict rejection, completion notes, availability and skill/certificate administration.
- **Scheduled maintenance:** recurring maintenance for all robot brands with reminder lead time, pause/resume, completion and Passport/audit evidence. The original AutoXing API remains available.
- **Fleet comparison:** site/provider grouping and equal-length current/previous reporting periods; current fleet snapshots are explicitly distinguished from historical event/service metrics.
- **Audit log:** server-filtered action, actor, result, object and date evidence with permission-controlled CSV export.

Design tokens, component rules and acceptance requirements are documented in `DESIGN_SYSTEM.md`.

Browser verification (Node 22):

```bash
npm ci
npx playwright install --with-deps chromium
npm run build
npm run test:browser
```

The 16 desktop/mobile Chromium scenarios use password sign-in and an isolated in-memory, mock-provider backend. Ports 3000/3001 must be free; existing servers are never reused. Failed tests retain screenshots/traces. CI requires these tests before publishing the backend image. No tests access the production website.

For older host Node installations, build from the repository root using `docker build -f frontend/Dockerfile.browser -t altegro-browser-tests .`, then `docker run --init --shm-size=1g altegro-browser-tests`.
