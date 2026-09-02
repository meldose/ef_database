# Altegro frontend design system

The typed frontend uses a small operational design system. It favors clarity, evidence and safe progressive disclosure over dashboard density.

## Tokens

| Token | Purpose |
|---|---|
| `--ink` | Primary text and the Altegro mark |
| `--muted` | Supporting copy and metadata |
| `--canvas` / `--panel` | Page and content surfaces |
| `--line` | Boundaries, tables and focus context |
| `--accent` / `--accent-soft` | Navigation, links and non-semantic brand emphasis |
| `--good` | Confirmed healthy/online state |
| `--warn` | Attention or degraded state |

Never use the brand pink to communicate success or failure. Operational status must retain semantic text in addition to color.

## Components

- **Workspace navigation:** destinations are filtered for comprehension, but backend permissions remain authoritative.
- **Metric:** one value, one label and one actionable interpretation; no decorative charts without a decision use.
- **Record list:** consistent robot/provider identity, state and supporting metadata.
- **Panel:** one user task or evidence group. Implementation diagnostics belong in the Integrations workspace.
- **Banner:** recoverable page-level error with a retry action.
- **Empty state:** explains whether there is no data, no permission or a migration handoff.

## Interaction rules

- Keep the role's two most likely actions visible and place specialist actions behind progressive disclosure.
- Every request has loading, empty, success and recoverable error behavior.
- Do not infer authorization from hidden controls.
- Do not expose provider secrets, raw protected diagnostics or command controls in customer workspaces.
- Support keyboard navigation, visible focus, 200% text zoom, reduced motion and phone layouts.
- Do not add live robot commands to the Phase 1 typed frontend.

## Verification

Role navigation is unit-tested in `lib/navigation.test.ts`. The production container runs strict TypeScript, unit tests and the optimized Next.js build. Each migrated journey must also join the root end-to-end and accessibility checks before legacy cutover.
