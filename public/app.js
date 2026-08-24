'use strict';

const state = { token:null,user:null,language:localStorage.getItem('altegroLanguage') || 'en',robots:[],robotOptions:[],serviceCases:[],supportTickets:[],compatibility:[],notifications:[],notificationUnreadCount:0,selectedNotificationId:null,reports:null,tracking:null,audit:[],autoXingResources:null,autoXingTasks:[],autoXingOperations:null,cenoBotsOperations:null,maintenanceSchedules:[],escalationRules:null,monitoring:null,emailNotifications:null,smsNotifications:null,selectedAlertId:null,onboardingStep:1,autoXingFleet:{ query:'',status:'all',battery:'all',alerts:'all',page:1,pageSize:12 },cenoBotsFleet:{ query:'',status:'all',attention:'all' },robotAccounts:[],workforce:null,summary:null,selectedRobotId:null,registry:{ page:1,pageSize:10,pageCount:1,count:0 },sync:{ provider:null,startedAt:0,timer:null },autoRefresh:{ timer:null,intervalMs:30000,lastAt:null },trackingRefresh:{ timer:null,intervalMs:10000 } };
const $ = (selector) => document.querySelector(selector);
const translations={
  en:{ skip:'Skip to operations content',language:'Language',signInTitle:'Sign in to Altegro',signInCopy:'Access your organization’s robot registry, Passports, events and service history.',signIn:'Sign in',alerts:'Alerts',logout:'Log out',overview:'Overview',robots:'Robots',eventsService:'Events & Service',technicians:'Technicians',reports:'Reports',support:'Support',administration:'Administration',guardedControl:'Guarded robot control',missionScheduling:'Mission scheduling and controls',controlSafety:'Commands require an authorized administrator, live provider configuration, and exact robot confirmation.',robot:'Robot',robotReport:'Robot report',maintenancePdf:'Maintenance PDF',compliancePdf:'Compliance PDF',customerCare:'Customer care',supportPortal:'Support ticket portal',refresh:'Refresh',newTicket:'＋ New ticket',status:'Status' },
  de:{ skip:'Zum Betriebsbereich springen',language:'Sprache',signInTitle:'Bei Altegro anmelden',signInCopy:'Greifen Sie auf Roboterregister, Pässe, Ereignisse und Servicehistorie Ihrer Organisation zu.',signIn:'Anmelden',alerts:'Warnungen',logout:'Abmelden',overview:'Übersicht',robots:'Roboter',eventsService:'Ereignisse & Service',technicians:'Techniker',reports:'Berichte',support:'Support',administration:'Verwaltung',guardedControl:'Abgesicherte Robotersteuerung',missionScheduling:'Missionsplanung und Steuerung',controlSafety:'Befehle erfordern einen autorisierten Administrator, eine Live-Anbindung und die exakte Roboterbestätigung.',robot:'Roboter',robotReport:'Roboterbericht',maintenancePdf:'Wartungs-PDF',compliancePdf:'Compliance-PDF',customerCare:'Kundenservice',supportPortal:'Support-Ticketportal',refresh:'Aktualisieren',newTicket:'＋ Neues Ticket',status:'Status',
    'Platform control center':'Plattform-Kontrollzentrum','Fleet data governance':'Flottendatenverwaltung','Service operations center':'Service-Leitstand','Customer fleet overview':'Kundenflottenübersicht','Technician workspace':'Techniker-Arbeitsbereich','Assurance dashboard':'Prüfungs-Dashboard','My robot dashboard':'Mein Roboter-Dashboard','CenoBots health':'CenoBots-Status','Administration':'Verwaltung','Fleet reports':'Flottenberichte','Review registry':'Register prüfen','Audit & compatibility':'Audit & Kompatibilität','Data report':'Datenbericht','Service queue':'Service-Warteschlange','Technician matrix':'Technikermatrix','Service report':'Servicebericht','My robots':'Meine Roboter','Service status':'Servicestatus','Performance report':'Leistungsbericht','Service work':'Servicearbeiten','Qualifications':'Qualifikationen','Robot Passports':'Roboterpässe','Operational report':'Betriebsbericht','Passport evidence':'Passnachweise','Audit activity':'Audit-Aktivität','Open my robot':'Meinen Roboter öffnen','Technical events':'Technische Ereignisse','Robot report':'Roboterbericht'
  }
};
const tr=(key) => translations[state.language]?.[key] || translations.en[key] || key;
function applyLanguage(language=state.language) { state.language=translations[language] ? language : 'en'; localStorage.setItem('altegroLanguage',state.language); document.documentElement.lang=state.language; $('#languageSelect').value=state.language; document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent=tr(element.dataset.i18n); }); if (state.user) renderRoleDashboard(); }
function accessibilityPreferences() { try { return { textSize:'normal',contrast:false,reduceMotion:false,...JSON.parse(localStorage.getItem('altegroAccessibility') || '{}') }; } catch { return { textSize:'normal',contrast:false,reduceMotion:false }; } }
function applyAccessibility(preferences=accessibilityPreferences()) { const root=document.documentElement; root.classList.remove('text-large','text-extra-large','high-contrast','reduce-motion'); if (preferences.textSize === 'large') root.classList.add('text-large'); if (preferences.textSize === 'extra-large') root.classList.add('text-extra-large'); if (preferences.contrast) root.classList.add('high-contrast'); if (preferences.reduceMotion) root.classList.add('reduce-motion'); localStorage.setItem('altegroAccessibility',JSON.stringify(preferences)); }
const api = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload.error?.message || 'Request failed'); error.status = response.status; error.code = payload.error?.code; if (response.status === 401 && state.token) expireSession(); throw error; }
  return payload;
};
const download = async (path, fallbackName) => {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!response.ok) { const payload = await response.json().catch(() => ({})); if (response.status === 401 && state.token) expireSession(); throw new Error(payload.error?.message || 'Download failed'); }
  const blob = await response.blob(); const disposition = response.headers.get('content-disposition') || ''; const match = disposition.match(/filename="([^"]+)"/); const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = match?.[1] || fallbackName; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const formatDate = (value) => value ? new Date(value).toLocaleString(state.language === 'de' ? 'de-DE' : 'en-GB', { dateStyle:'medium', timeStyle:'short' }) : '—';
const toDateTimeLocal = (date = new Date()) => { const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16); };
const dashboardViews = new Set(['overview', 'tracking', 'robots', 'operations', 'autoxing', 'cenobots', 'workforce', 'reports', 'support', 'admin']);
const roleViews = {
  robot_user:['overview','tracking','robots','operations','reports','support'],
  auditor:['overview','tracking','robots','operations','reports','admin'],
  owner:['overview','tracking','robots','operations','reports','support'],
  technician:['overview','tracking','robots','operations','workforce','reports','support'],
  platform_admin:[...dashboardViews],data_admin:[...dashboardViews],support_admin:[...dashboardViews],
};

function toast(message, isError = false) {
  const element = $('#toast'); element.textContent = message; element.classList.toggle('error', isError); element.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 3200);
}

function showLogin() {
  $('#loginScreen').classList.remove('hidden'); $('#appShell').classList.add('hidden'); $('#loginPassword').value = '';
}

function expireSession(message = 'Your session expired. Please sign in again.') {
  sessionStorage.removeItem('altegroSession'); clearInterval(state.autoRefresh.timer); clearInterval(state.trackingRefresh.timer); state.autoRefresh.timer = null; state.trackingRefresh.timer=null; state.token = null; state.user = null; state.robots = []; state.selectedRobotId = null; showLogin(); $('#loginError').textContent = message;
}

function showApp() {
  $('#loginScreen').classList.add('hidden'); $('#appShell').classList.remove('hidden');
  $('#loggedInUser').textContent = `${state.user.name} · ${state.user.role.replaceAll('_', ' ')}`;
  const robotUser = state.user.role === 'robot_user'; const auditor = state.user.role === 'auditor';
  ['syncAll', 'syncAutoXing', 'syncCenoBots', 'syncCenoBotsWorkspace'].forEach((id) => { const element = $(`#${id}`); if (element) element.classList.toggle('hidden', robotUser || auditor); });
  $('#newRobotButton').classList.toggle('hidden', auditor);
  $('#exportTenant').classList.toggle('hidden', robotUser);
  $('#exportRobotsCsv').classList.toggle('hidden', robotUser);
  $('#serviceTechniciansButton').classList.toggle('hidden', robotUser);
  $('#resourceExplorerPanel').classList.toggle('hidden', robotUser);
  $('#autoXingEscalationPanel').classList.toggle('hidden', robotUser);
  $('#taskHistoryPanel').classList.toggle('audit-panel', robotUser);
  $('#robotAccountsSection').classList.toggle('hidden', state.user.role !== 'platform_admin');
  $('#emailNotificationsSection').classList.toggle('hidden', !['platform_admin','data_admin','support_admin'].includes(state.user.role));
  $('#smsNotificationsSection').classList.toggle('hidden', !['platform_admin','data_admin','support_admin'].includes(state.user.role));
  $('#workforceSection').classList.toggle('hidden', robotUser);
  $('#newTechnicianButton').classList.toggle('hidden', !['platform_admin','data_admin','support_admin'].includes(state.user.role));
  $('#newCompatibilityButton').classList.toggle('hidden', !['platform_admin', 'data_admin'].includes(state.user.role));
  const accountFields = $('#robotAccountFields'); if (accountFields) accountFields.classList.toggle('hidden', robotUser);
  const allowed=new Set(roleViews[state.user.role] || [...dashboardViews]); document.querySelectorAll('[data-dashboard-tab]').forEach((button) => button.classList.toggle('hidden',!allowed.has(button.dataset.dashboardTab)));
  renderRoleDashboard(); setDashboardView(sessionStorage.getItem('altegroDashboardView') || 'overview');
}

function setDashboardView(requestedView) {
  const allowed=new Set(roleViews[state.user?.role] || [...dashboardViews]); const view = dashboardViews.has(requestedView) && allowed.has(requestedView) ? requestedView : 'overview';
  sessionStorage.setItem('altegroDashboardView', view);
  document.querySelectorAll('[data-dashboard-view]').forEach((element) => { const hidden=element.dataset.dashboardView !== view; element.classList.toggle('view-hidden',hidden); element.setAttribute('aria-hidden',String(hidden)); });
  document.querySelectorAll('[data-dashboard-tab]').forEach((button) => { const selected = button.dataset.dashboardTab === view; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
  document.querySelectorAll('.lower-grid').forEach((grid) => {
    const visibleChildren = [...grid.children].filter((child) => !child.classList.contains('view-hidden') && !child.classList.contains('hidden'));
    grid.classList.toggle('view-grid-empty', !grid.classList.contains('view-hidden') && !grid.classList.contains('hidden') && visibleChildren.length === 0);
    grid.classList.toggle('view-grid-single', visibleChildren.length === 1);
  });
}

function renderRoleDashboard() {
  const profiles={
    platform_admin:{ title:'Platform control center',copy:'Monitor integrations, fleet health, access, security and operational workflows.',message:'Review provider health, unresolved alerts and onboarding readiness.',actions:[['cenobots','CenoBots health'],['admin','Administration'],['reports','Fleet reports']] },
    data_admin:{ title:'Fleet data governance',copy:'Maintain canonical robot identities, Passports, evidence and integration quality.',message:'Complete draft records and review data-quality or integration warnings.',actions:[['robots','Review registry'],['admin','Audit & compatibility'],['reports','Data report']] },
    support_admin:{ title:'Service operations center',copy:'Prioritize robot alerts, service cases, maintenance and qualified dispatch.',message:'Start with unresolved alerts and robots that require qualified service.',actions:[['operations','Service queue'],['workforce','Technician matrix'],['reports','Service report']] },
    owner:{ title:'Customer fleet overview',copy:'Track fleet availability, service progress and lifecycle compliance.',message:'Review offline robots, open service cases and operational performance.',actions:[['robots','My robots'],['support','Support'],['reports','Performance report']] },
    technician:{ title:'Technician workspace',copy:'See assigned robots, technical events and qualification requirements.',message:'Review active service work and confirm your eligibility before intervention.',actions:[['operations','Service work'],['workforce','Qualifications'],['robots','Robot Passports']] },
    auditor:{ title:'Assurance dashboard',copy:'Inspect immutable Passport evidence, events, reports and audit history.',message:'Use the read-only views and exports to verify lifecycle traceability.',actions:[['reports','Operational report'],['robots','Passport evidence'],['admin','Audit activity']] },
    robot_user:{ title:'My robot dashboard',copy:'A scoped operational view for the robots assigned to this account.',message:'Review current state, technical history and your Robot Passport.',actions:[['robots','Open my robot'],['support','Support'],['reports','Robot report']] },
  };
  const profile=profiles[state.user.role] || profiles.owner; $('#roleDashboardTitle').textContent=tr(profile.title); $('#roleDashboardCopy').textContent=tr(profile.copy); $('#roleDashboardEyebrow').textContent=`${state.user.role.replaceAll('_',' ')} workspace`; $('#roleDashboardMessage').textContent=tr(profile.message); $('#roleDashboardActions').innerHTML=profile.actions.map(([view,label]) => `<button type="button" class="button secondary" data-role-target="${view}">${escapeHtml(tr(label))}</button>`).join(''); $('#roleDashboardActions').querySelectorAll('[data-role-target]').forEach((button) => button.addEventListener('click',() => setDashboardView(button.dataset.roleTarget)));
}

function populateExistingRobotSelect() {
  const select = $('#existingRobotId');
  if (!select) return;
  const selected = select.value;
  select.innerHTML = '<option value="">＋ New robot</option>' + state.robotOptions.map((robot) => `<option value="${escapeHtml(robot.id)}">${escapeHtml(robot.serialNumber)} · ${escapeHtml(robot.externalIdentities?.[0]?.system || 'manual')} · ${escapeHtml(robot.status)}</option>`).join('');
  if (selected && state.robotOptions.some((robot) => robot.id === selected)) select.value = selected;
}

function populateEventRobotFilter() {
  const select = $('#eventRobotFilter'); if (!select) return; const selected = select.value;
  select.innerHTML = '<option value="">All robots</option>' + state.robotOptions.map((robot) => `<option value="${escapeHtml(robot.id)}">${escapeHtml(robot.serialNumber)}</option>`).join('');
  if (selected && state.robotOptions.some((robot) => robot.id === selected)) select.value = selected;
}

function populateTaskRobotFilter() {
  const select = $('#taskRobotFilter'); if (!select) return; const selected = select.value;
  const robots = state.robotOptions.filter((robot) => robot.externalIdentities?.some((identity) => identity.system === 'autoxing'));
  select.innerHTML = '<option value="">All visible AutoXing robots</option>' + robots.map((robot) => `<option value="${escapeHtml(robot.id)}">${escapeHtml(robot.serialNumber)}</option>`).join('');
  if (selected && robots.some((robot) => robot.id === selected)) select.value = selected;
}

function populateWorkforceRobotFilter() {
  const select = $('#workforceRobotFilter'); if (!select) return; const selected = select.value;
  select.innerHTML = '<option value="">All visible robots</option>' + state.robotOptions.map((robot) => `<option value="${escapeHtml(robot.id)}">${escapeHtml(robot.serialNumber)} · ${escapeHtml(robot.modelId.replace('model-','').replaceAll('-',' '))}</option>`).join('');
  if (selected && state.robotOptions.some((robot) => robot.id === selected)) select.value = selected;
}

function populateFeatureRobotSelects() {
  for (const id of ['pdfReportRobot','supportTicketRobot']) { const select=$(`#${id}`); if (!select) continue; const selected=select.value; select.innerHTML='<option value="">Select a robot</option>'+state.robotOptions.map((robot) => `<option value="${escapeHtml(robot.id)}">${escapeHtml(robot.serialNumber)}</option>`).join(''); if (state.robotOptions.some((robot) => robot.id === selected)) select.value=selected; }
  const cenoBots=state.robotOptions.filter((robot) => robot.externalIdentities?.some((identity) => identity.system === 'cenobots'));
  for (const id of ['cenoBotsControlRobot','cenoBotsScheduleRobot']) { const select=$(`#${id}`); if (!select) continue; const selected=select.value; select.innerHTML='<option value="">Select a CenoBots robot</option>'+cenoBots.map((robot) => `<option value="${escapeHtml(robot.id)}">${escapeHtml(robot.serialNumber)}</option>`).join(''); if (cenoBots.some((robot) => robot.id === selected)) select.value=selected; }
}

async function loadRobotOptions() {
  const payload = await api('/api/v1/robots?pageSize=100&sort=serialNumber&order=asc'); state.robotOptions = payload.data; populateExistingRobotSelect(); populateEventRobotFilter(); populateTaskRobotFilter(); populateWorkforceRobotFilter(); populateFeatureRobotSelects();
}

async function login(email, password) {
  const response = await fetch('/api/v1/auth/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ email, password }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Unable to sign in');
  $('#loginPassword').value = '';
  await completeLogin(payload);
}

async function completeLogin(payload) {
  state.token = payload.token; state.user = payload.user;
  sessionStorage.setItem('altegroSession', JSON.stringify({ token:state.token, user:state.user }));
  showApp(); await refreshAll(); startAutoRefresh(); startTrackingRefresh();
}

async function restoreSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('altegroSession') || 'null');
    if (!saved?.token || !saved?.user) return false;
    const response = await fetch('/api/v1/auth/session', { headers:{ Authorization:`Bearer ${saved.token}` } });
    if (!response.ok) throw new Error('Saved session is no longer valid');
    const payload = await response.json();
    state.token = saved.token; state.user = payload.user; showApp(); await refreshAll(); startAutoRefresh(); startTrackingRefresh();
    return true;
  } catch {
    sessionStorage.removeItem('altegroSession'); state.token = null; state.user = null;
    return false;
  }
}

function logout() {
  const token = state.token; if (token) fetch('/api/v1/auth/logout', { method:'POST', headers:{ Authorization:`Bearer ${token}` } }).catch(() => {});
  expireSession('');
}

