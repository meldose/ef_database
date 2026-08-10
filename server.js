'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const { once } = require('node:events');
const pathUtil = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

function loadLocalEnv(filePath = process.env.ALTEGRO_ENV_FILE || pathUtil.join(__dirname, '.env')) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const separator = line.indexOf('='); const key = line.slice(0, separator).trim(); let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const startedAt = new Date().toISOString();
const runtimeMetrics = { requestsTotal:0, activeRequests:0, errorsTotal:0, responseTimeMsTotal:0, responseTimeMsMax:0, byStatus:{} };
const MAX_EVENT_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_ACCOUNT_PASSWORD = process.env.DEFAULT_ACCOUNT_PASSWORD || 'efrobotics';
const MAX_JSON_BODY_BYTES = 5 * 1024 * 1024;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const PASSWORD_KEY_LENGTH = 64;
const DATA_FILE = pathUtil.resolve(process.env.ALTEGRO_DATA_FILE || pathUtil.join(__dirname, 'data', 'altegro-state.json'));
const persistenceEnabled = () => !['0', 'false', 'no'].includes(String(process.env.ALTEGRO_PERSISTENCE ?? 'true').toLowerCase());
const loginFailures = new Map();
const allowedAttachmentTypes = new Set(['application/pdf', 'application/json', 'text/plain', 'text/csv', 'image/png', 'image/jpeg', 'image/webp', 'application/octet-stream']);
const allowedAttachmentExtensions = new Set(['.pdf', '.json', '.txt', '.csv', '.png', '.jpg', '.jpeg', '.webp']);

const ids = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const publicDir = pathUtil.join(__dirname, 'public');
const execFileAsync = promisify(execFile);
const AUTOXING_BRIDGE = pathUtil.join(__dirname, 'integrations', 'autoxing_bridge.py');
const CENOBOTS_CLIENT = pathUtil.join(__dirname, 'integrations', 'cenobots', 'client.py');
const AUTOXING_REPO = process.env.AUTOXING_REPO_PATH || pathUtil.resolve(__dirname, '..', 'autoxing');
const AUTOXING_LIB = process.env.AUTOXING_LIB_PATH || pathUtil.join(AUTOXING_REPO, 'lib');
const autoXingLiveEnabled = () => ['1', 'true', 'yes'].includes(String(process.env.AUTOXING_LIVE || '').toLowerCase());
const autoXingPollIntervalMs = () => Math.max(0, Number(process.env.AUTOXING_POLL_INTERVAL_MS || 300000));
const parseJsonEnv = (name, fallback = {}) => { try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; } catch { return fallback; } };
const autoXingMappingRequired = () => ['1', 'true', 'yes'].includes(String(process.env.AUTOXING_REQUIRE_MAPPING || '').toLowerCase());
const cenoBotsLiveEnabled = () => ['1', 'true', 'yes'].includes(String(process.env.CENOBOTS_LIVE || '').toLowerCase());
function secretEnvValue(name) {
  if (process.env[name]) return process.env[name];
  const filePath = process.env[`${name}_FILE`];
  if (!filePath) return '';
  try { return fs.readFileSync(pathUtil.resolve(filePath), 'utf8').trim(); }
  catch (error) { throw new Error(`Could not read managed secret ${name}: ${error.message}`); }
}
function secretConfigurationMode() {
  if (['APPID', 'APPSECRET', 'APPCODE'].some((name) => process.env[`${name}_FILE`])) return 'managed-secret-files';
  if (process.env.AUTOXING_ENV_FILE) return 'protected-env-file';
  if (['APPID', 'APPSECRET', 'APPCODE'].every((name) => process.env[name])) return 'environment-variables';
  return autoXingLiveEnabled() ? 'wrapper-managed' : 'not-required-in-mock-mode';
}
const enabled = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
function managedSecretStatus() {
  const providers = [
    { name:'autoxing', enabled:autoXingLiveEnabled(), names:['APPID','APPSECRET','APPCODE'] },
    { name:'cenobots', enabled:cenoBotsLiveEnabled(), names:['CENOBOTS_ACCESS_KEY','CENOBOTS_SECRET_KEY'] },
    { name:'email', enabled:enabled(process.env.EMAIL_ALERTS_ENABLED) && Boolean(process.env.EMAIL_SMTP_USERNAME), names:['EMAIL_SMTP_PASSWORD'] }
  ];
  const requireManaged = enabled(process.env.ALTEGRO_REQUIRE_MANAGED_SECRETS) || process.env.NODE_ENV === 'production';
  const details = providers.map((provider) => {
    const direct = provider.names.filter((name) => Boolean(process.env[name]));
    const files = provider.names.filter((name) => Boolean(process.env[`${name}_FILE`]));
    const missing = provider.enabled ? provider.names.filter((name) => !process.env[name] && !process.env[`${name}_FILE`]) : [];
    return { provider:provider.name, liveEnabled:provider.enabled, configured:!provider.enabled || missing.length === 0, managed:!provider.enabled || (files.length === provider.names.length && direct.length === 0), missingCount:missing.length, directValueCount:direct.length, secretFileCount:files.length };
  });
  const valid = details.every((item) => item.configured && (!requireManaged || item.managed));
  return { valid, requireManaged, providers:details };
}
function assertProductionSecretConfiguration() {
  const report = managedSecretStatus();
  if (!report.valid) throw new Error('Production secret policy failed. Live providers must use complete managed secret-file configuration.');
  const email=emailAlertConfiguration();
  if (email.enabled && !email.configured) throw new Error(`Email alert configuration failed: ${email.configurationError}`);
}

function emailAddress(value) {
  const address=String(value || '').trim();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) ? address : null;
}

function emailAlertConfiguration() {
  const isEnabled=enabled(process.env.EMAIL_ALERTS_ENABLED); const transport=String(process.env.EMAIL_ALERT_TRANSPORT || 'smtp').toLowerCase();
  const recipients=String(process.env.EMAIL_ALERT_RECIPIENTS || '').split(',').map(emailAddress).filter(Boolean); const from=emailAddress(process.env.EMAIL_ALERT_FROM);
  const host=String(process.env.EMAIL_SMTP_HOST || '').trim(); const port=Math.max(1,Math.min(65535,Number(process.env.EMAIL_SMTP_PORT || 465))); const secure=!['0','false','no'].includes(String(process.env.EMAIL_SMTP_SECURE ?? 'true').toLowerCase());
  const username=String(process.env.EMAIL_SMTP_USERNAME || '').trim(); const passwordConfigured=Boolean(process.env.EMAIL_SMTP_PASSWORD || process.env.EMAIL_SMTP_PASSWORD_FILE); const minimumSeverity=['info','warning','error','critical'].includes(process.env.EMAIL_ALERT_MIN_SEVERITY) ? process.env.EMAIL_ALERT_MIN_SEVERITY : 'error';
  let configurationError=null;
  if (isEnabled && !['smtp','capture'].includes(transport)) configurationError='EMAIL_ALERT_TRANSPORT must be smtp or capture';
  else if (isEnabled && transport === 'capture' && process.env.NODE_ENV === 'production') configurationError='capture transport is not allowed in production';
  else if (isEnabled && !from) configurationError='EMAIL_ALERT_FROM must be a valid email address';
  else if (isEnabled && !recipients.length) configurationError='EMAIL_ALERT_RECIPIENTS must contain at least one valid address';
  else if (isEnabled && transport === 'smtp' && !host) configurationError='EMAIL_SMTP_HOST is required';
  else if (isEnabled && username && !passwordConfigured) configurationError='EMAIL_SMTP_PASSWORD or EMAIL_SMTP_PASSWORD_FILE is required with EMAIL_SMTP_USERNAME';
  else if (isEnabled && transport === 'smtp' && username && !secure && !enabled(process.env.EMAIL_SMTP_ALLOW_INSECURE_AUTH)) configurationError='SMTP authentication requires TLS unless EMAIL_SMTP_ALLOW_INSECURE_AUTH is explicitly enabled';
  return { enabled:isEnabled,configured:!isEnabled || !configurationError,configurationError,transport,hostConfigured:Boolean(host),port,secure,authenticationConfigured:Boolean(username && passwordConfigured),fromConfigured:Boolean(from),recipientCount:recipients.length,minimumSeverity,cooldownMinutes:Math.max(1,Number(process.env.EMAIL_ALERT_COOLDOWN_MINUTES || 60)),recipients,from,username };
}

function smtpMessage(delivery,config) {
  const subject=`[Altegro ${delivery.severity.toUpperCase()}] ${delivery.title}`.replace(/[\r\n]+/g,' ').slice(0,180); const encodedSubject=`=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const text=[delivery.title,'',delivery.message,delivery.robotSerialNumber ? `Robot: ${delivery.robotSerialNumber}` : null,`Severity: ${delivery.severity}`,`Occurred: ${delivery.occurredAt}`,process.env.ALTEGRO_PUBLIC_URL ? `Open Altegro: ${String(process.env.ALTEGRO_PUBLIC_URL).replace(/\/$/,'')}` : null,'',`Notification ID: ${delivery.notificationKey}`].filter((line) => line !== null).join('\r\n');
  return `Date: ${new Date().toUTCString()}\r\nMessage-ID: <${delivery.id}@altegro.local>\r\nFrom: ${config.from}\r\nTo: ${delivery.recipients.join(', ')}\r\nSubject: ${encodedSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}`;
}

async function sendSmtpEmail(delivery,config) {
  const socket=config.secure ? tls.connect({ host:config.host,port:config.port,servername:config.host,rejectUnauthorized:!['0','false','no'].includes(String(process.env.EMAIL_SMTP_TLS_REJECT_UNAUTHORIZED ?? 'true').toLowerCase()) }) : net.createConnection({ host:config.host,port:config.port });
  socket.setEncoding('utf8'); socket.setTimeout(Math.max(5000,Number(process.env.EMAIL_SMTP_TIMEOUT_MS || 15000)),() => socket.destroy(new Error('SMTP connection timed out')));
  let buffer=''; let responseLines=[]; const completed=[]; let waiter=null; let socketError=null;
  const settle=(response) => { if (waiter) { const current=waiter; waiter=null; current.resolve(response); } else completed.push(response); };
  socket.on('data',(chunk) => { buffer += chunk; let index; while ((index=buffer.indexOf('\n')) >= 0) { const line=buffer.slice(0,index+1).trimEnd(); buffer=buffer.slice(index+1); responseLines.push(line); if (/^\d{3} /.test(line)) { settle({ code:Number(line.slice(0,3)),text:responseLines.join('\n') }); responseLines=[]; } } });
  socket.on('error',(error) => { socketError=error; if (waiter) { const current=waiter; waiter=null; current.reject(error); } });
  await once(socket,config.secure ? 'secureConnect' : 'connect');
  const response=() => { if (completed.length) return Promise.resolve(completed.shift()); if (socketError) return Promise.reject(socketError); return new Promise((resolve,reject) => { waiter={ resolve,reject }; }); };
  const expect=async (codes,command=null) => { if (command !== null) socket.write(`${command}\r\n`); const reply=await response(); if (!codes.includes(reply.code)) throw new Error(`SMTP rejected the request with status ${reply.code}`); return reply; };
  try {
    await expect([220]); await expect([250],`EHLO ${String(process.env.EMAIL_SMTP_CLIENT_NAME || 'altegro.local').replace(/[^A-Za-z0-9.-]/g,'')}`);
    if (config.username) { const password=secretEnvValue('EMAIL_SMTP_PASSWORD'); const auth=Buffer.from(`\0${config.username}\0${password}`).toString('base64'); await expect([235],`AUTH PLAIN ${auth}`); }
    await expect([250],`MAIL FROM:<${config.from}>`); for (const recipient of delivery.recipients) await expect([250,251],`RCPT TO:<${recipient}>`); await expect([354],'DATA');
    const message=smtpMessage(delivery,config).replace(/(^|\r\n)\./g,'$1..'); socket.write(`${message}\r\n.\r\n`); await expect([250]); socket.write('QUIT\r\n');
  } finally { socket.end(); }
}

function createEmailDelivery(notification) {
  const config=emailAlertConfiguration();
  const delivery={ id:ids(),notificationKey:String(notification.notificationKey),type:notification.type || 'operational_alert',severity:notification.severity || 'error',title:String(notification.title || 'Altegro alert').slice(0,180),message:String(notification.message || '').slice(0,4000),robotId:notification.robotId || null,robotSerialNumber:notification.robotSerialNumber || null,recipients:[...config.recipients],status:'pending',attempts:0,lastError:null,createdAt:timestamp(),occurredAt:notification.occurredAt || timestamp(),sentAt:null,nextAttemptAt:null };
  state.emailDeliveries.push(delivery); state.emailDeliveries=state.emailDeliveries.slice(-200); schedulePersist(); return delivery;
}

function queueEmailAlert(notification,{ force=false }={}) {
  const config=emailAlertConfiguration(); if (!config.enabled || !config.configured) return null;
  const severityRank={ info:0,warning:1,error:2,critical:3 }; if (!force && (severityRank[notification.severity] ?? 0) < severityRank[config.minimumSeverity]) return null;
  const cutoff=Date.now()-config.cooldownMinutes*60000; const duplicate=state.emailDeliveries.find((item) => item.notificationKey === notification.notificationKey && Date.parse(item.createdAt) >= cutoff && ['pending','sending','sent'].includes(item.status)); if (duplicate) return duplicate;
  const delivery=createEmailDelivery(notification); setImmediate(() => processEmailQueue()); return delivery;
}

let emailQueueRunning=false;
async function deliverEmailNotification(delivery) {
  const config=emailAlertConfiguration(); if (!config.enabled || !config.configured) throw new Error(config.configurationError || 'Email alerts are disabled');
  delivery.status='sending'; delivery.attempts += 1; delivery.lastError=null;
  try { if (config.transport === 'smtp') await sendSmtpEmail(delivery,config); delivery.status='sent'; delivery.sentAt=timestamp(); delivery.nextAttemptAt=null; }
  catch(error) { delivery.status='failed'; delivery.lastError=String(error.message || error).slice(0,500); delivery.nextAttemptAt=new Date(Date.now()+Math.min(15,delivery.attempts*5)*60000).toISOString(); throw error; }
  finally { schedulePersist(); }
  return delivery;
}

async function processEmailQueue() {
  if (emailQueueRunning || !emailAlertConfiguration().enabled) return; emailQueueRunning=true;
  try { for (const delivery of state.emailDeliveries.filter((item) => ['pending','failed'].includes(item.status) && item.attempts < 3 && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now())).slice(0,20)) { try { await deliverEmailNotification(delivery); } catch {} } }
  finally { emailQueueRunning=false; }
}

function emailDeliverySummary() {
  const config=emailAlertConfiguration(); const deliveries=state.emailDeliveries.slice().reverse().slice(0,30).map((item) => ({ id:item.id,type:item.type,severity:item.severity,title:item.title,robotId:item.robotId,robotSerialNumber:item.robotSerialNumber,recipientCount:item.recipients.length,status:item.status,attempts:item.attempts,lastError:item.lastError,createdAt:item.createdAt,sentAt:item.sentAt }));
  return { configuration:{ enabled:config.enabled,configured:config.configured,configurationError:config.configurationError,transport:config.transport,hostConfigured:config.hostConfigured,port:config.port,secure:config.secure,authenticationConfigured:config.authenticationConfigured,fromConfigured:config.fromConfigured,recipientCount:config.recipientCount,minimumSeverity:config.minimumSeverity,cooldownMinutes:config.cooldownMinutes },counts:{ total:state.emailDeliveries.length,pending:state.emailDeliveries.filter((item) => item.status === 'pending').length,sent:state.emailDeliveries.filter((item) => item.status === 'sent').length,failed:state.emailDeliveries.filter((item) => item.status === 'failed').length },deliveries };
}
const authenticatedSessions = new Map();
let persistenceTimer = null;

const state = {
  tenants: new Map(),
  organizations: new Map(),
  sites: new Map(),
  models: new Map(),
  robots: new Map(),
  passportEntries: new Map(),
  serviceCases: new Map(),
  technicians: new Map(),
  modelRequirements: new Map(),
  robotAssignments: new Map(),
  alertWorkflows: new Map(),
  maintenanceSchedules: new Map(),
  alertEscalationRules: new Map(),
  alertEscalations: new Map(),
  emailDeliveries: [],
  documents: [],
  certificates: [],
  deployments: [],
  compatibilityRecords: [],
  events: [],
  audit: [],
  outbox: [],
  adapters: new Map(),
  autoxing: {
    businesses: [],
    buildings: [],
    pois: new Map(),
    areas: new Map(),
    maps: new Map(),
    tasks: new Map(),
    lastSyncAt: null,
    resourceErrors: []
  }
};

const demoUsers = {
  'demo-owner': { id: 'user-owner', name: 'Demo Owner', email: 'owner@demo.altegro.local', role: 'owner', tenantId: 'tenant-demo', organizationId: 'org-demo' },
  'demo-technician': { id: 'user-technician', name: 'Demo Technician', email: 'technician@demo.altegro.local', role: 'technician', tenantId: 'tenant-demo', organizationId: 'org-service' },
  'demo-platform-admin': { id: 'user-platform-admin', name: 'Demo Platform Admin', email: 'admin@demo.altegro.local', role: 'platform_admin', tenantId: 'tenant-demo', organizationId: 'org-ef' },
  'demo-data-admin': { id: 'user-data-admin', name: 'Demo Data Admin', email: 'data@demo.altegro.local', role: 'data_admin', tenantId: 'tenant-demo', organizationId: 'org-ef' },
  'demo-support-admin': { id: 'user-support-admin', name: 'Demo Support Admin', email: 'support@demo.altegro.local', role: 'support_admin', tenantId: 'tenant-demo', organizationId: 'org-ef' },
  'demo-auditor': { id: 'user-auditor', name: 'Demo Auditor', email: 'auditor@demo.altegro.local', role: 'auditor', tenantId: 'tenant-demo', organizationId: 'org-demo' },
  // Robot accounts are read-only apart from robot registration in this prototype. In production,
  // replace these demo passwords with OIDC/SSO identities and database memberships.
  'demo-robot-ax-001': { id: 'user-robot-ax-001', name: 'AX-DEMO-001 User', email: 'robot-ax-001@demo.altegro.local', demoPassword: 'AX-robot-001-demo', role: 'robot_user', tenantId: 'tenant-demo', organizationId: 'org-demo', robotSystem: 'autoxing', robotExternalId: 'AX-1001', robotSerialNumber: 'AX-DEMO-001' },
  'demo-robot-cb-001': { id: 'user-robot-cb-001', name: 'CB-DEMO-001 User', email: 'robot-cb-001@demo.altegro.local', demoPassword: 'CB-robot-001-demo', role: 'robot_user', tenantId: 'tenant-demo', organizationId: 'org-demo', robotSystem: 'cenobots', robotExternalId: 'CB-1001', robotSerialNumber: 'CB-DEMO-001' },
  'demo-robot-se52512706922ne': { id: 'user-robot-se52512706922ne', name: 'SE52512706922NE User', email: 'robot-se52512706922ne@demo.altegro.local', demoPassword: 'SE-robot-001-demo', role: 'robot_user', tenantId: 'tenant-demo', organizationId: 'org-demo', robotSystem: 'autoxing', robotSerialNumber: 'SE52512706922NE' }
};

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const digest = crypto.scryptSync(String(password), salt, PASSWORD_KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

function verifyPassword(password, storedHash) {
  const [scheme, salt, expectedHex] = String(storedHash || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function initializeCredentialHashes() {
  for (const user of Object.values(demoUsers)) {
    const plainPassword = user.demoPassword || DEFAULT_ACCOUNT_PASSWORD;
    if (!user.passwordHash) user.passwordHash = hashPassword(plainPassword);
    delete user.demoPassword;
  }
}

function mapEntries(map) {
  return [...map.entries()];
}

function persistedSnapshot() {
  return {
    schemaVersion: 1,
    savedAt: timestamp(),
    users: clone(demoUsers),
    sessions: mapEntries(authenticatedSessions).filter(([, session]) => session.expiresAt > Date.now()),
    state: {
      tenants: mapEntries(state.tenants), organizations: mapEntries(state.organizations), sites: mapEntries(state.sites), models: mapEntries(state.models), robots: mapEntries(state.robots),
      passportEntries: mapEntries(state.passportEntries), serviceCases: mapEntries(state.serviceCases), technicians: mapEntries(state.technicians), modelRequirements: mapEntries(state.modelRequirements), robotAssignments: mapEntries(state.robotAssignments), alertWorkflows:mapEntries(state.alertWorkflows), maintenanceSchedules:mapEntries(state.maintenanceSchedules), alertEscalationRules:mapEntries(state.alertEscalationRules), alertEscalations:mapEntries(state.alertEscalations), documents: state.documents, certificates: state.certificates,
      deployments: state.deployments, compatibilityRecords: state.compatibilityRecords, events: state.events, audit: state.audit, outbox: state.outbox, emailDeliveries:state.emailDeliveries,
      autoxing: { ...state.autoxing, pois: mapEntries(state.autoxing.pois), areas: mapEntries(state.autoxing.areas), maps: mapEntries(state.autoxing.maps), tasks: mapEntries(state.autoxing.tasks) },
      adapterRuntime: mapEntries(state.adapters).map(([provider, adapter]) => [provider, { lastSyncAt: adapter.lastSyncAt || null, lastSyncStatus: adapter.lastSyncStatus || 'never', lastError: adapter.lastError || null, lastSyncDurationMs:adapter.lastSyncDurationMs || null, lastSyncCount:adapter.lastSyncCount ?? null, lastSyncWarnings:adapter.lastSyncWarnings || 0, syncHistory:clone(adapter.syncHistory || []) }])
    }
  };
}

function persistState() {
  if (!persistenceEnabled()) return false;
  fs.mkdirSync(pathUtil.dirname(DATA_FILE), { recursive: true });
  const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, `${JSON.stringify(persistedSnapshot(), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryFile, DATA_FILE);
  return true;
}

function schedulePersist() {
  if (!persistenceEnabled() || persistenceTimer) return;
  persistenceTimer = setTimeout(() => {
    persistenceTimer = null;
    try { persistState(); } catch (error) { console.error(`Could not persist Altegro state: ${error.message}`); }
  }, 50);
  persistenceTimer.unref?.();
}

function replaceMap(target, entries) {
  if (!Array.isArray(entries)) return;
  target.clear();
  for (const [key, value] of entries) target.set(key, value);
}

function loadPersistedState() {
  if (!persistenceEnabled() || !fs.existsSync(DATA_FILE)) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (saved.schemaVersion !== 1 || !saved.state) throw new Error('unsupported data schema');
    for (const [token, user] of Object.entries(saved.users || {})) demoUsers[token] = user;
    initializeCredentialHashes();
    replaceMap(authenticatedSessions, (saved.sessions || []).filter(([, session]) => session.expiresAt > Date.now()));
    for (const name of ['tenants', 'organizations', 'sites', 'models', 'robots', 'passportEntries', 'serviceCases', 'technicians', 'modelRequirements', 'robotAssignments', 'alertWorkflows', 'maintenanceSchedules', 'alertEscalationRules', 'alertEscalations']) replaceMap(state[name], saved.state[name]);
    for (const name of ['documents', 'certificates', 'deployments', 'compatibilityRecords', 'events', 'audit', 'outbox', 'emailDeliveries']) if (Array.isArray(saved.state[name])) state[name] = saved.state[name];
    const autoXing = saved.state.autoxing || {};
    state.autoxing.businesses = autoXing.businesses || []; state.autoxing.buildings = autoXing.buildings || []; state.autoxing.lastSyncAt = autoXing.lastSyncAt || null; state.autoxing.resourceErrors = autoXing.resourceErrors || [];
    for (const name of ['pois', 'areas', 'maps', 'tasks']) replaceMap(state.autoxing[name], autoXing[name]);
    for (const [provider, runtime] of saved.state.adapterRuntime || []) { const adapter = state.adapters.get(provider); if (!adapter) continue; Object.assign(adapter,runtime); if (!Array.isArray(runtime.syncHistory)) adapter.syncHistory = []; }
    return true;
  } catch (error) {
    console.error(`Could not load ${DATA_FILE}; starting from the seeded state: ${error.message}`);
    return false;
  }
}

