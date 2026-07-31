'use strict';

const state = { token: null, user: null, otpChallenge: null, robots: [], serviceCases: [], compatibility: [], summary: null, selectedRobotId: null };
const $ = (selector) => document.querySelector(selector);
const api = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Request failed');
  return payload;
};
const download = async (path, fallbackName) => {
  const response = await fetch(path, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!response.ok) { const payload = await response.json(); throw new Error(payload.error?.message || 'Export failed'); }
  const blob = await response.blob(); const disposition = response.headers.get('content-disposition') || ''; const match = disposition.match(/filename="([^"]+)"/); const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = match?.[1] || fallbackName; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const formatDate = (value) => value ? new Date(value).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : '—';
const toDateTimeLocal = (date = new Date()) => { const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16); };

function toast(message, isError = false) {
  const element = $('#toast'); element.textContent = message; element.classList.toggle('error', isError); element.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 3200);
}

function showLogin() {
  $('#loginScreen').classList.remove('hidden'); $('#appShell').classList.add('hidden'); $('#loginForm').classList.remove('hidden'); $('#otpForm').classList.add('hidden'); $('#loginPassword').value = ''; $('#otpCode').value = ''; state.otpChallenge = null;
}

function showOtpChallenge(payload) {
  state.otpChallenge = payload; $('#loginForm').classList.add('hidden'); $('#otpForm').classList.remove('hidden'); $('#otpDestination').textContent = `Enter the one-time code sent to ${payload.destination}. It expires in ${Math.ceil(payload.expiresInSeconds / 60)} minutes.`; $('#otpError').textContent = ''; $('#otpCode').value = ''; $('#otpCode').focus();
}

function showApp() {
  $('#loginScreen').classList.add('hidden'); $('#appShell').classList.remove('hidden');
  $('#loggedInUser').textContent = `${state.user.name} · ${state.user.role.replaceAll('_', ' ')}`;
  const robotUser = state.user.role === 'robot_user'; const auditor = state.user.role === 'auditor';
  ['syncAutoXing', 'syncCenoBots'].forEach((id) => { const element = $(`#${id}`); if (element) element.classList.toggle('hidden', robotUser || auditor); });
  $('#newRobotButton').classList.toggle('hidden', auditor);
  $('#exportTenant').classList.toggle('hidden', robotUser);
  const accountFields = $('#robotAccountFields'); if (accountFields) accountFields.classList.toggle('hidden', robotUser);
}

function populateExistingRobotSelect() {
  const select = $('#existingRobotId');
  if (!select) return;
  const selected = select.value;
  select.innerHTML = '<option value="">＋ New robot</option>' + state.robots.map((robot) => `<option value="${escapeHtml(robot.id)}">${escapeHtml(robot.serialNumber)} · ${escapeHtml(robot.externalIdentities?.[0]?.system || 'manual')} · ${escapeHtml(robot.status)}</option>`).join('');
  if (selected && state.robots.some((robot) => robot.id === selected)) select.value = selected;
}

async function login(email, password) {
  const response = await fetch('/api/v1/auth/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ email, password }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Unable to sign in');
  $('#loginPassword').value = '';
  if (payload.otpRequired) return showOtpChallenge(payload);
  await completeLogin(payload);
}

async function completeLogin(payload) {
  state.token = payload.token; state.user = payload.user; state.otpChallenge = null; showApp(); await refreshAll();
}

async function verifyOtp(code) {
  if (!state.otpChallenge) throw new Error('Start the login again');
  const response = await fetch('/api/v1/auth/otp/verify', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ challengeId:state.otpChallenge.challengeId, code }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'OTP verification failed');
  await completeLogin(payload);
}

async function resendOtp() {
  if (!state.otpChallenge) throw new Error('Start the login again');
  const response = await fetch('/api/v1/auth/otp/resend', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ challengeId:state.otpChallenge.challengeId }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Could not resend the OTP');
  showOtpChallenge(payload); toast('A new one-time code was sent');
}

