'use client';

import { FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { attachmentAccept, readAttachment } from '@/lib/attachments';
import type { EvidenceRecord, RobotPassportData, RobotSummary, SessionUser } from '@/lib/types';

export function RobotPassport({ robots, user, onDataChanged }: { robots: RobotSummary[]; user: SessionUser; onDataChanged: () => void }) {
  const [selected, setSelected] = useState(''); const [query, setQuery] = useState('');
  const [passport, setPassport] = useState<RobotPassportData | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { setPassport(null); setError(''); if (!selected) return; let active = true;
    api.passport(selected).then(({ data }) => { if (active) setPassport(data); }).catch((e: Error) => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [selected]);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); setBusy(true); setError('');
    try { await api.addDocument(selected, { title: String(data.get('title')), description: String(data.get('description')), attachment: await readAttachment(data.get('attachment') as File) }); setPassport((await api.passport(selected)).data); form.reset(); onDataChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Document could not be saved'); } finally { setBusy(false); }
  }
  function evidence(title: string, records: EvidenceRecord[], downloads = false) {
    return <section className="panel"><h2>{title}</h2>{records.map((record) => <article className="evidence" key={record.id}><strong>{record.title}</strong><p>{record.description}</p><small>{record.status || record.version || record.issuer} {record.validUntil && ` · expires ${new Date(record.validUntil).toLocaleDateString()}`}</small>{downloads && record.attachment && <a href={`/api/v1/robots/${encodeURIComponent(selected)}/documents/${encodeURIComponent(record.id)}/attachment`}>Download {record.attachment.name}</a>}</article>)}{!records.length && <p className="empty">No {title.toLowerCase()} recorded.</p>}</section>;
  }
  return <div className="stack">
    <section className="panel"><h2>Robot registry</h2><label>Search robots<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Serial number, model or site" /></label><div className="records">{robots.filter((robot) => `${robot.serialNumber} ${robot.modelId} ${robot.siteId}`.toLowerCase().includes(query.toLowerCase())).map((robot) => <article key={robot.id}><div><strong>{robot.serialNumber}</strong><small>{robot.modelId} · {robot.siteId}</small></div><button aria-pressed={selected === robot.id} onClick={() => setSelected(robot.id)}>Open Passport {robot.serialNumber}</button></article>)}</div>{!robots.length && <p className="empty">No robots are visible.</p>}</section>
    {error && <p className="banner error" role="alert">{error}</p>}
    {selected && !passport && !error && <p aria-live="polite">Loading Passport…</p>}
    {passport && <>
      <section className="panel"><div className="panel-title"><h2>Passport · {passport.robot.serialNumber}</h2><span>{passport.completeness.percentage}% complete</span></div><p>{passport.model?.name || passport.robot.modelId} · {passport.site?.name || passport.robot.siteId}</p><p>Owner: {passport.owner?.name || 'Unassigned'} · Operator: {passport.operator?.name || 'Unassigned'}</p><details><summary>Identity and configuration</summary><pre>{JSON.stringify(passport.robot, null, 2)}</pre></details><div className="record-actions"><a href={`/api/v1/robots/${encodeURIComponent(selected)}/reports/maintenance.pdf`}>Maintenance PDF</a><a href={`/api/v1/robots/${encodeURIComponent(selected)}/reports/compliance.pdf`}>Compliance PDF</a>{user.permissions.includes('report.export') && <a href={`/api/v1/robots/${encodeURIComponent(selected)}/export`}>Export Passport</a>}</div></section>
      {evidence('Documents', passport.documents, true)}
      {user.permissions.includes('robot.write') && <section className="panel"><h2>Add Passport document</h2><form className="schedule-form" onSubmit={upload}><label>Document title<input name="title" required maxLength={200} /></label><label>Attachment (maximum 2 MB)<input name="attachment" type="file" accept={attachmentAccept} /></label><label className="wide">Document description<textarea name="description" maxLength={4000} /></label><button disabled={busy}>{busy ? 'Saving…' : 'Save document'}</button></form></section>}
      {evidence('Certificates', passport.certificates)}{evidence('Deployments', passport.deployments)}
      <section className="panel"><h2>Service history</h2>{passport.serviceCases.map((item) => <article className="evidence" key={item.id}><strong>{item.title}</strong><p>{item.description}</p><small>{item.externalId} · {item.status}</small></article>)}{!passport.serviceCases.length && <p className="empty">No service cases recorded.</p>}</section>
      <section className="panel"><h2>Qualifications and compatibility</h2><details><summary>Required qualifications</summary><pre>{JSON.stringify(passport.workforce.requirements, null, 2)}</pre></details>{passport.workforce.assignedTechnicians.map(({ technician, eligibility }) => <p key={technician.id}>{technician.name} · {eligibility.eligible ? 'Qualified' : 'Qualification missing'}</p>)}{passport.compatibility.map((item) => <p key={item.id}>{item.capability} · {item.status} · {item.evidence}</p>)}</section>
      <section className="panel"><h2>Complete lifecycle timeline</h2>{[...passport.entries].reverse().map((entry) => <details className="evidence" key={entry.id}><summary>{entry.type.replaceAll('_', ' ')} · {entry.source} · {entry.occurredAt || entry.createdAt || ''}</summary><pre>{JSON.stringify(entry.data, null, 2)}</pre></details>)}</section>
    </>}
  </div>;
}