function applyRequestedTechnicianRoster() {
  const roster = [
    ['technician-lena','Midhun Eldose','midhun.eldose@robotcare.demo'],
    ['technician-omar','Ahmed Galai','ahmed.galai@robotcare.demo'],
    ['technician-nora','Michell Blawat','michell.blawat@robotcare.demo'],
    ['technician-elvis','Elvis Heil','elvis.heil@robotcare.demo']
  ];
  for (const [id,name,email] of roster) {
    const existing = state.technicians.get(id);
    if (existing) { Object.assign(existing,{ name,email,jobTitle:'Service Technician',updatedAt:timestamp() }); continue; }
    state.technicians.set(id,{ id,tenantId:'tenant-demo',organizationId:'org-service',name,email,jobTitle:'Service Technician',status:'active',skills:id === 'technician-omar' ? [{ code:'fleet_diagnostics',level:'advanced',verifiedAt:timestamp() }] : [{ code:'autoxing_service',level:'qualified',verifiedAt:timestamp() },{ code:'cleaning_robot_service',level:'qualified',verifiedAt:timestamp() }],certificates:id === 'technician-omar' ? [] : [{ id:`cert-${id}-safety`,type:'robot_electrical_safety',issuer:'Demo Technical Academy',validUntil:new Date(Date.now()+365*86400000).toISOString(),modelIds:['model-autoxing-a1','model-cenobots-c1'] }],createdAt:timestamp(),updatedAt:timestamp() });
  }
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId, scope: actorRobotSerials(user).length ? { type: 'robot', system: user.robotSystem, externalId: user.robotExternalId || null, serialNumber: actorRobotSerials(user)[0], serialNumbers: actorRobotSerials(user) } : { type: 'tenant' } };
}

function authenticatedSession(token, user) {
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  authenticatedSessions.set(crypto.createHash('sha256').update(sessionToken).digest('hex'), { userToken: token, expiresAt: Date.now() + Math.max(60000, Number(process.env.AUTH_SESSION_TTL_SECONDS || 28800) * 1000) });
  schedulePersist();
  return { token: sessionToken, user: publicUser(user) };
}

function seed() {
  state.tenants.set('tenant-demo', { id: 'tenant-demo', name: 'Demo Customer Tenant', status: 'active' });
  state.organizations.set('org-demo', { id: 'org-demo', tenantId: 'tenant-demo', type: 'customer', name: 'Demo Customer GmbH', externalIdentities: [{ system: 'crm-demo', externalId: 'CRM-1001' }] });
  state.organizations.set('org-service', { id: 'org-service', tenantId: 'tenant-demo', type: 'servicepartner', name: 'Demo Robot Care' });
  state.organizations.set('org-ef', { id: 'org-ef', tenantId: 'tenant-demo', type: 'ef_unit', name: 'EF Systemhaus' });
  state.sites.set('site-berlin', { id: 'site-berlin', tenantId: 'tenant-demo', organizationId: 'org-demo', name: 'Berlin Operations Site', country: 'DE', timezone: 'Europe/Berlin', status: 'active' });
  state.models.set('model-autoxing-a1', { id: 'model-autoxing-a1', manufacturer: 'AutoXing', model: 'A1', category: 'cleaning', capabilities: ['read.status', 'read.battery', 'event.alert'] });
  state.models.set('model-cenobots-c1', { id: 'model-cenobots-c1', manufacturer: 'CenoBots', model: 'C1', category: 'cleaning', capabilities: ['read.status', 'read.battery', 'read.service_history'] });
  state.models.set('model-mock-m3', { id: 'model-mock-m3', manufacturer: 'Mock OEM', model: 'M3', category: 'transport', capabilities: ['read.status', 'event.status'] });
  state.modelRequirements.set('model-autoxing-a1', { modelId: 'model-autoxing-a1', requiredSkills: ['autoxing_service'], requiredCertificates: ['robot_electrical_safety'], updatedAt: timestamp() });
  state.modelRequirements.set('model-cenobots-c1', { modelId: 'model-cenobots-c1', requiredSkills: ['cleaning_robot_service'], requiredCertificates: ['robot_electrical_safety'], updatedAt: timestamp() });
  state.modelRequirements.set('model-mock-m3', { modelId: 'model-mock-m3', requiredSkills: ['fleet_diagnostics'], requiredCertificates: [], updatedAt: timestamp() });
  const certificateFuture = new Date(Date.now() + 365 * 86400000).toISOString();
  const certificateSoon = new Date(Date.now() + 35 * 86400000).toISOString();
  const certificatePast = new Date(Date.now() - 30 * 86400000).toISOString();
  state.technicians.set('technician-lena', { id:'technician-lena', tenantId:'tenant-demo', organizationId:'org-service', name:'Midhun Eldose', email:'midhun.eldose@robotcare.demo', jobTitle:'Service Technician', status:'active', skills:[{ code:'autoxing_service', level:'advanced', verifiedAt:timestamp() },{ code:'cleaning_robot_service', level:'advanced', verifiedAt:timestamp() }], certificates:[{ id:'cert-lena-safety', type:'robot_electrical_safety', issuer:'Demo Technical Academy', validUntil:certificateFuture, modelIds:['model-autoxing-a1','model-cenobots-c1'] }], createdAt:timestamp(), updatedAt:timestamp() });
  state.technicians.set('technician-omar', { id:'technician-omar', tenantId:'tenant-demo', organizationId:'org-service', name:'Ahmed Galai', email:'ahmed.galai@robotcare.demo', jobTitle:'Service Technician', status:'active', skills:[{ code:'fleet_diagnostics', level:'advanced', verifiedAt:timestamp() }], certificates:[], createdAt:timestamp(), updatedAt:timestamp() });
  state.technicians.set('technician-nora', { id:'technician-nora', tenantId:'tenant-demo', organizationId:'org-service', name:'Michell Blawat', email:'michell.blawat@robotcare.demo', jobTitle:'Service Technician', status:'active', skills:[{ code:'cleaning_robot_service', level:'intermediate', verifiedAt:timestamp() }], certificates:[{ id:'cert-nora-safety', type:'robot_electrical_safety', issuer:'Demo Technical Academy', validUntil:certificatePast, modelIds:['model-cenobots-c1'] },{ id:'cert-nora-autoxing', type:'autoxing_service_authorization', issuer:'Demo OEM Academy', validUntil:certificateSoon, modelIds:['model-autoxing-a1'] }], createdAt:timestamp(), updatedAt:timestamp() });
  state.technicians.set('technician-elvis', { id:'technician-elvis', tenantId:'tenant-demo', organizationId:'org-service', name:'Elvis Heil', email:'elvis.heil@robotcare.demo', jobTitle:'Service Technician', status:'active', skills:[{ code:'autoxing_service', level:'advanced', verifiedAt:timestamp() },{ code:'cleaning_robot_service', level:'qualified', verifiedAt:timestamp() }], certificates:[{ id:'cert-elvis-safety', type:'robot_electrical_safety', issuer:'Demo Technical Academy', validUntil:certificateFuture, modelIds:['model-autoxing-a1','model-cenobots-c1'] }], createdAt:timestamp(), updatedAt:timestamp() });
  state.compatibilityRecords.push(
    { id: ids(), tenantId: 'tenant-demo', modelId: 'model-autoxing-a1', capability: 'read.status', versionConstraint: 'wrapper-backed', status: 'compatible', evidence: 'AutoXing reference-adapter contract', verifiedAt: timestamp(), verifiedBy: 'Altegro Engineering' },
    { id: ids(), tenantId: 'tenant-demo', modelId: 'model-autoxing-a1', capability: 'remote.command', versionConstraint: 'all', status: 'blocked', evidence: 'Phase 1 command safety gate', verifiedAt: timestamp(), verifiedBy: 'Altegro Security' },
    { id: ids(), tenantId: 'tenant-demo', modelId: 'model-mock-m3', capability: 'read.status', versionConstraint: '1.x', status: 'testing_required', evidence: 'Synthetic adapter only', verifiedAt: null, verifiedBy: null }
  );

  state.adapters.set('autoxing', {
    provider: 'autoxing', version: 'wrapper-backed', status: autoXingLiveEnabled() ? 'live-wrapper-enabled' : 'mock-fallback', integration: 'autoxing/lib/api_lib.py', lastSyncAt: null, lastSyncStatus: 'never', lastError: null, lastSyncDurationMs:null, lastSyncCount:null, lastSyncWarnings:0, syncHistory:[], pollingIntervalMs: autoXingPollIntervalMs(),
    capabilities: { read: ['identity', 'status', 'battery', 'position', 'emergency_stop', 'obstruction', 'detailed_errors', 'pois', 'areas', 'maps', 'task_history', 'task_status'], event: ['alert', 'status', 'task_status'], command: [] },
    sync: () => ({ externalId: 'AX-1001', modelId: 'model-autoxing-a1', serialNumber: 'AX-DEMO-001', status: 'active', battery: 87, eventType: 'online' })
  });
  state.adapters.set('cenobots', {
    provider: 'cenobots', version: cenoBotsLiveEnabled() ? 'open-api-v1.0.16' : 'mock-1.0.0', status: cenoBotsLiveEnabled() ? 'live-api-enabled' : 'mock-only', integration: 'integrations/cenobots/client.py',
    capabilities: { read: ['identity', 'status', 'battery', 'position', 'service_history', 'system_errors'], event: ['online', 'offline', 'maintenance', 'error'], command: [] },
    sync: () => ({ externalId: 'CB-1001', modelId: 'model-cenobots-c1', serialNumber: 'CB-DEMO-001', status: 'active', battery: 64, eventType: 'maintenance' })
  });
  state.adapters.set('mock-oem', {
    provider: 'mock-oem', version: '1.0.0', status: 'certified-test-adapter',
    capabilities: { read: ['identity', 'status'], event: ['status'], command: [] },
    sync: () => ({ externalId: 'MOCK-1001', modelId: 'model-mock-m3', serialNumber: 'MOCK-DEMO-001', status: 'active', battery: 100, eventType: 'online' })
  });

  syncAdapter('autoxing', 'seed');
  syncAdapter('cenobots', 'seed');
}

function recordAudit(actor, action, objectType, objectId, result = 'success', details = {}) {
  state.audit.push({ id: ids(), actorId: actor.id, actorName: actor.name, action, objectType, objectId, result, details, occurredAt: timestamp() });
  schedulePersist();
}

function appendOutbox(eventType, aggregateType, aggregateId, payload = {}) {
  const item = { id: ids(), eventType, aggregateType, aggregateId, payload: clone(payload), status: 'pending', createdAt: timestamp(), publishedAt: null };
  state.outbox.push(item);
  return item;
}

function appendPassportEntry(robotId, entry, actor = { id: 'system', name: 'System' }) {
  const fullEntry = { id: ids(), robotId, source: entry.source || 'altegro', trustStatus: entry.trustStatus || 'reported', createdBy: actor.id, occurredAt: entry.occurredAt || timestamp(), type: entry.type, data: entry.data || {} };
  const entries = state.passportEntries.get(robotId) || [];
  entries.push(fullEntry);
  state.passportEntries.set(robotId, entries);
  appendOutbox('passport.entry.appended', 'robot', robotId, { passportEntryId: fullEntry.id, type: fullEntry.type });
  return fullEntry;
}