function logout() {
  const token = state.token; if (token) fetch('/api/v1/auth/logout', { method:'POST', headers:{ Authorization:`Bearer ${token}` } }).catch(() => {});
  sessionStorage.removeItem('altegroSession'); state.token = null; state.user = null; state.otpChallenge = null; state.robots = []; state.selectedRobotId = null; showLogin();
}

async function loadRobots() {
  const params = new URLSearchParams(); const query = $('#searchInput').value.trim(); const status = $('#statusFilter').value;
  if (query) params.set('q', query); if (status) params.set('status', status);
  const payload = await api(`/api/v1/robots?${params}`); state.robots = payload.data;
  $('#robotCount').textContent = payload.count; $('#metricTotal').textContent = payload.count;
  $('#metricActive').textContent = payload.data.filter((robot) => robot.status === 'active').length;
  $('#metricDraft').textContent = payload.data.filter((robot) => robot.status === 'draft').length;
  populateExistingRobotSelect();
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
    <td><button class="view-button" data-robot-id="${escapeHtml(robot.id)}">View →</button></td>
  </tr>`).join('');
  table.querySelectorAll('[data-robot-id]').forEach((button) => button.addEventListener('click', () => loadPassport(button.dataset.robotId)));
}

async function loadPassport(robotId) {
  try {
    const payload = await api(`/api/v1/robots/${robotId}/passport`); state.selectedRobotId = robotId; renderPassport(payload.data);
  } catch (error) { toast(error.message, true); }
}

function renderPassport(passport) {
  const robot = passport.robot; const model = passport.model || {}; const entries = [...(passport.entries || [])].reverse(); const documents = passport.documents || []; const certificates = passport.certificates || []; const deployments = passport.deployments || []; const cases = passport.serviceCases || []; const compatibility = passport.compatibility || [];
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
    </div>
    <div class="subhead"><h4>Compatibility</h4><span class="serial">${compatibility.length} model records</span></div><div class="compatibility-chips">${compatibility.map((item) => `<span class="compatibility-${escapeHtml(item.status)}">${escapeHtml(item.capability)} · ${escapeHtml(item.status.replaceAll('_', ' '))}</span>`).join('') || '<span class="serial">No compatibility records.</span>'}</div>
    <div class="subhead"><h4>Lifecycle history</h4><div><button class="text-button" id="addEventButton">＋ Add event</button><span class="serial">${entries.length} entries</span></div></div>
    <div class="entries">${entries.length ? entries.slice(0, 8).map((entry) => `<div class="entry"><div class="entry-type">${escapeHtml(entry.data?.title || entry.type.replaceAll('_', ' '))}</div><div class="entry-meta"><span class="entry-source">${escapeHtml(entry.source)}</span> · ${formatDate(entry.occurredAt)}${entry.data?.severity ? ` · ${escapeHtml(entry.data.severity)}` : ''}</div>${entry.data?.description ? `<div class="entry-description">${escapeHtml(entry.data.description)}</div>` : ''}</div>`).join('') : '<div class="empty">No Passport entries.</div>'}</div>`;
  $('#blockedCommand').addEventListener('click', async () => { try { await api(`/api/v1/robots/${robot.id}/commands`, { method:'POST', body:JSON.stringify({ command:'move' }) }); } catch (error) { toast(`Expected Phase 1 rejection: ${error.message}`); } });
  $('#exportPassport').addEventListener('click', () => download(`/api/v1/robots/${robot.id}/export`, `altegro-passport-${robot.serialNumber}.json`).catch((error) => toast(error.message, true)));
  $('#syncSelected').addEventListener('click', () => syncAdapter(robot.externalIdentities[0]?.system || 'mock-oem'));
  $('#addEventButton').addEventListener('click', () => openEventDialog(robot.id));
  $('#openIncidentButton').addEventListener('click', () => openIncidentDialog(robot.id));
  $('#addLifecycleButton').addEventListener('click', () => openLifecycleDialog(robot.id));
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
  const payload = await api('/api/v1/events'); $('#metricEvents').textContent = payload.data.length;
  $('#eventsList').innerHTML = payload.data.length ? payload.data.slice(-6).reverse().map((event) => `<div class="event-item"><div class="event-main"><strong>${escapeHtml(event.title || event.eventType.replaceAll('_', ' '))}</strong><small>${escapeHtml(event.eventType)} · ${escapeHtml(event.sourceSystem)} · ${escapeHtml(event.robotId.slice(0, 8))}…</small></div><span class="event-time">${escapeHtml(event.severity)}<br />${formatDate(event.ingestedAt)}</span></div>`).join('') : '<div class="empty">No events yet.</div>';
}

