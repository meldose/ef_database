import { describe, expect, it } from 'vitest';
import { legacyWorkspacePath, navigationForRole } from './navigation';

describe('role navigation', () => {
  it('keeps provider and administration diagnostics away from customers', () => {
    const destinations=navigationForRole('owner').map((item) => item.id);
    expect(destinations).toContain('robots');
    expect(destinations).not.toContain('integrations');
    expect(destinations).not.toContain('administration');
  });

  it('shows integration and administration workspaces to platform administrators', () => {
    const destinations=navigationForRole('platform_admin').map((item) => item.id);
    expect(destinations).toContain('integrations');
    expect(destinations).toContain('administration');
  });

  it('maps the service workspace to the established legacy route', () => {
    expect(legacyWorkspacePath('service')).toBe('/dashboard/operations');
    expect(legacyWorkspacePath('reports')).toBe('/dashboard/reports');
  });
});