function robotAccountSlug(value) {
  return String(value || 'robot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'robot';
}

function createRobotUser(robot, { email, password, system = 'manual', externalId = null } = {}) {
  const existingRobotUser = Object.entries(demoUsers).find(([, user]) => user.role === 'robot_user' && user.robotSystem === system && user.robotSerialNumber === robot.serialNumber);
  if (existingRobotUser) return { token: existingRobotUser[0], email: existingRobotUser[1].email, password: null, serialNumber: robot.serialNumber, robotId: robot.id, created: false };
  if (Object.values(demoUsers).some((user) => user.email.toLowerCase() === email.toLowerCase())) throw httpError(409, 'That username/email is already in use');
  const slug = robotAccountSlug(robot.serialNumber);
  let token = `demo-robot-${slug}`;
  let suffix = 2;
  while (demoUsers[token]) token = `demo-robot-${slug}-${suffix++}`;
  const user = { id: `user-${token}`, name: `${robot.serialNumber} User`, email, passwordHash: hashPassword(password), role: 'robot_user', tenantId: robot.tenantId, organizationId: robot.organizationId, robotSystem: system, robotExternalId: externalId, robotSerialNumber: robot.serialNumber };
  demoUsers[token] = user;
  schedulePersist();
  return { token, email: user.email, password, serialNumber: robot.serialNumber, robotId: robot.id, created: true };
}

function ensureRobotUser(robot) {
  const identity = (robot.externalIdentities || [])[0];
  if (!identity || !robot.serialNumber) return null;
  const slug = robotAccountSlug(robot.serialNumber);
  return createRobotUser(robot, { email: `robot-${slug}@demo.altegro.local`, password: `Robot-${slug}-demo`, system: identity.system, externalId: identity.externalId });
}

function ensureAllRobotUsers() {
  [...state.robots.values()].map(ensureRobotUser).filter(Boolean);
  return Object.entries(demoUsers).filter(([, user]) => user.role === 'robot_user').map(([token, user]) => { const serialNumbers = actorRobotSerials(user); return { token, email: user.email, password: null, serialNumber: serialNumbers[0] || null, serialNumbers, robotId: [...state.robots.values()].find((robot) => robot.serialNumber === serialNumbers[0])?.id || null, created: false }; });
}

function upsertEvent(robotId, event, actor = { id: 'system', name: 'System' }) {
  const duplicate = state.events.find((item) => item.sourceSystem === event.sourceSystem && item.sourceEventId === event.sourceEventId);
  if (duplicate) return duplicate;
  const fullEvent = { eventId: ids(), eventType: event.eventType, schemaVersion: '1.0.0', tenantId: state.robots.get(robotId).tenantId, robotId, sourceSystem: event.sourceSystem, sourceEventId: event.sourceEventId, occurredAt: event.occurredAt || timestamp(), ingestedAt: timestamp(), severity: event.severity || 'info', title: event.title || event.eventType, description: event.description || '', attachment: event.attachment || null, payload: event.payload || {}, correlationId: ids() };
  state.events.push(fullEvent);
  appendPassportEntry(robotId, { type: 'technical_event', source: event.sourceSystem, data: fullEvent }, actor);
  const robot=state.robots.get(robotId); queueEmailAlert({ notificationKey:`event:${fullEvent.eventId}`,type:'technical_event',severity:fullEvent.severity,title:fullEvent.title,message:fullEvent.description || fullEvent.eventType,robotId,robotSerialNumber:robot?.serialNumber,occurredAt:fullEvent.occurredAt });
  return fullEvent;
}

function recordAdapterSync(adapter, { status, startedAt, count = 0, warnings = 0, error = null, trigger = 'manual' }) {
  if (!adapter) return;
  const completedAt = timestamp(); const durationMs = Math.max(0, Date.now() - startedAt);
  adapter.lastSyncAt = completedAt; adapter.lastSyncStatus = status; adapter.lastError = error; adapter.lastSyncDurationMs = durationMs; adapter.lastSyncCount = count; adapter.lastSyncWarnings = warnings;
  adapter.syncHistory = [...(adapter.syncHistory || []), { id:ids(), status, startedAt:new Date(startedAt).toISOString(), completedAt, durationMs, count, warnings, trigger }].slice(-20);
  if (status === 'error') { const digest=crypto.createHash('sha256').update(String(error || 'unknown')).digest('hex').slice(0,16); queueEmailAlert({ notificationKey:`adapter:${adapter.provider}:${digest}`,type:'integration_error',severity:'error',title:`${adapter.provider} synchronization failed`,message:'The provider synchronization failed. Retry from Altegro and inspect the protected server log if the error remains.',occurredAt:completedAt }); }
}

function syncAdapter(provider, actorId = 'system') {
  const adapter = state.adapters.get(provider);
  if (!adapter) throw httpError(404, `Unknown adapter: ${provider}`);
  const syncStartedAt = Date.now();
  const payload = adapter.sync();
  let robot = [...state.robots.values()].find((item) => item.externalIdentities.some((identity) => identity.system === provider && identity.externalId === payload.externalId));
  const actor = typeof actorId === 'string' && demoUsers[actorId] ? demoUsers[actorId] : { id: actorId, name: 'System' };
  if (!robot) {
    robot = {
      id: ids(), tenantId: 'tenant-demo', organizationId: 'org-demo', operatorOrganizationId: 'org-service', siteId: 'site-berlin', modelId: payload.modelId,
      serialNumber: payload.serialNumber, status: payload.status, externalIdentities: [{ system: provider, externalId: payload.externalId }], createdAt: timestamp(), updatedAt: timestamp()
    };
    state.robots.set(robot.id, robot);
    appendPassportEntry(robot.id, { type: 'registration', source: provider, data: { modelId: robot.modelId, serialNumber: robot.serialNumber, externalId: payload.externalId } }, actor);
  } else {
    robot.status = payload.status;
    robot.updatedAt = timestamp();
  }
  ensureRobotUser(robot);
  appendPassportEntry(robot.id, { type: 'configuration_snapshot', source: provider, data: { battery: payload.battery, status: payload.status } }, actor);
  upsertEvent(robot.id, { eventType: payload.eventType, sourceSystem: provider, sourceEventId: `${payload.externalId}:${payload.eventType}:${payload.battery}`, payload: { battery: payload.battery, status: payload.status } }, actor);
  recordAdapterSync(adapter, { status:'success', startedAt:syncStartedAt, count:1, trigger:actorId === 'seed' ? 'seed' : 'manual' });
  return { provider, adapterVersion: adapter.version, robot: getPassport(robot.id), commandCapabilitiesEnabled: false };
}

async function runAutoXingBridge(command = 'snapshot') {
  const env = { ...process.env, AUTOXING_REPO_PATH: AUTOXING_REPO, AUTOXING_LIB_PATH: AUTOXING_LIB };
  for (const name of ['APPID', 'APPSECRET', 'APPCODE']) { const value = secretEnvValue(name); if (value) env[name] = value; }
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await execFileAsync(process.env.PYTHON_BIN || 'python3', [AUTOXING_BRIDGE, command], { cwd: AUTOXING_REPO, env, timeout: Math.max(120000, Number(process.env.AUTOXING_BRIDGE_TIMEOUT_MS || 300000)), maxBuffer: 128 * 1024 * 1024 });
      let payload;
      try {
        payload = JSON.parse(result.stdout.trim());
      } catch (parseError) {
        throw httpError(503, `AutoXing bridge returned invalid JSON: ${parseError.message}`, { provider: 'autoxing', stderr: String(result.stderr || '').slice(-4000) });
      }
      if (!payload.ok) throw httpError(503, payload.message, { provider: 'autoxing', bridgeCode: payload.code });
      return payload;
    } catch (error) {
      const diagnostic = [error.message, error.stderr ? String(error.stderr).slice(-4000) : ''].filter(Boolean).join(' | ');
      lastError = Object.assign(error, { diagnostic });
      // Child-process failures also have a numeric `status`; only stop
      // immediately for our own structured HTTP errors. Python stderr is
      // needed to diagnose wrapper failures.
      if ((error.status && !error.code) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  if (lastError.status && !lastError.code) throw lastError;
  throw httpError(503, `AutoXing wrapper unavailable: ${lastError.diagnostic || lastError.message}`, { provider: 'autoxing' });
}

async function runCenoBotsBridge(command = 'snapshot') {
  try {
    const env = { ...process.env };
    for (const name of ['CENOBOTS_ACCESS_KEY', 'CENOBOTS_SECRET_KEY']) { const value = secretEnvValue(name); if (value) env[name] = value; }
    const result = await execFileAsync(process.env.PYTHON_BIN || 'python3', [CENOBOTS_CLIENT, command], { cwd: __dirname, env, timeout:Math.max(20000, Number(process.env.CENOBOTS_BRIDGE_TIMEOUT_MS || 120000)), maxBuffer:32 * 1024 * 1024 });
    let payload;
    try { payload = JSON.parse(result.stdout.trim()); }
    catch (error) { throw httpError(503, `CenoBots client returned invalid JSON: ${error.message}`, { provider:'cenobots' }); }
    if (!payload.ok) throw httpError(503, payload.error || 'CenoBots synchronization failed', { provider:'cenobots' });
    return payload;
  } catch (error) {
    if (error.status) throw error;
    let providerMessage = '';
    try { providerMessage = JSON.parse(String(error.stdout || '').trim()).error || ''; } catch {}
    throw httpError(503, `CenoBots API unavailable: ${providerMessage || error.message}`, { provider:'cenobots' });
  }
}

function meaningful(value) {
  return value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0) && !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function storeAutoXingResources(resources = {}, resourceErrors = []) {
  const data = state.autoxing;
  data.businesses = Array.isArray(resources.businesses) ? resources.businesses : [];
  data.buildings = Array.isArray(resources.buildings) ? resources.buildings : [];
  data.pois = new Map((resources.pois || []).map((item) => [String(item.externalRobotId), item]));
  data.areas = new Map((resources.areas || []).map((item) => [String(item.externalRobotId), item]));
  data.maps = new Map((resources.maps || []).map((item) => [`${item.areaId}:${item.externalRobotId}`, item]));
  data.tasks = new Map((resources.tasks || []).filter((item) => item.taskId).map((item) => [String(item.taskId), item]));
  data.lastSyncAt = timestamp();
  data.resourceErrors = Array.isArray(resourceErrors) ? resourceErrors : [];
}

function taskRobotExternalId(task) {
  const raw = task?.raw || {};
  return task?.externalRobotId || task?.robotId || raw.robotId || raw.robot_id || raw.robotSn || raw.robotSN || raw.robot?.robotId || raw.robot?.id || null;
}

function autoXingResourcesForRobot(robot) {
  const externalId = robot.externalIdentities?.find((identity) => identity.system === 'autoxing')?.externalId;
  if (!externalId) return null;
  const maps = [...state.autoxing.maps.values()].filter((item) => item.externalRobotId === externalId || (robot.providerAreaId && String(item.areaId) === String(robot.providerAreaId)));
  const tasks = [...state.autoxing.tasks.values()].filter((task) => {
    const taskRobot = taskRobotExternalId(task);
    return taskRobot && String(taskRobot) === String(externalId);
  });
  return {
    externalRobotId: externalId,
    pois: clone(state.autoxing.pois.get(String(externalId)) || { externalRobotId: externalId, items: [] }),
    areas: clone(state.autoxing.areas.get(String(externalId)) || { externalRobotId: externalId, items: [] }),
    maps: clone(maps),
    tasks: clone(tasks),
    syncedAt: state.autoxing.lastSyncAt,
    resourceErrors: clone(state.autoxing.resourceErrors.filter((error) => !error.externalRobotId || error.externalRobotId === externalId))
  };
}

function providerField(record, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase())); const queue = [{ value:record, depth:0 }]; let visited = 0;
  while (queue.length && visited < 250) {
    const { value, depth } = queue.shift(); visited += 1;
    if (!value || typeof value !== 'object') continue;
    for (const [key, item] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase()) && meaningful(item)) return item;
      if (depth < 3 && item && typeof item === 'object') queue.push({ value:item, depth:depth + 1 });
    }
  }
  return null;
}

function autoXingTaskSummary(tasks) {
  const normalized = tasks.map((task) => {
    const statusValue = providerField(task, ['taskStatus','status','state','result']) || 'unknown';
    const status = typeof statusValue === 'object' ? JSON.stringify(statusValue) : String(statusValue);
    const statusKey = status.toLowerCase();
    const occurredAt = providerField(task, ['endTime','endedAt','updatedAt','startTime','startedAt','createdAt','timestamp']);
    const durationMinutesValue = Number(providerField(task, ['durationMinutes','workingTimeMinutes','totalWorkingTime']));
    const durationSecondsValue = Number(providerField(task, ['durationSeconds','duration','workingTime','totalTime']));
    const durationMinutes = Number.isFinite(durationMinutesValue) && durationMinutesValue >= 0 ? durationMinutesValue : Number.isFinite(durationSecondsValue) && durationSecondsValue >= 0 ? durationSecondsValue / 60 : null;
    const cleanedAreaValue = Number(providerField(task, ['cleanedArea','cleanedAreaSize','totalCleanedArea','coverageArea']));
    return { taskId:task.taskId || providerField(task,['taskId','id']) || 'unknown', robotExternalId:taskRobotExternalId(task), status, occurredAt:occurredAt && !Number.isNaN(Date.parse(occurredAt)) ? new Date(occurredAt).toISOString() : null, durationMinutes, cleanedArea:Number.isFinite(cleanedAreaValue) ? cleanedAreaValue : null, completed:/complete|completed|success|done|finish/.test(statusKey), failed:/fail|error|abort|cancel/.test(statusKey), running:/running|active|progress|executing|pending/.test(statusKey) };
  });
  const completed = normalized.filter((task) => task.completed).length; const failed = normalized.filter((task) => task.failed).length; const durations = normalized.map((task) => task.durationMinutes).filter(Number.isFinite); const areas = normalized.map((task) => task.cleanedArea).filter(Number.isFinite);
  return { total:normalized.length, completed, failed, running:normalized.filter((task) => task.running).length, successRate:completed + failed ? Math.round(completed / (completed + failed) * 100) : null, averageDurationMinutes:durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null, cleanedArea:areas.length ? Math.round(areas.reduce((sum, value) => sum + value, 0)) : null, tasks:normalized };
}

function autoXingRecommendedAction(text) {
  const value = String(text || '').toLowerCase();
  if (/emergency|e-stop|estop/.test(value)) return 'Inspect the robot and surrounding area. Release the emergency stop only after the physical hazard is cleared.';
  if (/obstruction|blocked|collision/.test(value)) return 'Inspect the travel path, remove the obstruction, and verify sensors before resuming operation.';
  if (/battery|charge|dock/.test(value)) return 'Check battery level, charging contacts, dock power, and alignment. Escalate if charging does not recover.';
  if (/map|locali[sz]|position/.test(value)) return 'Verify the active map and robot location, then inspect localization sensors and map changes.';
  if (/lidar|sensor|camera/.test(value)) return 'Clean and inspect the affected sensor, confirm it is unobstructed, and arrange qualified service if the alert remains.';
  if (/offline|network|connect/.test(value)) return 'Check robot power, Wi-Fi coverage, and provider connectivity. Confirm the last online time before dispatching service.';
  return 'Review the provider error details, inspect the robot safely, and assign a qualified technician if the condition persists.';
}

function autoXingRobotAlerts(robot) {
  const alerts = []; const add = (key, severity, title, message) => alerts.push({ id:`${robot.id}:${key}`, type:key,tenantId:robot.tenantId,robotId:robot.id,serialNumber:robot.serialNumber,severity,title,message,recommendedAction:autoXingRecommendedAction(`${title} ${message}`),occurredAt:robot.updatedAt });
  if (robot.online === false) add('offline','warning','Robot offline','AutoXing reports that the robot is offline.');
  if (robot.emergencyStop === true) add('emergency-stop','critical','Emergency stop active','The emergency-stop signal is active.');
  if (robot.obstruction === true) add('obstruction','warning','Obstruction detected','The robot reports an obstruction in its operating path.');
  if (Number.isFinite(Number(robot.battery)) && Number(robot.battery) <= 20) add('low-battery','warning','Low battery',`Battery is ${Number(robot.battery)}%.`);
  if (robot.lastProviderError) add('provider-state','error','Live status unavailable',String(robot.lastProviderError).slice(0,500));
  if (meaningful(robot.errors)) add('provider-errors','error','Provider errors reported',typeof robot.errors === 'string' ? robot.errors.slice(0,500) : JSON.stringify(robot.errors).slice(0,500));
  return alerts;
}

function maintenanceScheduleView(schedule) {
  const robot=state.robots.get(schedule.robotId); const technician=schedule.assignedTechnicianId ? state.technicians.get(schedule.assignedTechnicianId) : null; const dueTime=Date.parse(schedule.nextDueAt); const daysUntil=Math.ceil((dueTime-Date.now())/86400000); const dueState=schedule.status !== 'active' ? schedule.status : daysUntil < 0 ? 'overdue' : daysUntil <= 7 ? 'due_soon' : 'scheduled';
  return { ...clone(schedule),robotSerialNumber:robot?.serialNumber || 'Unknown robot',technicianName:technician?.name || null,dueState,daysUntilDue:Number.isFinite(daysUntil) ? daysUntil : null };
}

function autoXingMaintenanceAlerts(robots) {
  const robotIds=new Set(robots.map((robot) => robot.id)); const alerts=[];
  for (const schedule of state.maintenanceSchedules.values()) {
    if (!robotIds.has(schedule.robotId) || schedule.status !== 'active') continue; const view=maintenanceScheduleView(schedule); if (!['overdue','due_soon'].includes(view.dueState)) continue; const robot=state.robots.get(schedule.robotId); const severity=view.dueState === 'overdue' ? 'error' : 'warning';
    alerts.push({ id:`maintenance:${schedule.id}`,type:'maintenance_due',tenantId:schedule.tenantId,robotId:schedule.robotId,serialNumber:robot.serialNumber,severity,title:view.dueState === 'overdue' ? `Maintenance overdue: ${schedule.title}` : `Maintenance due soon: ${schedule.title}`,message:`Scheduled for ${schedule.nextDueAt.slice(0,10)}${view.technicianName ? ` with ${view.technicianName}` : ''}.`,recommendedAction:'Confirm the service window, assign a qualified technician, and record completion in the Robot Passport.',occurredAt:schedule.nextDueAt });
  }
  return alerts;
}

function autoXingAlertsForRobots(robots) {
  const alerts=[...robots.flatMap(autoXingRobotAlerts),...autoXingMaintenanceAlerts(robots)];
  for (const [index,warning] of (state.autoxing.resourceErrors || []).entries()) alerts.push({ id:`resource:${index}`,type:'integration_warning',tenantId:robots[0]?.tenantId || 'tenant-demo',robotId:null,serialNumber:warning.externalRobotId || 'Fleet resource',severity:'warning',title:`${warning.resource || 'AutoXing resource'} synchronization warning`,message:String(warning.message || warning.error || 'Provider resource could not be read').slice(0,500),recommendedAction:'Retry synchronization. If the warning remains, check the provider endpoint permission and protected server log.',occurredAt:state.autoxing.lastSyncAt });
  const severityRank={ critical:0,error:1,warning:2,info:3 }; alerts.sort((a,b) => (severityRank[a.severity] ?? 4)-(severityRank[b.severity] ?? 4)); return alerts;
}

function alertWithWorkflow(alert) {
  const workflow = state.alertWorkflows.get(alert.id) || null;
  return { ...alert, workflow:workflow ? clone(workflow) : { status:'open', technicianId:null, technicianName:null, note:'', serviceCaseId:null, updatedAt:null, updatedBy:null } };
}

function findVisibleAutoXingAlert(actor, alertId) {
  return autoXingOperations(actor).alerts.find((alert) => alert.id === alertId) || null;
}

function autoXingTaskView(actor, task) {
  const externalId = String(taskRobotExternalId(task) || '');
  const robot = [...state.robots.values()].find((item) => visibleToActor(actor,item) && item.externalIdentities?.some((identity) => identity.system === 'autoxing' && String(identity.externalId) === externalId));
  if (!robot) return null;
  const normalized = autoXingTaskSummary([task]).tasks[0];
  return { taskId:String(task.taskId || normalized.taskId), robot:{ id:robot.id, serialNumber:robot.serialNumber, externalId }, normalized, provider:clone(task), syncedAt:state.autoxing.lastSyncAt };
}

function autoXingOperations(actor) {
  const robots = [...state.robots.values()].filter((robot) => visibleToActor(actor, robot) && robot.externalIdentities?.some((identity) => identity.system === 'autoxing'));
  const externalIds = new Set(robots.map((robot) => robot.externalIdentities.find((identity) => identity.system === 'autoxing').externalId).map(String));
  const tasks = [...state.autoxing.tasks.values()].filter((task) => externalIds.has(String(taskRobotExternalId(task)))); const taskSummary = autoXingTaskSummary(tasks);
  const robotIds = new Set(robots.map((robot) => robot.id)); const events = state.events.filter((event) => robotIds.has(event.robotId) && event.sourceSystem === 'autoxing');
  const trends = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date(); day.setUTCHours(0,0,0,0); day.setUTCDate(day.getUTCDate() - offset); const next = new Date(day); next.setUTCDate(next.getUTCDate() + 1);
    const dayEvents = events.filter((event) => { const time = Date.parse(event.occurredAt); return time >= day.getTime() && time < next.getTime(); });
    const dayTasks = taskSummary.tasks.filter((task) => { const time = Date.parse(task.occurredAt); return Number.isFinite(time) && time >= day.getTime() && time < next.getTime(); });
    const batterySamples = dayEvents.map((event) => Number(event.payload?.battery)).filter(Number.isFinite);
    trends.push({ date:day.toISOString().slice(0,10), onlineEvents:dayEvents.filter((event) => event.eventType === 'online').length, offlineEvents:dayEvents.filter((event) => event.eventType === 'offline').length, errorEvents:dayEvents.filter((event) => ['error','critical'].includes(event.severity)).length, taskEvents:dayTasks.length, completedTasks:dayTasks.filter((task) => task.completed).length, averageBattery:batterySamples.length ? Math.round(batterySamples.reduce((sum, value) => sum + value, 0) / batterySamples.length) : null });
  }
  const alerts=autoXingAlertsForRobots(robots); const maintenance=[...state.maintenanceSchedules.values()].filter((schedule) => robots.some((robot) => robot.id === schedule.robotId)).map(maintenanceScheduleView);
  const adapter = state.adapters.get('autoxing') || {};
  return { fleet:robots.map((robot) => ({ id:robot.id,serialNumber:robot.serialNumber,externalId:robot.externalIdentities.find((identity) => identity.system === 'autoxing').externalId,online:robot.online,battery:robot.battery,charging:robot.charging,position:robot.position,speed:robot.speed,emergencyStop:robot.emergencyStop,obstruction:robot.obstruction,currentTask:robot.providerTask,providerVersion:robot.providerVersion,businessName:robot.providerBusinessName,siteId:robot.siteId,mappingStatus:robot.mappingStatus,updatedAt:robot.updatedAt,alertCount:alerts.filter((alert) => alert.robotId === robot.id).length })),taskAnalytics:{ ...taskSummary,tasks:undefined },maintenance:{ schedules:maintenance,total:maintenance.length,overdue:maintenance.filter((item) => item.dueState === 'overdue').length,dueSoon:maintenance.filter((item) => item.dueState === 'due_soon').length },alerts:alerts.map(alertWithWorkflow),alertWorkflow:{ canManage:canWrite(actor),technicians:techniciansForActor(actor).filter((technician) => technician.status === 'active').map((technician) => ({ id:technician.id,name:technician.name })) },trends,diagnostics:{ liveEnabled:autoXingLiveEnabled(),status:adapter.status,lastSyncAt:adapter.lastSyncAt,lastSyncStatus:adapter.lastSyncStatus,lastError:adapter.lastError ? 'Synchronization failed. Retry or inspect the protected server log.' : null,lastSyncDurationMs:adapter.lastSyncDurationMs,lastSyncCount:adapter.lastSyncCount,lastSyncWarnings:adapter.lastSyncWarnings || 0,pollingIntervalMs:autoXingPollIntervalMs(),nextPollAt:adapter.lastSyncAt && autoXingPollIntervalMs() ? new Date(Date.parse(adapter.lastSyncAt)+autoXingPollIntervalMs()).toISOString() : null,secretMode:secretConfigurationMode(),secretPolicy:managedSecretStatus(),syncHistory:clone(adapter.syncHistory || []) },generatedAt:timestamp() };
}