async function loadRobots() {
  const params = new URLSearchParams(); const query = $('#searchInput').value.trim(); const status = $('#statusFilter').value; const live = $('#liveFilter').value; const [sort, order] = $('#sortRobots').value.split(':');
  if (query) params.set('q', query); if (status) params.set('status', status); if (live) params.set('live', live); params.set('sort', sort); params.set('order', order); params.set('page', state.registry.page); params.set('pageSize', state.registry.pageSize);
  const payload = await api(`/api/v1/robots?${params}`); state.robots = payload.data;
  state.registry = { ...state.registry, ...payload.pagination, count:payload.count };
  $('#robotCount').textContent = payload.count; $('#metricTotal').textContent = payload.facets.total;
  $('#metricActive').textContent = payload.facets.active; $('#metricDraft').textContent = payload.facets.draft;
  $('#paginationSummary').textContent = payload.count ? `Showing ${payload.pagination.from}–${payload.pagination.to} of ${payload.count}` : '0 robots'; $('#pageIndicator').textContent = `Page ${payload.pagination.page} of ${payload.pagination.pageCount}`; $('#previousPage').disabled = payload.pagination.page <= 1; $('#nextPage').disabled = payload.pagination.page >= payload.pagination.pageCount;
  renderRobots();
  if (state.selectedRobotId && state.robots.some((robot) => robot.id === state.selectedRobotId)) await loadPassport(state.selectedRobotId);
}

function renderRobots() {
  const table = $('#robotTable');
  if (!state.robots.length) { table.innerHTML = '<tr><td colspan="6" class="empty">No robots match this filter.</td></tr>'; return; }
  table.innerHTML = state.robots.map((robot) => `<tr>
    <td><div class="robot-id">${escapeHtml(robot.serialNumber)}</div><div class="serial">${escapeHtml(robot.id)}</div></td>
    <td><div class="model-name">${escapeHtml(robot.modelId.replace('model-', '').replaceAll('-', ' '))}</div><div class="model-maker">${escapeHtml(robot.externalIdentities[0]?.system || 'manual')}</div></td>
    <td><div class="site-name">${escapeHtml(robot.siteId)}</div><div class="serial">${escapeHtml(robot.tenantId)}</div></td>
    <td><span class="status status-${escapeHtml(robot.status)}">${escapeHtml(robot.status)}</span></td>
    <td><div class="live-state ${robot.online === false ? 'offline' : robot.online === true ? 'online' : ''}">${robot.online === true ? 'Online' : robot.online === false ? 'Offline' : 'Not synced'}</div><div class="serial">${robot.battery != null ? `Battery ${escapeHtml(robot.battery)}%` : 'Battery —'}</div></td>
    <td><button class="view-button" data-robot-id="${escapeHtml(robot.id)}" aria-label="View Passport for ${escapeHtml(robot.serialNumber)}">View →</button></td>
  </tr>`).join('');
  table.querySelectorAll('[data-robot-id]').forEach((button) => button.addEventListener('click', () => loadPassport(button.dataset.robotId)));
}

async function loadPassport(robotId) {
  try {
    const payload = await api(`/api/v1/robots/${robotId}/passport`); state.selectedRobotId = robotId; renderPassport(payload.data);
  } catch (error) { toast(error.message, true); }
}

function renderPassport(passport) {
  const robot = passport.robot; const model = passport.model || {}; const entries = [...(passport.entries || [])].reverse(); const technicalEvents = entries.filter((entry) => entry.type === 'technical_event'); const documents = passport.documents || []; const certificates = passport.certificates || []; const deployments = passport.deployments || []; const cases = passport.serviceCases || []; const compatibility = passport.compatibility || []; const workforce = passport.workforce || { requirements:{ requiredSkills:[], requiredCertificates:[] }, assignedTechnicians:[] };
  const compactRecords = (items, empty, formatter) => items.length ? items.slice().reverse().slice(0, 5).map(formatter).join('') : `<div class="serial provider-empty">${empty}</div>`;
  $('#passportContent').className = 'passport-body';
  $('#passportContent').innerHTML = `<div class="passport-title"><div><p class="eyebrow">Immutable Altegro identity</p><h3>${escapeHtml(robot.serialNumber)}</h3><div class="identity-code">${escapeHtml(robot.id)}</div></div><span class="status status-${escapeHtml(robot.status)}">${escapeHtml(robot.status)}</span></div>
    <div class="progress-row"><div class="progress-label"><span>Passport completeness</span><strong>${passport.completeness.percentage}%</strong></div><div class="progress"><span style="width:${passport.completeness.percentage}%"></span></div></div>
    <dl class="detail-grid"><div><dt>Manufacturer</dt><dd>${escapeHtml(model.manufacturer || '—')}</dd></div><div><dt>Model</dt><dd>${escapeHtml(model.model || '—')}</dd></div><div><dt>Owner</dt><dd>${escapeHtml(passport.owner?.name || '—')}</dd></div><div><dt>Operator</dt><dd>${escapeHtml(passport.operator?.name || '—')}</dd></div><div><dt>Site</dt><dd>${escapeHtml(passport.site?.name || '—')}</dd></div><div><dt>External ID</dt><dd>${escapeHtml(robot.externalIdentities[0]?.externalId || '—')}</dd></div><div><dt>AutoXing status</dt><dd>${robot.online === true ? 'Online' : robot.online === false ? 'Offline' : 'Not synced'}</dd></div><div><dt>Battery</dt><dd>${robot.battery != null ? `${escapeHtml(robot.battery)}%` : '—'}</dd></div><div><dt>Mapping</dt><dd>${escapeHtml(robot.mappingStatus || '—')}</dd></div><div><dt>Provider version</dt><dd>${escapeHtml(robot.providerVersion || '—')}</dd></div></dl>
    <div class="passport-actions wrap-actions"><button class="button secondary" id="blockedCommand">Test command gate</button><button class="button secondary" id="exportPassport">Export JSON</button><button class="button secondary" id="addLifecycleButton">＋ Evidence</button><button class="button secondary" id="openIncidentButton">＋ Incident</button><button class="button primary" id="syncSelected">Sync adapter</button></div>
    <div id="autoxingDetails" class="integration-detail"><div class="subhead"><h4>AutoXing read-only data</h4></div><div class="empty">Loading POIs, areas, maps and task data…</div></div>
    <div class="passport-section-grid">
      <section><div class="subhead"><h4>Documents</h4><span class="count-pill">${documents.length}</span></div>${compactRecords(documents, 'No documents recorded.', (item) => `<div class="mini-record"><strong>${escapeHtml(item.title)}</strong><small>v${escapeHtml(item.version)}${item.attachment ? ` · ${escapeHtml(item.attachment.name)} · SHA-256 ${escapeHtml(item.attachment.sha256.slice(0, 10))}…` : ''}</small></div>`)}</section>
      <section><div class="subhead"><h4>Certificates</h4><span class="count-pill">${certificates.length}</span></div>${compactRecords(certificates, 'No certificates recorded.', (item) => `<div class="mini-record"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.issuer)} · expires ${formatDate(item.validUntil)}</small></div>`)}</section>
      <section><div class="subhead"><h4>Deployments</h4><span class="count-pill">${deployments.length}</span></div>${compactRecords(deployments, 'No deployment evidence.', (item) => `<div class="mini-record"><strong>${escapeHtml(item.packageName)} · ${escapeHtml(item.version)}</strong><small>${escapeHtml(item.status)}${item.rollbackVersion ? ` · rollback ${escapeHtml(item.rollbackVersion)}` : ''}</small></div>`)}</section>
      <section><div class="subhead"><h4>Service cases</h4><span class="count-pill">${cases.length}</span></div>${compactRecords(cases, 'No service cases linked.', (item) => `<div class="mini-record"><strong>${escapeHtml(item.title || item.externalId)}</strong><small>${escapeHtml(item.status)} · ${escapeHtml(item.assignedTo || 'unassigned')}</small></div>`)}</section>
      <section><div class="subhead"><h4>Work requirements</h4><span class="count-pill">${(workforce.requirements.requiredSkills || []).length + (workforce.requirements.requiredCertificates || []).length}</span></div><div class="mini-record"><strong>Skills</strong><small>${(workforce.requirements.requiredSkills || []).map((item) => escapeHtml(item.replaceAll('_',' '))).join(', ') || 'No required skills'}</small></div><div class="mini-record"><strong>Certificates</strong><small>${(workforce.requirements.requiredCertificates || []).map((item) => escapeHtml(item.replaceAll('_',' '))).join(', ') || 'No required certificates'}</small></div></section>
      <section><div class="subhead"><h4>Assigned technicians</h4><span class="count-pill">${workforce.assignedTechnicians.length}</span></div>${compactRecords(workforce.assignedTechnicians, 'No technicians assigned.', (item) => `<div class="mini-record"><strong>${escapeHtml(item.technician.name)}</strong><small>${escapeHtml(item.technician.jobTitle || 'Service Technician')} · ${escapeHtml(item.eligibility.status.replaceAll('_',' '))} · ${escapeHtml(item.technician.email)}</small></div>`)}</section>
    </div>
    <div class="subhead"><h4>Compatibility</h4><span class="serial">${compatibility.length} model records</span></div><div class="compatibility-chips">${compatibility.map((item) => `<span class="compatibility-${escapeHtml(item.status)}">${escapeHtml(item.capability)} · ${escapeHtml(item.status.replaceAll('_', ' '))}</span>`).join('') || '<span class="serial">No compatibility records.</span>'}</div>
    <div class="subhead"><h4>Technical event timeline</h4><span class="serial">${technicalEvents.length} events</span></div>
    <div class="entries">${technicalEvents.length ? technicalEvents.slice(0, 8).map((entry) => `<div class="entry"><div class="entry-type">${escapeHtml(entry.data?.title || entry.data?.eventType || 'Technical event')}</div><div class="entry-meta"><span class="entry-source">${escapeHtml(entry.data?.sourceSystem || entry.source)}</span> · ${formatDate(entry.data?.occurredAt || entry.occurredAt)} · ${escapeHtml(entry.data?.severity || 'info')}</div>${entry.data?.description ? `<div class="entry-description">${escapeHtml(entry.data.description)}</div>` : ''}${entry.data?.attachment ? `<button class="text-button attachment-button" data-event-attachment="${escapeHtml(entry.data.eventId)}">Download ${escapeHtml(entry.data.attachment.name)}</button>` : ''}</div>`).join('') : '<div class="empty">No technical events.</div>'}</div>
    <div class="subhead"><h4>Lifecycle history</h4><div><button class="text-button" id="addEventButton">＋ Add event</button><span class="serial">${entries.length} entries</span></div></div>
    <div class="entries">${entries.length ? entries.slice(0, 8).map((entry) => `<div class="entry"><div class="entry-type">${escapeHtml(entry.data?.title || entry.type.replaceAll('_', ' '))}</div><div class="entry-meta"><span class="entry-source">${escapeHtml(entry.source)}</span> · ${formatDate(entry.occurredAt)}${entry.data?.severity ? ` · ${escapeHtml(entry.data.severity)}` : ''}</div>${entry.data?.description ? `<div class="entry-description">${escapeHtml(entry.data.description)}</div>` : ''}</div>`).join('') : '<div class="empty">No Passport entries.</div>'}</div>`;
  $('#blockedCommand').addEventListener('click', async () => { try { await api(`/api/v1/robots/${robot.id}/commands`, { method:'POST', body:JSON.stringify({ command:'move' }) }); } catch (error) { toast(`Expected Phase 1 rejection: ${error.message}`); } });
  $('#exportPassport').addEventListener('click', () => download(`/api/v1/robots/${robot.id}/export`, `altegro-passport-${robot.serialNumber}.json`).catch((error) => toast(error.message, true)));
  $('#syncSelected').addEventListener('click', () => syncAdapter(robot.externalIdentities[0]?.system || 'mock-oem'));
  $('#addEventButton').addEventListener('click', () => openEventDialog(robot.id));
  $('#openIncidentButton').addEventListener('click', () => openIncidentDialog(robot.id));
  $('#addLifecycleButton').addEventListener('click', () => openLifecycleDialog(robot.id));
  document.querySelectorAll('[data-event-attachment]').forEach((button) => button.addEventListener('click', () => download(`/api/v1/events/${button.dataset.eventAttachment}/attachment`, 'event-attachment').catch((error) => toast(error.message, true))));
  if (state.user.role === 'robot_user') ['blockedCommand', 'exportPassport', 'syncSelected', 'addEventButton', 'openIncidentButton', 'addLifecycleButton'].forEach((id) => $(`#${id}`).classList.add('hidden'));
  if (state.user.role === 'auditor') ['blockedCommand', 'syncSelected', 'addEventButton', 'openIncidentButton', 'addLifecycleButton'].forEach((id) => $(`#${id}`).classList.add('hidden'));
  loadAutoXingDetails(robot);
}

async function loadAutoXingDetails(robot) {
  const panel = $('#autoxingDetails');
  if (!panel || robot.externalIdentities?.[0]?.system !== 'autoxing') return;
  try {
    const payload = await api(`/api/v1/robots/${robot.id}/autoxing`);
    const status = payload.data.status || {};
    const resources = payload.data.resources || {};
    const poiCount = (resources.pois?.items || []).length;
    const areaCount = (resources.areas?.items || []).length;
    const mapCount = (resources.maps || []).length;
    const taskCount = (resources.tasks || []).length;
    const latestTasks = (resources.tasks || []).slice(0, 5);
    const map = resources.maps?.find((item) => item.baseMap?.contentBase64);
    panel.innerHTML = `<div class="subhead"><h4>AutoXing read-only data</h4><span class="serial">Synced ${formatDate(resources.syncedAt)}</span></div>
      <div class="detail-grid compact-grid"><div><dt>Emergency stop</dt><dd class="${status.emergencyStop ? 'danger-text' : 'safe-text'}">${status.emergencyStop === true ? 'Active' : status.emergencyStop === false ? 'Clear' : '—'}</dd></div><div><dt>Obstruction</dt><dd class="${status.obstruction ? 'danger-text' : 'safe-text'}">${status.obstruction === true ? 'Detected' : status.obstruction === false ? 'Clear' : '—'}</dd></div><div><dt>Position</dt><dd>${status.position?.x != null ? `${escapeHtml(status.position.x)}, ${escapeHtml(status.position.y)}` : '—'}</dd></div><div><dt>Speed</dt><dd>${status.speed != null ? escapeHtml(status.speed) : '—'}</dd></div><div><dt>POIs</dt><dd>${poiCount}</dd></div><div><dt>Areas</dt><dd>${areaCount}</dd></div><div><dt>Maps</dt><dd>${mapCount}</dd></div><div><dt>Tasks</dt><dd>${taskCount}</dd></div></div>
      ${status.errors ? `<div class="provider-errors"><strong>Detailed errors</strong><pre>${escapeHtml(JSON.stringify(status.errors, null, 2))}</pre></div>` : ''}
      ${latestTasks.length ? `<div class="provider-tasks"><strong>Task history/status</strong>${latestTasks.map((task) => `<div class="provider-task"><span>${escapeHtml(task.taskId || 'Unknown task')}</span><small>${escapeHtml(JSON.stringify(task.status || task.raw || {}).slice(0, 180))}</small></div>`).join('')}</div>` : '<div class="serial provider-empty">No AutoXing task history returned.</div>'}
      ${map ? `<div class="provider-map"><strong>Base map</strong><img alt="AutoXing base map" src="data:${escapeHtml(map.baseMap.contentType)};base64,${map.baseMap.contentBase64}" /></div>` : ''}`;
  } catch (error) {
    panel.innerHTML = `<div class="subhead"><h4>AutoXing read-only data</h4></div><div class="adapter-error">${escapeHtml(error.message)}</div>`;
  }
}

function readAttachment(file) {
  if (!file) return Promise.resolve(null);
  if (file.size > 2 * 1024 * 1024) return Promise.reject(new Error('Attachment is limited to 2 MB'));
  const extension = `.${file.name.split('.').pop()?.toLowerCase()}`; const allowedExtensions = new Set(['.pdf','.json','.txt','.csv','.png','.jpg','.jpeg','.webp']);
  if (!allowedExtensions.has(extension) || /[\\/\u0000-\u001f]/.test(file.name)) return Promise.reject(new Error('Choose a PDF, image, text, CSV, or JSON file with a safe filename'));
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, contentType: file.type || 'application/octet-stream', contentBase64: String(reader.result).split(',')[1] }); reader.onerror = () => reject(new Error('Could not read attachment')); reader.readAsDataURL(file); });
}

function openEventDialog(robotId) {
  const dialog = $('#eventDialog'); dialog.dataset.robotId = robotId; $('#eventOccurredAt').value = toDateTimeLocal(); $('#eventSource').value = 'manual-portal'; $('#eventAttachment').value = ''; dialog.showModal();
}

function openIncidentDialog(robotId) {
  const dialog = $('#incidentDialog'); dialog.dataset.robotId = robotId; $('#incidentTitle').value = ''; $('#incidentDescription').value = ''; $('#incidentAssignedTo').value = ''; $('#incidentSeverity').value = 'warning'; dialog.showModal();
}

function updateLifecycleFields() {
  const type = $('#lifecycleType').value; const isDocument = type === 'document'; const isCertificate = type === 'certificate'; const isDeployment = type === 'deployment';
  $('#lifecycleIssuerField').classList.toggle('hidden', !isCertificate); $('#lifecycleExpiryField').classList.toggle('hidden', !isCertificate); $('#lifecycleAttachmentField').classList.toggle('hidden', !isDocument); $('#lifecycleStatusField').classList.toggle('hidden', isDocument); $('#lifecycleVersionField').classList.toggle('hidden', isCertificate);
  $('#lifecycleStatus').innerHTML = isCertificate ? '<option value="valid">Valid</option><option value="pending">Pending</option><option value="expired">Expired</option><option value="revoked">Revoked</option>' : isDeployment ? '<option value="planned">Planned</option><option value="approved">Approved</option><option value="deployed">Deployed</option><option value="verified">Verified</option><option value="failed">Failed</option><option value="rolled_back">Rolled back</option>' : '';
}

function openLifecycleDialog(robotId) {
  const dialog = $('#lifecycleDialog'); dialog.dataset.robotId = robotId; $('#lifecycleType').value = 'document'; $('#lifecycleTitle').value = ''; $('#lifecycleVersion').value = '1.0'; $('#lifecycleIssuer').value = ''; $('#lifecycleValidUntil').value = ''; $('#lifecycleDescription').value = ''; $('#lifecycleAttachment').value = ''; updateLifecycleFields(); dialog.showModal();
}

