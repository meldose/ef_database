'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AuditFilters } from '@/lib/api';
import type { AuditEntry, AuditFacets, SessionUser } from '@/lib/types';

const emptyFacets: AuditFacets = { actions: [], actors: [], objectTypes: [], results: [] };

export function AuditLog({ user }: { user: SessionUser }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [facets, setFacets] = useState<AuditFacets>(emptyFacets);
  const [filters, setFilters] = useState<AuditFilters>({ limit: 100 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (nextFilters = filters) => {
    setLoading(true); setError('');
    try { const result = await api.audit(nextFilters); setEntries(result.data); setFacets(result.facets); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Audit history could not be loaded'); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { void load(); }, []); // Initial evidence load only; filters are applied by the form.

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const next: AuditFilters = { limit: 100 };
    for (const key of ['q', 'action', 'result', 'actorId', 'objectType', 'from', 'to'] as const) {
      const raw = String(data.get(key) || '');
      if (raw) next[key] = (key === 'from' || key === 'to') ? new Date(`${raw}T${key === 'from' ? '00:00:00.000' : '23:59:59.999'}`).toISOString() : raw;
    }
    setFilters(next); void load(next);
  }

  const exportUrl = useMemo(() => {
    const query = new URLSearchParams(); Object.entries(filters).forEach(([key, value]) => { if (value != null && key !== 'limit') query.set(key, String(value)); });
    return `/api/v1/audit.csv${query.size ? `?${query}` : ''}`;
  }, [filters]);

  return <section className="panel">
    <div className="panel-title"><div><p className="eyebrow">Immutable operational evidence</p><h2>Detailed audit log</h2></div>{user.permissions.includes('audit.export') && <a className="button-link secondary" href={exportUrl}>Export CSV</a>}</div>
    {error && <div className="banner error" role="alert">{error}<button onClick={() => void load()}>Retry</button></div>}
    <form className="audit-filters" onSubmit={submit}>
      <label>Search<input name="q" placeholder="Action, actor, object or detail" /></label>
      <label>Action<select name="action"><option value="">All actions</option>{facets.actions.map((item) => <option key={item}>{item.replaceAll('.', ' ')}</option>)}</select></label>
      <label>Result<select name="result"><option value="">All results</option>{facets.results.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>Actor<select name="actorId"><option value="">All actors</option>{facets.actors.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <label>Object<select name="objectType"><option value="">All objects</option>{facets.objectTypes.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label>From<input name="from" type="date" /></label><label>To<input name="to" type="date" /></label>
      <button disabled={loading}>{loading ? 'Loading…' : 'Apply filters'}</button>
    </form>
    <div className="audit-list">{entries.map((entry) => <article key={entry.id || `${entry.occurredAt}:${entry.action}:${entry.objectId}`}><div><div className="record-heading"><strong>{entry.action.replaceAll('.', ' ')}</strong><span className={`result-${entry.result}`}>{entry.result}</span></div><p>{entry.actorName} · {entry.objectType} · {entry.objectId}</p><time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleString()}</time>{entry.details && Object.keys(entry.details).length > 0 && <details><summary>View recorded details</summary><pre>{JSON.stringify(entry.details, null, 2)}</pre></details>}</div></article>)}</div>
    {!loading && !entries.length && <p className="empty">No audit records match these filters.</p>}
  </section>;
}