function autoXingDiagnosticReport(actor,robot) {
  const externalId=robot.externalIdentities.find((identity) => identity.system === 'autoxing')?.externalId; const tasks=[...state.autoxing.tasks.values()].filter((task) => String(taskRobotExternalId(task)) === String(externalId)); const events=state.events.filter((event) => event.robotId === robot.id).sort((a,b) => Date.parse(b.occurredAt)-Date.parse(a.occurredAt)).slice(0,50); const schedules=[...state.maintenanceSchedules.values()].filter((schedule) => schedule.robotId === robot.id).map(maintenanceScheduleView); const assignments=[...state.robotAssignments.values()].filter((assignment) => assignment.robotId === robot.id && assignment.status === 'active').map((assignment) => ({ ...clone(assignment),technician:state.technicians.get(assignment.technicianId) ? { id:assignment.technicianId,name:state.technicians.get(assignment.technicianId).name } : null })); const adapter=state.adapters.get('autoxing') || {};
  return { schemaVersion:'1.0.0',reportType:'autoxing_remote_diagnostic',generatedAt:timestamp(),generatedBy:{ id:actor.id,name:actor.name,role:actor.role },robot:{ id:robot.id,serialNumber:robot.serialNumber,modelId:robot.modelId,siteId:robot.siteId,status:robot.status,externalId,providerVersion:robot.providerVersion,mappingStatus:robot.mappingStatus },liveTelemetry:{ online:robot.online ?? null,battery:robot.battery ?? null,charging:robot.charging ?? null,position:clone(robot.position || null),speed:robot.speed ?? null,emergencyStop:robot.emergencyStop ?? null,obstruction:robot.obstruction ?? null,currentTask:clone(robot.providerTask || null),statusDetails:clone(robot.statusDetails || {}),providerErrors:clone(robot.errors || []),lastProviderError:robot.lastProviderError || null,updatedAt:robot.updatedAt },diagnostics:{ alerts:autoXingAlertsForRobots([robot]).map(alertWithWorkflow),taskSummary:autoXingTaskSummary(tasks),recentEvents:clone(events),maintenanceSchedules:schedules,qualifiedAssignments:assignments,adapter:{ status:adapter.status,lastSyncAt:adapter.lastSyncAt,lastSyncStatus:adapter.lastSyncStatus,lastSyncDurationMs:adapter.lastSyncDurationMs,lastSyncWarnings:adapter.lastSyncWarnings || 0 },resources:autoXingResourcesForRobot(robot) },safetyNotice:'Read-only diagnostic report. Verify physical robot safety conditions before maintenance or recovery work.' };
}

function escalationRuleView(rule) {
  const technician=rule.technicianId ? state.technicians.get(rule.technicianId) : null; const executions=[...state.alertEscalations.values()].filter((item) => item.ruleId === rule.id);
  return { ...clone(rule),technicianName:technician?.name || null,executionCount:executions.length,lastEscalatedAt:executions.sort((a,b) => Date.parse(b.escalatedAt)-Date.parse(a.escalatedAt))[0]?.escalatedAt || null };
}

function ensureEscalationServiceCase(alert,rule,actor) {
  if (!alert.robotId) return null; const robot=state.robots.get(alert.robotId); if (!robot) return null; const digest=crypto.createHash('sha256').update(`${rule.id}:${alert.id}`).digest('hex').slice(0,12).toUpperCase(); const externalId=`AX-ESC-${digest}`; const key=`altegro:${externalId}`; let serviceCase=state.serviceCases.get(key); if (serviceCase) return serviceCase;
  let technician=null; if (rule.technicianId) { const candidate=state.technicians.get(rule.technicianId); if (candidate?.status === 'active' && technicianEligibility(candidate,robot).eligible) technician=candidate; }
  serviceCase={ id:ids(),robotId:robot.id,tenantId:robot.tenantId,provider:'altegro',externalId,title:`Escalated: ${alert.title}`,description:`${alert.message}\nEscalation rule: ${rule.name}\nRecommended action: ${alert.recommendedAction}`,severity:alert.severity,status:'open',cause:null,action:`Automatically escalated by ${rule.name}.`,parts:[],assignedTo:technician?.name || null,createdAt:timestamp(),updatedAt:timestamp(),closedAt:null };
  state.serviceCases.set(key,serviceCase); appendPassportEntry(robot.id,{ type:'incident_opened',source:'autoxing_escalation',data:{ serviceCaseId:serviceCase.id,externalId,alertId:alert.id,ruleId:rule.id,title:alert.title,severity:alert.severity } },actor); appendOutbox('service_case.escalated','service_case',serviceCase.id,{ ...serviceCase,ruleId:rule.id,alertId:alert.id }); return serviceCase;
}

function evaluateAlertEscalations(tenantId='tenant-demo') {
  const robots=[...state.robots.values()].filter((robot) => robot.tenantId === tenantId && robot.externalIdentities?.some((identity) => identity.system === 'autoxing')); const alerts=autoXingAlertsForRobots(robots); const rules=[...state.alertEscalationRules.values()].filter((rule) => rule.tenantId === tenantId && rule.active); const rank={ info:0,warning:1,error:2,critical:3 }; const actor={ id:'system-alert-escalation',name:'Alert Escalation Worker',role:'platform_admin',tenantId,organizationId:'org-ef' }; const created=[];
  for (const rule of rules) for (const alert of alerts) {
    if (rule.alertType !== 'any' && rule.alertType !== alert.type) continue; if ((rank[alert.severity] ?? 0) < (rank[rule.minimumSeverity] ?? 0)) continue; if (state.alertWorkflows.get(alert.id)?.status === 'resolved') continue; const occurred=Date.parse(alert.occurredAt); if (!Number.isFinite(occurred) || Date.now()-occurred < rule.afterMinutes*60000) continue; const key=`${rule.id}:${alert.id}`; if (state.alertEscalations.has(key)) continue;
    const actions=[]; let serviceCase=null; let delivery=null;
    if (['email','email_and_service_case'].includes(rule.action)) { delivery=queueEmailAlert({ notificationKey:`escalation:${key}`,type:'alert_escalation',severity:alert.severity,title:`Escalated: ${alert.title}`,message:`Rule ${rule.name} escalated ${alert.serialNumber}: ${alert.message}`,robotId:alert.robotId,robotSerialNumber:alert.serialNumber,occurredAt:alert.occurredAt },{ force:true }); if (delivery) actions.push('email'); }
    if (['service_case','email_and_service_case'].includes(rule.action)) { serviceCase=ensureEscalationServiceCase(alert,rule,actor); if (serviceCase) actions.push('service_case'); }
    if (!actions.length) continue; let assignedTechnician=null; if (rule.technicianId && alert.robotId) { const candidate=state.technicians.get(rule.technicianId); const robot=state.robots.get(alert.robotId); if (candidate && robot && technicianEligibility(candidate,robot).eligible) assignedTechnician=candidate; }
    const execution={ id:ids(),ruleId:rule.id,alertId:alert.id,tenantId,severity:alert.severity,robotId:alert.robotId,actions,deliveryId:delivery?.id || null,serviceCaseId:serviceCase?.id || null,escalatedAt:timestamp() }; state.alertEscalations.set(key,execution); const existing=state.alertWorkflows.get(alert.id) || {}; state.alertWorkflows.set(alert.id,{ alertId:alert.id,status:serviceCase ? 'in_progress' : existing.status || 'acknowledged',technicianId:assignedTechnician?.id || existing.technicianId || null,technicianName:assignedTechnician?.name || existing.technicianName || null,note:`Escalated automatically by ${rule.name}.`,serviceCaseId:serviceCase?.id || existing.serviceCaseId || null,updatedAt:timestamp(),updatedBy:actor.name }); appendOutbox('autoxing.alert.escalated','autoxing_alert',alert.id,execution); recordAudit(actor,'autoxing.alert.escalate','robot',alert.robotId || 'autoxing-fleet','success',{ ruleId:rule.id,alertId:alert.id,actions }); created.push(execution);
  }
  if (created.length) schedulePersist(); return { evaluatedRules:rules.length,evaluatedAlerts:alerts.length,created:clone(created),createdCount:created.length };
}

async function syncAutoXingLive(actor) {
  const adapter = state.adapters.get('autoxing');
  const syncStartedAt = Date.now();
  if (adapter) { adapter.lastSyncStatus = 'running'; adapter.lastError = null; }
  const bridge = await runAutoXingBridge('snapshot');
  const businessMap = parseJsonEnv('AUTOXING_BUSINESS_MAP');
  const modelMap = parseJsonEnv('AUTOXING_MODEL_MAP');
  const synced = [];
  for (const externalRobot of bridge.robots) {
    const externalId = externalRobot.externalId;
    if (!externalId) continue;
    let robot = [...state.robots.values()].find((item) => item.externalIdentities.some((identity) => identity.system === 'autoxing' && identity.externalId === externalId));
    const mapping = businessMap[String(externalRobot.businessId)] || businessMap[String(externalRobot.businessName)] || businessMap.default || {};
    if (autoXingMappingRequired() && !Object.keys(mapping).length) throw httpError(400, `No Altegro mapping configured for AutoXing business ${externalRobot.businessName || externalRobot.businessId || externalId}`);
    const modelId = modelMap[String(externalRobot.model)] || 'model-autoxing-a1';
    const mappingStatus = Object.keys(mapping).length ? 'configured' : 'default-demo';
    if (!robot) {
      robot = { id: ids(), tenantId: actor.tenantId, organizationId: mapping.organizationId || process.env.AUTOXING_DEFAULT_ORGANIZATION_ID || 'org-demo', operatorOrganizationId: mapping.operatorOrganizationId || process.env.AUTOXING_DEFAULT_OPERATOR_ORGANIZATION_ID || 'org-service', siteId: mapping.siteId || process.env.AUTOXING_DEFAULT_SITE_ID || 'site-berlin', modelId, serialNumber: externalRobot.serialNumber, status: 'draft', online: externalRobot.online, battery: externalRobot.battery, charging: externalRobot.charging, position: externalRobot.position, speed: externalRobot.speed, emergencyStop: externalRobot.emergencyStop, obstruction: externalRobot.obstruction, statusDetails: externalRobot.statusDetails, providerTask: externalRobot.task, errors: externalRobot.errors, providerVersion: externalRobot.version, providerBusinessId: externalRobot.businessId, providerBusinessName: externalRobot.businessName, providerAreaId: externalRobot.areaId, mappingStatus, lastProviderError: externalRobot.stateError || null, externalIdentities: [{ system: 'autoxing', externalId }], createdAt: timestamp(), updatedAt: timestamp() };
      state.robots.set(robot.id, robot);
      appendPassportEntry(robot.id, { type: 'registration', source: 'autoxing', data: { externalId, serialNumber: robot.serialNumber, model: externalRobot.model, businessId: externalRobot.businessId } }, actor);
    } else {
      robot.online = externalRobot.online;
      robot.battery = externalRobot.battery;
      robot.charging = externalRobot.charging;
      robot.position = externalRobot.position;
      robot.speed = externalRobot.speed;
      robot.emergencyStop = externalRobot.emergencyStop;
      robot.obstruction = externalRobot.obstruction;
      robot.statusDetails = externalRobot.statusDetails;
      robot.providerTask = externalRobot.task;
      robot.errors = externalRobot.errors;
      robot.providerBusinessId = externalRobot.businessId;
      robot.providerBusinessName = externalRobot.businessName;
      robot.providerAreaId = externalRobot.areaId;
      robot.providerVersion = externalRobot.version;
      robot.mappingStatus = mappingStatus;
      robot.lastProviderError = externalRobot.stateError || null;
      robot.updatedAt = timestamp();
    }
    ensureRobotUser(robot);
    appendPassportEntry(robot.id, { type: 'configuration_snapshot', source: 'autoxing', data: { model: externalRobot.model, battery: externalRobot.battery, online: externalRobot.online, version: externalRobot.version, mappingStatus, raw: externalRobot.raw } }, actor);
    const eventType = externalRobot.online === false ? 'offline' : 'online';
    upsertEvent(robot.id, { eventType, sourceSystem: 'autoxing', sourceEventId: `${externalId}:${eventType}:${externalRobot.battery ?? 'unknown'}`, title: `AutoXing robot ${eventType}`, description: `Read-only synchronization from the AutoXing Python wrapper for ${externalRobot.serialNumber}.`, severity: externalRobot.online === false ? 'warning' : 'info', payload: externalRobot }, actor);
    if (externalRobot.task) upsertEvent(robot.id, { eventType: 'mission_status', sourceSystem: 'autoxing', sourceEventId: `${externalId}:task:${JSON.stringify(externalRobot.task)}`, title: 'AutoXing mission status', description: 'Mission status received from the AutoXing wrapper.', severity: 'info', payload: { task: externalRobot.task } }, actor);
    if (externalRobot.errors && JSON.stringify(externalRobot.errors) !== '[]' && JSON.stringify(externalRobot.errors) !== '{}') { const errorText = JSON.stringify(externalRobot.errors); const errorDigest = crypto.createHash('sha256').update(errorText).digest('hex').slice(0,16); const recommendedAction = autoXingRecommendedAction(errorText); upsertEvent(robot.id, { eventType:'error', sourceSystem:'autoxing', sourceEventId:`${externalId}:errors:${errorDigest}`, title:'AutoXing alert or error', description:`An alert or error was received from AutoXing. Recommended action: ${recommendedAction}`, severity:'error', payload:{ errors:externalRobot.errors, recommendedAction } }, actor); }
    if (externalRobot.emergencyStop === true) upsertEvent(robot.id, { eventType: 'emergency_stop', sourceSystem: 'autoxing', sourceEventId: `${externalId}:emergency-stop:true`, title: 'AutoXing emergency stop active', description: 'The emergency-stop state is active according to AutoXing.', severity: 'critical', payload: { emergencyStop: true, statusDetails: externalRobot.statusDetails } }, actor);
    if (externalRobot.obstruction === true) upsertEvent(robot.id, { eventType: 'obstruction', sourceSystem: 'autoxing', sourceEventId: `${externalId}:obstruction:true`, title: 'AutoXing obstruction detected', description: 'The robot reports an obstruction according to AutoXing.', severity: 'warning', payload: { obstruction: true, statusDetails: externalRobot.statusDetails } }, actor);
    if (externalRobot.stateError) upsertEvent(robot.id, { eventType: 'error', sourceSystem: 'autoxing', sourceEventId: `${externalId}:state-error:${externalRobot.stateError}`, title: 'AutoXing status read failed', description: externalRobot.stateError, severity: 'warning', payload: { stateError: externalRobot.stateError } }, actor);
    synced.push(getPassport(robot.id));
  }
  storeAutoXingResources(bridge.resources, bridge.resourceErrors);
  recordAdapterSync(adapter, { status:'success', startedAt:syncStartedAt, count:synced.length, warnings:bridge.resourceErrors?.length || 0, trigger:String(actor.id || '').includes('poller') ? 'poll' : 'manual' });
  evaluateAlertEscalations(actor.tenantId);
  return { provider: 'autoxing', adapterVersion: 'wrapper-backed', source: bridge.wrapper, robots: synced, count: synced.length, resources: { businesses: state.autoxing.businesses.length, buildings: state.autoxing.buildings.length, poiRobotScopes: state.autoxing.pois.size, areaRobotScopes: state.autoxing.areas.size, maps: state.autoxing.maps.size, tasks: state.autoxing.tasks.size, warnings: state.autoxing.resourceErrors.length }, resourceErrors: clone(state.autoxing.resourceErrors), commandCapabilitiesEnabled: false };
}

async function syncCenoBotsLive(actor) {
  const adapter = state.adapters.get('cenobots');
  const syncStartedAt = Date.now();
  if (adapter) { adapter.lastSyncStatus = 'running'; adapter.lastError = null; }
  const bridge = await runCenoBotsBridge('snapshot');
  const synced = [];
  for (const externalRobot of bridge.robots || []) {
    const externalId = String(externalRobot.deviceOpenId || '').trim();
    if (!externalId) continue;
    const providerStatus = externalRobot.status || {}; const providerInfo = externalRobot.info || {};
    const serialNumber = String(providerInfo.serialNumber || externalRobot.licensePlate || providerStatus.licensePlate || `CB-${externalId}`).trim().slice(0, 120);
    const canonicalStatus = providerInfo.activated === false ? 'draft' : 'active';
    let robot = [...state.robots.values()].find((item) => item.externalIdentities.some((identity) => identity.system === 'cenobots' && identity.externalId === externalId));
    if (!robot) {
      robot = { id:ids(), tenantId:actor.tenantId, organizationId:process.env.CENOBOTS_DEFAULT_ORGANIZATION_ID || 'org-demo', operatorOrganizationId:process.env.CENOBOTS_DEFAULT_OPERATOR_ORGANIZATION_ID || 'org-service', siteId:process.env.CENOBOTS_DEFAULT_SITE_ID || 'site-berlin', modelId:'model-cenobots-c1', serialNumber, status:canonicalStatus, externalIdentities:[{ system:'cenobots', externalId }], createdAt:timestamp(), updatedAt:timestamp() };
      state.robots.set(robot.id, robot);
      appendPassportEntry(robot.id, { type:'registration', source:'cenobots', data:{ externalId, serialNumber, licensePlate:externalRobot.licensePlate || providerStatus.licensePlate || null } }, actor);
    }
    Object.assign(robot, { serialNumber, status:canonicalStatus, online:providerStatus.online, battery:providerStatus.soc, charging:providerStatus.charging, position:providerStatus.pose || null, emergencyStop:providerStatus.isEmergency, providerTask:providerStatus.missionTaskDetail || null, providerMapId:providerStatus.currentMapId || null, providerMapName:providerStatus.currentMapName || null, providerVersion:providerInfo.softwareVersion || null, providerBuildingName:providerInfo.buildingName || null, maintenance:externalRobot.maintenance || null, errors:externalRobot.errors || [], lastProviderError:null, updatedAt:timestamp() });
    ensureRobotUser(robot);
    appendPassportEntry(robot.id, { type:'configuration_snapshot', source:'cenobots', data:{ online:robot.online, battery:robot.battery, charging:robot.charging, position:robot.position, softwareVersion:robot.providerVersion, mission:robot.providerTask, maintenance:robot.maintenance, errors:robot.errors } }, actor);
    const connectionEvent = robot.online === false ? 'offline' : 'online';
    upsertEvent(robot.id, { eventType:connectionEvent, sourceSystem:'cenobots', sourceEventId:`${externalId}:${connectionEvent}:${robot.battery ?? 'unknown'}`, title:`CenoBots robot ${connectionEvent}`, description:`Read-only CenoBots synchronization for ${serialNumber}.`, severity:robot.online === false ? 'warning' : 'info', payload:{ online:robot.online, battery:robot.battery, charging:robot.charging } }, actor);
    const errors = Array.isArray(robot.errors) ? robot.errors : robot.errors?.data || [];
    if (errors.length) {
      const errorDigest = crypto.createHash('sha256').update(JSON.stringify(errors)).digest('hex').slice(0, 16);
      upsertEvent(robot.id, { eventType:'error', sourceSystem:'cenobots', sourceEventId:`${externalId}:errors:${errorDigest}`, title:'CenoBots system errors', description:`CenoBots reported ${errors.length} system error${errors.length === 1 ? '' : 's'}.`, severity:'error', payload:{ errors } }, actor);
    }
    const maintenanceItems = externalRobot.maintenance?.maintenanceItems || [];
    if (maintenanceItems.some((item) => Number(item.overDueHours || 0) > 0)) {
      const maintenanceDigest = crypto.createHash('sha256').update(JSON.stringify(maintenanceItems)).digest('hex').slice(0, 16);
      upsertEvent(robot.id, { eventType:'maintenance_due', sourceSystem:'cenobots', sourceEventId:`${externalId}:maintenance:${maintenanceDigest}`, title:'CenoBots maintenance due', description:'One or more CenoBots maintenance items are overdue.', severity:'warning', payload:{ maintenanceItems } }, actor);
    }
    synced.push(getPassport(robot.id));
  }
  recordAdapterSync(adapter, { status:'success', startedAt:syncStartedAt, count:synced.length, warnings:bridge.warnings?.length || 0, trigger:'manual' });
  return { provider:'cenobots', adapterVersion:'open-api-v1.0.16', source:'CenoBots Open API', robots:synced, count:synced.length, resourceErrors:clone(bridge.warnings || []), commandCapabilitiesEnabled:false };
}