async function loadEvents() {
  const params = new URLSearchParams({ limit:'50' }); const robotId = $('#eventRobotFilter').value; const severity = $('#eventSeverityFilter').value; const eventType = $('#eventTypeFilter').value; const from = $('#eventFromFilter').value; const to = $('#eventToFilter').value;
  if (robotId) params.set('robotId', robotId); if (severity) params.set('severity', severity); if (eventType) params.set('eventType', eventType); if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString()); if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
  const payload = await api(`/api/v1/events?${params}`);
  $('#eventsList').innerHTML = payload.data.length ? payload.data.map((event) => `<div class="event-item"><div class="event-main"><strong>${escapeHtml(event.title || event.eventType.replaceAll('_', ' '))}</strong><small>${escapeHtml(event.eventType)} · ${escapeHtml(event.sourceSystem)} · ${escapeHtml(event.robotId.slice(0, 8))}…</small>${event.description ? `<small>${escapeHtml(event.description)}</small>` : ''}${event.attachment ? `<button class="text-button attachment-button" data-event-attachment="${escapeHtml(event.eventId)}">Download ${escapeHtml(event.attachment.name)}</button>` : ''}</div><span class="event-time">${escapeHtml(event.severity)}<br />${formatDate(event.occurredAt)}</span></div>`).join('') : '<div class="empty">No events match these filters.</div>';
  $('#eventsList').querySelectorAll('[data-event-attachment]').forEach((button) => button.addEventListener('click', () => download(`/api/v1/events/${button.dataset.eventAttachment}/attachment`, 'event-attachment').catch((error) => toast(error.message, true))));
}

async function loadOperationsSummary() {
  const payload = await api('/api/v1/operations/summary'); state.summary = payload.data;
  $('#metricEvents').textContent = payload.data.events.total;
  $('#metricOnline').textContent = payload.data.robots.online;
  $('#metricOffline').textContent = payload.data.robots.offline;
  $('#metricErrors').textContent = payload.data.events.activeErrors;
  $('#metricMaintenanceDue').textContent = payload.data.events.maintenanceDue;
  $('#metricOpenCases').textContent = payload.data.service.open;
  $('#metricPassportComplete').textContent = `${payload.data.passport.percentage}%`;
  $('#metricCertificatesDue').textContent = payload.data.passport.certificatesDue;
}

async function loadNotifications() {
  const payload = await api('/api/v1/notifications'); state.notifications = payload.data;
  updateNotificationBadge(payload.unreadCount ?? payload.activeCount ?? payload.count);
  renderNotifications();
}

function updateNotificationBadge(count=0) { state.notificationUnreadCount=Math.max(0,Number(count) || 0); const badge=$('#notificationCount'); badge.textContent=state.notificationUnreadCount > 99 ? '99+' : String(state.notificationUnreadCount); badge.classList.toggle('hidden',state.notificationUnreadCount === 0); $('#notificationsButton').setAttribute('aria-label',state.notificationUnreadCount ? `Open operational notifications, ${state.notificationUnreadCount} unread` : 'Open operational notifications'); }

async function markVisibleNotificationsRead() { const notificationIds=state.notifications.filter((item) => !item.read).map((item) => item.id); if (!notificationIds.length) return updateNotificationBadge(0); const payload=await api('/api/v1/notifications/read',{ method:'POST',body:JSON.stringify({ notificationIds }) }); const readAt=payload.readAt || new Date().toISOString(); state.notifications=state.notifications.map((item) => notificationIds.includes(item.id) ? { ...item,read:true,readAt } : item); updateNotificationBadge(payload.unreadCount); }

function renderNotifications() {
  const query=$('#notificationSearch')?.value.trim().toLowerCase() || ''; const severity=$('#notificationSeverity')?.value || ''; const status=$('#notificationStatus')?.value || ''; const writable=!['robot_user','auditor'].includes(state.user.role);
  const data=state.notifications.filter((item) => (!query || [item.title,item.message,item.type,item.workflow?.technicianName].some((value) => String(value || '').toLowerCase().includes(query))) && (!severity || item.severity === severity) && (!status || item.workflow?.status === status));
  const list = $('#notificationsList');
  list.innerHTML = data.length ? data.map((item) => `<article class="notification-item ${escapeHtml(item.severity)}"><span class="notification-dot" aria-hidden="true"></span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p><small>${escapeHtml((item.workflow?.status || 'open').replaceAll('_',' '))}${item.workflow?.technicianName ? ` · ${escapeHtml(item.workflow.technicianName)}` : ''}${item.workflow?.snoozeUntil ? ` · until ${formatDate(item.workflow.snoozeUntil)}` : ''}</small></div><time datetime="${escapeHtml(item.occurredAt)}">${formatDate(item.occurredAt)}</time><div class="notification-actions">${item.robotId ? `<button type="button" class="text-button" data-notification-robot="${escapeHtml(item.robotId)}">Open robot</button>` : ''}${writable ? `<button type="button" class="text-button" data-manage-notification="${escapeHtml(item.id)}">Manage</button>` : ''}</div></article>`).join('') : '<div class="empty">No notifications match these filters.</div>';
  list.querySelectorAll('[data-notification-robot]').forEach((button) => button.addEventListener('click', async () => { $('#notificationsDialog').close(); setDashboardView('robots'); await loadPassport(button.dataset.notificationRobot); $('#detailPanel').scrollIntoView({ behavior:'smooth', block:'start' }); }));
  list.querySelectorAll('[data-manage-notification]').forEach((button) => button.addEventListener('click',() => openNotificationWorkflow(button.dataset.manageNotification)));
}

function updateNotificationSnoozeField() { const snoozed=$('#notificationWorkflowStatus').value === 'snoozed'; $('#notificationSnoozeField').classList.toggle('hidden',!snoozed); if (snoozed && !$('#notificationSnoozeUntil').value) $('#notificationSnoozeUntil').value=toDateTimeLocal(new Date(Date.now()+3600000)); }

function openNotificationWorkflow(notificationId) {
  const item=state.notifications.find((notification) => notification.id === notificationId); if (!item) return; state.selectedNotificationId=notificationId; $('#notificationWorkflowTitle').textContent=item.title; $('#notificationWorkflowDescription').textContent=item.message; $('#notificationWorkflowStatus').value=item.workflow?.status === 'snoozed' ? 'snoozed' : item.workflow?.status || 'acknowledged'; $('#notificationSnoozeUntil').value=item.workflow?.snoozeUntil ? toDateTimeLocal(new Date(item.workflow.snoozeUntil)) : ''; $('#notificationWorkflowNote').value=item.workflow?.note || ''; const technicians=state.workforce?.technicians || []; $('#notificationTechnician').innerHTML='<option value="">Not assigned</option>'+technicians.map((technician) => `<option value="${escapeHtml(technician.id)}">${escapeHtml(technician.name)}</option>`).join(''); $('#notificationTechnician').value=item.workflow?.technicianId || ''; updateNotificationSnoozeField(); $('#notificationsDialog').close(); $('#notificationWorkflowDialog').showModal();
}

function filteredTrackingFleet() {
  const robotId=$('#trackingRobotFilter').value; const status=$('#trackingStatusFilter').value; return (state.tracking?.fleet || []).filter((robot) => { const matchesStatus=!status || status === 'stale' && robot.stale || status === 'online' && robot.online === true || status === 'offline' && robot.online === false; return (!robotId || robot.id === robotId) && matchesStatus; });
}

function renderTracking() {
  if (!state.tracking) return; const data=state.tracking; const fleet=filteredTrackingFleet(); const metric=(value,label) => `<div class="resource-metric"><strong>${value}</strong><span>${label}</span></div>`; $('#trackingMetrics').innerHTML=metric(data.summary.total,'Robots')+metric(data.summary.online,'Online')+metric(data.summary.moving,'Moving')+metric(data.summary.located,'Located')+metric(data.summary.stale,'Stale'); const select=$('#trackingRobotFilter'); const selected=select.value; select.innerHTML='<option value="">All visible robots</option>'+data.fleet.map((robot) => `<option value="${escapeHtml(robot.id)}">${escapeHtml(robot.serialNumber)}</option>`).join(''); if (data.fleet.some((robot) => robot.id === selected)) select.value=selected;
  const located=fleet.filter((robot) => robot.position); if (located.length) { const xs=located.map((robot) => robot.position.x); const ys=located.map((robot) => robot.position.y); const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys); const scale=(value,min,max) => max === min ? 50 : 8+(value-min)/(max-min)*84; $('#trackingCanvas').innerHTML=located.map((robot) => `<div class="tracking-marker ${robot.online === false ? 'offline' : ''} ${robot.stale ? 'stale' : ''}" style="left:${scale(robot.position.x,minX,maxX)}%;top:${100-scale(robot.position.y,minY,maxY)}%" title="${escapeHtml(robot.serialNumber)}: ${robot.position.x.toFixed(2)}, ${robot.position.y.toFixed(2)}"><span>${escapeHtml(robot.serialNumber)}</span>${escapeHtml(robot.provider.slice(0,1).toUpperCase())}</div>`).join(''); $('#trackingCanvas').setAttribute('aria-label',`${located.length} robot positions. ${located.map((robot) => `${robot.serialNumber} at X ${robot.position.x.toFixed(1)}, Y ${robot.position.y.toFixed(1)}`).join('. ')}`); } else $('#trackingCanvas').innerHTML='<div class="empty">No provider coordinates match this filter.</div>';
  $('#trackingFleetList').innerHTML=fleet.length ? fleet.map((robot) => `<article class="tracking-row"><div><strong>${escapeHtml(robot.serialNumber)}</strong><small>${escapeHtml(robot.provider)} · ${escapeHtml(robot.siteId || 'No site')} · updated ${formatDate(robot.updatedAt)}</small><small>${robot.currentTask ? `Task: ${escapeHtml(robot.currentTask.name || robot.currentTask.status || robot.currentTask.taskStatus || 'running')}` : 'No active task'}</small></div><div><span class="status status-${robot.online === true ? 'active' : 'draft'}">${robot.online === true ? 'Online' : robot.online === false ? 'Offline' : 'Unknown'}</span><small>${robot.position ? `X ${robot.position.x.toFixed(2)} · Y ${robot.position.y.toFixed(2)}` : 'No coordinates'}${robot.speed == null ? '' : ` · ${robot.speed.toFixed(2)} m/s`}</small><small>${robot.battery == null ? 'Battery unknown' : `${robot.battery}% battery`}${robot.stale ? ' · stale' : ''}</small></div></article>`).join('') : '<div class="empty">No robots match this tracking filter.</div>'; $('#trackingRefreshStatus').textContent=`Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour:'2-digit',minute:'2-digit',second:'2-digit' })}`;
}

async function loadTracking() { const payload=await api('/api/v1/tracking/live'); state.tracking=payload.data; state.trackingRefresh.intervalMs=payload.data.refreshIntervalMs || 10000; renderTracking(); }

function startTrackingRefresh() { clearInterval(state.trackingRefresh.timer); state.trackingRefresh.timer=setInterval(() => { if (!state.token || document.hidden) return; loadTracking().catch((error) => { if (error.status !== 401) $('#trackingRefreshStatus').textContent=`Tracking paused · ${error.message}`; }); },state.trackingRefresh.intervalMs); }

async function loadReports() {
  const days=Number($('#reportPeriod').value || 30); const payload=await api(`/api/v1/reports/operations?days=${days}`); state.reports=payload.data; const data=payload.data; const metric=(value,suffix='') => value == null ? '—' : `${value}${suffix}`;
  $('#reportMetrics').innerHTML=`<div class="resource-metric"><strong>${metric(data.fleet.availabilityPercent,'%')}</strong><span>Current availability</span></div><div class="resource-metric"><strong>${metric(data.fleet.averageBattery,'%')}</strong><span>Average battery</span></div><div class="resource-metric"><strong>${metric(data.tasks.successRate,'%')}</strong><span>Task success</span></div><div class="resource-metric"><strong>${metric(data.tasks.cleanedArea,' m²')}</strong><span>Cleaned area</span></div><div class="resource-metric"><strong>${data.service.casesOpened}</strong><span>Cases opened</span></div><div class="resource-metric"><strong class="${data.service.overdue ? 'danger-text' : ''}">${data.service.overdue}</strong><span>Maintenance overdue</span></div>`;
  $('#advancedAnalytics').innerHTML=`<article class="analytics-card"><h3>Fleet health</h3><p><span>Health score</span><strong>${metric(data.fleet.healthScore,'%')}</strong></p><p><span>Needs attention</span><strong>${data.fleet.attentionRobots}</strong></p><p><span>Low battery</span><strong>${data.fleet.lowBattery}</strong></p></article><article class="analytics-card"><h3>Service performance</h3><p><span>Closure rate</span><strong>${metric(data.service.caseClosureRate,'%')}</strong></p><p><span>Average resolution</span><strong>${metric(data.service.averageResolutionHours,' h')}</strong></p><p><span>Incidents / robot</span><strong>${metric(data.events.incidentsPerRobot)}</strong></p></article><article class="analytics-card"><h3>Provider & workforce</h3>${data.fleet.providers.map((item) => `<p><span>${escapeHtml(item.provider)}</span><strong>${item.count}</strong></p>`).join('')}<p><span>Technician availability</span><strong>${metric(data.workforce.availabilityPercent,'%')}</strong></p></article>`;
  const daily=data.daily || []; const max=Math.max(1,...daily.map((item) => item.events)); $('#reportTrend').innerHTML=daily.map((item) => `<div class="report-day" title="${escapeHtml(item.date)}: ${item.events} events, ${item.errors} errors"><span style="height:${Math.max(3,item.events/max*100)}%" class="${item.errors ? 'has-error' : ''}"></span><small>${escapeHtml(item.date.slice(5))}</small></div>`).join(''); $('#reportTrendSummary').textContent=`Daily trend for ${daily.length} days: ${daily.reduce((sum,item) => sum+item.events,0)} events, ${daily.reduce((sum,item) => sum+item.errors,0)} errors, and ${daily.reduce((sum,item) => sum+item.tasks,0)} tasks.`;
}

async function loadServiceCases() {
  const payload = await api('/api/v1/service-cases'); state.serviceCases = payload.data;
  const writable = !['robot_user', 'auditor'].includes(state.user.role); const nextStatus = { open:'in_progress', in_progress:'waiting', waiting:'resolved', resolved:'closed' };
  $('#serviceCasesList').innerHTML = payload.data.length ? payload.data.slice().reverse().map((item) => `<div class="record-row"><div><strong>${escapeHtml(item.title || item.externalId)}</strong><small>${escapeHtml(item.externalId)} · ${escapeHtml(item.status.replaceAll('_', ' '))} · ${escapeHtml(item.assignedTo || 'unassigned')}</small></div>${writable && nextStatus[item.status] ? `<button class="text-button" data-service-id="${escapeHtml(item.id)}" data-service-status="${nextStatus[item.status]}">Move to ${escapeHtml(nextStatus[item.status].replaceAll('_', ' '))}</button>` : `<span class="status status-${item.status === 'closed' ? 'active' : 'draft'}">${escapeHtml(item.status)}</span>`}</div>`).join('') : '<div class="empty">No service cases yet. Open an incident from a Robot Passport.</div>';
  document.querySelectorAll('[data-service-id]').forEach((button) => button.addEventListener('click', async () => { try { const closing = button.dataset.serviceStatus === 'closed'; await api(`/api/v1/service-cases/${button.dataset.serviceId}`, { method:'PATCH', body:JSON.stringify({ status:button.dataset.serviceStatus, action:closing ? 'Service work completed and verified.' : undefined }) }); toast(`Service case moved to ${button.dataset.serviceStatus.replaceAll('_', ' ')}`); await refreshAll(); } catch (error) { toast(error.message, true); } }));
}

function renderSupportTickets() {
  const status=$('#supportStatusFilter').value; const tickets=state.supportTickets.filter((ticket) => !status || ticket.status === status); const list=$('#supportTicketsList');
  list.innerHTML=tickets.length ? tickets.map((ticket) => `<article class="support-ticket"><div><h3>${escapeHtml(ticket.title)}</h3><small>${escapeHtml(ticket.externalId)} · ${escapeHtml(ticket.robotSerialNumber || 'Robot')} · ${escapeHtml(ticket.category || 'technical')}</small><p>${escapeHtml(ticket.description)}</p><small>${ticket.messages?.length || 0} update${ticket.messages?.length === 1 ? '' : 's'} · updated ${formatDate(ticket.updatedAt)}</small></div><div class="support-ticket-actions"><span class="status status-${ticket.status === 'closed' || ticket.status === 'resolved' ? 'active' : 'draft'}">${escapeHtml(ticket.status.replaceAll('_',' '))}</span><button class="text-button" type="button" data-support-reply="${escapeHtml(ticket.id)}">View / reply</button></div></article>`).join('') : '<div class="empty">No support tickets match this filter.</div>';
  list.querySelectorAll('[data-support-reply]').forEach((button) => button.addEventListener('click',() => openSupportReply(button.dataset.supportReply)));
}

async function loadSupportTickets() {
  const payload=await api('/api/v1/support/tickets'); state.supportTickets=payload.data; state.supportPermissions=payload.permissions; $('#newSupportTicket').classList.toggle('hidden',!payload.permissions.create); renderSupportTickets();
}

function openSupportReply(ticketId) {
  const ticket=state.supportTickets.find((item) => item.id === ticketId); if (!ticket) return; $('#supportReplyTicketId').value=ticket.id; $('#supportReplyTitle').textContent=`${ticket.externalId} · ${ticket.title}`; $('#supportReplyMessage').value=''; $('#supportReplyStatusField').classList.toggle('hidden',!state.supportPermissions?.manage); $('#supportReplyStatus').value=ticket.status;
  $('#supportReplyHistory').innerHTML=(ticket.messages || []).map((message) => `<article class="support-message"><strong>${escapeHtml(message.authorName || 'Support')}</strong><small>${escapeHtml((message.authorRole || '').replaceAll('_',' '))} · ${formatDate(message.createdAt)}</small><p>${escapeHtml(message.message)}</p></article>`).join('') || '<div class="empty">No conversation messages yet.</div>'; $('#supportReplyDialog').showModal();
}

async function loadCompatibility() {
  const payload = await api('/api/v1/compatibility'); state.compatibility = payload.data;
  $('#compatibilityList').innerHTML = payload.data.map((item) => `<div class="record-row"><div><strong>${escapeHtml(item.modelId.replace('model-', '').replaceAll('-', ' '))}</strong><small>${escapeHtml(item.capability)} · ${escapeHtml(item.versionConstraint)}${item.evidence ? ` · ${escapeHtml(item.evidence)}` : ''}</small></div><span class="compatibility-${escapeHtml(item.status)}">${escapeHtml(item.status.replaceAll('_', ' '))}</span></div>`).join('') || '<div class="empty">No compatibility records.</div>';
}

async function loadAudit() {
  const payload = await api('/api/v1/audit'); state.audit = payload.data;
  $('#auditList').innerHTML = payload.data.length ? payload.data.slice(-12).reverse().map((item) => `<div class="record-row"><div><strong>${escapeHtml(item.action.replaceAll('.', ' '))}</strong><small>${escapeHtml(item.actorName)} · ${escapeHtml(item.objectType)} · ${escapeHtml(item.result)}</small></div><time class="event-time" datetime="${escapeHtml(item.occurredAt)}">${formatDate(item.occurredAt)}</time></div>`).join('') : '<div class="empty">No visible audit activity yet.</div>';
}

