# Altegro typed frontend

This is the incremental Next.js/React/TypeScript replacement for the legacy `public/` operations portal. It intentionally starts with the authenticated shell, role-scoped navigation, fleet priorities, Registry summary, and provider health. Unmigrated pages link back to the existing portal until parity and acceptance tests are complete.

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

Design tokens, component rules and acceptance requirements are documented in `DESIGN_SYSTEM.md`.