function getPassport(robotId) {
  const robot = state.robots.get(robotId);
  const entries = state.passportEntries.get(robotId) || [];
  const safeEntries = entries.map((entry) => {
    const copy = clone(entry);
    if (copy.data?.attachment) delete copy.data.attachment.contentBase64;
    return copy;
  });
  return {
    robot: clone(robot),
    model: clone(state.models.get(robot.modelId)),
    owner: clone(state.organizations.get(robot.organizationId)),
    operator: clone(state.organizations.get(robot.operatorOrganizationId)),
    site: clone(state.sites.get(robot.siteId)),
    entries: safeEntries,
    documents: clone(state.documents.filter((item) => item.robotId === robotId).map(({ attachment, ...item }) => ({ ...item, attachment: attachment ? { name: attachment.name, contentType: attachment.contentType, size: attachment.size, sha256: attachment.sha256 } : null }))),
    certificates: clone(state.certificates.filter((item) => item.robotId === robotId)),
    deployments: clone(state.deployments.filter((item) => item.robotId === robotId)),
    serviceCases: clone([...state.serviceCases.values()].filter((item) => item.robotId === robotId)),
    compatibility: clone(state.compatibilityRecords.filter((item) => item.modelId === robot.modelId)),
    workforce: { requirements:workRequirementsForRobot(robot), assignedTechnicians:[...state.robotAssignments.values()].filter((item) => item.robotId === robotId && item.status === 'active').map((assignment) => { const technician = state.technicians.get(assignment.technicianId); return technician ? { assignment:clone(assignment), technician:{ id:technician.id, name:technician.name, email:technician.email, jobTitle:technician.jobTitle || 'Service Technician' }, eligibility:technicianEligibility(technician, robot) } : null; }).filter(Boolean) },
    completeness: calculateCompleteness(robot, entries)
  };
}

function calculateCompleteness(robot, entries) {
  const robotId = robot.id;
  const checks = {
    robotId: Boolean(robot.id), model: Boolean(robot.modelId), serialNumber: Boolean(robot.serialNumber), owner: Boolean(robot.organizationId), site: Boolean(robot.siteId), registration: entries.some((item) => item.type === 'registration'), configuration: entries.some((item) => item.type === 'configuration_snapshot'), lifecycleEvidence: state.documents.some((item) => item.robotId === robotId) || state.certificates.some((item) => item.robotId === robotId) || state.deployments.some((item) => item.robotId === robotId)
  };
  const complete = Object.values(checks).filter(Boolean).length;
  return { percentage: Math.round((complete / Object.keys(checks).length) * 100), checks };
}

function getActor(req) {
  const header = req.headers.authorization || '';
  const cookieToken = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('altegro_session='))?.slice('altegro_session='.length);
  const token = header.startsWith('Bearer ') ? header.slice(7) : cookieToken ? decodeURIComponent(cookieToken) : null;
  if (!token) return null;
  const sessionKey = crypto.createHash('sha256').update(token).digest('hex');
  const session = authenticatedSessions.get(sessionKey);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { authenticatedSessions.delete(sessionKey); schedulePersist(); return null; }
  return demoUsers[session.userToken] || null;
}

function requireActor(req) {
  const actor = getActor(req);
  if (!actor) throw httpError(401, 'Your session is missing, expired, or has been revoked');
  return actor;
}

function canWrite(actor) {
  return ['owner', 'technician', 'platform_admin', 'data_admin', 'support_admin'].includes(actor.role);
}

function canRegisterRobot(actor) {
  return canWrite(actor) || actor.role === 'robot_user';
}

function canExport(actor) {
  return ['owner', 'platform_admin', 'data_admin', 'support_admin', 'auditor'].includes(actor.role);
}

function actorRobotSerials(actor) {
  if (Array.isArray(actor.robotSerialNumbers) && actor.robotSerialNumbers.length) return actor.robotSerialNumbers;
  return actor.robotSerialNumber ? [actor.robotSerialNumber] : [];
}

function addRobotToActorScope(actor, serialNumber) {
  actor.robotSerialNumbers = [...new Set([...actorRobotSerials(actor), serialNumber])];
  actor.robotSerialNumber = actor.robotSerialNumbers[0];
}

function matchesRobotScope(actor, robot) {
  if (actor.role !== 'robot_user') return true;
  return actorRobotSerials(actor).includes(robot.serialNumber);
}

function visibleToActor(actor, robot) {
  if (!robot || robot.tenantId !== actor.tenantId) return false;
  if (!matchesRobotScope(actor, robot)) return false;
  if (actor.role === 'robot_user') return true;
  if (['platform_admin', 'data_admin', 'support_admin'].includes(actor.role)) return true;
  if (actor.role === 'owner') return robot.organizationId === actor.organizationId;
  if (actor.role === 'auditor') return robot.organizationId === actor.organizationId;
  if (actor.role === 'technician') return robot.operatorOrganizationId === actor.organizationId || robot.organizationId === actor.tenantId;
  return false;
}

function visibleRobotIds(actor) {
  return new Set([...state.robots.values()].filter((robot) => visibleToActor(actor, robot)).map((robot) => robot.id));
}

function serviceCasesForActor(actor) {
  const robotIds = visibleRobotIds(actor);
  return [...state.serviceCases.values()].filter((item) => robotIds.has(item.robotId));
}

function canManageWorkforce(actor) {
  return ['platform_admin', 'data_admin', 'support_admin'].includes(actor.role);
}

function techniciansForActor(actor) {
  if (actor.role === 'robot_user') return [];
  return [...state.technicians.values()].filter((technician) => technician.tenantId === actor.tenantId);
}

function workRequirementsForRobot(robot) {
  const modelRequirements = state.modelRequirements.get(robot.modelId) || { requiredSkills: [], requiredCertificates: [] };
  const robotRequirements = robot.workRequirements || {};
  return { modelId: robot.modelId, requiredSkills: [...new Set([...(modelRequirements.requiredSkills || []), ...(robotRequirements.requiredSkills || [])])], requiredCertificates: [...new Set([...(modelRequirements.requiredCertificates || []), ...(robotRequirements.requiredCertificates || [])])] };
}

function technicianEligibility(technician, robot) {
  const requirements = workRequirementsForRobot(robot);
  const skillCodes = new Set((technician.skills || []).map((skill) => String(skill.code).toLowerCase()));
  const missingSkills = requirements.requiredSkills.filter((code) => !skillCodes.has(String(code).toLowerCase()));
  const now = Date.now(); const expiringCutoff = now + 60 * 86400000; const matchingCertificates = [];
  const missingCertificates = requirements.requiredCertificates.filter((type) => {
    const match = (technician.certificates || []).find((certificate) => String(certificate.type).toLowerCase() === String(type).toLowerCase() && (!certificate.modelIds?.length || certificate.modelIds.includes(robot.modelId)) && Date.parse(certificate.validUntil) >= now);
    if (match) matchingCertificates.push(match);
    return !match;
  });
  const expiringCertificates = matchingCertificates.filter((certificate) => Date.parse(certificate.validUntil) <= expiringCutoff).map((certificate) => ({ id:certificate.id, type:certificate.type, validUntil:certificate.validUntil }));
  const status = missingSkills.length || missingCertificates.length ? 'not_qualified' : expiringCertificates.length ? 'expiring_soon' : 'qualified';
  return { status, eligible: status !== 'not_qualified', requirements, missingSkills, missingCertificates, expiringCertificates };
}

function workforceMatrix(actor, robotId = null) {
  if (actor.role === 'robot_user') throw httpError(403, 'Workforce qualification access is not available to robot accounts');
  let robots = [...state.robots.values()].filter((robot) => visibleToActor(actor, robot));
  if (robotId) robots = robots.filter((robot) => robot.id === robotId);
  const technicians = techniciansForActor(actor).filter((technician) => technician.status === 'active');
  const rows = [];
  for (const robot of robots) for (const technician of technicians) {
    const assignment = [...state.robotAssignments.values()].find((item) => item.robotId === robot.id && item.technicianId === technician.id && item.status === 'active') || null;
    rows.push({ robot: { id:robot.id, serialNumber:robot.serialNumber, modelId:robot.modelId }, technician: { id:technician.id, name:technician.name, email:technician.email, jobTitle:technician.jobTitle || 'Service Technician', organizationId:technician.organizationId }, eligibility: technicianEligibility(technician, robot), assignment: assignment ? clone(assignment) : null });
  }
  return { rows, robots: robots.map((robot) => ({ id:robot.id, serialNumber:robot.serialNumber, modelId:robot.modelId, requirements:workRequirementsForRobot(robot) })), technicians:clone(technicians), assignments:clone([...state.robotAssignments.values()].filter((item) => robots.some((robot) => robot.id === item.robotId))), permissions:{ manage:canManageWorkforce(actor) }, generatedAt:timestamp() };
}

function operationsSummary(actor) {
  const robots = [...state.robots.values()].filter((robot) => visibleToActor(actor, robot));
  const robotIds = new Set(robots.map((robot) => robot.id));
  const cases = [...state.serviceCases.values()].filter((item) => robotIds.has(item.robotId));
  const events = state.events.filter((event) => robotIds.has(event.robotId));
  const now = Date.now();
  const expiringCertificates = state.certificates.filter((item) => robotIds.has(item.robotId) && item.validUntil && Date.parse(item.validUntil) <= now + 30 * 86400000 && item.status !== 'revoked').length;
  const completePassports = robots.filter((robot) => calculateCompleteness(robot, state.passportEntries.get(robot.id) || []).percentage >= 80).length;
  return {
    robots: { total: robots.length, active: robots.filter((item) => item.status === 'active').length, draft: robots.filter((item) => item.status === 'draft').length, online: robots.filter((item) => item.online === true).length, offline: robots.filter((item) => item.online === false).length },
    events: { total: events.length, activeErrors: events.filter((item) => ['error', 'critical'].includes(item.severity)).length, maintenanceDue: events.filter((item) => item.eventType === 'maintenance_due').length },
    service: { total: cases.length, open: cases.filter((item) => !['resolved', 'closed'].includes(item.status)).length, closed: cases.filter((item) => item.status === 'closed').length },
    passport: { complete: completePassports, percentage: robots.length ? Math.round((completePassports / robots.length) * 100) : 0, certificatesDue: expiringCertificates },
    proof: { robotTargetMinimum: 30, customerTargetMinimum: 5, siteTargetMinimum: 10, passportTargetPercentage: 80, serviceCaseTargetMinimum: 20 },
    generatedAt: timestamp()
  };
}

