'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { MaintenanceSchedule, OperationalNotification, RobotSummary, SessionUser } from '@/lib/types';

interface Props {
  robots: RobotSummary[];
  user: SessionUser;
  onUnreadChange: (count: number) => void;
  onDataChanged: () => void;
}

export function AlertsMaintenance({ robots, user, onUnreadChange, onDataChanged }: Props) {
  const [notifications, setNotifications] = useState<OperationalNotification[]>([]);
  const [schedules, setSchedules] = useState<MaintenanceSchedule[]>([]);
  const [canManageSchedules, setCanManageSchedules] = useState(false);
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const canManageAlerts = user.permissions.includes('notification.manage');
  const autoXingRobots = useMemo(() => robots.filter((robot) => robot.externalIdentities?.some((identity) => identity.system === 'autoxing')), [robots]);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError('');
    try {
      const [notificationResult, scheduleResult] = await Promise.all([api.notifications(), api.maintenanceSchedules()]);
      setNotifications(notificationResult.data);
      setSchedules(scheduleResult.data);
      setCanManageSchedules(scheduleResult.permissions.manage);
      onUnreadChange(notificationResult.unreadCount);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Operational alerts could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [onUnreadChange]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(false), 30000);
    return () => window.clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => notifications.filter((item) => {
    const text = `${item.title} ${item.message} ${item.type}`.toLowerCase();
    return (!query || text.includes(query.toLowerCase())) && (!severity || item.severity === severity);
  }), [notifications, query, severity]);

  async function updateAlert(item: OperationalNotification, status: 'acknowledged' | 'resolved') {
    setSaving(true); setError('');
    try { await api.updateNotification(item.id, status); await load(false); onDataChanged(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Alert could not be updated'); }
    finally { setSaving(false); }
  }

  async function markAllRead() {
    const ids = notifications.filter((item) => !item.read).map((item) => item.id);
    if (!ids.length) return;
    setSaving(true);
    try { await api.markNotificationsRead(ids); await load(false); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Alerts could not be marked as read'); }
    finally { setSaving(false); }
  }

  async function createSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget; const data = new FormData(form);
    setSaving(true); setError('');
    try {
      await api.createMaintenanceSchedule({
        robotId: String(data.get('robotId')),
        title: String(data.get('title')),
        nextDueAt: new Date(String(data.get('nextDueAt'))).toISOString(),
        intervalDays: Number(data.get('intervalDays')),
        reminderDays: Number(data.get('reminderDays')),
        priority: String(data.get('priority')) as MaintenanceSchedule['priority'],
        description: String(data.get('description') || '')
      });
      form.reset(); await load(false); onDataChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Maintenance could not be scheduled'); }
    finally { setSaving(false); }
  }

  async function updateSchedule(schedule: MaintenanceSchedule, action: 'complete' | 'toggle') {
    setSaving(true); setError('');
    try {
      if (action === 'complete') await api.updateMaintenanceSchedule(schedule.id, { complete: true, completionNote: 'Scheduled maintenance completed from the typed Altegro workspace.' });
      else await api.updateMaintenanceSchedule(schedule.id, { status: schedule.status === 'active' ? 'paused' : 'active' });
      await load(false); onDataChanged();
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Maintenance schedule could not be updated'); }
    finally { setSaving(false); }
  }

  if (loading) return <section className="panel empty" aria-live="polite">Loading alerts and maintenance…</section>;
  const overdue = schedules.filter((item) => item.dueState === 'overdue').length;
  const failures = notifications.filter((item) => ['error', 'critical'].includes(item.severity) && item.workflow.status !== 'resolved').length;
  return <div className="stack">
    {error && <div className="banner error" role="alert">{error}<button onClick={() => void load()}>Retry</button></div>}
    <section className="metrics">
      <article className="metric attention"><span>Active failures</span><strong>{failures}</strong><small>Error and critical alerts</small></article>
      <article className="metric"><span>Unread alerts</span><strong>{notifications.filter((item) => !item.read).length}</strong><small>Personal read status</small></article>
      <article className="metric attention"><span>Overdue service</span><strong>{overdue}</strong><small>Scheduled maintenance</small></article>
      <article className="metric good"><span>Active schedules</span><strong>{schedules.filter((item) => item.status === 'active').length}</strong><small>Recurring maintenance plans</small></article>
    </section>
    <section className="panel">
      <div className="panel-title"><div><p className="eyebrow">Automatic monitoring · 30-second refresh</p><h2>Failure alerts</h2></div><button className="quiet" disabled={saving} onClick={() => void markAllRead()}>Mark all read</button></div>
      <div className="filters"><label>Search<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Robot, failure or source" /></label><label>Severity<select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="">All severities</option><option value="critical">Critical</option><option value="error">Error</option><option value="warning">Warning</option><option value="info">Information</option></select></label></div>
      <div className="alert-list">{visible.map((item) => <article className={`alert severity-${item.severity} ${item.read ? 'read' : ''}`} key={item.id}><span className="alert-marker" /><div><div className="record-heading"><strong>{item.title}</strong><span>{item.severity}</span></div><p>{item.message}</p><small>{item.type.replaceAll('_', ' ')} · {new Date(item.occurredAt).toLocaleString()} · {item.workflow.status}</small></div>{canManageAlerts && item.workflow.status !== 'resolved' && <div className="record-actions">{item.workflow.status === 'open' && <button disabled={saving} onClick={() => void updateAlert(item, 'acknowledged')}>Acknowledge</button>}<button disabled={saving} onClick={() => void updateAlert(item, 'resolved')}>Resolve</button></div>}</article>)}</div>
      {!visible.length && <p className="empty">No alerts match these filters.</p>}
    </section>
    <section className="panel">
      <div className="panel-title"><div><p className="eyebrow">Preventive service</p><h2>Scheduled maintenance</h2></div><span>{schedules.length} schedules</span></div>
      {canManageSchedules && <form className="schedule-form" onSubmit={createSchedule}>
        <label>AutoXing robot<select name="robotId" required defaultValue=""><option value="" disabled>Select robot</option>{autoXingRobots.map((robot) => <option value={robot.id} key={robot.id}>{robot.serialNumber}</option>)}</select></label>
        <label>Service title<input name="title" required maxLength={160} placeholder="Quarterly inspection" /></label>
        <label>Next due<input name="nextDueAt" type="datetime-local" required defaultValue={new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16)} /></label>
        <label>Repeat every (days)<input name="intervalDays" type="number" required min={1} max={730} defaultValue={90} /></label>
        <label>Reminder (days)<input name="reminderDays" type="number" required min={1} max={90} defaultValue={7} /></label>
        <label>Priority<select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="critical">Critical</option></select></label>
        <label className="wide">Description<textarea name="description" maxLength={2000} placeholder="Inspection scope and safety notes" /></label>
        <button disabled={saving || !autoXingRobots.length}>{saving ? 'Saving…' : 'Create schedule'}</button>
        {!autoXingRobots.length && <small>No visible AutoXing robot is available for scheduling.</small>}
      </form>}
      <div className="schedule-list">{schedules.map((schedule) => <article key={schedule.id}><div><div className="record-heading"><strong>{schedule.title}</strong><span className={`state-${schedule.dueState}`}>{schedule.reminderState.replaceAll('_', ' ')}</span></div><p>{schedule.robotSerialNumber} · due {new Date(schedule.nextDueAt).toLocaleString()} · every {schedule.intervalDays} days</p><small>Reminder {schedule.reminderDays} days before · {schedule.technicianName || 'unassigned'} · {schedule.priority} priority</small></div>{canManageSchedules && schedule.status !== 'cancelled' && <div className="record-actions"><button disabled={saving} onClick={() => void updateSchedule(schedule, 'complete')}>Complete</button><button disabled={saving} onClick={() => void updateSchedule(schedule, 'toggle')}>{schedule.status === 'active' ? 'Pause' : 'Resume'}</button></div>}</article>)}</div>
      {!schedules.length && <p className="empty">No recurring maintenance has been scheduled.</p>}
    </section>
  </div>;
}