async function loadAdapters() {
  const payload = await api('/api/v1/adapters');
  $('#adaptersList').innerHTML = payload.data.map((adapter) => `<div class="adapter-item"><div><strong>${escapeHtml(adapter.provider)}</strong><small>${escapeHtml(adapter.status)} · v${escapeHtml(adapter.version)}<br />Last sync: ${formatDate(adapter.lastSyncAt)} · ${escapeHtml(adapter.lastSyncStatus || '—')}</small>${adapter.lastError ? `<small class="adapter-error">${escapeHtml(adapter.lastError)}</small>` : ''}</div><div class="adapter-capabilities">Read: ${escapeHtml(adapter.capabilities.read.join(', '))}<br />Events: ${escapeHtml(adapter.capabilities.event.join(', ') || 'none')}<br /><b>Commands: ${escapeHtml(adapter.capabilities.command?.join(', ') || 'disabled')}</b></div></div>`).join('');
}

async function loadAutoXingResources() {
  if (state.user.role === 'robot_user') return;
  const payload = await api('/api/v1/adapters/autoxing/resources'); state.autoXingResources = payload.data;
  const data = payload.data; const warnings = data.resourceErrors || [];
  const namedResources = [...(data.businesses || []).slice(0, 4).map((item) => ({ kind:'Business', name:item.name || item.businessName || item.id || item.businessId || 'Unnamed business' })), ...(data.buildings || []).slice(0, 4).map((item) => ({ kind:'Building', name:item.name || item.buildingName || item.id || item.buildingId || 'Unnamed building' }))];
  $('#resourceExplorer').innerHTML = `<div class="resource-metrics"><div class="resource-metric"><strong>${(data.businesses || []).length}</strong><span>Businesses</span></div><div class="resource-metric"><strong>${(data.buildings || []).length}</strong><span>Buildings</span></div><div class="resource-metric"><strong>${(data.maps || []).length}</strong><span>Maps</span></div><div class="resource-metric"><strong>${warnings.length}</strong><span>Warnings</span></div></div>${warnings.map((warning) => `<div class="resource-warning">${escapeHtml(warning.message || warning.error || JSON.stringify(warning))}</div>`).join('')}${namedResources.map((item) => `<div class="mini-record"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.kind)}</small></div>`).join('') || '<div class="serial provider-empty">No fleet resources returned yet. Run AutoXing synchronization first.</div>'}<div class="serial provider-empty">Last resource sync: ${formatDate(data.syncedAt)}</div>`;
}

async function loadAutoXingTasks() {
  const robotId = $('#taskRobotFilter').value; const suffix = robotId ? `?robotId=${encodeURIComponent(robotId)}` : '';
  const payload = await api(`/api/v1/autoxing/tasks${suffix}`); state.autoXingTasks = payload.data;
  $('#taskHistoryList').innerHTML = payload.data.length ? payload.data.slice(0, 50).map((task) => { const robotExternalId = task.externalRobotId || task.robotId || task.raw?.robotId || task.raw?.robot_id || 'Unassigned'; const taskId = task.taskId || task.id || 'Unknown task'; const statusValue = task.status || task.taskStatus || task.raw?.status || 'unknown'; const status = typeof statusValue === 'object' ? JSON.stringify(statusValue).slice(0, 120) : String(statusValue); const occurredAt = task.updatedAt || task.createdAt || task.raw?.updatedAt || task.raw?.createdAt || payload.syncedAt; return `<button type="button" class="record-row task-detail-row" data-task-detail="${escapeHtml(taskId)}"><div><strong>${escapeHtml(taskId)}</strong><small>${escapeHtml(robotExternalId)} · ${escapeHtml(status)}</small></div><span><time class="event-time" datetime="${escapeHtml(occurredAt || '')}">${formatDate(occurredAt)}</time><small>View details →</small></span></button>`; }).join('') : '<div class="empty">No AutoXing tasks are available for this selection.</div>';
  $('#taskHistoryList').querySelectorAll('[data-task-detail]').forEach((button) => button.addEventListener('click',() => openTaskDetail(button.dataset.taskDetail)));
}

async function openTaskDetail(taskId) {
  const dialog=$('#taskDetailDialog'); $('#taskDetailTitle').textContent=`Task ${taskId}`; $('#taskDetailContent').innerHTML='<div class="empty">Loading task details…</div>'; dialog.showModal();
  try { const payload=await api(`/api/v1/autoxing/tasks/${encodeURIComponent(taskId)}`); const detail=payload.data; const normalized=detail.normalized || {}; $('#taskDetailContent').innerHTML=`<div class="task-detail-summary"><div><span>Robot</span><strong>${escapeHtml(detail.robot.serialNumber)}</strong></div><div><span>Status</span><strong>${escapeHtml(normalized.status || 'unknown')}</strong></div><div><span>Duration</span><strong>${normalized.durationMinutes == null ? '—' : `${Math.round(normalized.durationMinutes)} min`}</strong></div><div><span>Cleaned area</span><strong>${normalized.cleanedArea == null ? '—' : `${normalized.cleanedArea} m²`}</strong></div><div><span>Occurred</span><strong>${formatDate(normalized.occurredAt)}</strong></div><div><span>Last sync</span><strong>${formatDate(detail.syncedAt)}</strong></div></div><details class="provider-json"><summary>Provider response</summary><pre>${escapeHtml(JSON.stringify(detail.provider,null,2))}</pre></details>`; } catch(error){ $('#taskDetailContent').innerHTML=`<div class="resource-warning">${escapeHtml(error.message)}</div>`; }
}

function compactProviderValue(value, fallback = '—') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 90);
  return String(value);
}

function renderAutoXingFleet() {
  const fleet=state.autoXingOperations?.fleet || []; const filter=state.autoXingFleet; const query=filter.query.trim().toLowerCase();
  let filtered=fleet.filter((robot) => {
    const online=robot.online === true ? 'online' : robot.online === false ? 'offline' : 'unknown'; const battery=Number(robot.battery);
    if (query && ![robot.serialNumber,robot.externalId,robot.businessName,robot.siteId].some((value) => String(value || '').toLowerCase().includes(query))) return false;
    if (filter.status !== 'all' && online !== filter.status) return false;
    if (filter.alerts === 'alerts' && !robot.alertCount || filter.alerts === 'clear' && robot.alertCount) return false;
    if (filter.battery === 'low' && !(Number.isFinite(battery) && battery <= 20) || filter.battery === 'medium' && !(battery > 20 && battery <= 60) || filter.battery === 'high' && !(battery > 60)) return false;
    return true;
  });
  const pageCount=Math.max(1,Math.ceil(filtered.length/filter.pageSize)); filter.page=Math.min(filter.page,pageCount); const from=(filter.page-1)*filter.pageSize; const visible=filtered.slice(from,from+filter.pageSize);
  $('#autoXingLiveFleet').innerHTML = visible.length ? visible.map((robot) => { const battery = Number(robot.battery); const batteryValue = Number.isFinite(battery) ? Math.max(0,Math.min(100,battery)) : null; const task = compactProviderValue(robot.currentTask,'No active task'); const position = robot.position && [robot.position.x,robot.position.y].some((value) => value != null) ? `${robot.position.x ?? '—'}, ${robot.position.y ?? '—'}` : '—'; return `<button class="autoxing-live-card" type="button" data-autoxing-robot="${escapeHtml(robot.id)}"><div class="live-card-head"><div><strong>${escapeHtml(robot.serialNumber)}</strong><small>${escapeHtml(robot.externalId)}</small></div><span class="live-state ${robot.online === true ? 'online' : robot.online === false ? 'offline' : ''}">${robot.online === true ? 'Online' : robot.online === false ? 'Offline' : 'Unknown'}</span></div><div class="battery-row"><span>Battery</span><strong>${batteryValue == null ? '—' : `${batteryValue}%`}</strong></div><div class="battery-track"><span style="width:${batteryValue ?? 0}%"></span></div><dl class="live-card-details"><div><dt>Charging</dt><dd>${robot.charging === true ? 'Yes' : robot.charging === false ? 'No' : '—'}</dd></div><div><dt>Position</dt><dd>${escapeHtml(position)}</dd></div><div><dt>Speed</dt><dd>${robot.speed == null ? '—' : escapeHtml(robot.speed)}</dd></div><div><dt>Version</dt><dd>${escapeHtml(robot.providerVersion || '—')}</dd></div></dl><div class="live-task"><span>Current task</span><strong>${escapeHtml(task)}</strong></div><div class="live-card-foot"><span>${escapeHtml(robot.businessName || robot.siteId || 'Unmapped')}</span><span class="${robot.alertCount ? 'danger-text' : 'safe-text'}">${robot.alertCount ? `${robot.alertCount} alert${robot.alertCount === 1 ? '' : 's'}` : 'No alerts'}</span></div></button>`; }).join('') : `<div class="empty">${fleet.length ? 'No robots match these filters.' : 'No visible AutoXing robots. Run synchronization or review tenant access.'}</div>`;
  $('#autoXingLiveFleet').querySelectorAll('[data-autoxing-robot]').forEach((button) => button.addEventListener('click', async () => { setDashboardView('robots'); await loadPassport(button.dataset.autoxingRobot); $('#detailPanel').scrollIntoView({ behavior:'smooth',block:'start' }); }));
  $('#autoXingFleetPageSummary').textContent=filtered.length ? `${from+1}–${Math.min(from+filter.pageSize,filtered.length)} of ${filtered.length} robots` : '0 robots'; $('#autoXingFleetPage').textContent=`Page ${filter.page} of ${pageCount}`; $('#autoXingFleetPrevious').disabled=filter.page <= 1; $('#autoXingFleetNext').disabled=filter.page >= pageCount;
}

function renderAutoXingOperations() {
  const operations = state.autoXingOperations; if (!operations) return;
  const fleet = operations.fleet || []; const analytics = operations.taskAnalytics || {}; const diagnostics = operations.diagnostics || {}; const alerts = operations.alerts || []; const trends = operations.trends || [];
  renderAutoXingFleet();
  const metric = (value,suffix='') => value == null ? '—' : `${value}${suffix}`;
  $('#autoXingTaskAnalytics').innerHTML = `<div class="autoxing-analytics-grid"><div class="resource-metric"><strong>${metric(analytics.total)}</strong><span>Total tasks</span></div><div class="resource-metric"><strong>${metric(analytics.completed)}</strong><span>Completed</span></div><div class="resource-metric"><strong>${metric(analytics.failed)}</strong><span>Failed</span></div><div class="resource-metric"><strong>${metric(analytics.running)}</strong><span>Running</span></div><div class="resource-metric"><strong>${metric(analytics.successRate,'%')}</strong><span>Success rate</span></div><div class="resource-metric"><strong>${metric(analytics.averageDurationMinutes,' min')}</strong><span>Average duration</span></div><div class="resource-metric"><strong>${metric(analytics.cleanedArea,' m²')}</strong><span>Cleaned area</span></div></div>${analytics.total ? '' : '<div class="provider-empty serial">Task collection is enabled independently of POI/map sync. Run AutoXing synchronization to load task history.</div>'}`;
  const duration = diagnostics.lastSyncDurationMs == null ? '—' : diagnostics.lastSyncDurationMs < 1000 ? `${diagnostics.lastSyncDurationMs} ms` : `${(diagnostics.lastSyncDurationMs/1000).toFixed(1)} s`; const poll = diagnostics.pollingIntervalMs ? `${Math.round(diagnostics.pollingIntervalMs/60000)} min` : 'Disabled'; const history = (diagnostics.syncHistory || []).slice().reverse().slice(0,6);
  $('#autoXingDiagnostics').innerHTML = `<div class="diagnostic-grid"><div><span>Connector</span><strong>${diagnostics.liveEnabled ? 'Live wrapper' : 'Mock fallback'}</strong></div><div><span>Last result</span><strong class="${diagnostics.lastSyncStatus === 'success' ? 'safe-text' : diagnostics.lastSyncStatus === 'error' ? 'danger-text' : ''}">${escapeHtml(diagnostics.lastSyncStatus || 'Never')}</strong></div><div><span>Last duration</span><strong>${escapeHtml(duration)}</strong></div><div><span>Robots updated</span><strong>${diagnostics.lastSyncCount ?? '—'}</strong></div><div><span>Warnings</span><strong>${diagnostics.lastSyncWarnings || 0}</strong></div><div><span>Provider polling</span><strong>${escapeHtml(poll)}</strong></div><div><span>Next poll</span><strong>${formatDate(diagnostics.nextPollAt)}</strong></div><div><span>Secret source</span><strong>${escapeHtml((diagnostics.secretMode || 'unknown').replaceAll('-',' '))}</strong></div></div>${diagnostics.lastError ? `<div class="resource-warning">${escapeHtml(diagnostics.lastError)}</div>` : ''}<div class="sync-history">${history.map((item) => `<div><span class="status status-${item.status === 'success' ? 'active' : 'draft'}">${escapeHtml(item.status)}</span><span>${escapeHtml(item.trigger)} · ${item.count} robots · ${item.warnings} warnings</span><time>${formatDate(item.completedAt)}</time></div>`).join('') || '<div class="provider-empty serial">No synchronization history recorded yet.</div>'}</div>`;
  $('#autoXingAlertCount').textContent = alerts.length;
  const canManageAlerts=operations.alertWorkflow?.canManage; $('#autoXingAlerts').innerHTML = alerts.length ? alerts.slice(0,30).map((alert) => `<article class="action-alert alert-${escapeHtml(alert.severity)}"><div class="alert-heading"><div><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.serialNumber)} · ${escapeHtml(alert.message)}</small></div><span class="workflow-status">${escapeHtml((alert.workflow?.status || 'open').replaceAll('_',' '))}</span></div><p><span>Recommended action</span>${escapeHtml(alert.recommendedAction)}</p>${alert.workflow?.technicianName ? `<small class="alert-assignee">Assigned to ${escapeHtml(alert.workflow.technicianName)}</small>` : ''}${alert.workflow?.serviceCaseId ? '<small class="alert-assignee safe-text">Service case linked</small>' : ''}${canManageAlerts ? `<div class="alert-actions">${alert.workflow?.status === 'open' ? `<button type="button" class="button mini secondary" data-alert-acknowledge="${escapeHtml(alert.id)}">Acknowledge</button>` : ''}<button type="button" class="button mini secondary" data-alert-manage="${escapeHtml(alert.id)}">Manage</button></div>` : ''}</article>`).join('') : '<div class="empty"><span class="safe-text">No actionable AutoXing alerts.</span></div>';
  $('#autoXingAlerts').querySelectorAll('[data-alert-acknowledge]').forEach((button) => button.addEventListener('click',() => updateAlertWorkflow(button.dataset.alertAcknowledge,{ status:'acknowledged' })));
  $('#autoXingAlerts').querySelectorAll('[data-alert-manage]').forEach((button) => button.addEventListener('click',() => openAlertWorkflow(button.dataset.alertManage)));
  const maxEvents = Math.max(1,...trends.map((day) => day.onlineEvents + day.offlineEvents + day.errorEvents + day.taskEvents));
  $('#autoXingTrends').innerHTML = trends.length ? `<div class="trend-legend"><span><i class="trend-online"></i>Online</span><span><i class="trend-offline"></i>Offline</span><span><i class="trend-error"></i>Errors</span><span><i class="trend-task"></i>Tasks</span></div><div class="trend-grid">${trends.map((day) => { const total = day.onlineEvents + day.offlineEvents + day.errorEvents + day.taskEvents; return `<div class="trend-day"><div class="trend-bars" aria-label="${escapeHtml(day.date)}: ${total} events"><span class="trend-online" style="height:${Math.max(2,day.onlineEvents/maxEvents*100)}%"></span><span class="trend-offline" style="height:${Math.max(2,day.offlineEvents/maxEvents*100)}%"></span><span class="trend-error" style="height:${Math.max(2,day.errorEvents/maxEvents*100)}%"></span><span class="trend-task" style="height:${Math.max(2,day.taskEvents/maxEvents*100)}%"></span></div><strong>${new Date(`${day.date}T00:00:00Z`).toLocaleDateString([],{ weekday:'short' })}</strong><small>${day.averageBattery == null ? 'Battery —' : `Battery ${day.averageBattery}%`} · ${total} events</small></div>`; }).join('')}</div>` : '<div class="empty">No seven-day AutoXing history is available.</div>';
  state.autoRefresh.lastAt = new Date(); $('#autoRefreshStatus').textContent = `Automatic refresh every ${state.autoRefresh.intervalMs/1000}s · updated ${state.autoRefresh.lastAt.toLocaleTimeString([], { hour:'2-digit',minute:'2-digit',second:'2-digit' })}`;
}

async function loadAutoXingOperations() {
  const payload = await api('/api/v1/autoxing/operations'); state.autoXingOperations = payload.data; renderAutoXingOperations(); populateDiagnosticRobots();
}

