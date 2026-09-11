'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { MaintenancePrediction, OperationsReport } from '@/lib/types';

function value(number: number | null | undefined, suffix = '') {
  return number == null ? '—' : `${number}${suffix}`;
}

export function AdvancedAnalytics() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<OperationsReport | null>(null);
  const [predictions, setPredictions] = useState<MaintenancePrediction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [reportResult, predictionResult] = await Promise.all([
        api.operationsReport(days),
        api.maintenancePredictions()
      ]);
      setReport(reportResult.data);
      setPredictions(predictionResult.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Analytics could not be loaded');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);
  const maxEvents = useMemo(() => Math.max(1, ...(report?.daily.map((item) => item.events) || [1])), [report]);

  if (loading && !report) return <section className="panel empty" aria-live="polite">Loading operational analytics…</section>;
  return <div className="stack">
    {error && <div className="banner error" role="alert">{error}<button onClick={() => void load()}>Retry</button></div>}
    <section className="panel">
      <div className="panel-title">
        <div><p className="eyebrow">Decision metrics</p><h2>Advanced analytics</h2></div>
        <label className="compact-control">Period<select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option></select></label>
      </div>
      <div className="metrics analytics-metrics">
        <article className="metric good"><span>Fleet health</span><strong>{value(report?.fleet.healthScore, '%')}</strong><small>{report?.fleet.attentionRobots ?? 0} need attention</small></article>
        <article className="metric"><span>Availability</span><strong>{value(report?.fleet.availabilityPercent, '%')}</strong><small>{report?.fleet.online ?? 0}/{report?.fleet.total ?? 0} online</small></article>
        <article className="metric"><span>Task success</span><strong>{value(report?.tasks.successRate, '%')}</strong><small>{report?.tasks.completed ?? 0} completed</small></article>
        <article className="metric attention"><span>High maintenance risk</span><strong>{report?.maintenance.predictedHighRisk ?? 0}</strong><small>Highest score {report?.maintenance.highestRiskScore ?? 0}%</small></article>
      </div>
      <div className="analytics-grid">
        <article><h3>Service performance</h3><dl><div><dt>Closure rate</dt><dd>{value(report?.service.caseClosureRate, '%')}</dd></div><div><dt>Average resolution</dt><dd>{value(report?.service.averageResolutionHours, ' h')}</dd></div><div><dt>Overdue maintenance</dt><dd>{report?.service.overdue ?? 0}</dd></div><div><dt>Incidents per robot</dt><dd>{value(report?.events.incidentsPerRobot)}</dd></div></dl></article>
        <article><h3>Provider distribution</h3><dl>{report?.fleet.providers.map((provider) => <div key={provider.provider}><dt>{provider.provider}</dt><dd>{provider.count}</dd></div>)}</dl></article>
        <article><h3>Workforce capacity</h3><dl><div><dt>Available</dt><dd>{report?.workforce.available ?? 0}</dd></div><div><dt>Availability</dt><dd>{value(report?.workforce.availabilityPercent, '%')}</dd></div><div><dt>On leave</dt><dd>{report?.workforce.onLeave ?? 0}</dd></div><div><dt>Total technicians</dt><dd>{report?.workforce.technicians ?? 0}</dd></div></dl></article>
      </div>
      <div className="trend" aria-label={`Daily event trend for ${days} days`}>
        {report?.daily.map((item) => <div className="trend-day" key={item.date} title={`${item.date}: ${item.events} events, ${item.errors} errors`}><span className={item.errors ? 'has-error' : ''} style={{ height: `${Math.max(4, item.events / maxEvents * 100)}%` }} /><small>{item.date.slice(5)}</small></div>)}
      </div>
      <div className="panel-actions"><a className="button-link" href={`/api/v1/reports/operations.csv?days=${days}`}>Export CSV</a><a className="button-link secondary" href={`/api/v1/reports/operations.json?days=${days}`}>Export JSON</a><small>{report ? `Updated ${new Date(report.generatedAt).toLocaleString()}` : ''}</small></div>
    </section>
    <section className="panel">
      <div className="panel-title"><div><p className="eyebrow">Predictive maintenance</p><h2>Highest-risk robots</h2></div><span>{predictions.filter((item) => item.score >= 25).length} need review</span></div>
      <div className="prediction-grid">{predictions.slice(0, 8).map((item) => <article className={`prediction risk-${item.risk}`} key={item.robotId}><div><strong>{item.serialNumber}</strong><span>{item.risk} · {item.score}%</span></div><p>{item.factors.join(' · ') || 'No current warning factors.'}</p><small>Recommended inspection within {item.predictedWindowDays} days</small></article>)}</div>
      {!predictions.length && <p className="empty">No robot data is available for predictions.</p>}
    </section>
  </div>;
}
