'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { NotificationPreferences as Preferences } from '@/lib/types';

const defaultPreferences: Preferences={ inApp:true,email:false,minimumSeverity:'warning',types:[],quietHours:{ enabled:false,start:'22:00',end:'07:00',timezone:'UTC' },updatedAt:null };

export function NotificationPreferences() {
  const [preferences,setPreferences]=useState<Preferences>(defaultPreferences);
  const [emailAvailable,setEmailAvailable]=useState(false);
  const [loading,setLoading]=useState(true); const [saving,setSaving]=useState(false); const [notice,setNotice]=useState(''); const [error,setError]=useState('');
  const load=useCallback(async () => { try { const result=await api.notificationPreferences(); setPreferences(result.data); setEmailAvailable(result.emailAvailable); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Notification preferences could not be loaded'); } finally { setLoading(false); } },[]);
  useEffect(() => { void load(); },[load]);
  function update(partial:Partial<Preferences>) { setPreferences((value) => ({ ...value,...partial })); }
  async function save() { setSaving(true); setError(''); setNotice(''); try { const result=await api.updateNotificationPreferences(preferences); setPreferences(result.data); setEmailAvailable(result.emailAvailable); setNotice('Notification preferences saved.'); } catch (caught) { setError(caught instanceof Error ? caught.message : 'Notification preferences could not be saved'); } finally { setSaving(false); } }
  return <section className="panel" aria-labelledby="notification-preferences-title" aria-busy={loading}>
    <div className="panel-title"><div><p className="eyebrow">Personal delivery</p><h2 id="notification-preferences-title">Notification preferences</h2></div><span>{preferences.updatedAt ? 'Saved' : 'Default settings'}</span></div>
    <p>Choose the alerts you want to see. Email delivery is enabled only when an administrator has configured the mail service.</p>
    {error && <p className="banner error" role="alert">{error}</p>}<p className="sr-status" aria-live="polite">{notice}</p>
    <div className="preferences-grid">
      <label><input type="checkbox" checked={preferences.inApp} onChange={(event) => update({ inApp:event.target.checked })} /> Show in-app alerts</label>
      <label><input type="checkbox" checked={preferences.email} disabled={!emailAvailable} onChange={(event) => update({ email:event.target.checked })} /> Send email alerts</label>
      <label>Minimum severity<select value={preferences.minimumSeverity} onChange={(event) => update({ minimumSeverity:event.target.value as Preferences['minimumSeverity'] })}><option value="info">Information</option><option value="warning">Warning</option><option value="error">Error</option><option value="critical">Critical</option></select></label>
      <label><input type="checkbox" checked={preferences.quietHours.enabled} onChange={(event) => update({ quietHours:{ ...preferences.quietHours,enabled:event.target.checked } })} /> Use quiet hours</label>
      <label>Quiet from<input type="time" value={preferences.quietHours.start} disabled={!preferences.quietHours.enabled} onChange={(event) => update({ quietHours:{ ...preferences.quietHours,start:event.target.value } })} /></label>
      <label>Quiet until<input type="time" value={preferences.quietHours.end} disabled={!preferences.quietHours.enabled} onChange={(event) => update({ quietHours:{ ...preferences.quietHours,end:event.target.value } })} /></label>
    </div>
    {!emailAvailable && <p className="banner attention">Email alerts are unavailable until SMTP delivery is configured.</p>}
    <div className="panel-actions"><button className="button-link" type="button" disabled={loading || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save preferences'}</button></div>
  </section>;
}
