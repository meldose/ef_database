'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import type { MaintenanceSchedule } from '@/lib/types';

export function MaintenanceCalendar() {
  const [items,setItems]=useState<MaintenanceSchedule[]>([]); const [month,setMonth]=useState(new Date().toISOString().slice(0,7)); const [error,setError]=useState('');
  const load=useCallback(async () => { try { setItems((await api.maintenanceSchedules()).data); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Maintenance calendar could not be loaded'); } },[]);
  useEffect(() => { void load(); },[load]);
  const days=useMemo(() => { const [year,monthNumber]=month.split('-').map(Number); const count=new Date(year,monthNumber,0).getDate(); return Array.from({ length:count },(_,index) => `${month}-${String(index+1).padStart(2,'0')}`); },[month]);
  const byDay=(day:string) => items.filter((item) => item.nextDueAt.slice(0,10) === day && item.status === 'active');
  return <section className="panel" aria-labelledby="maintenance-calendar-title"><div className="panel-title"><div><p className="eyebrow">Planning view</p><h2 id="maintenance-calendar-title">Maintenance calendar</h2></div><label>Month<input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label></div>{error && <p className="banner error" role="alert">{error}</p>}<div className="maintenance-calendar">{days.map((day) => <article key={day}><strong>{new Date(`${day}T12:00:00`).getDate()}</strong>{byDay(day).map((item) => <span className={`state-${item.dueState}`} key={item.id} title={`${item.robotSerialNumber}: ${item.title}`}>{item.robotSerialNumber}</span>)}</article>)}</div><p className="calendar-legend">Each entry is an active maintenance due date. Red indicates overdue work; amber indicates work due soon.</p></section>;
}
