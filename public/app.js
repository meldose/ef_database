'use strict';

const state = { token: null, user: null, robots: [], selectedRobotId: null };
const $ = (selector) => document.querySelector(selector);
const api = async (path, options = {}) => {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || 'Request failed');
  return payload;
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const formatDate = (value) => value ? new Date(value).toLocaleString([], { dateStyle:'medium', timeStyle:'short' }) : '—';
const toDateTimeLocal = (date = new Date()) => { const offset = date.getTimezoneOffset(); return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16); };

function toast(message, isError = false) {
  const element = $('#toast'); element.textContent = message; element.classList.toggle('error', isError); element.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 3200);
}

function showLogin() {
  $('#loginScreen').classList.remove('hidden'); $('#appShell').classList.add('hidden'); $('#loginPassword').value = '';
}

function showApp() {
  $('#loginScreen').classList.add('hidden'); $('#appShell').classList.remove('hidden');
  $('#loggedInUser').textContent = `${state.user.name} · ${state.user.role.replaceAll('_', ' ')}`;
  const robotUser = state.user.role === 'robot_user';
  ['syncAutoXing', 'syncCenoBots', 'newRobotButton'].forEach((id) => { const element = $(`#${id}`); if (element) element.classList.toggle('hidden', robotUser); });
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
  state.token = payload.token; state.user = payload.user; sessionStorage.setItem('altegroSession', JSON.stringify({ token: state.token, user: state.user })); showApp(); await refreshAll();
}

