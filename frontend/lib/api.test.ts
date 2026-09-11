import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, withQuery } from './api';

describe('typed operations API', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: {}, facets: {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('encodes non-empty audit filters without leaking empty values', () => {
    expect(withQuery('/api/v1/audit', { q: 'robot failure', result: '', limit: 100 }))
      .toBe('/api/v1/audit?q=robot+failure&limit=100');
  });

  it('requests the selected analytics period with the authenticated session', async () => {
    await api.operationsReport(90);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/reports/operations?days=90', expect.objectContaining({ credentials: 'include' }));
  });

  it('sends encoded alert workflow updates', async () => {
    await api.updateNotification('event:robot/one', 'acknowledged');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/notifications/event%3Arobot%2Fone', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'acknowledged' }) }));
  });

  it('creates recurring maintenance through the guarded endpoint', async () => {
    const input = { robotId: 'robot-1', title: 'Quarterly inspection', nextDueAt: '2026-10-01T08:00:00.000Z', intervalDays: 90, reminderDays: 7, priority: 'high' as const };
    await api.createMaintenanceSchedule(input);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/autoxing/maintenance-schedules', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
  });
});