async function loadOperationsSummary() {
  const payload = await api('/api/v1/operations/summary'); state.summary = payload.data;
  $('#metricOnline').textContent = payload.data.robots.online;
  $('#metricOpenCases').textContent = payload.data.service.open;
  $('#metricPassportComplete').textContent = `${payload.data.passport.percentage}%`;
  $('#metricCertificatesDue').textContent = payload.data.passport.certificatesDue;
}

async function loadServiceCases() {
  const payload = await api('/api/v1/service-cases'); state.serviceCases = payload.data;
  const writable = !['robot_user', 'auditor'].includes(state.user.role); const nextStatus = { open:'in_progress', in_progress:'waiting', waiting:'resolved', resolved:'closed' };
  $('#serviceCasesList').innerHTML = payload.data.length ? payload.data.slice().reverse().map((item) => `<div class="record-row"><div><strong>${escapeHtml(item.title || item.externalId)}</strong><small>${escapeHtml(item.externalId)} · ${escapeHtml(item.status.replaceAll('_', ' '))} · ${escapeHtml(item.assignedTo || 'unassigned')}</small></div>${writable && nextStatus[item.status] ? `<button class="text-button" data-service-id="${escapeHtml(item.id)}" data-service-status="${nextStatus[item.status]}">Move to ${escapeHtml(nextStatus[item.status].replaceAll('_', ' '))}</button>` : `<span class="status status-${item.status === 'closed' ? 'active' : 'draft'}">${escapeHtml(item.status)}</span>`}</div>`).join('') : '<div class="empty">No service cases yet. Open an incident from a Robot Passport.</div>';
  document.querySelectorAll('[data-service-id]').forEach((button) => button.addEventListener('click', async () => { try { const closing = button.dataset.serviceStatus === 'closed'; await api(`/api/v1/service-cases/${button.dataset.serviceId}`, { method:'PATCH', body:JSON.stringify({ status:button.dataset.serviceStatus, action:closing ? 'Service work completed and verified.' : undefined }) }); toast(`Service case moved to ${button.dataset.serviceStatus.replaceAll('_', ' ')}`); await refreshAll(); } catch (error) { toast(error.message, true); } }));
}

async function loadCompatibility() {
  const payload = await api('/api/v1/compatibility'); state.compatibility = payload.data;
  $('#compatibilityList').innerHTML = payload.data.map((item) => `<div class="record-row"><div><strong>${escapeHtml(item.modelId.replace('model-', '').replaceAll('-', ' '))}</strong><small>${escapeHtml(item.capability)} · ${escapeHtml(item.versionConstraint)}${item.evidence ? ` · ${escapeHtml(item.evidence)}` : ''}</small></div><span class="compatibility-${escapeHtml(item.status)}">${escapeHtml(item.status.replaceAll('_', ' '))}</span></div>`).join('') || '<div class="empty">No compatibility records.</div>';
}

async function loadAdapters() {
  const payload = await api('/api/v1/adapters');
  $('#adaptersList').innerHTML = payload.data.map((adapter) => `<div class="adapter-item"><div><strong>${escapeHtml(adapter.provider)}</strong><small>${escapeHtml(adapter.status)} · v${escapeHtml(adapter.version)}<br />Last sync: ${formatDate(adapter.lastSyncAt)} · ${escapeHtml(adapter.lastSyncStatus || '—')}</small>${adapter.lastError ? `<small class="adapter-error">${escapeHtml(adapter.lastError)}</small>` : ''}</div><div class="adapter-capabilities">Read: ${escapeHtml(adapter.capabilities.read.join(', '))}<br />Events: ${escapeHtml(adapter.capabilities.event.join(', ') || 'none')}<br /><b>Commands: disabled</b></div></div>`).join('');
}