function operationalNotifications(actor) {
  const robotIds = visibleRobotIds(actor);
  const robots = [...state.robots.values()].filter((robot) => robotIds.has(robot.id));
  const notifications = [];
  for (const robot of robots.filter((item) => item.online === false)) notifications.push({ id: `offline:${robot.id}`, type: 'robot_offline', severity: 'warning', title: `${robot.serialNumber} is offline`, message: 'The most recent synchronization reports this robot as offline.', robotId: robot.id, occurredAt: robot.updatedAt || startedAt });
  for (const event of state.events.filter((item) => robotIds.has(item.robotId) && ['error', 'critical'].includes(item.severity)).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, 10)) {
    const robot = state.robots.get(event.robotId);
    notifications.push({ id: `event:${event.eventId}`, type: 'technical_event', severity: event.severity, title: event.title || event.eventType, message: `${robot?.serialNumber || 'Robot'} · ${event.description || event.eventType}`, robotId: event.robotId, occurredAt: event.occurredAt });
  }
  const dueBefore = Date.now() + 30 * 86400000;
  for (const certificate of state.certificates.filter((item) => robotIds.has(item.robotId) && item.validUntil && Date.parse(item.validUntil) <= dueBefore && item.status !== 'revoked')) {
    const robot = state.robots.get(certificate.robotId);
    notifications.push({ id: `certificate:${certificate.id}`, type: 'certificate_due', severity: Date.parse(certificate.validUntil) < Date.now() ? 'critical' : 'warning', title: certificate.title, message: `${robot?.serialNumber || 'Robot'} · certificate ${Date.parse(certificate.validUntil) < Date.now() ? 'expired' : 'expires soon'}.`, robotId: certificate.robotId, occurredAt: certificate.validUntil });
  }
  for (const serviceCase of serviceCasesForActor(actor).filter((item) => !['resolved', 'closed'].includes(item.status)).slice(0, 10)) notifications.push({ id: `service:${serviceCase.id}`, type: 'service_case', severity: serviceCase.severity || 'warning', title: serviceCase.title, message: `Service case ${serviceCase.externalId} is ${serviceCase.status.replaceAll('_', ' ')}.`, robotId: serviceCase.robotId, occurredAt: serviceCase.updatedAt });
  for (const assignment of state.robotAssignments.values()) {
    if (assignment.status !== 'active' || !robotIds.has(assignment.robotId)) continue;
    const robot = state.robots.get(assignment.robotId); const technician = state.technicians.get(assignment.technicianId); if (!robot || !technician) continue;
    const eligibility = technicianEligibility(technician,robot);
    if (eligibility.status !== 'qualified') notifications.push({ id:`qualification:${assignment.id}`, type:'technician_qualification', severity:eligibility.status === 'not_qualified' ? 'error' : 'warning', title:`${technician.name} · ${eligibility.status.replaceAll('_',' ')}`, message:`Assignment to ${robot.serialNumber} requires qualification review.`, robotId:robot.id, occurredAt:technician.updatedAt || assignment.assignedAt });
  }
  if (!['robot_user', 'auditor'].includes(actor.role)) for (const adapter of state.adapters.values()) if (adapter.lastSyncStatus === 'error') notifications.push({ id: `adapter:${adapter.provider}`, type: 'integration_error', severity: 'error', title: `${adapter.provider} synchronization failed`, message: 'Retry synchronization or inspect the protected server log.', robotId: null, occurredAt: adapter.lastSyncAt || startedAt });
  const rank = { critical: 0, error: 1, warning: 2, info: 3 };
  notifications.sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4) || Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  return notifications.slice(0, 30);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''; let bytes = 0; let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) { tooLarge = true; reject(httpError(413, 'Request body is limited to 5 MB')); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(httpError(400, 'Request body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function httpError(status, message, details) {
  const error = new Error(message); error.status = status; error.details = details; return error;
}

function loginRateKey(req, email) {
  return `${req.socket.remoteAddress || 'unknown'}:${String(email || '').trim().toLowerCase()}`;
}

function activeLoginFailures(req, email) {
  const key = loginRateKey(req, email); const cutoff = Date.now() - LOGIN_WINDOW_MS;
  const attempts = (loginFailures.get(key) || []).filter((value) => value > cutoff);
  if (attempts.length) loginFailures.set(key, attempts); else loginFailures.delete(key);
  return { key, attempts };
}

function enforceLoginRateLimit(req, email) {
  const { attempts } = activeLoginFailures(req, email);
  if (attempts.length >= LOGIN_MAX_FAILURES) throw httpError(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
}

function recordLoginFailure(req, email) {
  const { key, attempts } = activeLoginFailures(req, email); attempts.push(Date.now()); loginFailures.set(key, attempts);
}

function clearLoginFailures(req, email) {
  loginFailures.delete(loginRateKey(req, email));
}

function validateEventAttachment(attachment) {
  if (!attachment) return null;
  if (!attachment.name || !attachment.contentType || !attachment.contentBase64) throw httpError(400, 'Attachment requires name, contentType, and contentBase64');
  const originalName = String(attachment.name).trim();
  const name = pathUtil.basename(originalName.replaceAll('\\', '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  const extension = pathUtil.extname(name).toLowerCase();
  const contentType = String(attachment.contentType).toLowerCase().split(';')[0].trim();
  if (!name || name !== originalName || !allowedAttachmentExtensions.has(extension)) throw httpError(400, 'Attachment filename or extension is not allowed');
  if (!allowedAttachmentTypes.has(contentType)) throw httpError(400, 'Attachment type is not allowed');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(String(attachment.contentBase64)) || String(attachment.contentBase64).length % 4 !== 0) throw httpError(400, 'Attachment content must be valid base64');
  const content = Buffer.from(attachment.contentBase64, 'base64');
  if (content.length > MAX_EVENT_ATTACHMENT_BYTES) throw httpError(413, 'Event attachment is limited to 2 MB');
  return { name, contentType, size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), contentBase64: attachment.contentBase64 };
}

function securityHeaders(contentType, extra = {}) {
  return { 'content-type': contentType, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'", 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-origin', ...extra };
}

function send(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, securityHeaders('application/json; charset=utf-8', { 'content-length': Buffer.byteLength(body), ...extraHeaders }));
  res.end(body);
}

function sessionCookie(token, maxAgeSeconds = Math.max(60, Number(process.env.AUTH_SESSION_TTL_SECONDS || 28800))) {
  const secure = ['1', 'true', 'yes'].includes(String(process.env.COOKIE_SECURE || '').toLowerCase()) ? '; Secure' : '';
  return `altegro_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function sendDownload(res, contentType, filename, body) {
  const content = Buffer.from(body);
  const safeFilename = pathUtil.basename(String(filename)).replace(/[^a-zA-Z0-9._-]/g, '_');
  res.writeHead(200, securityHeaders(contentType, { 'content-disposition': `attachment; filename="${safeFilename}"`, 'content-length': content.length }));
  res.end(content);
}

function systemReadiness() {
  const checks = [];
  const secretPolicy = managedSecretStatus();
  checks.push({ name:'secret-policy', ok:secretPolicy.valid, detail:secretPolicy.valid ? 'valid' : 'managed secret configuration required' });
  let storageOk = true;
  if (persistenceEnabled()) {
    try { fs.accessSync(pathUtil.dirname(DATA_FILE), fs.constants.R_OK | fs.constants.W_OK); }
    catch { storageOk = false; }
  }
  checks.push({ name:'persistence', ok:storageOk, detail:persistenceEnabled() ? (storageOk ? 'read-write' : 'unavailable') : 'disabled' });
  return { ready:checks.every((check) => check.ok), checks };
}

function monitoringSnapshot(actor = null) {
  const uptimeSeconds = Math.max(0,Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const robots=actor ? [...state.robots.values()].filter((robot) => visibleToActor(actor,robot)) : [...state.robots.values()]; const robotIds=new Set(robots.map((robot) => robot.id));
  const email=emailDeliverySummary();
  return { service:'altegro-prototype', uptimeSeconds, startedAt, readiness:systemReadiness(), requests:{ total:runtimeMetrics.requestsTotal, active:runtimeMetrics.activeRequests, errors:runtimeMetrics.errorsTotal, averageResponseTimeMs:runtimeMetrics.requestsTotal ? Math.round(runtimeMetrics.responseTimeMsTotal/runtimeMetrics.requestsTotal) : 0, maxResponseTimeMs:runtimeMetrics.responseTimeMsMax, byStatus:clone(runtimeMetrics.byStatus) }, fleet:{ robots:robots.length, events:state.events.filter((event) => robotIds.has(event.robotId)).length, openServiceCases:[...state.serviceCases.values()].filter((item) => robotIds.has(item.robotId) && !['resolved','closed'].includes(item.status)).length }, adapters:actor && ['robot_user','auditor'].includes(actor.role) ? [] : [...state.adapters.values()].map((adapter) => ({ provider:adapter.provider,status:adapter.status,lastSyncStatus:adapter.lastSyncStatus,lastSyncAt:adapter.lastSyncAt,lastSyncDurationMs:adapter.lastSyncDurationMs,lastSyncWarnings:adapter.lastSyncWarnings || 0 })),email:actor && ['platform_admin','data_admin','support_admin'].includes(actor.role) ? { configuration:email.configuration,counts:email.counts } : null };
}

function metricsAuthorized(req) {
  const expected = secretEnvValue('METRICS_TOKEN');
  if (!expected) return true;
  const supplied = String(req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  const left = Buffer.from(supplied); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left,right);
}

function sendPrometheusMetrics(res) {
  const snapshot = monitoringSnapshot();
  const lines = [
    '# HELP altegro_up Whether the Altegro process is ready.', '# TYPE altegro_up gauge', `altegro_up ${snapshot.readiness.ready ? 1 : 0}`,
    '# HELP altegro_uptime_seconds Process uptime.', '# TYPE altegro_uptime_seconds gauge', `altegro_uptime_seconds ${snapshot.uptimeSeconds}`,
    '# HELP altegro_http_requests_total Completed HTTP requests.', '# TYPE altegro_http_requests_total counter', `altegro_http_requests_total ${runtimeMetrics.requestsTotal}`,
    '# HELP altegro_http_errors_total HTTP 5xx responses.', '# TYPE altegro_http_errors_total counter', `altegro_http_errors_total ${runtimeMetrics.errorsTotal}`,
    '# HELP altegro_http_active_requests Active HTTP requests.', '# TYPE altegro_http_active_requests gauge', `altegro_http_active_requests ${runtimeMetrics.activeRequests}`,
    '# HELP altegro_robots_total Robots stored by Altegro.', '# TYPE altegro_robots_total gauge', `altegro_robots_total ${state.robots.size}`,
    '# HELP altegro_service_cases_open Open service cases.', '# TYPE altegro_service_cases_open gauge', `altegro_service_cases_open ${snapshot.fleet.openServiceCases}`
  ];
  for (const adapter of snapshot.adapters) lines.push(`altegro_adapter_last_sync_success{provider="${adapter.provider}"} ${adapter.lastSyncStatus === 'success' ? 1 : 0}`);
  const body = `${lines.join('\n')}\n`; res.writeHead(200,securityHeaders('text/plain; version=0.0.4; charset=utf-8',{'content-length':Buffer.byteLength(body)})); res.end(body);
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function serveFrontend(pathname, res) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const allowed = new Set(['index.html', 'app.js', 'styles.css']);
  if (!allowed.has(requested)) return false;
  const filePath = pathUtil.join(publicDir, requested);
  try {
    const body = fs.readFileSync(filePath);
    const contentTypes = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
    res.writeHead(200, securityHeaders(contentTypes[requested], { 'content-length': body.length }));
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function route(method, pathname, pattern) {
  const match = pathname.match(pattern);
  return match && match[1] ? { method, id: match[1] } : null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok', service: 'altegro-prototype', startedAt, now: timestamp() });
  if (req.method === 'GET' && path === '/ready') { const readiness=systemReadiness(); return send(res,readiness.ready ? 200 : 503,{ status:readiness.ready ? 'ready' : 'not_ready',...readiness,now:timestamp() }); }
  if (req.method === 'GET' && path === '/metrics') { if (!metricsAuthorized(req)) throw httpError(401,'A valid monitoring token is required'); return sendPrometheusMetrics(res); }
  if (req.method === 'GET' && path === '/api/v1/demo/tokens') {
    throw httpError(404, 'Static demo bearer tokens are disabled; sign in with username and password');
  }
  if (req.method === 'POST' && path === '/api/v1/auth/login') {
    const login = await readBody(req);
    const email = String(login.email || '').trim().toLowerCase();
    enforceLoginRateLimit(req, email);
    const match = Object.entries(demoUsers).find(([, user]) => user.email.toLowerCase() === email);
    if (!match || !verifyPassword(String(login.password || ''), match[1].passwordHash)) { recordLoginFailure(req, email); throw httpError(401, 'Invalid email or password'); }
    const [token, user] = match;
    clearLoginFailures(req, email);
    const session = authenticatedSession(token, user);
    return send(res, 200, session, { 'set-cookie': sessionCookie(session.token) });
  }
  if (req.method === 'POST' && path === '/api/v1/auth/logout') {
    const header = req.headers.authorization || ''; const cookieToken = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('altegro_session='))?.slice('altegro_session='.length); const token = header.startsWith('Bearer ') ? header.slice(7) : cookieToken ? decodeURIComponent(cookieToken) : null;
    if (token) authenticatedSessions.delete(crypto.createHash('sha256').update(token).digest('hex'));
    schedulePersist();
    return send(res, 200, { loggedOut: true }, { 'set-cookie': sessionCookie('', 0) });
  }
  if (req.method === 'GET' && path === '/api/v1/auth/session') {
    const actor = requireActor(req);
    return send(res, 200, { user: publicUser(actor) });
  }
  if (req.method === 'GET' && serveFrontend(path, res)) return;

  const actor = requireActor(req);
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

  if (req.method === 'GET' && path === '/api/v1/operations/summary') return send(res, 200, { data: operationsSummary(actor) });
  if (req.method === 'GET' && path === '/api/v1/notifications') { const data = operationalNotifications(actor); return send(res, 200, { data, count: data.length, generatedAt: timestamp() }); }
  if (req.method === 'GET' && path === '/api/v1/workforce/matrix') { const data = workforceMatrix(actor, url.searchParams.get('robotId')); return send(res, 200, { data }); }
  if (req.method === 'GET' && path === '/api/v1/technicians') {
    if (actor.role === 'robot_user') throw httpError(403, 'Technician access is not available to robot accounts');
    const data = techniciansForActor(actor); return send(res, 200, { data, count:data.length });
  }
  if (req.method === 'POST' && path === '/api/v1/technicians') {
    if (!canManageWorkforce(actor)) throw httpError(403, 'Workforce administration permission required');
    for (const field of ['name','email']) if (!body[field]) throw httpError(400, `Missing required field: ${field}`);
    const email = String(body.email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, 'Technician email must be valid');
    if ([...state.technicians.values()].some((item) => item.tenantId === actor.tenantId && item.email.toLowerCase() === email)) throw httpError(409, 'A technician with that email already exists');
    const technician = { id:ids(), tenantId:actor.tenantId, organizationId:body.organizationId || 'org-service', name:String(body.name).trim().slice(0,160), email, jobTitle:String(body.jobTitle || 'Service Technician').slice(0,120), status:'active', skills:[], certificates:[], createdAt:timestamp(), updatedAt:timestamp() };
    state.technicians.set(technician.id, technician); appendOutbox('technician.created','technician',technician.id,{ name:technician.name }); recordAudit(actor,'technician.create','technician',technician.id); return send(res,201,{ data:technician });
  }
  const technicianQualification = route(req.method, path, /^\/api\/v1\/technicians\/([^/]+)\/qualifications$/);
  if (technicianQualification && req.method === 'POST') {
    if (!canManageWorkforce(actor)) throw httpError(403, 'Workforce administration permission required');
    const technician = state.technicians.get(technicianQualification.id); if (!technician || technician.tenantId !== actor.tenantId) throw httpError(404, 'Technician not found');
    const code = String(body.code || '').trim().toLowerCase(); if (!code || !/^[a-z0-9][a-z0-9._-]{1,119}$/.test(code)) throw httpError(400, 'Qualification code must contain letters, numbers, dots, underscores, or hyphens');
    let qualification;
    if (body.kind === 'skill') {
      qualification = { code, level:String(body.level || 'qualified').slice(0,80), verifiedAt:timestamp() };
      technician.skills = (technician.skills || []).filter((item) => item.code !== code); technician.skills.push(qualification);
    } else if (body.kind === 'certificate') {
      if (!body.issuer || !body.validUntil || Number.isNaN(Date.parse(body.validUntil))) throw httpError(400, 'Certificate issuer and a valid expiry date are required');
      const modelIds = Array.isArray(body.modelIds) ? body.modelIds.filter((modelId) => state.models.has(modelId)) : [];
      qualification = { id:ids(), type:code, issuer:String(body.issuer).slice(0,160), validUntil:new Date(body.validUntil).toISOString(), modelIds };
      technician.certificates = (technician.certificates || []).filter((item) => !(item.type === code && JSON.stringify(item.modelIds || []) === JSON.stringify(modelIds))); technician.certificates.push(qualification);
    } else throw httpError(400, 'Qualification kind must be skill or certificate');
    technician.updatedAt = timestamp(); appendOutbox('technician.qualification.updated','technician',technician.id,{ kind:body.kind, code }); recordAudit(actor,'technician.qualification.add','technician',technician.id,'success',{ kind:body.kind, code }); return send(res,201,{ data:qualification, technician });
  }
  if (req.method === 'POST' && path === '/api/v1/robot-assignments') {
    if (!canManageWorkforce(actor)) throw httpError(403, 'Workforce administration permission required');
    const robot = state.robots.get(body.robotId); if (!robot || !visibleToActor(actor,robot)) throw httpError(404,'Robot not found');
    const technician = state.technicians.get(body.technicianId); if (!technician || technician.tenantId !== actor.tenantId || technician.status !== 'active') throw httpError(404,'Technician not found');
    const eligibility = technicianEligibility(technician,robot); if (!eligibility.eligible) throw httpError(409,'Technician is missing required qualifications',{ missingSkills:eligibility.missingSkills, missingCertificates:eligibility.missingCertificates });
    const existing = [...state.robotAssignments.values()].find((item) => item.robotId === robot.id && item.technicianId === technician.id && item.status === 'active'); if (existing) return send(res,200,{ data:existing, eligibility, idempotent:true });
    const assignment = { id:ids(), tenantId:actor.tenantId, robotId:robot.id, technicianId:technician.id, status:'active', notes:String(body.notes || '').slice(0,1000), assignedBy:actor.id, assignedAt:timestamp(), endedAt:null };
    state.robotAssignments.set(assignment.id,assignment); appendPassportEntry(robot.id,{ type:'technician_assigned',source:'altegro',data:{ assignmentId:assignment.id,technicianId:technician.id,technicianName:technician.name,eligibilityStatus:eligibility.status } },actor); appendOutbox('robot.technician.assigned','robot',robot.id,{ assignmentId:assignment.id,technicianId:technician.id }); recordAudit(actor,'technician.assign','robot',robot.id,'success',{ assignmentId:assignment.id,technicianId:technician.id }); return send(res,201,{ data:assignment, eligibility });
  }
  const robotAssignment = route(req.method,path,/^\/api\/v1\/robot-assignments\/([^/]+)$/);
  if (robotAssignment && req.method === 'DELETE') {
    if (!canManageWorkforce(actor)) throw httpError(403,'Workforce administration permission required');
    const assignment = state.robotAssignments.get(robotAssignment.id); if (!assignment || assignment.tenantId !== actor.tenantId) throw httpError(404,'Assignment not found');
    const robot = state.robots.get(assignment.robotId); if (!robot || !visibleToActor(actor,robot)) throw httpError(404,'Assignment not found');
    assignment.status='ended'; assignment.endedAt=timestamp(); appendPassportEntry(robot.id,{ type:'technician_unassigned',source:'altegro',data:{ assignmentId:assignment.id,technicianId:assignment.technicianId,endedAt:assignment.endedAt } },actor); appendOutbox('robot.technician.unassigned','robot',robot.id,{ assignmentId:assignment.id,technicianId:assignment.technicianId }); recordAudit(actor,'technician.unassign','robot',robot.id,'success',{ assignmentId:assignment.id,technicianId:assignment.technicianId }); return send(res,200,{ data:assignment });
  }
  if (req.method === 'GET' && path === '/api/v1/compatibility') return send(res, 200, { data: state.compatibilityRecords.filter((item) => item.tenantId === actor.tenantId), count: state.compatibilityRecords.filter((item) => item.tenantId === actor.tenantId).length });
  if (req.method === 'POST' && path === '/api/v1/compatibility') {
    if (!['platform_admin', 'data_admin'].includes(actor.role)) throw httpError(403, 'Compatibility administration permission required');
    for (const field of ['modelId', 'capability', 'versionConstraint', 'status']) if (!body[field]) throw httpError(400, `Missing required field: ${field}`);
    if (!state.models.has(body.modelId)) throw httpError(400, 'Unknown robot model');
    if (!['compatible', 'testing_required', 'incompatible', 'deprecated', 'blocked'].includes(body.status)) throw httpError(400, 'Invalid compatibility status');
    const record = { id: ids(), tenantId: actor.tenantId, modelId: body.modelId, capability: body.capability, versionConstraint: body.versionConstraint, status: body.status, evidence: body.evidence || '', verifiedAt: body.status === 'compatible' ? timestamp() : null, verifiedBy: body.status === 'compatible' ? actor.name : null };
    state.compatibilityRecords.push(record); appendOutbox('compatibility.record.created', 'compatibility_record', record.id, record); recordAudit(actor, 'compatibility.create', 'compatibility_record', record.id);
    return send(res, 201, { data: record });
  }
  if (req.method === 'GET' && path === '/api/v1/service-cases') return send(res, 200, { data: serviceCasesForActor(actor), count: serviceCasesForActor(actor).length });
  if (req.method === 'GET' && path === '/api/v1/outbox') {
    if (!['platform_admin', 'data_admin'].includes(actor.role)) throw httpError(403, 'Outbox administration permission required');
    return send(res, 200, { data: state.outbox, count: state.outbox.length, warning: 'Locally durable prototype Outbox; PostgreSQL transactionality and a publisher worker are still required.' });
  }
  if (req.method === 'GET' && path === '/api/v1/exports/robots.csv') {
    if (!canExport(actor)) throw httpError(403, 'Export permission required');
    const rows = [...state.robots.values()].filter((robot) => visibleToActor(actor, robot));
    const csv = [['robot_id', 'serial_number', 'model_id', 'status', 'tenant_id', 'organization_id', 'site_id', 'provider', 'external_id'], ...rows.map((robot) => [robot.id, robot.serialNumber, robot.modelId, robot.status, robot.tenantId, robot.organizationId, robot.siteId, robot.externalIdentities?.[0]?.system, robot.externalIdentities?.[0]?.externalId])].map((row) => row.map(csvCell).join(',')).join('\n');
    recordAudit(actor, 'export.robots.csv', 'tenant', actor.tenantId, 'success', { count: rows.length });
    return sendDownload(res, 'text/csv; charset=utf-8', `altegro-robots-${actor.tenantId}.csv`, csv);
  }
  if (req.method === 'GET' && path === '/api/v1/exports/tenant.json') {
    if (!canExport(actor)) throw httpError(403, 'Export permission required');
    const robotIds = visibleRobotIds(actor); const robots = [...robotIds].map((id) => getPassport(id));
    const exported = { schemaVersion: '1.0.0', tenantId: actor.tenantId, exportedAt: timestamp(), robots, events: state.events.filter((item) => robotIds.has(item.robotId)), serviceCases: serviceCasesForActor(actor), compatibility: state.compatibilityRecords.filter((item) => item.tenantId === actor.tenantId), documentManifest: state.documents.filter((item) => robotIds.has(item.robotId)).map(({ attachment, ...item }) => ({ ...item, attachment: attachment ? { name: attachment.name, contentType: attachment.contentType, size: attachment.size, sha256: attachment.sha256 } : null })) };
    recordAudit(actor, 'export.tenant.json', 'tenant', actor.tenantId, 'success', { robots: robots.length });
    return sendDownload(res, 'application/json; charset=utf-8', `altegro-tenant-${actor.tenantId}.json`, JSON.stringify(exported, null, 2));
  }

  if (req.method === 'GET' && path === '/api/v1/tenants') return send(res, 200, { data: [...state.tenants.values()].filter((tenant) => tenant.id === actor.tenantId) });
  if (req.method === 'GET' && path === '/api/v1/robot-accounts') {
    if (actor.role !== 'platform_admin') throw httpError(403, 'Platform administrator permission required');
    const accounts = ensureAllRobotUsers().map(({ token, email, serialNumber, robotId, created }) => ({ token, email, serialNumber, robotId, created, credentialStatus: 'password-set' }));
    return send(res, 200, { warning: 'Passwords are hashed and cannot be retrieved. Reset a password if access is lost.', data: accounts, count: accounts.length });
  }
  if (req.method === 'GET' && path === '/api/v1/adapters') return send(res, 200, { data: ['robot_user', 'auditor'].includes(actor.role) ? [] : [...state.adapters.values()].map(({ sync, lastError, ...adapter }) => ({ ...adapter, lastError: lastError ? 'Synchronization failed. Retry the operation or check the protected server log.' : null })) });
  if (req.method === 'GET' && path === '/api/v1/monitoring') return send(res,200,{ data:monitoringSnapshot(actor) });
  if (req.method === 'GET' && path === '/api/v1/email-notifications') {
    if (!['platform_admin','data_admin','support_admin'].includes(actor.role)) throw httpError(403,'Email notification administration permission required');
    return send(res,200,{ data:emailDeliverySummary() });
  }
  if (req.method === 'POST' && path === '/api/v1/email-notifications/test') {
    if (!['platform_admin','support_admin'].includes(actor.role)) throw httpError(403,'Email notification test permission required');
    const config=emailAlertConfiguration(); if (!config.enabled || !config.configured) throw httpError(400,config.configurationError || 'Email alerts are disabled');
    const delivery=createEmailDelivery({ notificationKey:`test:${ids()}`,type:'test',severity:'info',title:'Altegro email notification test',message:`Test requested by ${actor.name}. Email alerts are configured correctly when this message arrives.`,occurredAt:timestamp() });
    try { await deliverEmailNotification(delivery); } catch(error) { throw httpError(503,`Test email delivery failed: ${error.message}`); }
    recordAudit(actor,'email_notification.test','tenant',actor.tenantId,'success',{ deliveryId:delivery.id,recipientCount:delivery.recipients.length }); return send(res,200,{ data:{ id:delivery.id,status:delivery.status,sentAt:delivery.sentAt,recipientCount:delivery.recipients.length } });
  }
  const emailRetry=route(req.method,path,/^\/api\/v1\/email-notifications\/([^/]+)\/retry$/);
  if (emailRetry && req.method === 'POST') {
    if (!['platform_admin','support_admin'].includes(actor.role)) throw httpError(403,'Email notification retry permission required');
    const delivery=state.emailDeliveries.find((item) => item.id === emailRetry.id); if (!delivery) throw httpError(404,'Email delivery not found'); delivery.nextAttemptAt=null;
    try { await deliverEmailNotification(delivery); } catch(error) { throw httpError(503,`Email retry failed: ${error.message}`); }
    recordAudit(actor,'email_notification.retry','email_delivery',delivery.id); return send(res,200,{ data:{ id:delivery.id,status:delivery.status,sentAt:delivery.sentAt } });
  }
  if (req.method === 'GET' && path === '/api/v1/autoxing/operations') return send(res, 200, { data:autoXingOperations(actor) });
  if (req.method === 'GET' && path === '/api/v1/autoxing/maintenance-schedules') {
    const robotIds=visibleRobotIds(actor); const schedules=[...state.maintenanceSchedules.values()].filter((schedule) => robotIds.has(schedule.robotId)).map(maintenanceScheduleView).sort((a,b) => Date.parse(a.nextDueAt)-Date.parse(b.nextDueAt)); return send(res,200,{ data:schedules,count:schedules.length,permissions:{ manage:canWrite(actor) } });
  }
  if (req.method === 'POST' && path === '/api/v1/autoxing/maintenance-schedules') {
    if (!canWrite(actor)) throw httpError(403,'Maintenance scheduling permission required'); for (const field of ['robotId','title','nextDueAt','intervalDays']) if (!body[field]) throw httpError(400,`Missing required field: ${field}`);
    const robot=state.robots.get(body.robotId); if (!robot || !visibleToActor(actor,robot) || !robot.externalIdentities?.some((identity) => identity.system === 'autoxing')) throw httpError(404,'AutoXing robot not found'); const nextDueAt=new Date(body.nextDueAt); if (Number.isNaN(nextDueAt.getTime())) throw httpError(400,'nextDueAt must be a valid date'); const intervalDays=Number(body.intervalDays); if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 730) throw httpError(400,'intervalDays must be between 1 and 730');
    let technician=null; if (body.assignedTechnicianId) { technician=state.technicians.get(body.assignedTechnicianId); if (!technician || technician.tenantId !== actor.tenantId || !technicianEligibility(technician,robot).eligible) throw httpError(409,'Assigned technician must be qualified for this robot'); }
    const schedule={ id:ids(),tenantId:robot.tenantId,robotId:robot.id,title:String(body.title).trim().slice(0,160),description:String(body.description || '').trim().slice(0,2000),intervalDays,nextDueAt:nextDueAt.toISOString(),priority:['low','normal','high','critical'].includes(body.priority) ? body.priority : 'normal',assignedTechnicianId:technician?.id || null,status:'active',lastCompletedAt:null,createdAt:timestamp(),updatedAt:timestamp(),createdBy:actor.id };
    state.maintenanceSchedules.set(schedule.id,schedule); appendPassportEntry(robot.id,{ type:'maintenance_scheduled',source:'altegro',data:{ scheduleId:schedule.id,title:schedule.title,nextDueAt:schedule.nextDueAt,intervalDays,assignedTechnicianId:schedule.assignedTechnicianId } },actor); appendOutbox('maintenance.schedule.created','maintenance_schedule',schedule.id,schedule); recordAudit(actor,'maintenance.schedule.create','robot',robot.id,'success',{ scheduleId:schedule.id }); return send(res,201,{ data:maintenanceScheduleView(schedule) });
  }
  const maintenanceScheduleUpdate=route(req.method,path,/^\/api\/v1\/autoxing\/maintenance-schedules\/([^/]+)$/);
  if (maintenanceScheduleUpdate && req.method === 'PATCH') {
    if (!canWrite(actor)) throw httpError(403,'Maintenance scheduling permission required'); const schedule=state.maintenanceSchedules.get(maintenanceScheduleUpdate.id); const robot=schedule ? state.robots.get(schedule.robotId) : null; if (!schedule || !robot || !visibleToActor(actor,robot)) throw httpError(404,'Maintenance schedule not found');
    if (body.status && !['active','paused','cancelled'].includes(body.status)) throw httpError(400,'Invalid maintenance schedule status'); if (body.status) schedule.status=body.status; if (body.nextDueAt) { const next=new Date(body.nextDueAt); if (Number.isNaN(next.getTime())) throw httpError(400,'nextDueAt must be a valid date'); schedule.nextDueAt=next.toISOString(); }
    if (body.complete) { const completedAt=timestamp(); schedule.lastCompletedAt=completedAt; schedule.nextDueAt=new Date(Date.now()+schedule.intervalDays*86400000).toISOString(); schedule.status='active'; upsertEvent(robot.id,{ eventType:'maintenance_completed',sourceSystem:'altegro',sourceEventId:`maintenance:${schedule.id}:${completedAt}`,severity:'info',title:`Maintenance completed: ${schedule.title}`,description:String(body.completionNote || 'Scheduled maintenance completed.').slice(0,2000),occurredAt:completedAt,payload:{ scheduleId:schedule.id,nextDueAt:schedule.nextDueAt,technicianId:schedule.assignedTechnicianId } },actor); appendPassportEntry(robot.id,{ type:'maintenance_completion',source:'altegro',data:{ scheduleId:schedule.id,title:schedule.title,completedAt,nextDueAt:schedule.nextDueAt,note:String(body.completionNote || '').slice(0,2000) } },actor); const workflow=state.alertWorkflows.get(`maintenance:${schedule.id}`); if (workflow) state.alertWorkflows.set(`maintenance:${schedule.id}`,{ ...workflow,status:'resolved',updatedAt:timestamp(),updatedBy:actor.name }); }
    schedule.updatedAt=timestamp(); appendOutbox('maintenance.schedule.updated','maintenance_schedule',schedule.id,{ status:schedule.status,nextDueAt:schedule.nextDueAt,complete:Boolean(body.complete) }); recordAudit(actor,'maintenance.schedule.update','robot',robot.id,'success',{ scheduleId:schedule.id,complete:Boolean(body.complete) }); return send(res,200,{ data:maintenanceScheduleView(schedule) });
  }
  if (req.method === 'GET' && path === '/api/v1/autoxing/escalation-rules') {
    if (actor.role === 'robot_user') throw httpError(403,'Escalation rule access is not available to robot accounts'); const rules=[...state.alertEscalationRules.values()].filter((rule) => rule.tenantId === actor.tenantId).map(escalationRuleView); return send(res,200,{ data:rules,count:rules.length,executions:clone([...state.alertEscalations.values()].filter((item) => item.tenantId === actor.tenantId).slice(-30)),permissions:{ manage:['platform_admin','data_admin','support_admin'].includes(actor.role) } });
  }
  if (req.method === 'POST' && path === '/api/v1/autoxing/escalation-rules') {
    if (!['platform_admin','data_admin','support_admin'].includes(actor.role)) throw httpError(403,'Escalation rule administration permission required'); for (const field of ['name','minimumSeverity','alertType','action']) if (!body[field]) throw httpError(400,`Missing required field: ${field}`); if (!['info','warning','error','critical'].includes(body.minimumSeverity)) throw httpError(400,'Invalid minimumSeverity'); if (!['any','offline','low-battery','emergency-stop','obstruction','provider-state','provider-errors','maintenance_due','integration_warning'].includes(body.alertType)) throw httpError(400,'Invalid alertType'); if (!['email','service_case','email_and_service_case'].includes(body.action)) throw httpError(400,'Invalid escalation action'); const afterMinutes=Number(body.afterMinutes ?? 0); if (!Number.isInteger(afterMinutes) || afterMinutes < 0 || afterMinutes > 43200) throw httpError(400,'afterMinutes must be between 0 and 43200');
    if (body.technicianId) { const technician=state.technicians.get(body.technicianId); if (!technician || technician.tenantId !== actor.tenantId || technician.status !== 'active') throw httpError(400,'Active technician not found'); }
    const rule={ id:ids(),tenantId:actor.tenantId,name:String(body.name).trim().slice(0,160),minimumSeverity:body.minimumSeverity,alertType:body.alertType,afterMinutes,action:body.action,technicianId:body.technicianId || null,active:body.active !== false,createdAt:timestamp(),updatedAt:timestamp(),createdBy:actor.id }; state.alertEscalationRules.set(rule.id,rule); appendOutbox('autoxing.escalation_rule.created','escalation_rule',rule.id,rule); recordAudit(actor,'autoxing.escalation_rule.create','tenant',actor.tenantId,'success',{ ruleId:rule.id }); return send(res,201,{ data:escalationRuleView(rule) });
  }
  const escalationRuleUpdate=route(req.method,path,/^\/api\/v1\/autoxing\/escalation-rules\/([^/]+)$/);
  if (escalationRuleUpdate && req.method === 'PATCH') {
    if (!['platform_admin','data_admin','support_admin'].includes(actor.role)) throw httpError(403,'Escalation rule administration permission required'); const rule=state.alertEscalationRules.get(escalationRuleUpdate.id); if (!rule || rule.tenantId !== actor.tenantId) throw httpError(404,'Escalation rule not found'); if (body.active !== undefined) rule.active=Boolean(body.active); if (body.afterMinutes !== undefined) { const value=Number(body.afterMinutes); if (!Number.isInteger(value) || value < 0 || value > 43200) throw httpError(400,'afterMinutes must be between 0 and 43200'); rule.afterMinutes=value; } rule.updatedAt=timestamp(); appendOutbox('autoxing.escalation_rule.updated','escalation_rule',rule.id,{ active:rule.active,afterMinutes:rule.afterMinutes }); recordAudit(actor,'autoxing.escalation_rule.update','tenant',actor.tenantId,'success',{ ruleId:rule.id }); return send(res,200,{ data:escalationRuleView(rule) });
  }
  if (req.method === 'POST' && path === '/api/v1/autoxing/escalations/evaluate') {
    if (!['platform_admin','support_admin'].includes(actor.role)) throw httpError(403,'Escalation evaluation permission required'); return send(res,200,{ data:evaluateAlertEscalations(actor.tenantId) });
  }
  const diagnosticReport=route(req.method,path,/^\/api\/v1\/autoxing\/diagnostic-reports\/([^/]+)$/);
  if (diagnosticReport && req.method === 'GET') {
    if (!canExport(actor) && !canWrite(actor) && actor.role !== 'robot_user') throw httpError(403,'Diagnostic report permission required'); const robot=state.robots.get(diagnosticReport.id); if (!robot || !visibleToActor(actor,robot) || !robot.externalIdentities?.some((identity) => identity.system === 'autoxing')) throw httpError(404,'AutoXing robot not found'); const report=autoXingDiagnosticReport(actor,robot); recordAudit(actor,'autoxing.diagnostic_report.download','robot',robot.id,'success',{ alertCount:report.diagnostics.alerts.length,taskCount:report.diagnostics.taskSummary.total }); schedulePersist(); return sendDownload(res,'application/json; charset=utf-8',`autoxing-diagnostic-${robot.serialNumber}-${timestamp().slice(0,10)}.json`,JSON.stringify(report,null,2));
  }
  if (req.method === 'GET' && path === '/api/v1/adapters/autoxing/resources') {
    if (actor.role === 'robot_user') return send(res, 200, { data: { businesses: [], buildings: [], maps: [], syncedAt: state.autoxing.lastSyncAt, resourceErrors: [] } });
    return send(res, 200, { data: { businesses: clone(state.autoxing.businesses), buildings: clone(state.autoxing.buildings), maps: clone([...state.autoxing.maps.values()]), syncedAt: state.autoxing.lastSyncAt, resourceErrors: clone(state.autoxing.resourceErrors) } });
  }
  if (req.method === 'GET' && path === '/api/v1/autoxing/tasks') {
    const visibleExternalIds = new Set([...state.robots.values()].filter((robot) => visibleToActor(actor, robot)).map((robot) => robot.externalIdentities?.find((identity) => identity.system === 'autoxing')?.externalId).filter(Boolean).map(String));
    let tasks = [...state.autoxing.tasks.values()].filter((task) => visibleExternalIds.has(String(taskRobotExternalId(task))));
    const robotId = url.searchParams.get('robotId');
    if (robotId) {
      const item = state.robots.get(robotId);
      if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
      const externalId = item.externalIdentities?.find((identity) => identity.system === 'autoxing')?.externalId;
      tasks = tasks.filter((task) => String(taskRobotExternalId(task)) === String(externalId));
    }
    return send(res, 200, { data: clone(tasks), count: tasks.length, syncedAt: state.autoxing.lastSyncAt });
  }
  const autoXingTaskDetail = route(req.method,path,/^\/api\/v1\/autoxing\/tasks\/([^/]+)$/);
  if (autoXingTaskDetail && req.method === 'GET') {
    const taskId = decodeURIComponent(autoXingTaskDetail.id); const task = state.autoxing.tasks.get(taskId);
    const detail = task ? autoXingTaskView(actor,task) : null;
    if (!detail) throw httpError(404,'AutoXing task not found');
    return send(res,200,{ data:detail });
  }
  const autoXingAlertUpdate = route(req.method,path,/^\/api\/v1\/autoxing\/alerts\/([^/]+)$/);
  if (autoXingAlertUpdate && req.method === 'PATCH') {
    if (!canWrite(actor)) throw httpError(403,'Alert workflow permission required');
    const alertId = decodeURIComponent(autoXingAlertUpdate.id); const alert = findVisibleAutoXingAlert(actor,alertId);
    if (!alert) throw httpError(404,'AutoXing alert not found');
    const allowedStatuses = ['open','acknowledged','in_progress','resolved'];
    if (body.status && !allowedStatuses.includes(body.status)) throw httpError(400,'Invalid alert workflow status');
    let technician = null;
    if (body.technicianId) {
      technician = state.technicians.get(body.technicianId);
      if (!technician || technician.tenantId !== actor.tenantId || technician.status !== 'active') throw httpError(400,'Active technician not found');
      if (alert.robotId) { const robot=state.robots.get(alert.robotId); const eligibility=technicianEligibility(technician,robot); if (!eligibility.eligible) throw httpError(409,`Technician is not qualified: ${eligibility.reasons.join('; ')}`,eligibility); }
    }
    const existing = state.alertWorkflows.get(alertId) || {};
    const workflow = { alertId, status:body.status || existing.status || 'acknowledged', technicianId:technician?.id || existing.technicianId || null, technicianName:technician?.name || existing.technicianName || null, note:body.note !== undefined ? String(body.note).trim().slice(0,2000) : existing.note || '', serviceCaseId:existing.serviceCaseId || null, updatedAt:timestamp(), updatedBy:actor.name };
    if (body.createServiceCase) {
      if (!alert.robotId) throw httpError(400,'A fleet-level synchronization warning cannot create a robot service case');
      const digest=crypto.createHash('sha256').update(alertId).digest('hex').slice(0,12).toUpperCase(); const externalId=`AX-ALERT-${digest}`; const key=`altegro:${externalId}`;
      let serviceCase=state.serviceCases.get(key);
      if (!serviceCase) { const robot=state.robots.get(alert.robotId); serviceCase={ id:ids(),robotId:robot.id,tenantId:robot.tenantId,provider:'altegro',externalId,title:alert.title,description:`${alert.message}\nRecommended action: ${alert.recommendedAction}`,severity:alert.severity,status:'open',cause:null,action:workflow.note || null,parts:[],assignedTo:workflow.technicianName,createdAt:timestamp(),updatedAt:timestamp(),closedAt:null }; state.serviceCases.set(key,serviceCase); appendPassportEntry(robot.id,{ type:'incident_opened',source:'autoxing',data:{ serviceCaseId:serviceCase.id,externalId,alertId,title:alert.title,severity:alert.severity } },actor); appendOutbox('service_case.opened','service_case',serviceCase.id,serviceCase); }
      workflow.serviceCaseId=serviceCase.id; workflow.status='in_progress';
    }
    state.alertWorkflows.set(alertId,workflow); recordAudit(actor,'autoxing.alert.update','robot',alert.robotId || 'autoxing-fleet','success',{ alertId,status:workflow.status,technicianId:workflow.technicianId,serviceCaseId:workflow.serviceCaseId }); appendOutbox('autoxing.alert.updated','autoxing_alert',alertId,workflow);
    return send(res,200,{ data:{ ...alert,workflow } });
  }
  const eventAttachment = route(req.method, path, /^\/api\/v1\/events\/([^/]+)\/attachment$/);
  if (eventAttachment && req.method === 'GET') {
    const event = state.events.find((item) => item.eventId === eventAttachment.id);
    const robot = event ? state.robots.get(event.robotId) : null;
    if (!event || !robot || !visibleToActor(actor, robot)) throw httpError(404, 'Event attachment not found');
    if (!event.attachment?.contentBase64) throw httpError(404, 'Event has no downloadable attachment');
    recordAudit(actor, 'event.attachment.download', 'robot', robot.id, 'success', { eventId: event.eventId });
    return sendDownload(res, event.attachment.contentType, event.attachment.name, Buffer.from(event.attachment.contentBase64, 'base64'));
  }
  if (req.method === 'GET' && path === '/api/v1/events') {
    const robotIds = visibleRobotIds(actor); let data = state.events.filter((event) => robotIds.has(event.robotId));
    const filters = { robotId: url.searchParams.get('robotId'), eventType: url.searchParams.get('eventType') };
    for (const [field, value] of Object.entries(filters)) if (value) data = data.filter((event) => event[field] === value);
    const severity = url.searchParams.get('severity'); if (severity) data = data.filter((event) => severity === 'problem' ? ['error', 'critical'].includes(event.severity) : event.severity === severity);
    const from = url.searchParams.get('from'); const to = url.searchParams.get('to'); const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (from && !Number.isNaN(Date.parse(from))) data = data.filter((event) => Date.parse(event.occurredAt) >= Date.parse(from));
    if (to && !Number.isNaN(Date.parse(to))) data = data.filter((event) => Date.parse(event.occurredAt) <= Date.parse(to));
    if (q) data = data.filter((event) => [event.title, event.description, event.eventType, event.sourceSystem].some((value) => String(value || '').toLowerCase().includes(q)));
    data.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    const count = data.length; const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 25)));
    return send(res, 200, { data: data.slice(0, limit).map((event) => ({ ...clone(event), attachment: event.attachment ? { name: event.attachment.name, contentType: event.attachment.contentType, size: event.attachment.size, sha256: event.attachment.sha256 } : null })), count });
  }
  if (req.method === 'GET' && path === '/api/v1/audit') {
    const robotIds = visibleRobotIds(actor);
    const privileged = ['platform_admin', 'data_admin', 'support_admin'].includes(actor.role);
    return send(res, 200, { data: state.audit.filter((item) => item.actorId === actor.id || privileged || (actor.role === 'auditor' && robotIds.has(item.objectId))) });
  }
  if (req.method === 'GET' && path === '/api/v1/robots') {
    const allVisible = [...state.robots.values()].filter((robot) => visibleToActor(actor, robot)); let data = [...allVisible];
    for (const field of ['status', 'modelId', 'siteId']) if (url.searchParams.get(field)) data = data.filter((robot) => robot[field] === url.searchParams.get(field));
    if (url.searchParams.get('serialNumber')) { const serial = url.searchParams.get('serialNumber').trim().toLowerCase(); data = data.filter((robot) => robot.serialNumber.toLowerCase() === serial); }
    const live = url.searchParams.get('live');
    if (live === 'online') data = data.filter((robot) => robot.online === true);
    if (live === 'offline') data = data.filter((robot) => robot.online === false);
    if (live === 'unknown') data = data.filter((robot) => robot.online == null);
    if (url.searchParams.get('q')) {
      const q = url.searchParams.get('q').trim().toLowerCase();
      data = data.filter((robot) => [robot.id, robot.serialNumber, robot.modelId, robot.siteId, robot.organizationId, robot.operatorOrganizationId, ...(robot.externalIdentities || []).flatMap((identity) => [identity.system, identity.externalId])].some((value) => String(value || '').toLowerCase().includes(q)));
    }
    const sort = ['serialNumber', 'modelId', 'siteId', 'status', 'updatedAt'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'serialNumber';
    const direction = url.searchParams.get('order') === 'desc' ? -1 : 1;
    data.sort((a, b) => String(a[sort] || '').localeCompare(String(b[sort] || ''), undefined, { numeric: true, sensitivity: 'base' }) * direction);
    const count = data.length; const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 10))); const pageCount = Math.max(1, Math.ceil(count / pageSize)); const requestedPage = Math.max(1, Number(url.searchParams.get('page') || 1)); const page = Math.min(requestedPage, pageCount);
    const facets = { total: allVisible.length, active: allVisible.filter((robot) => robot.status === 'active').length, draft: allVisible.filter((robot) => robot.status === 'draft').length, online: allVisible.filter((robot) => robot.online === true).length, offline: allVisible.filter((robot) => robot.online === false).length };
    return send(res, 200, { data: data.slice((page - 1) * pageSize, page * pageSize).map(clone), count, facets, pagination: { page, pageSize, pageCount, from: count ? (page - 1) * pageSize + 1 : 0, to: Math.min(page * pageSize, count) } });
  }

  if (req.method === 'POST' && path === '/api/v1/incidents') {
    if (!canWrite(actor)) throw httpError(403, 'Incident creation permission required');
    for (const field of ['robotId', 'title', 'description', 'severity']) if (!body[field]) throw httpError(400, `Missing required field: ${field}`);
    const robot = state.robots.get(body.robotId); if (!robot || !visibleToActor(actor, robot)) throw httpError(404, 'Robot not found');
    if (!['warning', 'error', 'critical'].includes(body.severity)) throw httpError(400, 'Incident severity must be warning, error, or critical');
    const externalId = `INC-${Date.now()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const serviceCase = { id: ids(), robotId: robot.id, tenantId: robot.tenantId, provider: 'altegro', externalId, title: body.title, description: body.description, severity: body.severity, status: 'open', cause: null, action: null, parts: [], assignedTo: body.assignedTo || null, createdAt: timestamp(), updatedAt: timestamp(), closedAt: null };
    state.serviceCases.set(`altegro:${externalId}`, serviceCase);
    const event = upsertEvent(robot.id, { eventType: 'incident', sourceSystem: 'altegro', sourceEventId: externalId, severity: body.severity, title: body.title, description: body.description, payload: { serviceCaseId: serviceCase.id, assignedTo: serviceCase.assignedTo } }, actor);
    appendPassportEntry(robot.id, { type: 'incident_opened', source: 'altegro', data: { serviceCaseId: serviceCase.id, externalId, title: body.title, description: body.description, severity: body.severity } }, actor);
    appendOutbox('service_case.opened', 'service_case', serviceCase.id, serviceCase); recordAudit(actor, 'incident.create', 'robot', robot.id, 'success', { serviceCaseId: serviceCase.id });
    return send(res, 201, { data: { event, serviceCase } });
  }

  const sync = route(req.method, path, /^\/api\/v1\/adapters\/([^/]+)\/sync$/);
  if (sync && req.method === 'POST') {
    if (!canWrite(actor)) throw httpError(403, 'Write permission required');
    if (sync.id === 'autoxing' && autoXingLiveEnabled()) {
      const syncStartedAt = Date.now();
      try {
        const result = await syncAutoXingLive(actor); recordAudit(actor, 'adapter.sync.live', 'adapter', sync.id, 'success', { count: result.count }); return send(res, 200, { data: result });
      } catch (error) {
        recordAdapterSync(state.adapters.get('autoxing'), { status:'error', startedAt:syncStartedAt, error:error.message, trigger:'manual' });
        throw error;
      }
    }
    if (sync.id === 'cenobots' && cenoBotsLiveEnabled()) {
      const syncStartedAt = Date.now();
      try {
        const result = await syncCenoBotsLive(actor); recordAudit(actor, 'adapter.sync.live', 'adapter', sync.id, 'success', { count:result.count, warnings:result.resourceErrors.length }); return send(res, 200, { data:result });
      } catch (error) {
        recordAdapterSync(state.adapters.get('cenobots'), { status:'error', startedAt:syncStartedAt, error:error.message, trigger:'manual' });
        throw error;
      }
    }
    const result = syncAdapter(sync.id, actor.id); recordAudit(actor, 'adapter.sync', 'adapter', sync.id); return send(res, 200, { data: result });
  }

  if (req.method === 'POST' && path === '/api/v1/robots') {
    if (!canRegisterRobot(actor)) throw httpError(403, 'Robot registration permission required');
    for (const field of ['modelId', 'siteId', 'organizationId', 'serialNumber']) if (!body[field]) throw httpError(400, `Missing required field: ${field}`);
    if (!state.models.has(body.modelId) || !state.sites.has(body.siteId) || !state.organizations.has(body.organizationId)) throw httpError(400, 'Unknown model, site, or organization');
    const serialNumber = String(body.serialNumber).trim();
    if (!serialNumber || serialNumber.length > 120 || !/^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(serialNumber)) throw httpError(400, 'Serial number must be 1–120 letters, numbers, dots, underscores, slashes, or hyphens');
    const username = body.username ? String(body.username).trim().toLowerCase() : null;
    const password = body.password ? String(body.password) : null;
    if ((username && !password) || (!username && password)) throw httpError(400, 'Username and password must be provided together');
    if (username && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) throw httpError(400, 'Username must be a valid email address');
    if (password && password.length < 12) throw httpError(400, 'Password must be at least 12 characters');
    if (actor.role !== 'robot_user' && (!username || !password)) throw httpError(400, 'Username and password are required for this registration');
    if ([...state.robots.values()].some((item) => item.tenantId === actor.tenantId && item.serialNumber.toLowerCase() === serialNumber.toLowerCase())) throw httpError(409, 'A robot with that serial number already exists');
    const externalIdentities = Array.isArray(body.externalIdentities) ? body.externalIdentities.filter((identity) => identity?.system && identity?.externalId).map((identity) => ({ system:String(identity.system).slice(0, 80), externalId:String(identity.externalId).slice(0, 200) })) : [];
    if (externalIdentities.some((identity) => [...state.robots.values()].some((item) => item.externalIdentities?.some((existing) => existing.system === identity.system && existing.externalId === identity.externalId)))) throw httpError(409, 'An external robot identity is already registered');
    const robot = { id: ids(), tenantId: actor.tenantId, organizationId: body.organizationId, operatorOrganizationId: body.operatorOrganizationId || body.organizationId, siteId: body.siteId, modelId: body.modelId, serialNumber, status: 'draft', externalIdentities, createdAt: timestamp(), updatedAt: timestamp() };
    const account = actor.role === 'robot_user' && !username ? null : createRobotUser(robot, { email: username, password });
    if (actor.role === 'robot_user' && !username) addRobotToActorScope(actor, robot.serialNumber);
    state.robots.set(robot.id, robot);
    appendPassportEntry(robot.id, { type: 'registration', source: 'manual', data: { serialNumber: robot.serialNumber, username } }, actor);
    recordAudit(actor, 'robot.create', 'robot', robot.id);
    return send(res, 201, { data: getPassport(robot.id), account: account ? { username: account.email, password: account.password } : null, accountReused: actor.role === 'robot_user' && !username });
  }

  const robot = route(req.method, path, /^\/api\/v1\/robots\/([^/]+)$/);
  if (robot) {
    const item = state.robots.get(robot.id); if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
    if (req.method === 'GET') return send(res, 200, { data: item });
  }
  const robotAutoXing = route(req.method, path, /^\/api\/v1\/robots\/([^/]+)\/autoxing$/);
  if (robotAutoXing && req.method === 'GET') {
    const item = state.robots.get(robotAutoXing.id); if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
    if (!item.externalIdentities?.some((identity) => identity.system === 'autoxing')) throw httpError(404, 'Robot is not linked to AutoXing');
    return send(res, 200, { data: { robotId: item.id, status: { online: item.online ?? null, battery: item.battery ?? null, charging: item.charging ?? null, position: item.position ? clone(item.position) : null, speed: item.speed ?? null, emergencyStop: item.emergencyStop ?? null, obstruction: item.obstruction ?? null, details: clone(item.statusDetails || {}), errors: clone(item.errors || []), task: item.providerTask ? clone(item.providerTask) : null }, resources: autoXingResourcesForRobot(item) } });
  }
  const robotExport = route(req.method, path, /^\/api\/v1\/robots\/([^/]+)\/export$/);
  if (robotExport && req.method === 'GET') {
    if (!canExport(actor)) throw httpError(403, 'Export permission required');
    const item = state.robots.get(robotExport.id); if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
    recordAudit(actor, 'export.robot.json', 'robot', item.id);
    return sendDownload(res, 'application/json; charset=utf-8', `altegro-passport-${item.serialNumber}.json`, JSON.stringify({ schemaVersion: '1.0.0', exportedAt: timestamp(), passport: getPassport(item.id) }, null, 2));
  }
  const lifecycleRecords = route(req.method, path, /^\/api\/v1\/robots\/([^/]+)\/lifecycle-records$/);
  if (lifecycleRecords && req.method === 'POST') {
    if (!canWrite(actor)) throw httpError(403, 'Lifecycle write permission required');
    const item = state.robots.get(lifecycleRecords.id); if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
    if (!['document', 'certificate', 'deployment'].includes(body.recordType)) throw httpError(400, 'recordType must be document, certificate, or deployment');
    if (!body.title) throw httpError(400, 'Title is required');
    const common = { id: ids(), robotId: item.id, tenantId: item.tenantId, title: String(body.title).slice(0, 200), description: String(body.description || '').slice(0, 4000), source: body.source || 'manual-portal', createdBy: actor.id, createdAt: timestamp() };
    let record;
    if (body.recordType === 'document') {
      record = { ...common, documentType: body.documentType || 'general', version: body.version || '1.0', attachment: validateEventAttachment(body.attachment) };
      state.documents.push(record);
    } else if (body.recordType === 'certificate') {
      if (!body.validUntil || Number.isNaN(Date.parse(body.validUntil))) throw httpError(400, 'A valid certificate expiry date is required');
      record = { ...common, certificateType: body.certificateType || 'general', issuer: body.issuer || 'Unknown', validFrom: body.validFrom || null, validUntil: new Date(body.validUntil).toISOString(), status: body.status || 'valid' };
      state.certificates.push(record);
    } else {
      if (!body.version) throw httpError(400, 'Deployment version is required');
      if (!['planned', 'approved', 'deployed', 'verified', 'failed', 'rolled_back'].includes(body.status || 'planned')) throw httpError(400, 'Invalid deployment status');
      record = { ...common, packageName: body.packageName || body.title, version: body.version, status: body.status || 'planned', deployedAt: body.deployedAt || null, approvedBy: body.approvedBy || null, verificationResult: body.verificationResult || null, rollbackVersion: body.rollbackVersion || null };
      state.deployments.push(record);
    }
    appendPassportEntry(item.id, { type: body.recordType, source: record.source, data: { ...record, attachment: record.attachment ? { name: record.attachment.name, contentType: record.attachment.contentType, size: record.attachment.size, sha256: record.attachment.sha256 } : undefined } }, actor);
    appendOutbox(`${body.recordType}.created`, body.recordType, record.id, { robotId: item.id, title: record.title }); recordAudit(actor, `${body.recordType}.create`, 'robot', item.id, 'success', { recordId: record.id });
    return send(res, 201, { data: { ...record, attachment: record.attachment ? { name: record.attachment.name, contentType: record.attachment.contentType, size: record.attachment.size, sha256: record.attachment.sha256 } : undefined } });
  }
  const passport = route(req.method, path, /^\/api\/v1\/robots\/([^/]+)\/passport$/);
  if (passport && req.method === 'GET') {
    const item = state.robots.get(passport.id); if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
    return send(res, 200, { data: getPassport(passport.id) });
  }
  const entries = route(req.method, path, /^\/api\/v1\/robots\/([^/]+)\/passport-entries$/);
  if (entries) {
    const item = state.robots.get(entries.id); if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
    if (req.method === 'GET') return send(res, 200, { data: state.passportEntries.get(entries.id) || [] });
    if (req.method === 'POST') {
      if (!canWrite(actor)) throw httpError(403, 'Write permission required');
      if (!body.type) throw httpError(400, 'Missing required field: type');
      const entry = appendPassportEntry(entries.id, body, actor); recordAudit(actor, 'passport.append', 'robot', entries.id); return send(res, 201, { data: entry });
    }
  }
  const robotEvents = route(req.method, path, /^\/api\/v1\/robots\/([^/]+)\/events$/);
  if (robotEvents) {
    const item = state.robots.get(robotEvents.id); if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
    if (req.method === 'GET') return send(res, 200, { data: state.events.filter((event) => event.robotId === robotEvents.id) });
    if (req.method === 'POST') {
      if (!canWrite(actor)) throw httpError(403, 'Write permission required');
      for (const field of ['title', 'description', 'eventType', 'sourceSystem', 'severity', 'occurredAt']) if (!body[field]) throw httpError(400, `Missing required field: ${field}`);
      if (!['info', 'warning', 'error', 'critical'].includes(body.severity)) throw httpError(400, 'severity must be info, warning, error, or critical');
      if (Number.isNaN(Date.parse(body.occurredAt))) throw httpError(400, 'occurredAt must be a valid ISO date/time');
      const sourceEventId = body.sourceEventId || `manual-${ids()}`;
      const attachment = validateEventAttachment(body.attachment);
      const event = upsertEvent(robotEvents.id, { eventType: body.eventType, sourceSystem: body.sourceSystem, sourceEventId, occurredAt: new Date(body.occurredAt).toISOString(), severity: body.severity, title: body.title, description: body.description, attachment, payload: { ...(body.payload || {}), title: body.title, description: body.description } }, actor);
      recordAudit(actor, 'event.create', 'robot', robotEvents.id, 'success', { eventId: event.eventId, sourceEventId });
      return send(res, 201, { data: event });
    }
  }
  const commands = route(req.method, path, /^\/api\/v1\/robots\/([^/]+)\/commands$/);
  if (commands && req.method === 'POST') { recordAudit(actor, 'robot.command.blocked', 'robot', commands.id, 'rejected'); throw httpError(403, 'Command capabilities are disabled in Phase 1'); }

  const serviceCaseUpdate = route(req.method, path, /^\/api\/v1\/service-cases\/([^/]+)$/);
  if (serviceCaseUpdate && req.method === 'PATCH') {
    if (!canWrite(actor)) throw httpError(403, 'Service-case write permission required');
    const serviceCase = [...state.serviceCases.values()].find((item) => item.id === serviceCaseUpdate.id);
    if (!serviceCase) throw httpError(404, 'Service case not found');
    const robot = state.robots.get(serviceCase.robotId); if (!robot || !visibleToActor(actor, robot)) throw httpError(404, 'Service case not found');
    const allowedStatuses = ['open', 'in_progress', 'waiting', 'resolved', 'closed'];
    if (body.status && !allowedStatuses.includes(body.status)) throw httpError(400, 'Invalid service-case status');
    const previousStatus = serviceCase.status;
    for (const field of ['status', 'cause', 'action', 'assignedTo']) if (body[field] !== undefined) serviceCase[field] = body[field];
    if (Array.isArray(body.parts)) serviceCase.parts = body.parts;
    serviceCase.updatedAt = timestamp();
    if (serviceCase.status === 'closed' && previousStatus !== 'closed') {
      serviceCase.closedAt = timestamp();
      appendPassportEntry(robot.id, { type: 'service_completion', source: serviceCase.provider, data: { serviceCaseId: serviceCase.id, externalId: serviceCase.externalId, cause: serviceCase.cause, action: serviceCase.action, parts: serviceCase.parts, assignedTo: serviceCase.assignedTo, closedAt: serviceCase.closedAt } }, actor);
      upsertEvent(robot.id, { eventType: 'service_completed', sourceSystem: serviceCase.provider, sourceEventId: `${serviceCase.externalId}:closed`, severity: 'info', title: `Service case ${serviceCase.externalId} closed`, description: serviceCase.action || 'Service work completed.', payload: { serviceCaseId: serviceCase.id, cause: serviceCase.cause, parts: serviceCase.parts } }, actor);
    } else if (serviceCase.status !== previousStatus) {
      appendPassportEntry(robot.id, { type: 'service_status_changed', source: serviceCase.provider, data: { serviceCaseId: serviceCase.id, from: previousStatus, to: serviceCase.status } }, actor);
    }
    appendOutbox('service_case.updated', 'service_case', serviceCase.id, { previousStatus, status: serviceCase.status }); recordAudit(actor, 'service_case.update', 'robot', robot.id, 'success', { serviceCaseId: serviceCase.id, previousStatus, status: serviceCase.status });
    return send(res, 200, { data: serviceCase });
  }

  if (req.method === 'POST' && path === '/api/v1/service-cases') {
    if (!canWrite(actor)) throw httpError(403, 'Write permission required');
    const item = state.robots.get(body.robotId); if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
    if (!body.externalId || !body.provider || !body.status) throw httpError(400, 'robotId, provider, externalId, and status are required');
    const key = `${body.provider}:${body.externalId}`; if (state.serviceCases.has(key)) return send(res, 200, { data: state.serviceCases.get(key), idempotent: true });
    if (!['open', 'in_progress', 'waiting', 'resolved', 'closed'].includes(body.status)) throw httpError(400, 'Invalid service-case status');
    const serviceCase = { id: ids(), robotId: item.id, tenantId: item.tenantId, provider: body.provider, externalId: body.externalId, title: body.title || `Service case ${body.externalId}`, description: body.description || '', severity: body.severity || 'info', status: body.status, cause: body.cause || null, action: body.action || null, parts: body.parts || [], assignedTo: body.assignedTo || null, createdAt: timestamp(), updatedAt: timestamp(), closedAt: body.status === 'closed' ? timestamp() : null };
    state.serviceCases.set(key, serviceCase); appendPassportEntry(item.id, { type: body.status === 'closed' ? 'service_completion' : 'service_case', source: body.provider, data: serviceCase }, actor); appendOutbox('service_case.linked', 'service_case', serviceCase.id, serviceCase); recordAudit(actor, 'service_case.link', 'robot', item.id); return send(res, 201, { data: serviceCase });
  }
  throw httpError(404, 'Route not found');
}

seed();
initializeCredentialHashes();
loadPersistedState();
applyRequestedTechnicianRoster();
assertProductionSecretConfiguration();
if (persistenceEnabled()) persistState();
const server = http.createServer(async (req, res) => {
  const requestStartedAt=Date.now(); runtimeMetrics.activeRequests += 1;
  res.once('finish',() => { const duration=Date.now()-requestStartedAt; runtimeMetrics.activeRequests=Math.max(0,runtimeMetrics.activeRequests-1); runtimeMetrics.requestsTotal += 1; runtimeMetrics.responseTimeMsTotal += duration; runtimeMetrics.responseTimeMsMax=Math.max(runtimeMetrics.responseTimeMsMax,duration); const statusClass=`${Math.floor(res.statusCode/100)}xx`; runtimeMetrics.byStatus[statusClass]=(runtimeMetrics.byStatus[statusClass] || 0)+1; if (res.statusCode >= 500) runtimeMetrics.errorsTotal += 1; });
  try {
    await handle(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') persistState();
  } catch (error) {
    const status = Number(error.status) || 500; const correlationId = ids();
    if (status >= 500) console.error(`[${correlationId}] ${req.method} ${req.url}:`, error);
    const code = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 409 ? 'CONFLICT' : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
    send(res, status, { error: { code, message: status >= 500 ? 'The operation could not be completed. Retry or contact support with the correlation ID.' : error.message, details: status < 500 ? error.details : undefined, correlationId } });
  }
});

let autoXingPollTimer = null;
let autoXingPollRunning = false;
let emailQueueTimer = null;
function startEmailDeliveryWorker() { if (!emailAlertConfiguration().enabled) return; processEmailQueue(); emailQueueTimer=setInterval(processEmailQueue,60000); emailQueueTimer.unref?.(); }
let operationsAutomationTimer=null;
function startOperationsAutomationWorker() { operationsAutomationTimer=setInterval(() => { for (const tenantId of state.tenants.keys()) evaluateAlertEscalations(tenantId); },60000); operationsAutomationTimer.unref?.(); }
function startAutoXingPolling() {
  if (!autoXingLiveEnabled() || autoXingPollIntervalMs() === 0) return;
  const pollActor = { id: 'system-autoxing-poller', name: 'AutoXing Poller', role: 'platform_admin', tenantId: 'tenant-demo', organizationId: 'org-ef' };
  autoXingPollTimer = setInterval(async () => {
    if (autoXingPollRunning) return;
    autoXingPollRunning = true;
    const syncStartedAt = Date.now();
    try { await syncAutoXingLive(pollActor); } catch (error) { recordAdapterSync(state.adapters.get('autoxing'), { status:'error', startedAt:syncStartedAt, error:error.message, trigger:'poll' }); }
    finally { autoXingPollRunning = false; try { persistState(); } catch (error) { console.error(`Could not persist AutoXing synchronization: ${error.message}`); } }
  }, autoXingPollIntervalMs());
  autoXingPollTimer.unref?.();
}

if (require.main === module) {
  server.listen(PORT, BIND_HOST, () => { startAutoXingPolling(); startEmailDeliveryWorker(); startOperationsAutomationWorker(); console.log(`Altegro prototype listening on http://${BIND_HOST}:${PORT}`); });
  const shutdown = (signal) => { console.log(`${signal} received; saving state and shutting down.`); if (emailQueueTimer) clearInterval(emailQueueTimer); if (operationsAutomationTimer) clearInterval(operationsAutomationTimer); try { persistState(); } catch (error) { console.error(`Final persistence failed: ${error.message}`); } server.close(() => process.exit(0)); };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { server, state, persistState, DATA_FILE };
