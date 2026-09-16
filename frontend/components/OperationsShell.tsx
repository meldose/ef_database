'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { legacyWorkspacePath, navigationForRole, type Workspace } from '@/lib/navigation';
import type { AdapterSummary, OperationsSummary, RobotSummary, SessionUser } from '@/lib/types';
import { AdvancedAnalytics } from '@/components/AdvancedAnalytics';
import { AlertsMaintenance } from '@/components/AlertsMaintenance';
import { AuditLog } from '@/components/AuditLog';
import { RobotPassport } from '@/components/RobotPassport';
import { SupportPortal } from '@/components/SupportPortal';
import { TechnicianCalendar } from '@/components/TechnicianCalendar';
import { FleetComparison } from '@/components/FleetComparison';
import { ScheduledReports } from '@/components/ScheduledReports';
import { useI18n } from '@/lib/i18n';

function Login({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const { locale,setLocale,t }=useI18n();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      const result = await api.login(String(data.get('email')), String(data.get('password')));
      onLogin(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-layout" id="main-content"><a className="skip-link" href="#login-form">{t('Skip to main content')}</a>
      <section className="login-card">
        <div className="brand"><span>A</span><strong>altegro</strong></div>
        <p className="eyebrow">Secure platform access</p>
        <h1>Sign in to Altegro</h1>
        <p>Open the workspace for your organization, role and assigned robots.</p>
        <form onSubmit={submit} id="login-form" aria-busy={busy}>
          <label>Email<input name="email" type="email" autoComplete="username" required /></label>
          <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
          <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
        <footer className="legal-links"><a href="/impressum">Impressum</a><a href="/datenschutz">Datenschutz</a><label>{t('Language')}<select aria-label={t('Language')} value={locale} onChange={(event) => setLocale(event.target.value as 'de' | 'en')}><option value="de">Deutsch</option><option value="en">English</option></select></label></footer>
      </section>
      <aside><p className="eyebrow">Manufacturer-neutral operations</p><h2>One clear workspace for every role.</h2><p>Registry, Passport, service evidence and integrations without exposing tools a user does not need.</p></aside>
    </main>
  );
}

function Metric({ label, value, hint, tone }: { label: string; value: number | string; hint: string; tone?: 'good' | 'attention' }) {
  return <article className={`metric ${tone || ''}`}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>;
}

export function OperationsShell() {
  const { locale,setLocale,t }=useI18n();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [workspace, setWorkspace] = useState<Workspace>('overview');
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [robots, setRobots] = useState<RobotSummary[]>([]);
  const [adapters, setAdapters] = useState<AdapterSummary[]>([]);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const workspaceHeading=useRef<HTMLHeadingElement>(null); const initialWorkspace=useRef(true);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError('');
    try {
      const [summaryResult, robotsResult, adaptersResult, notificationResult] = await Promise.all([
        api.summary(), api.robots(), api.adapters().catch(() => ({ data: [] })), api.notifications().catch(() => ({ unreadCount: 0 }))
      ]);
      setSummary(summaryResult.data);
      setRobots(robotsResult.data);
      setAdapters(adaptersResult.data);
      setUnreadAlerts(notificationResult.unreadCount);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) setUser(null);
      else setError(caught instanceof Error ? caught.message : 'The workspace could not be loaded');
    } finally {
      setRefreshing(false);
    }
  }, []);
  const updateUnreadAlerts = useCallback((count: number) => setUnreadAlerts(count), []);

  useEffect(() => {
    api.session().then(({ user: sessionUser }) => setUser(sessionUser)).catch(() => setUser(null)).finally(() => setLoadingSession(false));
  }, []);
  useEffect(() => { if (user) void load(); }, [user, load]);
  useEffect(() => { if (initialWorkspace.current) { initialWorkspace.current=false; return; } workspaceHeading.current?.focus(); },[workspace]);

  const availableNavigation = useMemo(() => user ? navigationForRole(user.role) : [], [user]);
  if (loadingSession) return <main className="centered" aria-live="polite">Loading Altegro…</main>;
  if (!user) return <Login onLogin={setUser} />;

  return (
    <div className="app"><a className="skip-link" href="#main-content">{t('Skip to main content')}</a>
      <header>
        <div className="brand"><span>A</span><strong>altegro</strong><small>robot operations</small></div>
        <div className="header-actions"><span className="environment">Phase 1 · Read-first</span><label className="language-control"><span>{t('Language')}</span><select aria-label={t('Language')} value={locale} onChange={(event) => setLocale(event.target.value as 'de' | 'en')}><option value="de">DE</option><option value="en">EN</option></select></label><button className={`alert-button ${unreadAlerts ? 'active' : ''}`} onClick={() => setWorkspace('service')}>Alerts <strong>{unreadAlerts}</strong></button><span>{user.name}<small>{user.role.replaceAll('_', ' ')}</small></span><button className="quiet" onClick={() => void load()} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</button><button className="quiet" onClick={() => void api.logout().finally(() => setUser(null))}>Log out</button></div>
      </header>
      <div className="workspace">
        <nav aria-label={t('Role workspace')}>{availableNavigation.map((item) => <button key={item.id} aria-current={workspace === item.id ? 'page' : undefined} onClick={() => setWorkspace(item.id)}>{t(item.label)}</button>)}</nav>
        <main id="main-content" tabIndex={-1} aria-busy={refreshing}>
          {error && <div className="banner error" role="alert">{error} <button onClick={() => void load()}>Retry</button></div>}
          <section className="hero"><div><p className="eyebrow">{user.role.replaceAll('_', ' ')} workspace</p><h1 ref={workspaceHeading} tabIndex={-1}>{t(workspace === 'overview' ? 'Fleet priorities at a glance' : availableNavigation.find((item) => item.id === workspace)?.label || '')}</h1><p>Data and actions are limited to your tenant, role and robot assignments.</p></div><time aria-live="polite">{summary ? `${t('Updated')} ${new Date(summary.generatedAt).toLocaleTimeString(locale === 'de' ? 'de-DE' : 'en-GB')}` : t('Waiting for data')}</time></section>
          {workspace === 'overview' && <>
            <section className="metrics">
              <Metric label="Robots" value={summary?.robots.total ?? '—'} hint={`${summary?.robots.online ?? 0} online`} tone="good" />
              <Metric label="Needs attention" value={(summary?.robots.offline ?? 0) + (summary?.events.activeErrors ?? 0)} hint="Offline robots and active errors" tone="attention" />
              <Metric label="Open service" value={summary?.service.open ?? '—'} hint={`${summary?.service.closed ?? 0} closed`} />
              <Metric label="Passport coverage" value={`${summary?.passport.percentage ?? 0}%`} hint={`${summary?.passport.certificatesDue ?? 0} certificates due`} />
            </section>
            <section className="grid"><article className="panel"><div className="panel-title"><div><p className="eyebrow">Recent fleet</p><h2>Robots</h2></div><button onClick={() => setWorkspace('robots')}>View registry</button></div><RobotList robots={robots.slice(0, 5)} /></article><article className="panel"><div className="panel-title"><div><p className="eyebrow">Integration health</p><h2>Providers</h2></div><button onClick={() => setWorkspace('integrations')}>Open integrations</button></div><AdapterList adapters={adapters} /></article></section>
          </>}
          {workspace === 'robots' && <RobotPassport robots={robots} user={user} onDataChanged={load} />}
          {workspace === 'service' && <AlertsMaintenance robots={robots} user={user} onUnreadChange={updateUnreadAlerts} onDataChanged={load} />}
          {workspace === 'support' && <SupportPortal robots={robots} onDataChanged={load} />}
          {workspace === 'workforce' && <TechnicianCalendar robots={robots} user={user} />}
          {workspace === 'reports' && <div className="stack"><AdvancedAnalytics /><FleetComparison /><ScheduledReports user={user} /></div>}
          {workspace === 'audit' && <AuditLog user={user} />}
          {workspace === 'integrations' && <section className="panel"><div className="panel-title"><div><p className="eyebrow">Integration plane</p><h2>Provider contracts</h2></div><span>Commands disabled by default</span></div><AdapterList adapters={adapters} /></section>}
          {workspace === 'administration' && <section className="panel empty"><h2>Migration workspace</h2><p>The complete administration page remains available in the existing portal.</p><a href={legacyWorkspacePath(workspace)}>Open current {workspace} workspace</a></section>}
        </main>
      </div>
    </div>
  );
}