async function syncAdapter(provider) { toast(`Syncing ${provider}…`); try { await api(`/api/v1/adapters/${provider}/sync`, { method:'POST', body:'{}' }); toast(`${provider} adapter synchronized`); await refreshAll(); } catch (error) { toast(`Sync failed: ${error.message}`, true); await loadAdapters(); } }
async function refreshAll() { try { await Promise.all([loadRobots(), loadEvents(), loadAdapters(), loadOperationsSummary(), loadServiceCases(), loadCompatibility()]); } catch (error) { toast(error.message, true); } }

function bindUi() {
  let searchTimer; $('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadRobots, 180); }); $('#statusFilter').addEventListener('change', loadRobots); $('#refreshButton').addEventListener('click', refreshAll); $('#refreshEvents').addEventListener('click', loadEvents); $('#refreshAdapters').addEventListener('click', loadAdapters); $('#refreshServiceCases').addEventListener('click', loadServiceCases);
  $('#syncAutoXing').addEventListener('click', () => syncAdapter('autoxing')); $('#syncCenoBots').addEventListener('click', () => syncAdapter('cenobots'));
  $('#exportTenant').addEventListener('click', () => download('/api/v1/exports/tenant.json', 'altegro-tenant-export.json').catch((error) => toast(error.message, true)));
  $('#logoutButton').addEventListener('click', logout);
  $('#loginForm').addEventListener('submit', async (event) => { event.preventDefault(); const error = $('#loginError'); error.textContent = ''; try { await login($('#loginEmail').value.trim(), $('#loginPassword').value); } catch (loginError) { error.textContent = loginError.message; } });
  $('#otpForm').addEventListener('submit', async (event) => { event.preventDefault(); const error = $('#otpError'); error.textContent = ''; try { await verifyOtp($('#otpCode').value.trim()); } catch (otpError) { error.textContent = otpError.message; $('#otpCode').select(); } });
  $('#resendOtpButton').addEventListener('click', async () => { const error = $('#otpError'); error.textContent = ''; try { await resendOtp(); } catch (otpError) { error.textContent = otpError.message; } });
  $('#backToLoginButton').addEventListener('click', showLogin);
  const dialog = $('#robotDialog'); const existingRobotSelect = $('#existingRobotId'); const serialInput = $('#serialNumber'); const modelSelect = $('#modelId'); const robotUsername = $('#robotUsername'); const robotPassword = $('#robotPassword'); const accountFields = $('#robotAccountFields'); const registerButton = $('#registerButton'); const serialHint = $('#serialNumberHint');
  const setNewRobotFields = (isNew) => { const manualCredentials = isNew && state.user.role !== 'robot_user'; serialInput.readOnly = !isNew; robotUsername.disabled = !manualCredentials; robotPassword.disabled = !manualCredentials; robotUsername.required = manualCredentials; robotPassword.required = manualCredentials; accountFields.classList.toggle('hidden', state.user.role === 'robot_user'); if (isNew) { serialHint.textContent = state.user.role === 'robot_user' ? 'A separate account will be generated automatically.' : 'Enter a new unique serial number.'; registerButton.textContent = 'Register robot'; } else { serialHint.textContent = 'Existing synchronized robot selected.'; registerButton.textContent = 'Open robot'; } };
  $('#newRobotButton').addEventListener('click', () => { existingRobotSelect.value = ''; serialInput.value = ''; robotUsername.value = ''; robotPassword.value = ''; setNewRobotFields(true); dialog.showModal(); });
  existingRobotSelect.addEventListener('change', () => { const robot = state.robots.find((item) => item.id === existingRobotSelect.value); if (!robot) { serialInput.value = ''; setNewRobotFields(true); return; } modelSelect.value = robot.modelId; serialInput.value = robot.serialNumber; robotUsername.value = ''; robotPassword.value = ''; setNewRobotFields(false); });
  $('#robotForm').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); try { const existingRobot = state.robots.find((item) => item.id === existingRobotSelect.value); if (existingRobot) { dialog.close(); await loadPassport(existingRobot.id); toast(`Opened ${existingRobot.serialNumber}`); return; } const registeredSerial = serialInput.value.trim(); const payload = await api('/api/v1/robots', { method:'POST', body:JSON.stringify({ modelId:modelSelect.value, siteId:'site-berlin', organizationId:'org-demo', operatorOrganizationId:'org-service', serialNumber:registeredSerial, username:state.user.role === 'robot_user' ? undefined : robotUsername.value.trim(), password:state.user.role === 'robot_user' ? undefined : robotPassword.value }) }); dialog.close(); serialInput.value = ''; robotUsername.value = ''; robotPassword.value = ''; if (payload.account) { $('#createdAccountCredentials').textContent = `Robot: ${registeredSerial}\nUsername: ${payload.account.username}\nPassword: ${payload.account.password}`; $('#credentialsDialog').showModal(); } else toast(payload.accountReused ? 'Robot registered in your current login account' : 'Robot registered as draft'); await refreshAll(); } catch (error) { toast(error.message, true); } });
  $('#eventForm').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); try { const attachment = await readAttachment($('#eventAttachment').files[0]); await api(`/api/v1/robots/${$('#eventDialog').dataset.robotId}/events`, { method:'POST', body:JSON.stringify({ title:$('#eventTitle').value.trim(), description:$('#eventDescription').value.trim(), eventType:$('#eventType').value, severity:$('#eventSeverity').value, occurredAt:new Date($('#eventOccurredAt').value).toISOString(), sourceSystem:$('#eventSource').value.trim(), sourceEventId:$('#eventSourceId').value.trim() || undefined, attachment }) }); $('#eventDialog').close(); $('#eventTitle').value = ''; $('#eventDescription').value = ''; $('#eventSourceId').value = ''; toast('Event added to Robot Passport'); await Promise.all([loadPassport(state.selectedRobotId), loadEvents()]); } catch (error) { toast(error.message, true); } });
  $('#incidentForm').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); try { await api('/api/v1/incidents', { method:'POST', body:JSON.stringify({ robotId:$('#incidentDialog').dataset.robotId, title:$('#incidentTitle').value.trim(), description:$('#incidentDescription').value.trim(), severity:$('#incidentSeverity').value, assignedTo:$('#incidentAssignedTo').value.trim() || undefined }) }); $('#incidentDialog').close(); toast('Incident opened and linked to the Robot Passport'); await refreshAll(); } catch (error) { toast(error.message, true); } });
  $('#lifecycleType').addEventListener('change', updateLifecycleFields);
  $('#lifecycleForm').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); try { const recordType = $('#lifecycleType').value; if (recordType === 'certificate' && !$('#lifecycleValidUntil').value) throw new Error('Certificate expiry date is required'); if (recordType === 'deployment' && !$('#lifecycleVersion').value.trim()) throw new Error('Deployment version is required'); const attachment = recordType === 'document' ? await readAttachment($('#lifecycleAttachment').files[0]) : null; await api(`/api/v1/robots/${$('#lifecycleDialog').dataset.robotId}/lifecycle-records`, { method:'POST', body:JSON.stringify({ recordType, title:$('#lifecycleTitle').value.trim(), description:$('#lifecycleDescription').value.trim(), version:$('#lifecycleVersion').value.trim() || undefined, status:$('#lifecycleStatus').value || undefined, issuer:$('#lifecycleIssuer').value.trim() || undefined, validUntil:$('#lifecycleValidUntil').value ? new Date($('#lifecycleValidUntil').value).toISOString() : undefined, attachment }) }); $('#lifecycleDialog').close(); toast(`${recordType} added to the Robot Passport`); await Promise.all([loadPassport(state.selectedRobotId), loadOperationsSummary()]); } catch (error) { toast(error.message, true); } });
}

(async function init() { sessionStorage.removeItem('altegroSession'); bindUi(); showLogin(); })();