function renderCenoBotsOperations() {
  const operations=state.cenoBotsOperations; if (!operations) return;
  const summary=operations.summary || {}; const diagnostics=operations.diagnostics || {}; const alerts=operations.alerts || []; const control=operations.control || {}; const filter=state.cenoBotsFleet; const query=filter.query.trim().toLowerCase();
  $('#cenoBotsSummary').innerHTML=`<div class="resource-metric"><strong>${summary.total ?? 0}</strong><span>Robots</span></div><div class="resource-metric"><strong class="safe-text">${summary.online ?? 0}</strong><span>Online</span></div><div class="resource-metric"><strong class="${summary.offline ? 'danger-text' : ''}">${summary.offline ?? 0}</strong><span>Offline</span></div><div class="resource-metric"><strong>${summary.charging ?? 0}</strong><span>Charging</span></div><div class="resource-metric"><strong class="${summary.maintenanceDue ? 'danger-text' : ''}">${summary.maintenanceDue ?? 0}</strong><span>Maintenance due</span></div><div class="resource-metric"><strong class="${summary.errors ? 'danger-text' : ''}">${summary.errors ?? 0}</strong><span>System errors</span></div>`;
  const fleet=(operations.fleet || []).filter((robot) => {
    const connection=robot.online === true ? 'online' : robot.online === false ? 'offline' : 'unknown'; const attention=(robot.errorCount || 0)+(robot.maintenanceDueCount || 0);
    if (query && ![robot.serialNumber,robot.externalId,robot.buildingName,robot.mapName,robot.providerVersion].some((value) => String(value || '').toLowerCase().includes(query))) return false;
    if (filter.status !== 'all' && connection !== filter.status) return false;
    if (filter.attention === 'attention' && !attention || filter.attention === 'clear' && attention) return false;
    return true;
  });
  $('#cenoBotsLiveFleet').innerHTML=fleet.length ? fleet.map((robot) => {
    const battery=Number(robot.battery); const batteryValue=Number.isFinite(battery) ? Math.max(0,Math.min(100,battery)) : null; const task=compactProviderValue(robot.currentTask,'No active mission'); const attention=(robot.errorCount || 0)+(robot.maintenanceDueCount || 0);
    return `<button class="autoxing-live-card cenobots-card" type="button" data-cenobots-robot="${escapeHtml(robot.id)}"><div class="live-card-head"><div><strong>${escapeHtml(robot.serialNumber)}</strong><small>${escapeHtml(robot.externalId)}</small></div><span class="live-state ${robot.online === true ? 'online' : robot.online === false ? 'offline' : ''}">${robot.online === true ? 'Online' : robot.online === false ? 'Offline' : 'Unknown'}</span></div><div class="battery-row"><span>Battery</span><strong>${batteryValue == null ? '—' : `${batteryValue}%`}</strong></div><div class="battery-track"><span style="width:${batteryValue ?? 0}%"></span></div><dl class="live-card-details"><div><dt>Charging</dt><dd>${robot.charging === true ? 'Yes' : robot.charging === false ? 'No' : '—'}</dd></div><div><dt>Docked</dt><dd>${robot.docked === true ? 'Yes' : robot.docked === false ? 'No' : '—'}</dd></div><div><dt>Version</dt><dd>${escapeHtml(robot.providerVersion || '—')}</dd></div><div><dt>Map</dt><dd>${escapeHtml(robot.mapName || '—')}</dd></div></dl><div class="live-task"><span>Mission status</span><strong>${escapeHtml(task)}</strong></div><div class="live-card-foot"><span>${escapeHtml(robot.buildingName || 'No building')}</span><span class="${attention ? 'danger-text' : 'safe-text'}">${attention ? `${attention} item${attention === 1 ? '' : 's'} need attention` : 'No alerts'}</span></div></button>`;
  }).join('') : `<div class="empty">${operations.fleet?.length ? 'No CenoBots robots match these filters.' : 'No visible CenoBots robots. Run synchronization or review API account access.'}</div>`;
  $('#cenoBotsLiveFleet').querySelectorAll('[data-cenobots-robot]').forEach((button) => button.addEventListener('click',async () => { setDashboardView('robots'); await loadPassport(button.dataset.cenobotsRobot); $('#detailPanel').scrollIntoView({ behavior:'smooth',block:'start' }); }));
  $('#cenoBotsAlertCount').textContent=alerts.length;
  $('#cenoBotsAlerts').innerHTML=alerts.length ? alerts.slice(0,50).map((alert) => `<article class="action-alert alert-${escapeHtml(alert.severity)}"><div class="alert-heading"><div><strong>${escapeHtml(alert.title)}</strong><small>${escapeHtml(alert.serialNumber)} · ${escapeHtml(alert.message)}</small></div><span class="workflow-status">${escapeHtml(alert.type.replaceAll('_',' '))}</span></div><time class="event-time">${formatDate(alert.occurredAt)}</time></article>`).join('') : '<div class="empty"><span class="safe-text">No CenoBots maintenance or system-error alerts.</span></div>';
  const duration=diagnostics.lastSyncDurationMs == null ? '—' : diagnostics.lastSyncDurationMs < 1000 ? `${diagnostics.lastSyncDurationMs} ms` : `${(diagnostics.lastSyncDurationMs/1000).toFixed(1)} s`; const history=(diagnostics.syncHistory || []).slice().reverse().slice(0,6);
  const webhook=diagnostics.webhook || {}; $('#cenoBotsDiagnostics').innerHTML=`<div class="diagnostic-grid"><div><span>Connector</span><strong>${diagnostics.liveEnabled ? 'Live API bridge' : 'Mock fallback'}</strong></div><div><span>Last result</span><strong class="${diagnostics.lastSyncStatus === 'success' ? 'safe-text' : diagnostics.lastSyncStatus === 'error' ? 'danger-text' : ''}">${escapeHtml(diagnostics.lastSyncStatus || 'Never')}</strong></div><div><span>Last duration</span><strong>${escapeHtml(duration)}</strong></div><div><span>Robots updated</span><strong>${diagnostics.lastSyncCount ?? '—'}</strong></div><div><span>Warnings</span><strong>${diagnostics.lastSyncWarnings || 0}</strong></div><div><span>Request spacing</span><strong>${diagnostics.minimumRequestIntervalSeconds || 1.05} s</strong></div><div><span>Encrypted webhooks</span><strong class="${webhook.configured ? 'safe-text' : 'danger-text'}">${webhook.configured ? 'Ready' : 'Not configured'}</strong></div><div><span>Webhook events</span><strong>${webhook.receiptCount || 0} · last ${formatDate(webhook.lastReceivedAt)}</strong></div></div>${diagnostics.lastError ? `<div class="resource-warning">${escapeHtml(diagnostics.lastError)}</div>` : ''}${!webhook.configured ? '<div class="resource-warning">Set CENOBOTS_WEBHOOK_SECRET and register the public HTTPS callback /api/v1/webhooks/cenobots.</div>' : ''}<div class="sync-history">${history.map((item) => `<div><span class="status status-${item.status === 'success' ? 'active' : 'draft'}">${escapeHtml(item.status)}</span><span>${escapeHtml(item.trigger)} · ${item.count} robots · ${item.warnings} warnings</span><time>${formatDate(item.completedAt)}</time></div>`).join('') || '<div class="provider-empty serial">No CenoBots synchronization history recorded yet.</div>'}</div>`;
  $('#cenoBotsControlSection').classList.toggle('hidden',!control.canControl); $('#cenoBotsControlStatus').textContent=control.ready ? 'Live control ready' : 'Live control disabled'; $('#cenoBotsControlStatus').className=`status status-${control.ready ? 'active' : 'draft'}`; document.querySelectorAll('[data-cenobots-command],#newCenoBotsSchedule').forEach((button) => { button.disabled=!control.ready; });
  $('#cenoBotsRefreshStatus').textContent=`Updated ${new Date(operations.generatedAt || Date.now()).toLocaleTimeString([], { hour:'2-digit',minute:'2-digit',second:'2-digit' })}`;
}

async function loadCenoBotsOperations() {
  const payload=await api('/api/v1/cenobots/operations'); state.cenoBotsOperations=payload.data; renderCenoBotsOperations();
}

async function loadCenoBotsSchedules() {
  const robotId=$('#cenoBotsControlRobot').value; if (!robotId) { $('#cenoBotsSchedules').innerHTML='<div class="empty">Select a robot to view schedules.</div>'; return; }
  const payload=await api(`/api/v1/cenobots/robots/${encodeURIComponent(robotId)}/schedules`); $('#cenoBotsSchedules').innerHTML=payload.available ? (payload.data.length ? payload.data.map((schedule) => `<div class="record-row"><div><strong>${escapeHtml(schedule.sceneName || schedule.sweepMode || `Schedule ${schedule.id}`)}</strong><small>${escapeHtml(schedule.startTime || '—')} · ${escapeHtml((schedule.executionDays || []).join(', ') || 'no repeat')} · ${schedule.duration || '—'} min</small></div><span class="status status-${schedule.enable ? 'active' : 'draft'}">${schedule.enable ? 'Active' : 'Disabled'}</span></div>`).join('') : '<div class="empty">No schedules exist for this robot.</div>') : `<div class="empty">${escapeHtml(payload.reason || 'Schedule list unavailable.')}</div>`;
}

function selectedCenoBotsRobot(id='#cenoBotsControlRobot') { return state.cenoBotsOperations?.fleet?.find((robot) => robot.id === $(id).value); }

function openCenoBotsCommand(action) {
  const robot=selectedCenoBotsRobot(); if (!robot) return toast('Select a CenoBots robot first',true); $('#cenoBotsCommandAction').value=action; $('#cenoBotsCommandRobotId').value=robot.id; $('#cenoBotsCommandConfirmation').value=''; $('#cenoBotsCommandTitle').textContent=`Confirm ${action.replaceAll('-',' ')}`; $('#cenoBotsCommandSummary').textContent=`This sends a live ${action.replaceAll('-',' ')} command to ${robot.serialNumber} (${robot.externalId}). Type ${robot.serialNumber} exactly to continue.`; $('#cenoBotsCommandDialog').showModal();
}

function openCenoBotsSchedule() {
  const robot=selectedCenoBotsRobot(); if (!robot) return toast('Select a CenoBots robot first',true); $('#cenoBotsScheduleRobot').value=robot.id; $('#cenoBotsScheduleMapId').value=robot.mapId || ''; $('#cenoBotsScheduleMapVersion').value=robot.mapVersion || ''; $('#cenoBotsScheduleStart').value='04:52 PM'; $('#cenoBotsScheduleConfirmation').value=''; document.querySelectorAll('[name="cenoBotsRepeat"]').forEach((input) => { input.checked=['Mon.','Tue.','Wed.','Thur.','Fri.'].includes(input.value); }); $('#cenoBotsScheduleDialog').showModal();
}

function populateDiagnosticRobots() { const select=$('#diagnosticRobotSelect'); const selected=select.value; const fleet=state.autoXingOperations?.fleet || []; select.innerHTML='<option value="">Select a robot</option>'+fleet.map((robot) => `<option value="${escapeHtml(robot.id)}">${escapeHtml(robot.serialNumber)} · ${escapeHtml(robot.externalId)}</option>`).join(''); if (fleet.some((robot) => robot.id === selected)) select.value=selected; }

async function loadMaintenanceSchedules() {
  const payload=await api('/api/v1/autoxing/maintenance-schedules'); state.maintenanceSchedules=payload.data; $('#newMaintenanceSchedule').classList.toggle('hidden',!payload.permissions.manage);
  const overdue=payload.data.filter((item) => item.dueState === 'overdue').length; const dueSoon=payload.data.filter((item) => item.dueState === 'due_soon').length;
  $('#autoXingMaintenanceSummary').innerHTML=`<div class="maintenance-metrics"><div class="resource-metric"><strong>${payload.count}</strong><span>Schedules</span></div><div class="resource-metric"><strong class="${overdue ? 'danger-text' : ''}">${overdue}</strong><span>Overdue</span></div><div class="resource-metric"><strong>${dueSoon}</strong><span>Due soon</span></div></div><div class="maintenance-list">${payload.data.map((schedule) => `<div class="record-row maintenance-row"><div><strong>${escapeHtml(schedule.title)}</strong><small>${escapeHtml(schedule.robotSerialNumber)} · ${formatDate(schedule.nextDueAt)} · every ${schedule.intervalDays} days · ${escapeHtml(schedule.technicianName || 'unassigned')}</small></div><div class="maintenance-actions"><span class="status status-${schedule.dueState === 'scheduled' ? 'active' : 'draft'}">${escapeHtml(schedule.dueState.replaceAll('_',' '))}</span>${payload.permissions.manage ? `<button class="text-button" type="button" data-maintenance-complete="${escapeHtml(schedule.id)}">Complete</button><button class="text-button" type="button" data-maintenance-status="${escapeHtml(schedule.id)}" data-next-status="${schedule.status === 'active' ? 'paused' : 'active'}">${schedule.status === 'active' ? 'Pause' : 'Resume'}</button>` : ''}</div></div>`).join('') || '<div class="empty">No AutoXing maintenance schedules. Create one to track recurring service.</div>'}</div>`;
  $('#autoXingMaintenanceSummary').querySelectorAll('[data-maintenance-complete]').forEach((button) => button.addEventListener('click',async () => { try { await api(`/api/v1/autoxing/maintenance-schedules/${button.dataset.maintenanceComplete}`,{ method:'PATCH',body:JSON.stringify({ complete:true,completionNote:'Scheduled maintenance completed from the AutoXing workspace.' }) }); toast('Maintenance completed and next service scheduled'); await Promise.all([loadMaintenanceSchedules(),loadAutoXingOperations(),loadEvents()]); } catch(error){ toast(error.message,true); } }));
  $('#autoXingMaintenanceSummary').querySelectorAll('[data-maintenance-status]').forEach((button) => button.addEventListener('click',async () => { try { await api(`/api/v1/autoxing/maintenance-schedules/${button.dataset.maintenanceStatus}`,{ method:'PATCH',body:JSON.stringify({ status:button.dataset.nextStatus }) }); await loadMaintenanceSchedules(); } catch(error){ toast(error.message,true); } }));
}

async function populateMaintenanceTechnicians() { const robotId=$('#maintenanceRobot').value; const select=$('#maintenanceTechnician'); select.innerHTML='<option value="">Assign later</option>'; if (!robotId) return; try { const payload=await api(`/api/v1/workforce/matrix?robotId=${encodeURIComponent(robotId)}`); select.innerHTML+=[...new Map(payload.data.rows.filter((row) => row.eligibility.eligible).map((row) => [row.technician.id,row.technician])).values()].map((technician) => `<option value="${escapeHtml(technician.id)}">${escapeHtml(technician.name)}</option>`).join(''); } catch {} }

async function openMaintenanceScheduleDialog() { const fleet=state.autoXingOperations?.fleet || []; $('#maintenanceRobot').innerHTML=fleet.map((robot) => `<option value="${escapeHtml(robot.id)}">${escapeHtml(robot.serialNumber)}</option>`).join(''); $('#maintenanceTitle').value=''; $('#maintenanceNextDue').value=toDateTimeLocal(new Date(Date.now()+7*86400000)); $('#maintenanceInterval').value='90'; $('#maintenancePriority').value='normal'; $('#maintenanceDescription').value=''; await populateMaintenanceTechnicians(); $('#maintenanceScheduleDialog').showModal(); }

async function loadEscalationRules() {
  if (state.user.role === 'robot_user') return; const payload=await api('/api/v1/autoxing/escalation-rules'); state.escalationRules=payload.data; $('#newEscalationRule').classList.toggle('hidden',!payload.permissions.manage); $('#evaluateEscalations').classList.toggle('hidden',!['platform_admin','support_admin'].includes(state.user.role));
  $('#autoXingEscalationRules').innerHTML=payload.data.length ? payload.data.map((rule) => `<div class="record-row escalation-rule"><div><strong>${escapeHtml(rule.name)}</strong><small>${escapeHtml(rule.alertType.replaceAll('-',' '))} · ${escapeHtml(rule.minimumSeverity)}+ · after ${rule.afterMinutes} min · ${escapeHtml(rule.action.replaceAll('_',' '))}${rule.technicianName ? ` · ${escapeHtml(rule.technicianName)}` : ''}<br />${rule.executionCount} escalation${rule.executionCount === 1 ? '' : 's'} · last ${formatDate(rule.lastEscalatedAt)}</small></div><div><span class="status status-${rule.active ? 'active' : 'draft'}">${rule.active ? 'Active' : 'Paused'}</span>${payload.permissions.manage ? `<button class="text-button" type="button" data-escalation-toggle="${escapeHtml(rule.id)}" data-active="${!rule.active}">${rule.active ? 'Pause' : 'Activate'}</button>` : ''}</div></div>`).join('') : '<div class="empty">No escalation rules. Add a rule to automate email and service-case response.</div>';
  $('#autoXingEscalationRules').querySelectorAll('[data-escalation-toggle]').forEach((button) => button.addEventListener('click',async () => { try { await api(`/api/v1/autoxing/escalation-rules/${button.dataset.escalationToggle}`,{ method:'PATCH',body:JSON.stringify({ active:button.dataset.active === 'true' }) }); await loadEscalationRules(); } catch(error){ toast(error.message,true); } }));
}

function openEscalationRuleDialog() { const technicians=state.autoXingOperations?.alertWorkflow?.technicians || []; $('#escalationRuleName').value=''; $('#escalationAlertType').value='any'; $('#escalationSeverity').value='error'; $('#escalationAfterMinutes').value='15'; $('#escalationAction').value='email_and_service_case'; $('#escalationTechnician').innerHTML='<option value="">Assign qualified technician later</option>'+technicians.map((technician) => `<option value="${escapeHtml(technician.id)}">${escapeHtml(technician.name)}</option>`).join(''); $('#escalationRuleDialog').showModal(); }

async function loadMonitoring() { const payload=await api('/api/v1/monitoring'); state.monitoring=payload.data; const data=payload.data; const requests=data.requests || {}; $('#autoXingMonitoring').innerHTML=`<div class="diagnostic-grid"><div><span>Readiness</span><strong class="${data.readiness?.ready ? 'safe-text' : 'danger-text'}">${data.readiness?.ready ? 'Ready' : 'Attention required'}</strong></div><div><span>Uptime</span><strong>${Math.floor((data.uptimeSeconds || 0)/60)} min</strong></div><div><span>HTTP requests</span><strong>${requests.total || 0}</strong></div><div><span>Server errors</span><strong class="${requests.errors ? 'danger-text' : 'safe-text'}">${requests.errors || 0}</strong></div><div><span>Average response</span><strong>${requests.averageResponseTimeMs || 0} ms</strong></div><div><span>Open service cases</span><strong>${data.fleet?.openServiceCases || 0}</strong></div></div><div class="sync-history">${(data.adapters || []).map((adapter) => `<div><span class="status status-${adapter.lastSyncStatus === 'success' ? 'active' : 'draft'}">${escapeHtml(adapter.provider)}</span><span>${escapeHtml(adapter.lastSyncStatus || 'never')} · ${adapter.lastSyncWarnings || 0} warnings</span><time>${formatDate(adapter.lastSyncAt)}</time></div>`).join('')}</div>`; }

async function updateAlertWorkflow(alertId,body) { try { await api(`/api/v1/autoxing/alerts/${encodeURIComponent(alertId)}`,{ method:'PATCH',body:JSON.stringify(body) }); toast(body.createServiceCase ? 'Alert assigned and service case created' : 'Alert workflow updated'); await Promise.all([loadAutoXingOperations(),loadServiceCases(),loadNotifications()]); } catch(error){ toast(error.message,true); throw error; } }

