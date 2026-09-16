'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type ReportSubscriptionInput } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { ReportSubscription, SessionUser } from '@/lib/types';

export function ScheduledReports({ user }: { user: SessionUser }) {
  const { t,formatDateTime }=useI18n(); const [items,setItems]=useState<ReportSubscription[]>([]); const [delivery,setDelivery]=useState({ enabled:false,configured:false,configurationError:null as string | null }); const [cadence,setCadence]=useState<ReportSubscription['cadence']>('weekly'); const [busy,setBusy]=useState(''); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
  const load=useCallback(async () => { try { const result=await api.reportSubscriptions(); setItems(result.data); setDelivery(result.delivery); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Report schedules could not be loaded'); } },[]);
  useEffect(() => { void load(); },[load]);
  async function act(id:string,action:() => Promise<unknown>,message:string) { setBusy(id); setError(''); setNotice(''); try { await action(); setNotice(message); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : 'The report schedule could not be updated'); } finally { setBusy(''); } }
  async function create(event:FormEvent<HTMLFormElement>) { event.preventDefault(); const form=event.currentTarget; const data=new FormData(form); const input:ReportSubscriptionInput={ name:String(data.get('name')),cadence,days:Number(data.get('days')) as ReportSubscription['days'],hourUtc:Number(data.get('hourUtc')),weekday:Number(data.get('weekday')),monthDay:Number(data.get('monthDay')) }; await act('new',() => api.createReportSubscription(input),t('Report schedule created.')); form.reset(); setCadence('weekly'); }
  const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return <section className="panel" aria-labelledby="scheduled-reports-title">
    <div className="panel-title"><div><p className="eyebrow">{t('Automated delivery')}</p><h2 id="scheduled-reports-title">{t('Scheduled email reports')}</h2></div><span>{user.email}</span></div>
    {(!delivery.enabled || !delivery.configured) && <p className="banner attention" role="status">{t('Email delivery is not configured. An administrator must configure SMTP before reports can be sent.')}{delivery.configurationError ? ` ${delivery.configurationError}` : ''}</p>}
    {error && <p className="banner error" role="alert">{error}</p>}<p className="sr-status" aria-live="polite">{notice}</p>
    <h3>{t('Create report schedule')}</h3><form className="schedule-form" onSubmit={(event) => void create(event)}>
      <label>{t('Report name')}<input name="name" required maxLength={120} defaultValue={t('Operations summary')} /></label>
      <label>{t('Frequency')}<select name="cadence" value={cadence} onChange={(event) => setCadence(event.target.value as ReportSubscription['cadence'])}><option value="daily">{t('Daily')}</option><option value="weekly">{t('Weekly')}</option><option value="monthly">{t('Monthly')}</option></select></label>
      <label>{t('Report period')}<select name="days" defaultValue="30">{[7,30,90,365].map((days) => <option key={days} value={days}>{days} {t('days')}</option>)}</select></label>
      <label>{t('Delivery hour (UTC)')}<input name="hourUtc" type="number" min={0} max={23} defaultValue={7} required /></label>
      {cadence === 'weekly' && <label>{t('Weekday')}<select name="weekday" defaultValue="1">{weekdays.map((day,index) => <option key={day} value={index}>{t(day)}</option>)}</select></label>}
      {cadence === 'monthly' && <label>{t('Day of month')}<input name="monthDay" type="number" min={1} max={28} defaultValue={1} required /></label>}
      <input type="hidden" name="weekday" value="1" disabled={cadence === 'weekly'} /><input type="hidden" name="monthDay" value="1" disabled={cadence === 'monthly'} />
      <button disabled={busy === 'new'}>{busy === 'new' ? t('Saving…') : t('Create report')}</button>
    </form>
    <div className="schedule-list">{items.map((item) => <article key={item.id}><div><div className="record-heading"><strong>{item.name}</strong><span>{item.active ? t('Active') : t('Paused')}</span></div><p>{t('Delivery email')}: {item.email} · {t(item.cadence)} · {item.days} {t('days')}</p><small>{t('Next delivery')}: {formatDateTime(item.nextRunAt)} · {t('Last delivery')}: {item.lastRunAt ? `${formatDateTime(item.lastRunAt)} (${t(item.lastStatus)})` : t('never')}</small>{item.lastError && <p className="error">{item.lastError}</p>}</div><div className="record-actions"><button disabled={Boolean(busy) || !delivery.enabled || !delivery.configured} onClick={() => void act(item.id,() => api.sendReportNow(item.id),t('Report sent.'))}>{t('Send now')}</button><button disabled={Boolean(busy)} onClick={() => void act(item.id,() => api.updateReportSubscription(item.id,{ active:!item.active }),item.active ? t('Schedule paused.') : t('Schedule resumed.'))}>{item.active ? t('Pause') : t('Resume')}</button><button disabled={Boolean(busy)} onClick={() => { if (window.confirm(t('Delete this report schedule?'))) void act(item.id,() => api.deleteReportSubscription(item.id),t('Schedule deleted.')); }}>{t('Delete')}</button></div></article>)}</div>
    {!items.length && <p className="empty">{t('No report schedules yet.')}</p>}
  </section>;
}
