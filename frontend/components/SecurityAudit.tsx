'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { AuditEntry, SessionUser } from '@/lib/types';

export function SecurityAudit({ user }: { user: SessionUser }) {
  const [entries,setEntries]=useState<AuditEntry[]>([]); const [error,setError]=useState('');
  const load=useCallback(async () => { try { setEntries((await api.audit({ limit:100 })).data); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Security audit could not be loaded'); } },[]);
  useEffect(() => { if (['platform_admin','data_admin','support_admin'].includes(user.role)) void load(); },[load,user.role]);
  const summary=useMemo(() => ({ failed:entries.filter((item) => item.result !== 'success').length, access:entries.filter((item) => /auth|session|permission|login/i.test(item.action)).length, changes:entries.filter((item) => /create|update|delete|void/i.test(item.action)).length }),[entries]);
  if (!['platform_admin','data_admin','support_admin'].includes(user.role)) return null;
  return <section className="panel"><div className="panel-title"><div><p className="eyebrow">Security review</p><h2>Security audit summary</h2></div><button className="quiet" onClick={() => void load()}>Refresh</button></div>{error && <p className="banner error" role="alert">{error}</p>}<div className="metrics security-metrics"><article className="metric attention"><span>Review items</span><strong>{summary.failed}</strong><small>Non-success audit results</small></article><article className="metric"><span>Access events</span><strong>{summary.access}</strong><small>Authentication or permission activity</small></article><article className="metric good"><span>Recorded changes</span><strong>{summary.changes}</strong><small>Recent controlled changes</small></article></div><p>Review the detailed audit log below for actor, time, affected record and recorded result. No credentials or tokens are exposed here.</p></section>;
}