function openAlertWorkflow(alertId) { const alert=state.autoXingOperations?.alerts?.find((item) => item.id === alertId); if (!alert) return; state.selectedAlertId=alertId; $('#alertWorkflowTitle').textContent=alert.title; $('#alertWorkflowDescription').textContent=`${alert.serialNumber}: ${alert.message}`; $('#alertWorkflowStatus').value=alert.workflow?.status || 'acknowledged'; const technicians=state.autoXingOperations.alertWorkflow?.technicians || []; $('#alertWorkflowTechnician').innerHTML='<option value="">Not assigned</option>'+technicians.map((technician) => `<option value="${escapeHtml(technician.id)}">${escapeHtml(technician.name)}</option>`).join(''); $('#alertWorkflowTechnician').value=alert.workflow?.technicianId || ''; $('#alertWorkflowNote').value=alert.workflow?.note || ''; $('#alertCreateServiceCase').checked=false; $('#alertCreateServiceCase').disabled=!alert.robotId || Boolean(alert.workflow?.serviceCaseId); $('#alertWorkflowDialog').showModal(); }

function startAutoRefresh() {
  clearInterval(state.autoRefresh.timer);
  state.autoRefresh.timer = setInterval(async () => {
    if (!state.token || document.hidden || state.sync.provider) return;
    try { await Promise.all([loadAutoXingOperations(),loadCenoBotsOperations(),loadMaintenanceSchedules(),loadEscalationRules(),loadMonitoring(),loadEmailNotifications(),loadRobots(),loadOperationsSummary(),loadAdapters()]); }
    catch (error) { if (error.status !== 401) $('#autoRefreshStatus').textContent = `Automatic refresh paused · ${error.message}`; }
  },state.autoRefresh.intervalMs);
}

async function loadRobotAccounts() {
  if (state.user.role !== 'platform_admin') return;
  const payload = await api('/api/v1/robot-accounts'); state.robotAccounts = payload.data;
  $('#robotAccountsList').innerHTML = payload.data.length ? payload.data.map((account) => `<div class="record-row"><div><strong>${escapeHtml(account.email)}</strong><small>${escapeHtml(account.serialNumber || 'No robot assigned')} · ${escapeHtml(account.robotId || 'Pending synchronization')}</small></div><span class="account-status">${escapeHtml(account.credentialStatus || 'password set')}</span></div>`).join('') : '<div class="empty">No robot accounts are available.</div>';
}

async function loadEmailNotifications() {
  if (!['platform_admin','data_admin','support_admin'].includes(state.user.role)) return;
  const payload=await api('/api/v1/email-notifications'); state.emailNotifications=payload.data; const config=payload.data.configuration; const counts=payload.data.counts;
  $('#testEmailNotification').disabled=!config.enabled || !config.configured || !['platform_admin','support_admin'].includes(state.user.role);
  const configurationState=!config.enabled ? 'Disabled' : config.configured ? 'Ready' : 'Configuration error';
  $('#emailNotificationStatus').innerHTML=`<div class="email-status-grid"><div class="resource-metric"><strong class="${config.enabled && config.configured ? 'safe-text' : config.enabled ? 'danger-text' : ''}">${escapeHtml(configurationState)}</strong><span>Delivery status</span></div><div class="resource-metric"><strong>${config.recipientCount}</strong><span>Recipients</span></div><div class="resource-metric"><strong>${escapeHtml(config.minimumSeverity)}</strong><span>Minimum severity</span></div><div class="resource-metric"><strong>${counts.sent}</strong><span>Emails sent</span></div><div class="resource-metric"><strong>${counts.pending}</strong><span>Pending</span></div><div class="resource-metric"><strong class="${counts.failed ? 'danger-text' : ''}">${counts.failed}</strong><span>Failed</span></div></div>${config.configurationError ? `<div class="resource-warning">${escapeHtml(config.configurationError)}</div>` : ''}<div class="email-delivery-list">${payload.data.deliveries.map((delivery) => `<div class="record-row"><div><strong>${escapeHtml(delivery.title)}</strong><small>${escapeHtml(delivery.status)} · ${delivery.recipientCount} recipient${delivery.recipientCount === 1 ? '' : 's'}${delivery.robotSerialNumber ? ` · ${escapeHtml(delivery.robotSerialNumber)}` : ''}${delivery.lastError ? ` · ${escapeHtml(delivery.lastError)}` : ''}</small></div><div class="email-delivery-actions"><time>${formatDate(delivery.sentAt || delivery.createdAt)}</time>${delivery.status === 'failed' && ['platform_admin','support_admin'].includes(state.user.role) ? `<button class="text-button" type="button" data-email-retry="${escapeHtml(delivery.id)}">Retry</button>` : ''}</div></div>`).join('') || '<div class="empty">No email deliveries have been recorded.</div>'}</div>`;
  $('#emailNotificationStatus').querySelectorAll('[data-email-retry]').forEach((button) => button.addEventListener('click',async () => { try { await api(`/api/v1/email-notifications/${button.dataset.emailRetry}/retry`,{ method:'POST' }); toast('Email delivered'); await loadEmailNotifications(); } catch(error){ toast(error.message,true); } }));
}

async function loadSmsNotifications() {
  if (!['platform_admin','data_admin','support_admin'].includes(state.user.role)) return; const payload=await api('/api/v1/sms-notifications'); state.smsNotifications=payload.data; const config=payload.data.configuration; const counts=payload.data.counts; $('#testSmsNotification').disabled=!config.enabled || !config.configured || !['platform_admin','support_admin'].includes(state.user.role); const configurationState=!config.enabled ? 'Disabled' : config.configured ? 'Ready' : 'Configuration error';
  $('#smsNotificationStatus').innerHTML=`<div class="email-status-grid"><div class="resource-metric"><strong class="${config.enabled && config.configured ? 'safe-text' : config.enabled ? 'danger-text' : ''}">${escapeHtml(configurationState)}</strong><span>Delivery status</span></div><div class="resource-metric"><strong>${config.recipientCount}</strong><span>Phone recipients</span></div><div class="resource-metric"><strong>${escapeHtml(config.minimumSeverity)}</strong><span>Minimum severity</span></div><div class="resource-metric"><strong>${counts.sent}</strong><span>SMS sent</span></div><div class="resource-metric"><strong>${counts.pending}</strong><span>Pending</span></div><div class="resource-metric"><strong class="${counts.failed ? 'danger-text' : ''}">${counts.failed}</strong><span>Failed</span></div></div>${config.configurationError ? `<div class="resource-warning">${escapeHtml(config.configurationError)}</div>` : ''}<div class="email-delivery-list">${payload.data.deliveries.map((delivery) => `<div class="record-row"><div><strong>${escapeHtml(delivery.title)}</strong><small>${escapeHtml(delivery.status)} · ${delivery.recipientCount} recipient${delivery.recipientCount === 1 ? '' : 's'}${delivery.robotSerialNumber ? ` · ${escapeHtml(delivery.robotSerialNumber)}` : ''}${delivery.lastError ? ` · ${escapeHtml(delivery.lastError)}` : ''}</small></div><time>${formatDate(delivery.sentAt || delivery.createdAt)}</time></div>`).join('') || '<div class="empty">No SMS deliveries have been recorded.</div>'}</div>`;
}

function openCompatibilityDialog() {
  const models = [...new Set([...state.robotOptions.map((robot) => robot.modelId), ...state.compatibility.map((item) => item.modelId)])].filter(Boolean).sort();
  $('#compatibilityModel').innerHTML = models.map((modelId) => `<option value="${escapeHtml(modelId)}">${escapeHtml(modelId.replace('model-', '').replaceAll('-', ' '))}</option>`).join('');
  $('#compatibilityCapability').value = ''; $('#compatibilityVersion').value = ''; $('#compatibilityStatus').value = 'testing_required'; $('#compatibilityEvidence').value = '';
  $('#compatibilityDialog').showModal();
}

function renderWorkforceMatrix() {
  if (!state.workforce) return;
  const statusFilter = $('#workforceStatusFilter').value; let rows = state.workforce.rows;
  if (statusFilter === 'assigned') rows = rows.filter((row) => row.assignment);
  else if (statusFilter) rows = rows.filter((row) => row.eligibility.status === statusFilter);
  const qualified = state.workforce.rows.filter((row) => row.eligibility.status === 'qualified').length;
  const expiring = state.workforce.rows.filter((row) => row.eligibility.status === 'expiring_soon').length;
  const blocked = state.workforce.rows.filter((row) => row.eligibility.status === 'not_qualified').length;
  const assigned = state.workforce.rows.filter((row) => row.assignment).length;
  $('#workforceSummary').innerHTML = `<div class="resource-metric"><strong>${qualified}</strong><span>Qualified</span></div><div class="resource-metric"><strong>${expiring}</strong><span>Expiring soon</span></div><div class="resource-metric"><strong>${blocked}</strong><span>Not qualified</span></div><div class="resource-metric"><strong>${assigned}</strong><span>Assigned</span></div>`;
  const columnHeader = '<div class="workforce-grid-header" aria-hidden="true"><span>Technician</span><span>Robot</span><span>Qualification status</span><span>Actions</span></div>';
  $('#workforceMatrixList').innerHTML = rows.length ? columnHeader + rows.map((row) => { const missing = [...row.eligibility.missingSkills.map((item) => `Skill: ${item.replaceAll('_',' ')}`), ...row.eligibility.missingCertificates.map((item) => `Certificate: ${item.replaceAll('_',' ')}`)]; const expiringText = row.eligibility.expiringCertificates.map((item) => `${item.type.replaceAll('_',' ')} expires ${formatDate(item.validUntil)}`); const canManage = state.workforce.permissions.manage; return `<div class="workforce-row"><div class="workforce-cell" data-column="Technician"><strong>${escapeHtml(row.technician.name)}</strong><small>${escapeHtml(row.technician.jobTitle || 'Service Technician')} · ${escapeHtml(row.technician.email)}</small></div><div class="workforce-cell" data-column="Robot"><strong>${escapeHtml(row.robot.serialNumber)}</strong><small>${escapeHtml(row.robot.modelId.replace('model-','').replaceAll('-',' '))}</small></div><div class="workforce-cell workforce-qualification" data-column="Qualification"><span class="eligibility eligibility-${escapeHtml(row.eligibility.status)}">${escapeHtml(row.eligibility.status.replaceAll('_',' '))}</span><div class="workforce-requirements">${missing.length ? `Missing: ${escapeHtml(missing.join(' · '))}` : expiringText.length ? escapeHtml(expiringText.join(' · ')) : 'All required qualifications are valid.'}</div></div><div class="workforce-cell workforce-actions" data-column="Actions">${row.assignment ? `<span class="assignment-active">Assigned</span>${canManage ? `<button class="text-button" type="button" data-unassign="${escapeHtml(row.assignment.id)}">Remove</button>` : ''}` : canManage && row.eligibility.eligible ? `<button class="button primary mini" type="button" data-assign-technician="${escapeHtml(row.technician.id)}" data-assign-robot="${escapeHtml(row.robot.id)}">Assign</button>` : ''}${canManage ? `<button class="text-button" type="button" data-qualify-technician="${escapeHtml(row.technician.id)}" data-technician-name="${escapeHtml(row.technician.name)}">＋ Qualification</button>` : ''}</div></div>`; }).join('') : '<div class="empty">No technician and robot combinations match this filter.</div>';
  $('#technicianAvailabilityList').innerHTML=state.workforce.technicians.map((technician) => { const availability=technician.availability; return `<article class="availability-card"><div class="availability-head"><div><strong>${escapeHtml(technician.name)}</strong><small>${escapeHtml(availability.workingDays.join(', '))} · ${availability.dailyCapacityHours} h/day</small></div><span class="status status-${availability.status === 'available' ? 'active' : 'draft'}">${escapeHtml(availability.status.replaceAll('_',' '))}</span></div><div class="capacity-track"><span style="width:${availability.capacityPercent}%"></span></div><div class="availability-foot"><span>${availability.activeAssignments} assignment${availability.activeAssignments === 1 ? '' : 's'} · ${availability.estimatedHours}/${availability.dailyCapacityHours} h estimated</span>${state.workforce.permissions.manage ? `<button class="text-button" type="button" data-edit-availability="${escapeHtml(technician.id)}">Plan</button>` : ''}</div></article>`; }).join('') || '<div class="empty">No technicians are available.</div>'; $('#technicianAvailabilityList').querySelectorAll('[data-edit-availability]').forEach((button) => button.addEventListener('click',() => openAvailabilityDialog(button.dataset.editAvailability)));
}

function openAvailabilityDialog(technicianId) { const technician=state.workforce?.technicians.find((item) => item.id === technicianId); if (!technician) return; const availability=technician.availability; $('#availabilityTechnicianId').value=technician.id; $('#technicianAvailabilityTitle').textContent=`Availability · ${technician.name}`; $('#availabilityStatus').value=availability.status; $('#availabilityFrom').value=availability.availableFrom ? toDateTimeLocal(new Date(availability.availableFrom)) : ''; $('#availabilityUntil').value=availability.availableUntil ? toDateTimeLocal(new Date(availability.availableUntil)) : ''; $('#availabilityCapacity').value=availability.dailyCapacityHours; $('#availabilityNotes').value=availability.notes || ''; document.querySelectorAll('[name="availabilityDay"]').forEach((input) => { input.checked=availability.workingDays.includes(input.value); }); $('#technicianAvailabilityDialog').showModal(); }

async function loadWorkforceMatrix() {
  if (state.user.role === 'robot_user') return;
  const robotId = $('#workforceRobotFilter').value; const payload = await api(`/api/v1/workforce/matrix${robotId ? `?robotId=${encodeURIComponent(robotId)}` : ''}`); state.workforce = payload.data; renderWorkforceMatrix();
}

function openTechnicianDialog() {
  $('#technicianName').value = ''; $('#technicianEmail').value = ''; $('#technicianOrganization').value = 'org-service'; $('#technicianDialog').showModal();
}

function updateQualificationFields() {
  const certificate = $('#qualificationKind').value === 'certificate'; $('#qualificationLevelField').classList.toggle('hidden', certificate); $('#certificateFields').classList.toggle('hidden', !certificate);
  const requirements = (state.workforce?.robots || []).flatMap((robot) => certificate ? robot.requirements.requiredCertificates : robot.requirements.requiredSkills);
  const defaults = certificate ? ['robot_electrical_safety','autoxing_service_authorization'] : ['autoxing_service','cleaning_robot_service','fleet_diagnostics'];
  const codes = [...new Set([...requirements,...defaults])].sort(); $('#qualificationCode').innerHTML = codes.map((code) => `<option value="${escapeHtml(code)}">${escapeHtml(code.replaceAll('_',' '))}</option>`).join('');
}

function openQualificationDialog(technicianId, technicianName) {
  const dialog = $('#qualificationDialog'); dialog.dataset.technicianId = technicianId; $('#qualificationTechnicianName').textContent = `Add a verified skill or certificate for ${technicianName}.`; $('#qualificationKind').value = 'skill'; $('#qualificationLevel').value = 'qualified'; $('#qualificationIssuer').value = ''; $('#qualificationValidUntil').value = ''; const models = [...new Set(state.robotOptions.map((robot) => robot.modelId))].sort(); $('#qualificationModel').innerHTML = '<option value="">All robot models</option>' + models.map((modelId) => `<option value="${escapeHtml(modelId)}">${escapeHtml(modelId.replace('model-','').replaceAll('-',' '))}</option>`).join(''); updateQualificationFields(); dialog.showModal();
}

async function refreshWorkforceAndPassport(robotId = null) {
  await Promise.all([loadWorkforceMatrix(), loadNotifications(), loadAudit(), robotId && state.selectedRobotId === robotId ? loadPassport(robotId) : Promise.resolve()]);
}

function setSyncButtons(running) {
  document.querySelectorAll('.sync-button, #syncSelected').forEach((button) => { button.disabled = running; button.classList.toggle('running', running); });
}

function setSyncStatus(message, kind = '', retryProvider = null) {
  const panel = $('#syncStatus'); panel.className = `sync-status ${kind}`.trim(); panel.innerHTML = `<span>${escapeHtml(message)}</span>${retryProvider ? `<button type="button" class="text-button" id="retrySync">Try again</button>` : ''}`;
  if (retryProvider) $('#retrySync').addEventListener('click', () => retryProvider === 'all' ? syncAllAdapters() : syncAdapter(retryProvider));
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve,milliseconds));
async function waitForSyncJob(job,onProgress) {
  if (!job?.id || !['queued','running'].includes(job.status)) return job;
  const deadline=Date.now()+Math.max(60000,Number(job.timeoutMs || 20*60*1000)); let current=job;
  while (['queued','running'].includes(current.status)) {
    if (Date.now() >= deadline) throw new Error(`Synchronization job ${current.id} is still running; check Sync diagnostics later`);
    onProgress?.(current); await delay(1000); current=(await api(`/api/v1/sync-jobs/${encodeURIComponent(current.id)}`)).data;
  }
  if (current.status === 'failed') throw new Error(current.error || `${current.provider} synchronization failed`);
  return current.result || current;
}

async function syncAdapter(provider) {
  if (state.sync.provider) return toast(`${state.sync.provider} synchronization is already running`);
  state.sync.provider = provider; state.sync.startedAt = Date.now(); setSyncButtons(true);
  const updateElapsed = () => setSyncStatus(`Synchronizing ${provider}… ${Math.floor((Date.now() - state.sync.startedAt) / 1000)}s`);
  updateElapsed(); state.sync.timer = setInterval(updateElapsed, 1000);
  try {
    const payload=await api(`/api/v1/adapters/${provider}/sync`,{ method:'POST',body:'{}' });
    const data=await waitForSyncJob(payload.data,(job) => setSyncStatus(`${provider} synchronization ${job.status}… ${Math.floor((Date.now()-state.sync.startedAt)/1000)}s`));
    const seconds=Math.max(1,Math.round((Date.now()-state.sync.startedAt)/1000)); const count=data?.count; const warnings=data?.resourceErrors?.length || data?.resources?.warnings || 0;
    setSyncStatus(warnings ? `${provider} synchronized with ${warnings} warning${warnings === 1 ? '' : 's'} in ${seconds}s${count != null ? ` · ${count} robots updated` : ''}.` : `${provider} synchronized successfully in ${seconds}s${count != null ? ` · ${count} robots updated` : ''}.`, warnings ? 'warning' : 'success'); toast(warnings ? `${provider} synchronized with warnings` : `${provider} adapter synchronized`); await refreshAll();
  } catch (error) {
    if (error.status !== 401) { setSyncStatus(`${provider} synchronization failed. ${error.message}`, 'error', provider); toast(`Sync failed: ${error.message}`, true); await loadAdapters().catch(() => {}); }
  } finally { clearInterval(state.sync.timer); state.sync.timer = null; state.sync.provider = null; setSyncButtons(false); }
}

