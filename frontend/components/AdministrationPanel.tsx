'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { SessionUser } from '@/lib/types';

export function AdministrationPanel({ user }: { user: SessionUser }) {
  const [monitoring,setMonitoring]=useState<{ generatedAt:string; [key:string]:unknown } | null>(null);
  const [email,setEmail]=useState<{ configuration:{ enabled:boolean; configured:boolean; configurationError:string | null; recipientCount:number }; counts:{ total:number; pending:number; sent:number; failed:number } } | null>(null);
  const [accounts,setAccounts]=useState<Array<{ email:string; serialNumber:string; credentialStatus:string }>>([]); const [error,setError]=useState('');
  const load=useCallback(async () => { setError(''); try { const [monitoringResult,emailResult,accountResult]=await Promise.all([api.monitoring(),api.emailDeliveries(),user.role === 'platform_admin' ? api.robotAccounts() : Promise.resolve(null)]); setMonitoring(monitoringResult.data); setEmail(emailResult.data); setAccounts(accountResult?.data || []); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Administration data could not be loaded'); } },[user.role]);
  useEffect(() => { void load(); },[load]);
  return <div className="stack">
    {error && <div className="banner error" role="alert">{error} <button onClick={() => void load()}>Retry</button></div>}
    <section className="panel"><div className="panel-title"><div><p className="eyebrow">Platform health</p><h2>Administration</h2></div><button className="quiet" onClick={() => void load()}>Refresh</button></div><p>Service health and delivery controls are visible only to authorized administrators. Credentials and protected provider diagnostics remain server-side.</p><dl className="admin-metrics"><div><dt>Monitoring updated</dt><dd>{monitoring?.generatedAt ? new Date(monitoring.generatedAt).toLocaleString() : 'Loading…'}</dd></div><div><dt>Email delivery</dt><dd>{email?.configuration.configured ? 'Configured' : 'Needs configuration'}</dd></div><div><dt>Alert recipients</dt><dd>{email?.configuration.recipientCount ?? '—'}</dd></div><div><dt>Failed deliveries</dt><dd>{email?.counts.failed ?? '—'}</dd></div></dl>{email?.configuration.configurationError && <p className="banner attention">{email.configuration.configurationError}</p>}</section>
    {user.role === 'platform_admin' && <section className="panel"><div className="panel-title"><div><p className="eyebrow">Read-only accounts</p><h2>Robot access accounts</h2></div><span>{accounts.length} accounts</span></div><p>Passwords are never displayed or recoverable. Use the secure administration process to reset a lost credential.</p><div className="records">{accounts.map((account) => <article key={account.email}><div><strong>{account.serialNumber}</strong><small>{account.email}</small></div><em>{account.credentialStatus}</em></article>)}</div></section>}
  </div>;
}