function RobotList({ robots }: { robots: RobotSummary[] }) {
  if (!robots.length) return <p className="empty">No robots are visible in this workspace.</p>;
  return <div className="records">{robots.map((robot) => <article key={robot.id}><span className={`dot ${robot.online === true ? 'online' : robot.online === false ? 'offline' : ''}`} /><div><strong>{robot.serialNumber}</strong><small>{robot.modelId} · {robot.siteId}</small></div><span>{robot.battery == null ? 'No telemetry' : `${robot.battery}%`}</span><em>{robot.status}</em></article>)}</div>;
}

function AdapterList({ adapters }: { adapters: AdapterSummary[] }) {
  if (!adapters.length) return <p className="empty">Integration details are unavailable for this role.</p>;
  return <div className="records">{adapters.map((adapter) => <article key={adapter.provider}><span className={`dot ${adapter.lastSyncStatus === 'success' ? 'online' : adapter.lastSyncStatus === 'error' ? 'offline' : ''}`} /><div><strong>{adapter.provider}</strong><small>{adapter.capabilities.read.slice(0, 4).join(', ') || 'No read capabilities'}</small></div><span>{adapter.lastSyncStatus || 'never'}</span><em>{adapter.capabilities.command.length ? 'guarded commands' : 'read only'}</em></article>)}</div>;
}