async function syncAllAdapters() {
  if (state.sync.provider) return toast(`${state.sync.provider} synchronization is already running`);
  const providers = ['autoxing', 'cenobots']; const labels = { autoxing:'AutoXing', cenobots:'CenoBots' };
  state.sync.provider = 'all providers'; state.sync.startedAt = Date.now(); setSyncButtons(true);
  const updateElapsed = () => setSyncStatus(`Synchronizing AutoXing and CenoBots… ${Math.floor((Date.now() - state.sync.startedAt) / 1000)}s`);
  updateElapsed(); state.sync.timer = setInterval(updateElapsed, 1000);
  try {
    const results=await Promise.allSettled(providers.map(async (provider) => { const payload=await api(`/api/v1/adapters/${provider}/sync`,{ method:'POST',body:'{}' }); const data=await waitForSyncJob(payload.data); return { provider,payload:{ data } }; }));
    const summaries = results.map((result, index) => {
      const provider = providers[index]; const label = labels[provider];
      if (result.status === 'rejected') return `${label}: failed (${result.reason.message})`;
      const data = result.value.payload.data || {}; const warnings = data.resourceErrors?.length || data.resources?.warnings || 0;
      return `${label}: ${data.count ?? 0} robots${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`;
    });
    const successes = results.filter((result) => result.status === 'fulfilled').length;
    const kind = successes === providers.length ? (results.some((result) => (result.value?.payload.data?.resourceErrors?.length || result.value?.payload.data?.resources?.warnings)) ? 'warning' : 'success') : successes ? 'warning' : 'error';
    const heading = successes === providers.length ? 'All providers synchronized.' : successes ? 'Synchronization completed partially.' : 'Synchronization failed.';
    setSyncStatus(`${heading} ${summaries.join(' · ')}`, kind, successes < providers.length ? 'all' : null);
    toast(successes === providers.length ? 'All robot providers synchronized' : successes ? 'Some providers could not synchronize' : 'All provider synchronizations failed', successes === 0);
    if (successes) await refreshAll();
    else await loadAdapters().catch(() => {});
  } finally { clearInterval(state.sync.timer); state.sync.timer = null; state.sync.provider = null; setSyncButtons(false); }
}
async function refreshAll() { try { await Promise.all([loadRobotOptions(),loadRobots(),loadEvents(),loadAdapters(),loadOperationsSummary(),loadTracking(),loadServiceCases(),loadSupportTickets(),loadCompatibility(),loadNotifications(),loadReports(),loadAudit(),loadAutoXingResources(),loadAutoXingTasks(),loadAutoXingOperations(),loadCenoBotsOperations(),loadMaintenanceSchedules(),loadEscalationRules(),loadMonitoring(),loadRobotAccounts(),loadEmailNotifications(),loadSmsNotifications(),loadWorkforceMatrix()]); } catch (error) { if (error.status !== 401) toast(error.message,true); } }

function setFormBusy(form, busy) {
  form.querySelectorAll('button[type="submit"], button:not([type])').forEach((button) => { if (button.value !== 'cancel') button.disabled = busy; });
  form.setAttribute('aria-busy', String(busy));
}

async function serialNumberExists(serialNumber) {
  const payload = await api(`/api/v1/robots?serialNumber=${encodeURIComponent(serialNumber)}&pageSize=1`); return payload.count > 0;
}

function resetRegistryPage() { state.registry.page = 1; return loadRobots(); }

function applyMetricAction(action) {
  document.querySelectorAll('[data-metric-action]').forEach((card) => card.classList.toggle('active-filter', card.dataset.metricAction === action && ['active','draft','online','offline'].includes(action)));
  if (action === 'events') { setDashboardView('operations'); return $('#eventsPanel').scrollIntoView({ behavior:'smooth', block:'start' }); }
  if (action === 'service') { setDashboardView('operations'); return $('#serviceCasesList').scrollIntoView({ behavior:'smooth', block:'start' }); }
  if (action === 'errors' || action === 'maintenance') { $('#eventSeverityFilter').value = action === 'errors' ? 'problem' : ''; $('#eventTypeFilter').value = action === 'maintenance' ? 'maintenance_due' : ''; setDashboardView('operations'); loadEvents(); return $('#eventsPanel').scrollIntoView({ behavior:'smooth', block:'start' }); }
  $('#statusFilter').value = ['active','draft'].includes(action) ? action : ''; $('#liveFilter').value = ['online','offline'].includes(action) ? action : ''; setDashboardView('robots'); resetRegistryPage(); document.querySelector('.registry-panel').scrollIntoView({ behavior:'smooth', block:'start' });
}