function logout() {
  sessionStorage.removeItem('altegroSession'); state.token = null; state.user = null; state.robots = []; state.selectedRobotId = null; showLogin();
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
  const robot = passport.robot; const model = passport.model || {}; const entries = [...(passport.entries || [])].reverse();
  $('#passportContent').className = 'passport-body';
  $('#passportContent').innerHTML = `<div class="passport-title"><div><p class="eyebrow">Immutable Altegro identity</p><h3>${escapeHtml(robot.serialNumber)}</h3><div class="identity-code">${escapeHtml(robot.id)}</div></div><span class="status status-${escapeHtml(robot.status)}">${escapeHtml(robot.status)}</span></div>
    <div class="progress-row"><div class="progress-label"><span>Passport completeness</span><strong>${passport.completeness.percentage}%</strong></div><div class="progress"><span style="width:${passport.completeness.percentage}%"></span></div></div>
    <dl class="detail-grid"><div><dt>Manufacturer</dt><dd>${escapeHtml(model.manufacturer || '—')}</dd></div><div><dt>Model</dt><dd>${escapeHtml(model.model || '—')}</dd></div><div><dt>Owner</dt><dd>${escapeHtml(passport.owner?.name || '—')}</dd></div><div><dt>Operator</dt><dd>${escapeHtml(passport.operator?.name || '—')}</dd></div><div><dt>Site</dt><dd>${escapeHtml(passport.site?.name || '—')}</dd></div><div><dt>External ID</dt><dd>${escapeHtml(robot.externalIdentities[0]?.externalId || '—')}</dd></div><div><dt>AutoXing status</dt><dd>${robot.online === true ? 'Online' : robot.online === false ? 'Offline' : 'Not synced'}</dd></div><div><dt>Battery</dt><dd>${robot.battery != null ? `${escapeHtml(robot.battery)}%` : '—'}</dd></div><div><dt>Mapping</dt><dd>${escapeHtml(robot.mappingStatus || '—')}</dd></div><div><dt>Provider version</dt><dd>${escapeHtml(robot.providerVersion || '—')}</dd></div></dl>
    <div class="passport-actions"><button class="button secondary" id="blockedCommand">Test command gate</button><button class="button primary" id="syncSelected">Sync adapter</button></div>
    <div id="autoxingDetails" class="integration-detail"><div class="subhead"><h4>AutoXing read-only data</h4></div><div class="empty">Loading POIs, areas, maps and task data…</div></div>
    <div class="subhead"><h4>Lifecycle history</h4><div><button class="text-button" id="addEventButton">＋ Add event</button><span class="serial">${entries.length} entries</span></div></div>
    <div class="entries">${entries.length ? entries.slice(0, 8).map((entry) => `<div class="entry"><div class="entry-type">${escapeHtml(entry.data?.title || entry.type.replaceAll('_', ' '))}</div><div class="entry-meta"><span class="entry-source">${escapeHtml(entry.source)}</span> · ${formatDate(entry.occurredAt)}${entry.data?.severity ? ` · ${escapeHtml(entry.data.severity)}` : ''}</div>${entry.data?.description ? `<div class="entry-description">${escapeHtml(entry.data.description)}</div>` : ''}</div>`).join('') : '<div class="empty">No Passport entries.</div>'}</div>`;
  $('#blockedCommand').addEventListener('click', async () => { try { await api(`/api/v1/robots/${robot.id}/commands`, { method:'POST', body:JSON.stringify({ command:'move' }) }); } catch (error) { toast(`Expected Phase 1 rejection: ${error.message}`); } });
  $('#syncSelected').addEventListener('click', () => syncAdapter(robot.externalIdentities[0]?.system || 'mock-oem'));
  $('#addEventButton').addEventListener('click', () => openEventDialog(robot.id));
  if (state.user.role === 'robot_user') ['blockedCommand', 'syncSelected', 'addEventButton'].forEach((id) => $(`#${id}`).classList.add('hidden'));
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

async function loadEvents() {
  const payload = await api('/api/v1/events'); $('#metricEvents').textContent = payload.data.length;
  $('#eventsList').innerHTML = payload.data.length ? payload.data.slice(-6).reverse().map((event) => `<div class="event-item"><div class="event-main"><strong>${escapeHtml(event.title || event.eventType.replaceAll('_', ' '))}</strong><small>${escapeHtml(event.eventType)} · ${escapeHtml(event.sourceSystem)} · ${escapeHtml(event.robotId.slice(0, 8))}…</small></div><span class="event-time">${escapeHtml(event.severity)}<br />${formatDate(event.ingestedAt)}</span></div>`).join('') : '<div class="empty">No events yet.</div>';
}

async function loadAdapters() {
  const payload = await api('/api/v1/adapters');
  $('#adaptersList').innerHTML = payload.data.map((adapter) => `<div class="adapter-item"><div><strong>${escapeHtml(adapter.provider)}</strong><small>${escapeHtml(adapter.status)} · v${escapeHtml(adapter.version)}<br />Last sync: ${formatDate(adapter.lastSyncAt)} · ${escapeHtml(adapter.lastSyncStatus || '—')}</small>${adapter.lastError ? `<small class="adapter-error">${escapeHtml(adapter.lastError)}</small>` : ''}</div><div class="adapter-capabilities">Read: ${escapeHtml(adapter.capabilities.read.join(', '))}<br />Events: ${escapeHtml(adapter.capabilities.event.join(', ') || 'none')}<br /><b>Commands: disabled</b></div></div>`).join('');
}

async function syncAdapter(provider) { toast(`Syncing ${provider}…`); try { await api(`/api/v1/adapters/${provider}/sync`, { method:'POST', body:'{}' }); toast(`${provider} adapter synchronized`); await refreshAll(); } catch (error) { toast(`Sync failed: ${error.message}`, true); await loadAdapters(); } }
async function refreshAll() { try { await Promise.all([loadRobots(), loadEvents(), loadAdapters()]); } catch (error) { toast(error.message, true); } }

function bindUi() {
  let searchTimer; $('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadRobots, 180); }); $('#statusFilter').addEventListener('change', loadRobots); $('#refreshButton').addEventListener('click', refreshAll); $('#refreshEvents').addEventListener('click', loadEvents); $('#refreshAdapters').addEventListener('click', loadAdapters);
  $('#syncAutoXing').addEventListener('click', () => syncAdapter('autoxing')); $('#syncCenoBots').addEventListener('click', () => syncAdapter('cenobots'));
  $('#logoutButton').addEventListener('click', logout);
  $('#loginForm').addEventListener('submit', async (event) => { event.preventDefault(); const error = $('#loginError'); error.textContent = ''; try { await login($('#loginEmail').value.trim(), $('#loginPassword').value); } catch (loginError) { error.textContent = loginError.message; } });
  document.querySelectorAll('[data-demo-email]').forEach((button) => button.addEventListener('click', () => { $('#loginEmail').value = button.dataset.demoEmail; $('#loginPassword').value = button.dataset.demoPassword || 'demo'; $('#loginPassword').focus(); }));
  const dialog = $('#robotDialog'); const existingRobotSelect = $('#existingRobotId'); const serialInput = $('#serialNumber'); const modelSelect = $('#modelId'); const robotUsername = $('#robotUsername'); const robotPassword = $('#robotPassword'); const registerButton = $('#registerButton'); const serialHint = $('#serialNumberHint');
  const setNewRobotFields = (isNew) => { serialInput.readOnly = !isNew; robotUsername.disabled = !isNew; robotPassword.disabled = !isNew; robotUsername.required = isNew; robotPassword.required = isNew; if (isNew) { serialHint.textContent = 'Enter a new unique serial number.'; registerButton.textContent = 'Register robot'; } else { serialHint.textContent = 'Existing synchronized robot selected.'; registerButton.textContent = 'Open robot'; } };
  $('#newRobotButton').addEventListener('click', () => { existingRobotSelect.value = ''; serialInput.value = ''; robotUsername.value = ''; robotPassword.value = ''; setNewRobotFields(true); dialog.showModal(); });
  existingRobotSelect.addEventListener('change', () => { const robot = state.robots.find((item) => item.id === existingRobotSelect.value); if (!robot) { serialInput.value = ''; setNewRobotFields(true); return; } modelSelect.value = robot.modelId; serialInput.value = robot.serialNumber; robotUsername.value = ''; robotPassword.value = ''; setNewRobotFields(false); });
  $('#robotForm').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); try { const existingRobot = state.robots.find((item) => item.id === existingRobotSelect.value); if (existingRobot) { dialog.close(); await loadPassport(existingRobot.id); toast(`Opened ${existingRobot.serialNumber}`); return; } await api('/api/v1/robots', { method:'POST', body:JSON.stringify({ modelId:modelSelect.value, siteId:'site-berlin', organizationId:'org-demo', operatorOrganizationId:'org-service', serialNumber:serialInput.value.trim(), username:robotUsername.value.trim(), password:robotPassword.value }) }); dialog.close(); serialInput.value = ''; robotUsername.value = ''; robotPassword.value = ''; toast('Robot and robot account registered as draft'); await refreshAll(); } catch (error) { toast(error.message, true); } });
  $('#eventForm').addEventListener('submit', async (event) => { if (event.submitter?.value === 'cancel') return; event.preventDefault(); try { const attachment = await readAttachment($('#eventAttachment').files[0]); await api(`/api/v1/robots/${$('#eventDialog').dataset.robotId}/events`, { method:'POST', body:JSON.stringify({ title:$('#eventTitle').value.trim(), description:$('#eventDescription').value.trim(), eventType:$('#eventType').value, severity:$('#eventSeverity').value, occurredAt:new Date($('#eventOccurredAt').value).toISOString(), sourceSystem:$('#eventSource').value.trim(), sourceEventId:$('#eventSourceId').value.trim() || undefined, attachment }) }); $('#eventDialog').close(); $('#eventTitle').value = ''; $('#eventDescription').value = ''; $('#eventSourceId').value = ''; toast('Event added to Robot Passport'); await Promise.all([loadPassport(state.selectedRobotId), loadEvents()]); } catch (error) { toast(error.message, true); } });
}

(async function init() { try { bindUi(); const saved = sessionStorage.getItem('altegroSession'); if (!saved) return showLogin(); const session = JSON.parse(saved); state.token = session.token; state.user = session.user; showApp(); await refreshAll(); } catch (error) { sessionStorage.removeItem('altegroSession'); showLogin(); } })();
