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
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/maintenance-schedules', expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }));
  });

  it('loads every registry page for Passport and scheduling selection', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'robot-1' }], pagination: { pageCount: 2 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'robot-2' }], pagination: { pageCount: 2 } })));
    expect((await api.robots()).data.map((robot) => robot.id)).toEqual(['robot-1', 'robot-2']);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/robots?page=2&pageSize=100&sort=updatedAt&order=desc', expect.objectContaining({ credentials: 'include' }));
  });

  it('encodes Passport and support reply identifiers', async () => {
    await api.passport('robot/one'); await api.replyTicket('ticket/one', { message: 'Checked', status: 'resolved' });
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/robots/robot%2Fone/passport', expect.anything());
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/support/tickets/ticket%2Fone/messages', expect.objectContaining({ method: 'POST' }));
  });
});