function bindUi() {
  $('#languageSelect').addEventListener('change',(event) => { applyLanguage(event.target.value); if (state.supportTickets.length) renderSupportTickets(); if (state.cenoBotsOperations) renderCenoBotsOperations(); if (state.reports) loadReports().catch(() => {}); });
  $('#accessibilityButton').addEventListener('click',() => { const preferences=accessibilityPreferences(); $('#accessibilityTextSize').value=preferences.textSize; $('#accessibilityContrast').checked=preferences.contrast; $('#accessibilityMotion').checked=preferences.reduceMotion; $('#accessibilityDialog').showModal(); });
  $('#accessibilityForm').addEventListener('submit',(event) => { event.preventDefault(); applyAccessibility({ textSize:$('#accessibilityTextSize').value,contrast:$('#accessibilityContrast').checked,reduceMotion:$('#accessibilityMotion').checked }); $('#accessibilityDialog').close(); toast('Accessibility preferences applied'); });
  $('#resetAccessibility').addEventListener('click',() => { const preferences={ textSize:'normal',contrast:false,reduceMotion:false }; applyAccessibility(preferences); $('#accessibilityTextSize').value='normal'; $('#accessibilityContrast').checked=false; $('#accessibilityMotion').checked=false; });
  $('#dashboardTabs').addEventListener('click', (event) => { const button = event.target.closest('[data-dashboard-tab]'); if (button) setDashboardView(button.dataset.dashboardTab); });
  $('#dashboardTabs').addEventListener('keydown', (event) => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; const tabs = [...document.querySelectorAll('[data-dashboard-tab]:not(.hidden)')]; const current = tabs.indexOf(document.activeElement); let next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; event.preventDefault(); tabs[next].focus(); setDashboardView(tabs[next].dataset.dashboardTab); });
  let searchTimer; $('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); state.registry.page = 1; searchTimer = setTimeout(loadRobots, 250); }); ['statusFilter','liveFilter','sortRobots'].forEach((id) => $(`#${id}`).addEventListener('change', resetRegistryPage)); $('#pageSize').addEventListener('change', () => { state.registry.pageSize = Number($('#pageSize').value); resetRegistryPage(); }); $('#previousPage').addEventListener('click', () => { if (state.registry.page > 1) { state.registry.page -= 1; loadRobots(); } }); $('#nextPage').addEventListener('click', () => { if (state.registry.page < state.registry.pageCount) { state.registry.page += 1; loadRobots(); } });
  $('#refreshButton').addEventListener('click', async () => { const button = $('#refreshButton'); button.disabled = true; try { await refreshAll(); } finally { button.disabled = false; } }); $('#refreshEvents').addEventListener('click', loadEvents); $('#refreshAdapters').addEventListener('click', loadAdapters); $('#refreshServiceCases').addEventListener('click', loadServiceCases);
  $('#refreshAudit').addEventListener('click', loadAudit);
  $('#refreshTracking').addEventListener('click',() => loadTracking().catch((error) => toast(error.message,true))); ['trackingRobotFilter','trackingStatusFilter'].forEach((id) => $(`#${id}`).addEventListener('change',renderTracking));
  $('#refreshResources').addEventListener('click', () => loadAutoXingResources().catch((error) => toast(error.message, true)));
  $('#refreshAutoXingOperations').addEventListener('click', () => loadAutoXingOperations().catch((error) => toast(error.message, true)));
  $('#refreshCenoBotsOperations').addEventListener('click', () => loadCenoBotsOperations().catch((error) => toast(error.message, true)));
  $('#cenoBotsControlRobot').addEventListener('change',() => loadCenoBotsSchedules().catch((error) => toast(error.message,true))); document.querySelectorAll('[data-cenobots-command]').forEach((button) => button.addEventListener('click',() => openCenoBotsCommand(button.dataset.cenobotsCommand))); $('#newCenoBotsSchedule').addEventListener('click',openCenoBotsSchedule); $('#cenoBotsScheduleEverywhere').addEventListener('change',(event) => $('#cenoBotsScheduleAreaField').classList.toggle('hidden',event.target.checked));
  $('#refreshMaintenanceSchedules').addEventListener('click',() => loadMaintenanceSchedules().catch((error) => toast(error.message,true)));
  $('#newMaintenanceSchedule').addEventListener('click',() => openMaintenanceScheduleDialog().catch((error) => toast(error.message,true)));
  $('#maintenanceRobot').addEventListener('change',populateMaintenanceTechnicians);
  $('#downloadDiagnosticReport').addEventListener('click',() => { const robotId=$('#diagnosticRobotSelect').value; if (!robotId) return toast('Select an AutoXing robot first',true); download(`/api/v1/autoxing/diagnostic-reports/${encodeURIComponent(robotId)}`,'autoxing-diagnostic.json').catch((error) => toast(error.message,true)); });
  $('#newEscalationRule').addEventListener('click',openEscalationRuleDialog);
  $('#evaluateEscalations').addEventListener('click',async () => { try { const payload=await api('/api/v1/autoxing/escalations/evaluate',{ method:'POST',body:'{}' }); toast(`${payload.data.createdCount} new escalation${payload.data.createdCount === 1 ? '' : 's'}`); await Promise.all([loadEscalationRules(),loadAutoXingOperations(),loadServiceCases(),loadEmailNotifications()]); } catch(error){ toast(error.message,true); } });
  $('#refreshMonitoring').addEventListener('click', () => loadMonitoring().catch((error) => toast(error.message,true)));
  $('#refreshReports').addEventListener('click',() => loadReports().catch((error) => toast(error.message,true))); $('#reportPeriod').addEventListener('change',() => loadReports().catch((error) => toast(error.message,true))); $('#exportReportCsv').addEventListener('click',() => { const days=$('#reportPeriod').value; download(`/api/v1/reports/operations.csv?days=${days}`,`altegro-operations-${days}d.csv`).catch((error) => toast(error.message,true)); }); $('#exportReportJson').addEventListener('click',() => { const days=$('#reportPeriod').value; download(`/api/v1/reports/operations.json?days=${days}`,`altegro-operations-${days}d.json`).catch((error) => toast(error.message,true)); });
  $('#exportMaintenancePdf').addEventListener('click',() => { const robotId=$('#pdfReportRobot').value; if (!robotId) return toast('Select a robot first',true); download(`/api/v1/robots/${encodeURIComponent(robotId)}/reports/maintenance.pdf`,'altegro-maintenance.pdf').catch((error) => toast(error.message,true)); }); $('#exportCompliancePdf').addEventListener('click',() => { const robotId=$('#pdfReportRobot').value; if (!robotId) return toast('Select a robot first',true); download(`/api/v1/robots/${encodeURIComponent(robotId)}/reports/compliance.pdf`,'altegro-compliance.pdf').catch((error) => toast(error.message,true)); });
  $('#refreshSupportTickets').addEventListener('click',() => loadSupportTickets().catch((error) => toast(error.message,true))); $('#supportStatusFilter').addEventListener('change',renderSupportTickets); $('#newSupportTicket').addEventListener('click',() => { $('#supportTicketForm').reset(); populateFeatureRobotSelects(); $('#supportTicketDialog').showModal(); });
  let fleetSearchTimer; $('#autoXingFleetSearch').addEventListener('input',(event) => { clearTimeout(fleetSearchTimer); fleetSearchTimer=setTimeout(() => { state.autoXingFleet.query=event.target.value; state.autoXingFleet.page=1; renderAutoXingFleet(); },150); });
  [['autoXingFleetStatus','status'],['autoXingFleetBattery','battery'],['autoXingFleetAlerts','alerts']].forEach(([id,key]) => $(`#${id}`).addEventListener('change',(event) => { state.autoXingFleet[key]=event.target.value; state.autoXingFleet.page=1; renderAutoXingFleet(); }));
  let cenoBotsSearchTimer; $('#cenoBotsFleetSearch').addEventListener('input',(event) => { clearTimeout(cenoBotsSearchTimer); cenoBotsSearchTimer=setTimeout(() => { state.cenoBotsFleet.query=event.target.value; renderCenoBotsOperations(); },150); });
  [['cenoBotsFleetStatus','status'],['cenoBotsFleetAttention','attention']].forEach(([id,key]) => $(`#${id}`).addEventListener('change',(event) => { state.cenoBotsFleet[key]=event.target.value; renderCenoBotsOperations(); }));
  $('#autoXingFleetPrevious').addEventListener('click',() => { if (state.autoXingFleet.page > 1) { state.autoXingFleet.page -= 1; renderAutoXingFleet(); } }); $('#autoXingFleetNext').addEventListener('click',() => { state.autoXingFleet.page += 1; renderAutoXingFleet(); });
  $('#refreshTasks').addEventListener('click', () => loadAutoXingTasks().catch((error) => toast(error.message, true)));
  $('#taskRobotFilter').addEventListener('change', () => loadAutoXingTasks().catch((error) => toast(error.message, true)));
  $('#refreshRobotAccounts').addEventListener('click', () => loadRobotAccounts().catch((error) => toast(error.message, true)));
  $('#refreshEmailNotifications').addEventListener('click',() => loadEmailNotifications().catch((error) => toast(error.message,true)));
  $('#testEmailNotification').addEventListener('click',async () => { const button=$('#testEmailNotification'); button.disabled=true; try { await api('/api/v1/email-notifications/test',{ method:'POST',body:'{}' }); toast('Test email delivered'); await loadEmailNotifications(); } catch(error){ toast(error.message,true); } finally { button.disabled=false; } });
  $('#refreshSmsNotifications').addEventListener('click',() => loadSmsNotifications().catch((error) => toast(error.message,true))); $('#testSmsNotification').addEventListener('click',async () => { const button=$('#testSmsNotification'); button.disabled=true; try { await api('/api/v1/sms-notifications/test',{ method:'POST',body:'{}' }); toast('Test SMS delivered'); await loadSmsNotifications(); } catch(error){ toast(error.message,true); } finally { button.disabled=false; } });
  $('#refreshWorkforce').addEventListener('click', () => loadWorkforceMatrix().catch((error) => toast(error.message, true)));
  $('#workforceRobotFilter').addEventListener('change', () => loadWorkforceMatrix().catch((error) => toast(error.message, true)));
  $('#workforceStatusFilter').addEventListener('change', renderWorkforceMatrix);
  ['eventRobotFilter','eventSeverityFilter','eventTypeFilter','eventFromFilter','eventToFilter'].forEach((id) => $(`#${id}`).addEventListener('change', loadEvents)); $('#clearEventFilters').addEventListener('click', () => { ['eventRobotFilter','eventSeverityFilter','eventTypeFilter','eventFromFilter','eventToFilter'].forEach((id) => { $(`#${id}`).value = ''; }); loadEvents(); });
  document.querySelectorAll('[data-metric-action]').forEach((card) => { card.addEventListener('click', () => applyMetricAction(card.dataset.metricAction)); card.addEventListener('keydown', (event) => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); applyMetricAction(card.dataset.metricAction); } }); });
  $('#syncAll').addEventListener('click', syncAllAdapters); $('#syncAutoXing').addEventListener('click', () => syncAdapter('autoxing')); $('#syncCenoBots').addEventListener('click', () => syncAdapter('cenobots')); $('#syncCenoBotsWorkspace').addEventListener('click', () => syncAdapter('cenobots'));
  $('#exportTenant').addEventListener('click', () => download('/api/v1/exports/tenant.json', 'altegro-tenant-export.json').catch((error) => toast(error.message, true)));
  $('#exportRobotsCsv').addEventListener('click', () => download('/api/v1/exports/robots.csv', 'altegro-robots.csv').catch((error) => toast(error.message, true)));
  $('#serviceTechniciansButton').addEventListener('click', () => { setDashboardView('workforce'); $('#workforceSection').scrollIntoView({ behavior:'smooth', block:'start' }); });
  $('#logoutButton').addEventListener('click', logout);
  $('#notificationsButton').addEventListener('click', async () => { try { await loadNotifications(); $('#notificationsDialog').showModal(); } catch (error) { toast(error.message, true); } });
  $('#notificationsDialog').addEventListener('close',() => markVisibleNotificationsRead().catch((error) => toast(error.message,true)));
  ['notificationSeverity','notificationStatus'].forEach((id) => $(`#${id}`).addEventListener('change',renderNotifications)); let notificationSearchTimer; $('#notificationSearch').addEventListener('input',() => { clearTimeout(notificationSearchTimer); notificationSearchTimer=setTimeout(renderNotifications,150); }); $('#notificationWorkflowStatus').addEventListener('change',updateNotificationSnoozeField);
  $('#notificationWorkflowForm').addEventListener('submit',async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; setFormBusy(form,true); try { const status=$('#notificationWorkflowStatus').value; await api(`/api/v1/notifications/${encodeURIComponent(state.selectedNotificationId)}`,{ method:'PATCH',body:JSON.stringify({ status,technicianId:$('#notificationTechnician').value || undefined,note:$('#notificationWorkflowNote').value.trim(),snoozeUntil:status === 'snoozed' && $('#notificationSnoozeUntil').value ? new Date($('#notificationSnoozeUntil').value).toISOString() : undefined }) }); $('#notificationWorkflowDialog').close(); toast('Notification workflow updated'); await loadNotifications(); } catch(error){ toast(error.message,true); } finally { setFormBusy(form,false); } });
  $('#newCompatibilityButton').addEventListener('click', openCompatibilityDialog);
  $('#newTechnicianButton').addEventListener('click', openTechnicianDialog);
  $('#qualificationKind').addEventListener('change', updateQualificationFields);
  $('#technicianAvailabilityForm').addEventListener('submit',async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; const workingDays=[...document.querySelectorAll('[name="availabilityDay"]:checked')].map((input) => input.value); if (!workingDays.length) return toast('Select at least one working day',true); setFormBusy(form,true); try { await api(`/api/v1/technicians/${encodeURIComponent($('#availabilityTechnicianId').value)}/availability`,{ method:'PATCH',body:JSON.stringify({ status:$('#availabilityStatus').value,availableFrom:$('#availabilityFrom').value ? new Date($('#availabilityFrom').value).toISOString() : null,availableUntil:$('#availabilityUntil').value ? new Date($('#availabilityUntil').value).toISOString() : null,dailyCapacityHours:Number($('#availabilityCapacity').value),workingDays,notes:$('#availabilityNotes').value.trim(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin' }) }); $('#technicianAvailabilityDialog').close(); toast('Technician availability updated'); await Promise.all([loadWorkforceMatrix(),loadReports()]); } catch(error){ toast(error.message,true); } finally { setFormBusy(form,false); } });
  $('#alertWorkflowForm').addEventListener('submit',async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; setFormBusy(form,true); try { await updateAlertWorkflow(state.selectedAlertId,{ status:$('#alertWorkflowStatus').value,technicianId:$('#alertWorkflowTechnician').value || undefined,note:$('#alertWorkflowNote').value.trim(),createServiceCase:$('#alertCreateServiceCase').checked }); $('#alertWorkflowDialog').close(); } catch {} finally { setFormBusy(form,false); } });
  $('#maintenanceScheduleForm').addEventListener('submit',async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; setFormBusy(form,true); try { await api('/api/v1/autoxing/maintenance-schedules',{ method:'POST',body:JSON.stringify({ robotId:$('#maintenanceRobot').value,title:$('#maintenanceTitle').value.trim(),nextDueAt:new Date($('#maintenanceNextDue').value).toISOString(),intervalDays:Number($('#maintenanceInterval').value),priority:$('#maintenancePriority').value,assignedTechnicianId:$('#maintenanceTechnician').value || undefined,description:$('#maintenanceDescription').value.trim() }) }); $('#maintenanceScheduleDialog').close(); toast('Maintenance schedule created'); await Promise.all([loadMaintenanceSchedules(),loadAutoXingOperations()]); } catch(error){ toast(error.message,true); } finally { setFormBusy(form,false); } });
  $('#escalationRuleForm').addEventListener('submit',async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; setFormBusy(form,true); try { await api('/api/v1/autoxing/escalation-rules',{ method:'POST',body:JSON.stringify({ name:$('#escalationRuleName').value.trim(),alertType:$('#escalationAlertType').value,minimumSeverity:$('#escalationSeverity').value,afterMinutes:Number($('#escalationAfterMinutes').value),action:$('#escalationAction').value,technicianId:$('#escalationTechnician').value || undefined }) }); $('#escalationRuleDialog').close(); toast('Escalation rule created'); await loadEscalationRules(); } catch(error){ toast(error.message,true); } finally { setFormBusy(form,false); } });
  $('#cenoBotsCommandForm').addEventListener('submit',async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; setFormBusy(form,true); try { const action=$('#cenoBotsCommandAction').value; await api(`/api/v1/cenobots/robots/${encodeURIComponent($('#cenoBotsCommandRobotId').value)}/commands`,{ method:'POST',body:JSON.stringify({ action,execute:true,confirmation:$('#cenoBotsCommandConfirmation').value }) }); $('#cenoBotsCommandDialog').close(); toast(`CenoBots accepted ${action.replaceAll('-',' ')}`); await Promise.all([loadCenoBotsOperations(),loadEvents(),loadAudit()]); } catch(error){ toast(error.message,true); } finally { setFormBusy(form,false); } });
  $('#cenoBotsScheduleForm').addEventListener('submit',async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; const repeat=[...document.querySelectorAll('[name="cenoBotsRepeat"]:checked')].map((input) => input.value); if (!repeat.length) return toast('Select at least one repeat day',true); setFormBusy(form,true); try { const robotId=$('#cenoBotsScheduleRobot').value; await api(`/api/v1/cenobots/robots/${encodeURIComponent(robotId)}/commands`,{ method:'POST',body:JSON.stringify({ action:'schedule',execute:true,confirmation:$('#cenoBotsScheduleConfirmation').value,mapId:Number($('#cenoBotsScheduleMapId').value),mapVersion:$('#cenoBotsScheduleMapVersion').value.trim(),startTime:$('#cenoBotsScheduleStart').value.trim().toUpperCase(),duration:Number($('#cenoBotsScheduleDuration').value),intensity:$('#cenoBotsScheduleIntensity').value,cleanEverywhere:$('#cenoBotsScheduleEverywhere').checked,areaIds:$('#cenoBotsScheduleAreas').value.split(',').map((item) => item.trim()).filter(Boolean),repeat }) }); $('#cenoBotsScheduleDialog').close(); $('#cenoBotsControlRobot').value=robotId; toast('CenoBots cleaning schedule created'); await Promise.all([loadCenoBotsSchedules(),loadEvents(),loadAudit()]); } catch(error){ toast(error.message,true); } finally { setFormBusy(form,false); } });
  $('#supportTicketForm').addEventListener('submit',async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; setFormBusy(form,true); try { await api('/api/v1/support/tickets',{ method:'POST',body:JSON.stringify({ robotId:$('#supportTicketRobot').value,category:$('#supportTicketCategory').value,severity:$('#supportTicketSeverity').value,title:$('#supportTicketSubject').value.trim(),description:$('#supportTicketDescription').value.trim() }) }); $('#supportTicketDialog').close(); toast('Support ticket created'); await Promise.all([loadSupportTickets(),loadServiceCases(),loadNotifications()]); } catch(error){ toast(error.message,true); } finally { setFormBusy(form,false); } });
  $('#supportReplyForm').addEventListener('submit',async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; setFormBusy(form,true); try { const body={ message:$('#supportReplyMessage').value.trim() }; if (state.supportPermissions?.manage) body.status=$('#supportReplyStatus').value; await api(`/api/v1/support/tickets/${encodeURIComponent($('#supportReplyTicketId').value)}/messages`,{ method:'POST',body:JSON.stringify(body) }); $('#supportReplyDialog').close(); toast('Support update sent'); await Promise.all([loadSupportTickets(),loadServiceCases()]); } catch(error){ toast(error.message,true); } finally { setFormBusy(form,false); } });
  $('#workforceMatrixList').addEventListener('click', async (event) => {
    const qualify = event.target.closest('[data-qualify-technician]'); if (qualify) return openQualificationDialog(qualify.dataset.qualifyTechnician, qualify.dataset.technicianName);
    const assign = event.target.closest('[data-assign-technician]'); const unassign = event.target.closest('[data-unassign]');
    try {
      if (assign) { await api('/api/v1/robot-assignments',{ method:'POST',body:JSON.stringify({ technicianId:assign.dataset.assignTechnician, robotId:assign.dataset.assignRobot }) }); toast('Qualified technician assigned'); await refreshWorkforceAndPassport(assign.dataset.assignRobot); }
      if (unassign) { const row = state.workforce.rows.find((item) => item.assignment?.id === unassign.dataset.unassign); await api(`/api/v1/robot-assignments/${unassign.dataset.unassign}`,{ method:'DELETE' }); toast('Technician assignment removed'); await refreshWorkforceAndPassport(row?.robot.id); }
    } catch (error) { toast(error.message,true); }
  });
  $('#loginForm').addEventListener('submit', async (event) => { event.preventDefault(); const error = $('#loginError'); const form = event.currentTarget; error.textContent = ''; setFormBusy(form, true); try { await login($('#loginEmail').value.trim(), $('#loginPassword').value); } catch (loginError) { error.textContent = loginError.message; } finally { setFormBusy(form, false); } });
  const dialog = $('#robotDialog'); const existingRobotSelect = $('#existingRobotId'); const serialInput = $('#serialNumber'); const modelSelect = $('#modelId'); const robotUsername = $('#robotUsername'); const robotPassword = $('#robotPassword'); const accountFields = $('#robotAccountFields'); const registerButton = $('#registerButton'); const serialHint = $('#serialNumberHint'); const providerSelect=$('#onboardingProvider'); const externalIdInput=$('#onboardingExternalId');
  const setWizardStep=(step) => { state.onboardingStep=Math.max(1,Math.min(3,step)); document.querySelectorAll('[data-wizard-step]').forEach((element) => element.classList.toggle('hidden',Number(element.dataset.wizardStep) !== state.onboardingStep)); document.querySelectorAll('[data-wizard-progress]').forEach((element) => { const current=Number(element.dataset.wizardProgress); element.classList.toggle('active',current === state.onboardingStep); element.classList.toggle('complete',current < state.onboardingStep); }); $('#onboardingBack').classList.toggle('hidden',state.onboardingStep === 1); $('#onboardingNext').classList.toggle('hidden',state.onboardingStep === 3); registerButton.classList.toggle('hidden',state.onboardingStep !== 3); if (state.onboardingStep === 3) $('#onboardingReview').innerHTML=`<strong>${escapeHtml(serialInput.value || 'New robot')}</strong><span>${escapeHtml(providerSelect.value)} · ${escapeHtml(modelSelect.options[modelSelect.selectedIndex]?.text || '')}</span><span>${escapeHtml(externalIdInput.value || 'No provider identity')}</span>`; };
  const updateProviderFields=() => { const provider=providerSelect.value; $('#externalIdentityField').classList.toggle('hidden',provider === 'manual'); externalIdInput.required=provider !== 'manual'; if (provider === 'autoxing') modelSelect.value='model-autoxing-a1'; if (provider === 'cenobots') modelSelect.value='model-cenobots-c1'; if (provider === 'manual') modelSelect.value='model-mock-m3'; };
  const setNewRobotFields = (isNew) => { const manualCredentials = isNew && state.user.role !== 'robot_user'; serialHint.classList.remove('field-error'); serialInput.readOnly = !isNew; robotUsername.disabled = !manualCredentials; robotPassword.disabled = !manualCredentials; robotUsername.required = manualCredentials; robotPassword.required = manualCredentials; accountFields.classList.toggle('hidden', state.user.role === 'robot_user'); serialHint.textContent=isNew ? (state.user.role === 'robot_user' ? 'The robot will be added to your current account.' : 'Enter a new unique serial number.') : 'Existing synchronized robot selected.'; };
  $('#newRobotButton').addEventListener('click', () => { existingRobotSelect.value=''; providerSelect.value='autoxing'; serialInput.value=''; externalIdInput.value=''; robotUsername.value=''; robotPassword.value=''; $('#onboardingOrganization').value='org-demo'; $('#onboardingOperator').value='org-service'; setNewRobotFields(true); updateProviderFields(); setWizardStep(1); dialog.showModal(); });
  existingRobotSelect.addEventListener('change', () => { const robot=state.robotOptions.find((item) => item.id === existingRobotSelect.value); if (!robot) { serialInput.value=''; setNewRobotFields(true); return; } const identity=robot.externalIdentities?.[0]; providerSelect.value=identity?.system === 'cenobots' ? 'cenobots' : identity?.system === 'autoxing' ? 'autoxing' : 'manual'; modelSelect.value=robot.modelId; serialInput.value=robot.serialNumber; externalIdInput.value=identity?.externalId || ''; setNewRobotFields(false); updateProviderFields(); });
  providerSelect.addEventListener('change',updateProviderFields); $('#onboardingBack').addEventListener('click',() => setWizardStep(state.onboardingStep-1)); $('#onboardingNext').addEventListener('click',async () => { const existingRobot=state.robotOptions.find((item) => item.id === existingRobotSelect.value); if (state.onboardingStep === 1 && existingRobot) { dialog.close(); setDashboardView('robots'); await loadPassport(existingRobot.id); return toast(`Opened ${existingRobot.serialNumber}`); } const current=document.querySelector(`[data-wizard-step="${state.onboardingStep}"]`); const invalid=[...current.querySelectorAll('input,select')].find((input) => !input.checkValidity()); if (invalid) return invalid.reportValidity(); setWizardStep(state.onboardingStep+1); });
  $('#robotForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return; event.preventDefault(); if (state.onboardingStep !== 3) { $('#onboardingNext').click(); return; } const form = event.currentTarget; setFormBusy(form, true);
    try {
      const existingRobot = state.robotOptions.find((item) => item.id === existingRobotSelect.value);
      if (existingRobot) { dialog.close(); await loadPassport(existingRobot.id); toast(`Opened ${existingRobot.serialNumber}`); return; }
      const registeredSerial = serialInput.value.trim();
      if (!/^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(registeredSerial)) throw new Error('Use only letters, numbers, dots, underscores, slashes, or hyphens in the serial number');
      if (await serialNumberExists(registeredSerial)) { serialHint.textContent = 'This serial number is already registered.'; serialHint.classList.add('field-error'); serialInput.focus(); throw new Error('A robot with that serial number already exists'); }
      const provider=providerSelect.value; const payload = await api('/api/v1/robots', { method:'POST', body:JSON.stringify({ modelId:modelSelect.value, siteId:$('#onboardingSite').value, organizationId:$('#onboardingOrganization').value, operatorOrganizationId:$('#onboardingOperator').value, serialNumber:registeredSerial, externalIdentities:provider !== 'manual' && externalIdInput.value.trim() ? [{ system:provider,externalId:externalIdInput.value.trim() }] : [], username:state.user.role === 'robot_user' ? undefined : robotUsername.value.trim(), password:state.user.role === 'robot_user' ? undefined : robotPassword.value }) });
      dialog.close(); serialInput.value = ''; robotUsername.value = ''; robotPassword.value = ''; serialHint.classList.remove('field-error');
      if (payload.account) { $('#createdAccountCredentials').textContent = `Robot: ${registeredSerial}\nUsername: ${payload.account.username}\nPassword: ${payload.account.password}`; $('#credentialsDialog').showModal(); } else toast(payload.accountReused ? 'Robot registered in your current login account' : 'Robot registered as draft');
      await refreshAll();
    } catch (error) { toast(error.message, true); } finally { setFormBusy(form, false); }
  });
  $('#eventForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form = event.currentTarget; setFormBusy(form, true);
    try { const attachment = await readAttachment($('#eventAttachment').files[0]); await api(`/api/v1/robots/${$('#eventDialog').dataset.robotId}/events`, { method:'POST', body:JSON.stringify({ title:$('#eventTitle').value.trim(), description:$('#eventDescription').value.trim(), eventType:$('#eventType').value, severity:$('#eventSeverity').value, occurredAt:new Date($('#eventOccurredAt').value).toISOString(), sourceSystem:$('#eventSource').value.trim(), sourceEventId:$('#eventSourceId').value.trim() || undefined, attachment }) }); $('#eventDialog').close(); $('#eventTitle').value = ''; $('#eventDescription').value = ''; $('#eventSourceId').value = ''; toast('Event added to Robot Passport'); await Promise.all([loadPassport(state.selectedRobotId), loadEvents(), loadOperationsSummary()]); } catch (error) { toast(error.message, true); } finally { setFormBusy(form, false); }
  });
  $('#incidentForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form = event.currentTarget; setFormBusy(form, true);
    try { await api('/api/v1/incidents', { method:'POST', body:JSON.stringify({ robotId:$('#incidentDialog').dataset.robotId, title:$('#incidentTitle').value.trim(), description:$('#incidentDescription').value.trim(), severity:$('#incidentSeverity').value, assignedTo:$('#incidentAssignedTo').value.trim() || undefined }) }); $('#incidentDialog').close(); toast('Incident opened and linked to the Robot Passport'); await refreshAll(); } catch (error) { toast(error.message, true); } finally { setFormBusy(form, false); }
  });
  $('#lifecycleType').addEventListener('change', updateLifecycleFields);
  $('#lifecycleForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form = event.currentTarget; setFormBusy(form, true);
    try { const recordType = $('#lifecycleType').value; if (recordType === 'certificate' && !$('#lifecycleValidUntil').value) throw new Error('Certificate expiry date is required'); if (recordType === 'deployment' && !$('#lifecycleVersion').value.trim()) throw new Error('Deployment version is required'); const attachment = recordType === 'document' ? await readAttachment($('#lifecycleAttachment').files[0]) : null; await api(`/api/v1/robots/${$('#lifecycleDialog').dataset.robotId}/lifecycle-records`, { method:'POST', body:JSON.stringify({ recordType, title:$('#lifecycleTitle').value.trim(), description:$('#lifecycleDescription').value.trim(), version:$('#lifecycleVersion').value.trim() || undefined, status:$('#lifecycleStatus').value || undefined, issuer:$('#lifecycleIssuer').value.trim() || undefined, validUntil:$('#lifecycleValidUntil').value ? new Date($('#lifecycleValidUntil').value).toISOString() : undefined, attachment }) }); $('#lifecycleDialog').close(); toast(`${recordType} added to the Robot Passport`); await Promise.all([loadPassport(state.selectedRobotId), loadOperationsSummary()]); } catch (error) { toast(error.message, true); } finally { setFormBusy(form, false); }
  });
  $('#compatibilityForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form = event.currentTarget; setFormBusy(form, true);
    try { await api('/api/v1/compatibility', { method:'POST', body:JSON.stringify({ modelId:$('#compatibilityModel').value, capability:$('#compatibilityCapability').value.trim(), versionConstraint:$('#compatibilityVersion').value.trim(), status:$('#compatibilityStatus').value, evidence:$('#compatibilityEvidence').value.trim() }) }); $('#compatibilityDialog').close(); toast('Compatibility record added'); await Promise.all([loadCompatibility(), state.selectedRobotId ? loadPassport(state.selectedRobotId) : Promise.resolve()]); } catch (error) { toast(error.message, true); } finally { setFormBusy(form, false); }
  });
  $('#technicianForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; setFormBusy(form,true);
    try { const payload=await api('/api/v1/technicians',{ method:'POST',body:JSON.stringify({ name:$('#technicianName').value.trim(),email:$('#technicianEmail').value.trim(),organizationId:$('#technicianOrganization').value }) }); $('#technicianDialog').close(); toast('Technician created'); await loadWorkforceMatrix(); openQualificationDialog(payload.data.id,payload.data.name); } catch(error){ toast(error.message,true); } finally { setFormBusy(form,false); }
  });
  $('#qualificationForm').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return; event.preventDefault(); const form=event.currentTarget; setFormBusy(form,true); const kind=$('#qualificationKind').value; const technicianId=$('#qualificationDialog').dataset.technicianId;
    try { await api(`/api/v1/technicians/${technicianId}/qualifications`,{ method:'POST',body:JSON.stringify({ kind,code:$('#qualificationCode').value,level:$('#qualificationLevel').value,issuer:kind==='certificate'?$('#qualificationIssuer').value.trim():undefined,validUntil:kind==='certificate'?$('#qualificationValidUntil').value:undefined,modelIds:kind==='certificate'&&$('#qualificationModel').value?[$('#qualificationModel').value]:[] }) }); $('#qualificationDialog').close(); toast('Qualification saved'); await loadWorkforceMatrix(); } catch(error){ toast(error.message,true); } finally { setFormBusy(form,false); }
  });
}

(async function init() { applyLanguage(); applyAccessibility(); bindUi(); if (!await restoreSession()) showLogin(); })();
