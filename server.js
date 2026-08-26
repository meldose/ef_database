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
const { PostgresStore } = require('./infrastructure/postgres-store');
const { S3ObjectStore } = require('./infrastructure/object-store');

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
const PERSISTENCE_DRIVER = String(process.env.ALTEGRO_PERSISTENCE_DRIVER || (process.env.NODE_ENV === 'production' ? 'postgres' : 'file')).toLowerCase();
const OBJECT_STORAGE_DRIVER = String(process.env.OBJECT_STORAGE_DRIVER || (process.env.NODE_ENV === 'production' ? 's3' : 'inline')).toLowerCase();
const SYNC_MODE = String(process.env.ALTEGRO_SYNC_MODE || (PERSISTENCE_DRIVER === 'postgres' ? 'async' : 'inline')).toLowerCase();
const persistenceEnabled = () => PERSISTENCE_DRIVER !== 'memory' && !['0','false','no'].includes(String(process.env.ALTEGRO_PERSISTENCE ?? 'true').toLowerCase());
const filePersistenceEnabled = () => persistenceEnabled() && PERSISTENCE_DRIVER === 'file';
const postgresPersistenceEnabled = () => persistenceEnabled() && PERSISTENCE_DRIVER === 'postgres';
const asyncSyncEnabled = () => SYNC_MODE === 'async' && postgresPersistenceEnabled();
let databaseStore = null;
let objectStore = null;
let infrastructureInitialized = false;
const loginFailures = new Map();
const allowedAttachmentTypes = new Set(['application/pdf', 'application/json', 'text/plain', 'text/csv', 'image/png', 'image/jpeg', 'image/webp', 'application/octet-stream']);
const allowedAttachmentExtensions = new Set(['.pdf', '.json', '.txt', '.csv', '.png', '.jpg', '.jpeg', '.webp']);

const ids = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const publicDir = pathUtil.join(__dirname, 'public');
const execFileAsync = promisify(execFile);
const AUTOXING_BRIDGE = pathUtil.join(__dirname, 'integrations', 'autoxing_bridge.py');
const CENOBOTS_BRIDGE = pathUtil.join(__dirname, 'integrations', 'cenobots_bridge.py');
const CENOBOTS_TASKS = pathUtil.join(__dirname, 'integrations', 'cenobots', 'tasks.py');
const CENOBOTS_CLIENT = pathUtil.join(__dirname, 'integrations', 'cenobots', 'client.py');
const AUTOXING_REPO = process.env.AUTOXING_REPO_PATH || pathUtil.resolve(__dirname, '..', 'autoxing');
const AUTOXING_LIB = process.env.AUTOXING_LIB_PATH || pathUtil.join(AUTOXING_REPO, 'lib');
const autoXingLiveEnabled = () => ['1', 'true', 'yes'].includes(String(process.env.AUTOXING_LIVE || '').toLowerCase());
const autoXingPollIntervalMs = () => Math.max(0, Number(process.env.AUTOXING_POLL_INTERVAL_MS || 300000));
const parseJsonEnv = (name, fallback = {}) => { try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; } catch { return fallback; } };
const autoXingMappingRequired = () => ['1', 'true', 'yes'].includes(String(process.env.AUTOXING_REQUIRE_MAPPING || '').toLowerCase());
const cenoBotsLiveEnabled = () => ['1', 'true', 'yes'].includes(String(process.env.CENOBOTS_LIVE || '').toLowerCase());
const cenoBotsPollIntervalMs = () => Math.max(0,Number(process.env.CENOBOTS_POLL_INTERVAL_MS || 300000));
function secretEnvValue(name) {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    try { return fs.readFileSync(pathUtil.resolve(filePath),'utf8').trim(); }
    catch(error) { throw new Error(`Could not read managed secret ${name}: ${error.message}`); }
  }
  return process.env[name] || '';
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
    { name:'cenobots-webhook', enabled:Boolean(process.env.CENOBOTS_WEBHOOK_SECRET || process.env.CENOBOTS_WEBHOOK_SECRET_FILE), names:['CENOBOTS_WEBHOOK_SECRET'] },
    { name:'email', enabled:enabled(process.env.EMAIL_ALERTS_ENABLED) && Boolean(process.env.EMAIL_SMTP_USERNAME), names:['EMAIL_SMTP_PASSWORD'] },
    { name:'sms', enabled:enabled(process.env.SMS_ALERTS_ENABLED) && Boolean(process.env.SMS_ALERT_WEBHOOK_TOKEN || process.env.SMS_ALERT_WEBHOOK_TOKEN_FILE), names:['SMS_ALERT_WEBHOOK_TOKEN'] },
    { name:'postgres',enabled:postgresPersistenceEnabled(),names:['PGPASSWORD'] },
    { name:'object-storage',enabled:OBJECT_STORAGE_DRIVER === 's3' && Boolean(process.env.OBJECT_STORAGE_ENDPOINT),names:['OBJECT_STORAGE_ACCESS_KEY','OBJECT_STORAGE_SECRET_KEY'] }
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
  if (report.requireManaged && !report.valid) throw new Error('Production secret policy failed. Live providers must use complete managed secret-file configuration.');
  const email=emailAlertConfiguration();
  if (email.enabled && !email.configured) throw new Error(`Email alert configuration failed: ${email.configurationError}`);
  const sms=smsAlertConfiguration();
  if (sms.enabled && !sms.configured) throw new Error(`SMS alert configuration failed: ${sms.configurationError}`);
  if (process.env.NODE_ENV === 'production') {
    if (!enabled(process.env.COOKIE_SECURE)) throw new Error('COOKIE_SECURE=true is required in production');
    if (!String(process.env.ALTEGRO_ALLOWED_HOSTS || '').trim()) throw new Error('ALTEGRO_ALLOWED_HOSTS is required in production');
    if (!String(process.env.ALTEGRO_ALLOWED_ORIGINS || '').trim()) throw new Error('ALTEGRO_ALLOWED_ORIGINS is required in production');
  }
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
  state.emailDeliveries.push(delivery); state.emailDeliveries=state.emailDeliveries.slice(-200); schedulePersist();
  if (databaseStore) databaseStore.enqueueEmailJob(delivery).then(() => setImmediate(processEmailQueue)).catch((error) => console.error(`Could not enqueue email delivery: ${error.message}`));
  return delivery;
}

function queueEmailAlert(notification,{ force=false }={}) {
  const config=emailAlertConfiguration(); if (!config.enabled || !config.configured) return null;
  const severityRank={ info:0,warning:1,error:2,critical:3 }; if (!force && (severityRank[notification.severity] ?? 0) < severityRank[config.minimumSeverity]) return null;
  const cutoff=Date.now()-config.cooldownMinutes*60000; const duplicate=state.emailDeliveries.find((item) => item.notificationKey === notification.notificationKey && Date.parse(item.createdAt) >= cutoff && ['pending','sending','sent'].includes(item.status)); if (duplicate) return duplicate;
  const delivery=createEmailDelivery(notification); if (!databaseStore) setImmediate(() => processEmailQueue()); return delivery;
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
  try {
    if (databaseStore) {
      for (let index=0;index<20;index+=1) {
        const job=await databaseStore.claimEmailJob(syncWorkerId,Number(process.env.EMAIL_JOB_STALE_SECONDS || 300)); if (!job) break;
        let delivery=state.emailDeliveries.find((item) => item.id === job.id);
        if (!delivery) { delivery=job.delivery; state.emailDeliveries.push(delivery); }
        try { await deliverEmailNotification(delivery); } catch {} finally { await databaseStore.finishEmailJob(delivery); }
      }
      return;
    }
    for (const delivery of state.emailDeliveries.filter((item) => ['pending','failed'].includes(item.status) && item.attempts < 3 && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now())).slice(0,20)) { try { await deliverEmailNotification(delivery); } catch {} }
  }
  finally { emailQueueRunning=false; }
}

function emailDeliverySummary() {
  const config=emailAlertConfiguration(); const deliveries=state.emailDeliveries.slice().reverse().slice(0,30).map((item) => ({ id:item.id,type:item.type,severity:item.severity,title:item.title,robotId:item.robotId,robotSerialNumber:item.robotSerialNumber,recipientCount:item.recipients.length,status:item.status,attempts:item.attempts,lastError:item.lastError,createdAt:item.createdAt,sentAt:item.sentAt }));
  return { configuration:{ enabled:config.enabled,configured:config.configured,configurationError:config.configurationError,transport:config.transport,hostConfigured:config.hostConfigured,port:config.port,secure:config.secure,authenticationConfigured:config.authenticationConfigured,fromConfigured:config.fromConfigured,recipientCount:config.recipientCount,minimumSeverity:config.minimumSeverity,cooldownMinutes:config.cooldownMinutes },counts:{ total:state.emailDeliveries.length,pending:state.emailDeliveries.filter((item) => item.status === 'pending').length,sent:state.emailDeliveries.filter((item) => item.status === 'sent').length,failed:state.emailDeliveries.filter((item) => item.status === 'failed').length },deliveries };
}

function smsRecipient(value) {
  const recipient=String(value || '').replace(/[\s()-]/g,'');
  return /^\+[1-9]\d{7,14}$/.test(recipient) ? recipient : null;
}

function smsAlertConfiguration() {
  const isEnabled=enabled(process.env.SMS_ALERTS_ENABLED); const transport=String(process.env.SMS_ALERT_TRANSPORT || 'webhook').toLowerCase();
  const recipients=String(process.env.SMS_ALERT_RECIPIENTS || '').split(',').map(smsRecipient).filter(Boolean); const webhookUrl=String(process.env.SMS_ALERT_WEBHOOK_URL || '').trim(); const tokenConfigured=Boolean(process.env.SMS_ALERT_WEBHOOK_TOKEN || process.env.SMS_ALERT_WEBHOOK_TOKEN_FILE);
  const minimumSeverity=['info','warning','error','critical'].includes(process.env.SMS_ALERT_MIN_SEVERITY) ? process.env.SMS_ALERT_MIN_SEVERITY : 'critical'; let configurationError=null;
  if (isEnabled && !['webhook','capture'].includes(transport)) configurationError='SMS_ALERT_TRANSPORT must be webhook or capture';
  else if (isEnabled && transport === 'capture' && process.env.NODE_ENV === 'production') configurationError='capture transport is not allowed in production';
  else if (isEnabled && !recipients.length) configurationError='SMS_ALERT_RECIPIENTS must contain at least one E.164 phone number';
  else if (isEnabled && transport === 'webhook' && !webhookUrl) configurationError='SMS_ALERT_WEBHOOK_URL is required';
  else if (isEnabled && transport === 'webhook') {
    try { const parsed=new URL(webhookUrl); if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') configurationError='SMS_ALERT_WEBHOOK_URL must use HTTPS in production'; else if (!['http:','https:'].includes(parsed.protocol)) configurationError='SMS_ALERT_WEBHOOK_URL must use HTTP or HTTPS'; }
    catch { configurationError='SMS_ALERT_WEBHOOK_URL must be a valid URL'; }
  }
  return { enabled:isEnabled,configured:!isEnabled || !configurationError,configurationError,transport,webhookConfigured:Boolean(webhookUrl),tokenConfigured,recipientCount:recipients.length,minimumSeverity,cooldownMinutes:Math.max(1,Number(process.env.SMS_ALERT_COOLDOWN_MINUTES || 60)),recipients,webhookUrl };
}

function createSmsDelivery(notification) {
  const config=smsAlertConfiguration(); const delivery={ id:ids(),notificationKey:String(notification.notificationKey),type:notification.type || 'operational_alert',severity:notification.severity || 'critical',title:String(notification.title || 'Altegro alert').slice(0,120),message:String(notification.message || '').slice(0,1000),robotId:notification.robotId || null,robotSerialNumber:notification.robotSerialNumber || null,recipients:[...config.recipients],status:'pending',attempts:0,lastError:null,createdAt:timestamp(),occurredAt:notification.occurredAt || timestamp(),sentAt:null,nextAttemptAt:null };
  state.smsDeliveries.push(delivery); state.smsDeliveries=state.smsDeliveries.slice(-200); schedulePersist(); return delivery;
}

async function deliverSmsNotification(delivery) {
  const config=smsAlertConfiguration(); if (!config.enabled || !config.configured) throw new Error(config.configurationError || 'SMS alerts are disabled'); delivery.status='sending'; delivery.attempts+=1; delivery.lastError=null;
  try {
    if (config.transport === 'webhook') { const headers={ 'content-type':'application/json' }; const token=secretEnvValue('SMS_ALERT_WEBHOOK_TOKEN'); if (token) headers.authorization=`Bearer ${token}`; const response=await fetch(config.webhookUrl,{ method:'POST',headers,body:JSON.stringify({ recipients:delivery.recipients,message:`[Altegro ${delivery.severity.toUpperCase()}] ${delivery.title}: ${delivery.message}`.slice(0,1500),notificationId:delivery.notificationKey,robotSerialNumber:delivery.robotSerialNumber }),signal:AbortSignal.timeout(Math.max(1000,Number(process.env.SMS_ALERT_TIMEOUT_MS || 10000))) }); if (!response.ok) throw new Error(`SMS webhook returned HTTP ${response.status}`); }
    delivery.status='sent'; delivery.sentAt=timestamp(); delivery.nextAttemptAt=null;
  } catch(error) { delivery.status='failed'; delivery.lastError=String(error.message || error).slice(0,500); delivery.nextAttemptAt=new Date(Date.now()+Math.min(15,delivery.attempts*5)*60000).toISOString(); throw error; }
  finally { schedulePersist(); }
  return delivery;
}

function queueSmsAlert(notification,{ force=false }={}) {
  const config=smsAlertConfiguration(); if (!config.enabled || !config.configured) return null; const severityRank={ info:0,warning:1,error:2,critical:3 }; if (!force && (severityRank[notification.severity] ?? 0) < severityRank[config.minimumSeverity]) return null;
  const cutoff=Date.now()-config.cooldownMinutes*60000; const duplicate=state.smsDeliveries.find((item) => item.notificationKey === notification.notificationKey && Date.parse(item.createdAt) >= cutoff && ['pending','sending','sent'].includes(item.status)); if (duplicate) return duplicate; const delivery=createSmsDelivery(notification); setImmediate(() => deliverSmsNotification(delivery).catch(() => {})); return delivery;
}

function queueOperationalAlert(notification,options={}) { return { email:queueEmailAlert(notification,options),sms:queueSmsAlert(notification,options) }; }

function smsDeliverySummary() {
  const config=smsAlertConfiguration(); const deliveries=state.smsDeliveries.slice().reverse().slice(0,30).map((item) => ({ id:item.id,type:item.type,severity:item.severity,title:item.title,robotId:item.robotId,robotSerialNumber:item.robotSerialNumber,recipientCount:item.recipients.length,status:item.status,attempts:item.attempts,lastError:item.lastError,createdAt:item.createdAt,sentAt:item.sentAt }));
  return { configuration:{ enabled:config.enabled,configured:config.configured,configurationError:config.configurationError,transport:config.transport,webhookConfigured:config.webhookConfigured,tokenConfigured:config.tokenConfigured,recipientCount:config.recipientCount,minimumSeverity:config.minimumSeverity,cooldownMinutes:config.cooldownMinutes },counts:{ total:state.smsDeliveries.length,pending:state.smsDeliveries.filter((item) => item.status === 'pending').length,sent:state.smsDeliveries.filter((item) => item.status === 'sent').length,failed:state.smsDeliveries.filter((item) => item.status === 'failed').length },deliveries };
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
  notificationWorkflows: new Map(),
  notificationReads: new Map(),
  workOrders: new Map(),
  cenobotsWebhookReceipts: new Map(),
  maintenanceSchedules: new Map(),
  alertEscalationRules: new Map(),
  alertEscalations: new Map(),
  emailDeliveries: [],
  smsDeliveries: [],
  trackingSamples: new Map(),
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
  'demo-technician': { id: 'user-technician', name: 'Demo Technician', email: 'technician@demo.altegro.local', role: 'technician', technicianId:'technician-lena', tenantId: 'tenant-demo', organizationId: 'org-service' },
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

const ROLE_PERMISSIONS = Object.freeze({
  platform_admin:['robot.read','robot.write','robot.register','report.read','report.export','notification.manage','workforce.read','workforce.manage','work_order.read','work_order.manage','audit.read','audit.export','customer_dashboard.read','customer_dashboard.all','integration.read','integration.sync','robot.control','support.create','support.manage'],
  data_admin:['robot.read','robot.write','robot.register','report.read','report.export','notification.manage','workforce.read','workforce.manage','work_order.read','work_order.manage','audit.read','audit.export','customer_dashboard.read','customer_dashboard.all','integration.read','integration.sync','support.create','support.manage'],
  support_admin:['robot.read','robot.write','robot.register','report.read','report.export','notification.manage','workforce.read','workforce.manage','work_order.read','work_order.manage','audit.read','audit.export','customer_dashboard.read','customer_dashboard.all','integration.read','integration.sync','robot.control','support.create','support.manage'],
  owner:['robot.read','robot.write','robot.register','report.read','report.export','workforce.read','work_order.read','audit.read','customer_dashboard.read','support.create'],
  technician:['robot.read','robot.write','report.read','workforce.read','work_order.read','work_order.update_assigned','audit.read','support.create'],
  auditor:['robot.read','report.read','report.export','audit.read','audit.export','customer_dashboard.read'],
  robot_user:['robot.read','robot.register','report.read','work_order.read','customer_dashboard.read','support.create']
});

function permissionsFor(actor) { return [...new Set([...(ROLE_PERMISSIONS[actor?.role] || []),...(Array.isArray(actor?.additionalPermissions) ? actor.additionalPermissions : [])])].sort(); }
function hasPermission(actor,permission) { return permissionsFor(actor).includes(permission); }

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
      passportEntries: mapEntries(state.passportEntries), serviceCases: mapEntries(state.serviceCases), technicians: mapEntries(state.technicians), modelRequirements: mapEntries(state.modelRequirements), robotAssignments: mapEntries(state.robotAssignments), alertWorkflows:mapEntries(state.alertWorkflows), notificationWorkflows:mapEntries(state.notificationWorkflows), notificationReads:mapEntries(state.notificationReads), workOrders:mapEntries(state.workOrders), cenobotsWebhookReceipts:mapEntries(state.cenobotsWebhookReceipts), maintenanceSchedules:mapEntries(state.maintenanceSchedules), alertEscalationRules:mapEntries(state.alertEscalationRules), alertEscalations:mapEntries(state.alertEscalations), documents: state.documents, certificates: state.certificates,
      deployments: state.deployments, compatibilityRecords: state.compatibilityRecords, events: state.events, audit: state.audit, outbox: state.outbox, emailDeliveries:state.emailDeliveries, smsDeliveries:state.smsDeliveries, trackingSamples:mapEntries(state.trackingSamples),
      autoxing: { ...state.autoxing, pois: mapEntries(state.autoxing.pois), areas: mapEntries(state.autoxing.areas), maps: mapEntries(state.autoxing.maps), tasks: mapEntries(state.autoxing.tasks) },
      adapterRuntime: mapEntries(state.adapters).map(([provider, adapter]) => [provider, { lastSyncAt: adapter.lastSyncAt || null, lastSyncStatus: adapter.lastSyncStatus || 'never', lastError: adapter.lastError || null, lastSyncDurationMs:adapter.lastSyncDurationMs || null, lastSyncCount:adapter.lastSyncCount ?? null, lastSyncWarnings:adapter.lastSyncWarnings || 0, syncHistory:clone(adapter.syncHistory || []) }])
    }
  };
}

function persistState() {
  if (!persistenceEnabled()) return false;
  if (postgresPersistenceEnabled()) {
    if (!databaseStore) throw new Error('PostgreSQL persistence has not been initialized');
    return databaseStore.saveSnapshot(persistedSnapshot());
  }
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
    try { Promise.resolve(persistState()).catch((error) => console.error(`Could not persist Altegro state: ${error.message}`)); }
    catch (error) { console.error(`Could not persist Altegro state: ${error.message}`); }
  }, 50);
  persistenceTimer.unref?.();
}

function replaceMap(target, entries) {
  if (!Array.isArray(entries)) return;
  target.clear();
  for (const [key, value] of entries) target.set(key, value);
}

function hydratePersistedState(saved) {
  if (saved.schemaVersion !== 1 || !saved.state) throw new Error('unsupported data schema');
  for (const [token,user] of Object.entries(saved.users || {})) demoUsers[token]=user;
  if (demoUsers['demo-technician']) demoUsers['demo-technician'].technicianId ||= 'technician-lena';
  initializeCredentialHashes();
  replaceMap(authenticatedSessions,(saved.sessions || []).filter(([,session]) => session.expiresAt > Date.now()));
  for (const name of ['tenants','organizations','sites','models','robots','passportEntries','serviceCases','technicians','modelRequirements','robotAssignments','alertWorkflows','notificationWorkflows','notificationReads','workOrders','cenobotsWebhookReceipts','maintenanceSchedules','alertEscalationRules','alertEscalations','trackingSamples']) replaceMap(state[name],saved.state[name]);
  for (const name of ['documents','certificates','deployments','compatibilityRecords','events','audit','outbox','emailDeliveries','smsDeliveries']) if (Array.isArray(saved.state[name])) state[name]=saved.state[name];
  const autoXing=saved.state.autoxing || {};
  state.autoxing.businesses=autoXing.businesses || []; state.autoxing.buildings=autoXing.buildings || []; state.autoxing.lastSyncAt=autoXing.lastSyncAt || null; state.autoxing.resourceErrors=autoXing.resourceErrors || [];
  for (const name of ['pois','areas','maps','tasks']) replaceMap(state.autoxing[name],autoXing[name]);
  for (const [provider,runtime] of saved.state.adapterRuntime || []) { const adapter=state.adapters.get(provider); if (!adapter) continue; Object.assign(adapter,runtime); if (!Array.isArray(runtime.syncHistory)) adapter.syncHistory=[]; }
  return true;
}

function loadPersistedState() {
  if (!filePersistenceEnabled() || !fs.existsSync(DATA_FILE)) return false;
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return hydratePersistedState(saved);
  } catch (error) {
    console.error(`Could not load ${DATA_FILE}; starting from the seeded state: ${error.message}`);
    return false;
  }
}

function postgresOptions() {
  return {
    connectionString:process.env.DATABASE_URL || undefined,
    host:process.env.PGHOST || undefined,port:Number(process.env.PGPORT || 5432),
    database:process.env.PGDATABASE || undefined,user:process.env.PGUSER || undefined,
    password:secretEnvValue('PGPASSWORD') || undefined,
    ssl:String(process.env.PGSSLMODE || '').toLowerCase() === 'require',
    sslRejectUnauthorized:!['0','false','no'].includes(String(process.env.PGSSL_REJECT_UNAUTHORIZED ?? 'true').toLowerCase()),
    maxConnections:Number(process.env.PGPOOL_MAX || 10),migrationsDirectory:pathUtil.join(__dirname,'migrations'),
  };
}

function objectStorageOptions() {
  return {
    endpoint:process.env.OBJECT_STORAGE_ENDPOINT || undefined,region:process.env.OBJECT_STORAGE_REGION || 'eu-central-1',
    bucket:process.env.OBJECT_STORAGE_BUCKET || 'altegro-attachments',
    accessKeyId:secretEnvValue('OBJECT_STORAGE_ACCESS_KEY') || undefined,
    secretAccessKey:secretEnvValue('OBJECT_STORAGE_SECRET_KEY') || undefined,
    forcePathStyle:enabled(process.env.OBJECT_STORAGE_FORCE_PATH_STYLE),
    createBucket:enabled(process.env.OBJECT_STORAGE_CREATE_BUCKET),
  };
}

async function initializeInfrastructure() {
  if (infrastructureInitialized) return;
  if (!['file','postgres','memory'].includes(PERSISTENCE_DRIVER)) throw new Error(`Unsupported ALTEGRO_PERSISTENCE_DRIVER: ${PERSISTENCE_DRIVER}`);
  if (!['inline','s3'].includes(OBJECT_STORAGE_DRIVER)) throw new Error(`Unsupported OBJECT_STORAGE_DRIVER: ${OBJECT_STORAGE_DRIVER}`);
  if (process.env.NODE_ENV === 'production' && PERSISTENCE_DRIVER !== 'postgres') throw new Error('Production requires ALTEGRO_PERSISTENCE_DRIVER=postgres');
  if (process.env.NODE_ENV === 'production' && OBJECT_STORAGE_DRIVER !== 's3') throw new Error('Production requires OBJECT_STORAGE_DRIVER=s3');
  if (postgresPersistenceEnabled()) {
    databaseStore=new PostgresStore(postgresOptions()); await databaseStore.initialize();
    const saved=await databaseStore.loadSnapshot(); if (saved) hydratePersistedState(saved);
    applyRequestedTechnicianRoster();
    for (const delivery of state.emailDeliveries.filter((item) => ['pending','sending','failed'].includes(item.status) && item.attempts < 3)) { if (delivery.status === 'sending') delivery.status='pending'; await databaseStore.enqueueEmailJob(delivery); }
    await persistState();
  }
  if (OBJECT_STORAGE_DRIVER === 's3') { objectStore=new S3ObjectStore(objectStorageOptions()); await objectStore.initialize(); }
  infrastructureInitialized=true;
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
  return { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId,technicianId:user.technicianId || null,permissions:permissionsFor(user), scope: actorRobotSerials(user).length ? { type: 'robot', system: user.robotSystem, externalId: user.robotExternalId || null, serialNumber: actorRobotSerials(user)[0], serialNumbers: actorRobotSerials(user) } : { type: 'tenant' } };
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
    provider: 'cenobots', version: cenoBotsLiveEnabled() ? 'open-api-v1.0.16' : 'mock-1.0.0', status: cenoBotsLiveEnabled() ? 'live-bridge-enabled' : 'mock-only', integration: 'integrations/cenobots_bridge.py',
    capabilities: { read: ['identity', 'status', 'battery', 'position', 'service_history', 'system_errors'], event: ['online', 'offline', 'maintenance', 'error'], command: enabled(process.env.CENOBOTS_COMMANDS_ENABLED) ? ['schedule','clean','go-home','pause','continue','stop'] : [] },
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
  state.audit.push({ id:ids(),tenantId:actor.tenantId || null,actorId:actor.id,actorName:actor.name,action,objectType,objectId,result,details,occurredAt:timestamp() });
  schedulePersist();
}

function appendOutbox(eventType, aggregateType, aggregateId, payload = {}) {
  const item = { id: ids(), eventType, aggregateType, aggregateId, payload: clone(payload), status: 'pending', createdAt: timestamp(), publishedAt: null };
  state.outbox.push(item);
  return item;
}

function appendPassportEntry(robotId, entry, actor = { id: 'system', name: 'System' }) {
  const fullEntry={ id:ids(),tenantId:state.robots.get(robotId)?.tenantId || actor.tenantId || null,robotId,source:entry.source || 'altegro',trustStatus:entry.trustStatus || 'reported',createdBy:actor.id,occurredAt:entry.occurredAt || timestamp(),type:entry.type,data:entry.data || {} };
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
  const robot=state.robots.get(robotId); queueOperationalAlert({ notificationKey:`event:${fullEvent.eventId}`,type:'technical_event',severity:fullEvent.severity,title:fullEvent.title,message:fullEvent.description || fullEvent.eventType,robotId,robotSerialNumber:robot?.serialNumber,occurredAt:fullEvent.occurredAt });
  return fullEvent;
}

function recordAdapterSync(adapter, { status, startedAt, count = 0, warnings = 0, error = null, trigger = 'manual' }) {
  if (!adapter) return;
  const completedAt = timestamp(); const durationMs = Math.max(0, Date.now() - startedAt);
  adapter.lastSyncAt = completedAt; adapter.lastSyncStatus = status; adapter.lastError = error; adapter.lastSyncDurationMs = durationMs; adapter.lastSyncCount = count; adapter.lastSyncWarnings = warnings;
  adapter.syncHistory = [...(adapter.syncHistory || []), { id:ids(), status, startedAt:new Date(startedAt).toISOString(), completedAt, durationMs, count, warnings, trigger }].slice(-20);
  if (status === 'error') { const digest=crypto.createHash('sha256').update(String(error || 'unknown')).digest('hex').slice(0,16); queueOperationalAlert({ notificationKey:`adapter:${adapter.provider}:${digest}`,type:'integration_error',severity:'error',title:`${adapter.provider} synchronization failed`,message:'The provider synchronization failed. Retry from Altegro and inspect the protected server log if the error remains.',occurredAt:completedAt }); }
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
    const result = await execFileAsync(process.env.PYTHON_BIN || 'python3', [CENOBOTS_BRIDGE, command], { cwd: __dirname, env, timeout:Math.max(20000, Number(process.env.CENOBOTS_BRIDGE_TIMEOUT_MS || 300000)), maxBuffer:32 * 1024 * 1024 });
    let payload;
    try { payload = JSON.parse(result.stdout.trim()); }
    catch (error) { throw httpError(503, `CenoBots bridge returned invalid JSON: ${error.message}`, { provider:'cenobots' }); }
    if (!payload.ok) throw httpError(503, payload.message || payload.error || 'CenoBots synchronization failed', { provider:'cenobots', bridgeCode:payload.code });
    return payload;
  } catch (error) {
    if (error.status) throw error;
    let providerMessage = '';
    try { providerMessage = JSON.parse(String(error.stdout || '').trim()).error || ''; } catch {}
    throw httpError(503, `CenoBots API unavailable: ${providerMessage || error.message}`, { provider:'cenobots' });
  }
}

function cenoBotsControlConfiguration() {
  const credentialsConfigured=Boolean(secretEnvValue('CENOBOTS_ACCESS_KEY') && secretEnvValue('CENOBOTS_SECRET_KEY'));
  const commandsEnabled=enabled(process.env.CENOBOTS_COMMANDS_ENABLED);
  return { liveEnabled:cenoBotsLiveEnabled(),commandsEnabled,credentialsConfigured,ready:cenoBotsLiveEnabled() && commandsEnabled && credentialsConfigured,safetyConfirmation:'Exact robot serial number required for every live command.' };
}

async function runCenoBotsTask(action,robot,body={},execute=false) {
  const identity=robot.externalIdentities?.find((item) => item.system === 'cenobots');
  if (!identity) throw httpError(404,'Robot is not linked to CenoBots');
  const args=[CENOBOTS_TASKS,action,'--device-open-id',String(identity.externalId)];
  if (['clean','schedule'].includes(action)) {
    const mapId=Number(body.mapId ?? robot.providerMapId); const mapVersion=String(body.mapVersion ?? robot.providerMapVersion ?? '').trim();
    args.push('--map-id',String(mapId),'--map-version',mapVersion,body.cleanEverywhere === false ? '--area-id' : '--everywhere');
    if (body.cleanEverywhere === false) {
      args.pop();
      const areas=Array.isArray(body.areaIds) ? body.areaIds : String(body.areaIds || '').split(',');
      for (const area of areas.map((item) => String(item).trim()).filter(Boolean)) args.push('--area-id',area);
    }
    args.push('--intensity',String(body.intensity || 'MEDIUM').toUpperCase());
    if (body.duration) args.push('--duration',String(Number(body.duration))); else args.push('--fixed-laps',String(Number(body.fixedLaps || 1)));
    if (body.backPointId) args.push('--back-point-id',String(body.backPointId));
    if (action === 'schedule') {
      args.push('--start-time',String(body.startTime || ''));
      for (const day of Array.isArray(body.repeat) ? body.repeat : []) args.push('--repeat',String(day));
    }
  }
  if (execute) args.push('--execute','--confirm-device',String(identity.externalId));
  const env={ ...process.env }; for (const name of ['CENOBOTS_ACCESS_KEY','CENOBOTS_SECRET_KEY']) { const value=secretEnvValue(name); if (value) env[name]=value; }
  try {
    const result=await execFileAsync(process.env.PYTHON_BIN || 'python3',args,{ cwd:__dirname,env,timeout:Math.max(20000,Number(process.env.CENOBOTS_COMMAND_TIMEOUT_MS || 60000)),maxBuffer:4*1024*1024 });
    const payload=JSON.parse(result.stdout.trim()); if (!payload.ok) throw new Error(payload.error || 'CenoBots rejected the task'); return payload;
  } catch(error) {
    if (error.status) throw error;
    let message=''; try { message=JSON.parse(String(error.stdout || '').trim()).error || ''; } catch {}
    throw httpError(502,`CenoBots command failed: ${message || error.message}`);
  }
}

async function listCenoBotsSchedules(robot) {
  const identity=robot.externalIdentities?.find((item) => item.system === 'cenobots'); if (!identity) throw httpError(404,'Robot is not linked to CenoBots');
  const config=cenoBotsControlConfiguration(); if (!config.liveEnabled || !config.credentialsConfigured) return { data:[],available:false,reason:'Live CenoBots credentials are not configured.' };
  const env={ ...process.env }; for (const name of ['CENOBOTS_ACCESS_KEY','CENOBOTS_SECRET_KEY']) { const value=secretEnvValue(name); if (value) env[name]=value; }
  try {
    const result=await execFileAsync(process.env.PYTHON_BIN || 'python3',[CENOBOTS_CLIENT,'schedules',String(identity.externalId)],{ cwd:__dirname,env,timeout:Math.max(20000,Number(process.env.CENOBOTS_COMMAND_TIMEOUT_MS || 60000)),maxBuffer:4*1024*1024 });
    const response=JSON.parse(result.stdout.trim()); if (response.success !== true || ![0,200].includes(response.code)) throw new Error(response.info || 'Schedule list failed');
    return { data:Array.isArray(response.data) ? response.data : [],available:true };
  } catch(error) { throw httpError(502,`Could not load CenoBots schedules: ${error.message}`); }
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
  const robot=state.robots.get(schedule.robotId); const technician=schedule.assignedTechnicianId ? state.technicians.get(schedule.assignedTechnicianId) : null; const dueTime=Date.parse(schedule.nextDueAt); const daysUntil=Math.ceil((dueTime-Date.now())/86400000); const reminderDays=Number.isInteger(Number(schedule.reminderDays)) ? Number(schedule.reminderDays) : 7; const dueState=schedule.status !== 'active' ? schedule.status : daysUntil < 0 ? 'overdue' : daysUntil <= 7 ? 'due_soon' : 'scheduled'; const reminderState=schedule.status !== 'active' ? schedule.status : daysUntil < 0 ? 'overdue' : daysUntil <= reminderDays ? 'reminder_due' : 'scheduled';
  return { ...clone(schedule),reminderDays,robotSerialNumber:robot?.serialNumber || 'Unknown robot',technicianName:technician?.name || null,dueState,reminderState,daysUntilDue:Number.isFinite(daysUntil) ? daysUntil : null };
}

function maintenancePrediction(robot) {
  const recentCutoff=Date.now()-30*86400000; const events=state.events.filter((item) => item.robotId === robot.id && Date.parse(item.occurredAt) >= recentCutoff && ['error','critical'].includes(item.severity)); const schedules=[...state.maintenanceSchedules.values()].filter((item) => item.robotId === robot.id && item.status === 'active').map(maintenanceScheduleView); const providerItems=Array.isArray(robot.maintenance?.maintenanceItems) ? robot.maintenance.maintenanceItems : []; const lowConsumables=providerItems.filter((item) => { const percent=Number(String(item.remainPercent ?? item.remainingPercentage ?? '').replace('%','')); return Number.isFinite(percent) && percent <= 25 || Number(item.overDueHours || 0) > 0; }); const providerErrors=Array.isArray(robot.errors) ? robot.errors.length : meaningful(robot.errors) ? 1 : 0; let score=0; const factors=[];
  if (robot.online === false) { score+=20; factors.push('Robot is offline'); }
  if (Number.isFinite(Number(robot.battery)) && Number(robot.battery) <= 20) { score+=15; factors.push(`Battery is ${Number(robot.battery)}%`); }
  if (events.length) { score+=Math.min(30,events.length*8); factors.push(`${events.length} recent error event${events.length === 1 ? '' : 's'}`); }
  if (providerErrors) { score+=Math.min(25,providerErrors*10); factors.push(`${providerErrors} active provider error${providerErrors === 1 ? '' : 's'}`); }
  if (schedules.some((item) => item.dueState === 'overdue')) { score+=35; factors.push('Scheduled maintenance is overdue'); } else if (schedules.some((item) => item.dueState === 'due_soon')) { score+=15; factors.push('Maintenance is due within seven days'); }
  if (lowConsumables.length) { score+=Math.min(25,lowConsumables.length*10); factors.push(`${lowConsumables.length} consumable${lowConsumables.length === 1 ? '' : 's'} near end of life`); }
  score=Math.min(100,score); const risk=score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 25 ? 'medium' : 'low'; const predictedWindowDays=risk === 'critical' ? 3 : risk === 'high' ? 7 : risk === 'medium' ? 21 : 60;
  return { robotId:robot.id,serialNumber:robot.serialNumber,provider:robotProvider(robot),score,risk,predictedWindowDays,factors,recommendedAction:factors.length ? 'Schedule a qualified inspection before the predicted service window and verify the listed risk factors.' : 'Continue routine monitoring and preventive maintenance.',generatedAt:timestamp() };
}

function maintenancePredictions(actor) { const data=[...state.robots.values()].filter((robot) => visibleToActor(actor,robot)).map(maintenancePrediction).sort((a,b) => b.score-a.score); return { data,summary:{ total:data.length,critical:data.filter((item) => item.risk === 'critical').length,high:data.filter((item) => item.risk === 'high').length,attention:data.filter((item) => ['critical','high','medium'].includes(item.risk)).length },generatedAt:timestamp() }; }

function workOrderView(order) { const robot=state.robots.get(order.robotId); const technician=state.technicians.get(order.technicianId); return { ...clone(order),robotSerialNumber:robot?.serialNumber || null,technicianName:technician?.name || null,siteId:robot?.siteId || null }; }

function workOrdersForActor(actor) { const robotIds=visibleRobotIds(actor); return [...state.workOrders.values()].filter((item) => robotIds.has(item.robotId) && (actor.role !== 'technician' || !item.technicianId || item.technicianId === actor.technicianId || state.technicians.get(item.technicianId)?.email === actor.email)).map(workOrderView).sort((a,b) => Date.parse(a.startsAt)-Date.parse(b.startsAt)); }

function customerDashboard(actor,requestedOrganizationId=null) {
  if (!hasPermission(actor,'customer_dashboard.read')) throw httpError(403,'Customer dashboard permission required'); const customers=[...state.organizations.values()].filter((item) => item.tenantId === actor.tenantId && item.type === 'customer'); const organizationId=hasPermission(actor,'customer_dashboard.all') ? requestedOrganizationId || customers[0]?.id : actor.organizationId; const customer=customers.find((item) => item.id === organizationId); if (!customer) throw httpError(404,'Customer organization not found'); const robots=[...state.robots.values()].filter((robot) => robot.tenantId === actor.tenantId && robot.organizationId === organizationId && matchesRobotScope(actor,robot)); const robotIds=new Set(robots.map((item) => item.id)); const cases=[...state.serviceCases.values()].filter((item) => robotIds.has(item.robotId)); const predictions=robots.map(maintenancePrediction); const sites=[...state.sites.values()].filter((site) => site.tenantId === actor.tenantId).map((site) => { const fleet=robots.filter((robot) => robot.siteId === site.id); return { id:site.id,name:site.name,total:fleet.length,online:fleet.filter((item) => item.online === true).length,attention:fleet.filter((item) => predictions.find((prediction) => prediction.robotId === item.id)?.score >= 25).length }; }).filter((site) => site.total);
  return { customer:{ id:customer.id,name:customer.name },customers:hasPermission(actor,'customer_dashboard.all') ? customers.map((item) => ({ id:item.id,name:item.name })) : [],fleet:{ total:robots.length,online:robots.filter((item) => item.online === true).length,offline:robots.filter((item) => item.online === false).length,averageBattery:(() => { const values=robots.map((item) => Number(item.battery)).filter(Number.isFinite); return values.length ? Math.round(values.reduce((sum,value) => sum+value,0)/values.length) : null; })(),providers:['autoxing','cenobots','manual'].map((provider) => ({ provider,count:robots.filter((item) => robotProvider(item) === provider).length })) },service:{ open:cases.filter((item) => !['resolved','closed'].includes(item.status)).length,closed:cases.filter((item) => item.status === 'closed').length },maintenance:{ attention:predictions.filter((item) => item.score >= 25).length,highRisk:predictions.filter((item) => ['high','critical'].includes(item.risk)).length },sites,generatedAt:timestamp() };
}

function filteredAudit(actor,searchParams) {
  const robotIds=visibleRobotIds(actor); const privileged=hasPermission(actor,'audit.read') && ['platform_admin','data_admin','support_admin'].includes(actor.role); let data=state.audit.filter((item) => item.actorId === actor.id || privileged || (actor.role === 'auditor' && robotIds.has(item.objectId))); const q=String(searchParams.get('q') || '').trim().toLowerCase(); const action=String(searchParams.get('action') || '').trim(); const result=String(searchParams.get('result') || '').trim(); const actorId=String(searchParams.get('actorId') || '').trim(); const objectType=String(searchParams.get('objectType') || '').trim(); const from=Date.parse(searchParams.get('from')); const to=Date.parse(searchParams.get('to'));
  if (q) data=data.filter((item) => [item.action,item.actorName,item.objectType,item.objectId,JSON.stringify(item.details || {})].some((value) => String(value || '').toLowerCase().includes(q))); if (action) data=data.filter((item) => item.action === action); if (result) data=data.filter((item) => item.result === result); if (actorId) data=data.filter((item) => item.actorId === actorId); if (objectType) data=data.filter((item) => item.objectType === objectType); if (Number.isFinite(from)) data=data.filter((item) => Date.parse(item.occurredAt) >= from); if (Number.isFinite(to)) data=data.filter((item) => Date.parse(item.occurredAt) <= to); return data.sort((a,b) => Date.parse(b.occurredAt)-Date.parse(a.occurredAt));
}

function autoXingMaintenanceAlerts(robots) {
  const robotIds=new Set(robots.map((robot) => robot.id)); const alerts=[];
  for (const schedule of state.maintenanceSchedules.values()) {
    if (!robotIds.has(schedule.robotId) || schedule.status !== 'active') continue; const view=maintenanceScheduleView(schedule); if (!['overdue','reminder_due'].includes(view.reminderState)) continue; const robot=state.robots.get(schedule.robotId); const severity=view.reminderState === 'overdue' ? 'error' : schedule.priority === 'critical' ? 'critical' : 'warning';
    alerts.push({ id:`maintenance:${schedule.id}`,type:'maintenance_due',tenantId:schedule.tenantId,robotId:schedule.robotId,serialNumber:robot.serialNumber,severity,title:view.reminderState === 'overdue' ? `Maintenance overdue: ${schedule.title}` : `Maintenance reminder: ${schedule.title}`,message:`Scheduled for ${schedule.nextDueAt.slice(0,10)}${view.technicianName ? ` with ${view.technicianName}` : ''}. Reminder lead time: ${view.reminderDays} days.`,recommendedAction:'Confirm the service window, assign a qualified technician, and record completion in the Robot Passport.',occurredAt:schedule.nextDueAt });
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

function cenoBotsOperations(actor) {
  const robots=[...state.robots.values()].filter((robot) => visibleToActor(actor,robot) && robot.externalIdentities?.some((identity) => identity.system === 'cenobots'));
  const alerts=[];
  const fleet=robots.map((robot) => {
    const externalId=robot.externalIdentities.find((identity) => identity.system === 'cenobots').externalId;
    const errorItems=Array.isArray(robot.errors) ? robot.errors : Array.isArray(robot.errors?.data) ? robot.errors.data : [];
    const maintenanceItems=Array.isArray(robot.maintenance?.maintenanceItems) ? robot.maintenance.maintenanceItems : [];
    const maintenanceDue=maintenanceItems.filter((item) => { const rawRemaining=String(item.remainPercent ?? '').replace('%','').trim(); const remaining=rawRemaining ? Number(rawRemaining) : NaN; return Number(item.overDueHours || 0) > 0 || Number.isFinite(remaining) && remaining <= 20; });
    errorItems.forEach((error,index) => alerts.push({ id:`${robot.id}:error:${index}`,robotId:robot.id,serialNumber:robot.serialNumber,type:'error',severity:'error',title:error.name || error.title || error.code || 'CenoBots system error',message:error.message || error.description || JSON.stringify(error).slice(0,300),occurredAt:error.occurredAt || error.timestamp || robot.updatedAt }));
    maintenanceDue.forEach((item,index) => alerts.push({ id:`${robot.id}:maintenance:${index}`,robotId:robot.id,serialNumber:robot.serialNumber,type:'maintenance_due',severity:Number(item.overDueHours || 0) > 0 ? 'error' : 'warning',title:`Maintenance due: ${item.name || 'Consumable'}`,message:Number(item.overDueHours || 0) > 0 ? `${item.overDueHours} overdue hours` : `${item.remainPercent || 'Low remaining life'} remaining`,occurredAt:robot.updatedAt }));
    return { id:robot.id,serialNumber:robot.serialNumber,externalId,online:robot.online,battery:robot.battery,charging:robot.charging,position:clone(robot.position || null),speed:robot.speed ?? null,emergencyStop:robot.emergencyStop ?? null,manualMode:robot.manualMode ?? null,docked:robot.docked ?? null,currentTask:clone(robot.providerTask || null),providerVersion:robot.providerVersion || null,buildingName:robot.providerBuildingName || null,mapId:robot.providerMapId || null,mapName:robot.providerMapName || null,mapVersion:robot.providerMapVersion || null,maintenanceItems:clone(maintenanceItems),maintenanceDueCount:maintenanceDue.length,errorCount:errorItems.length,updatedAt:robot.updatedAt };
  });
  const adapter=state.adapters.get('cenobots') || {}; const policy=managedSecretStatus().providers.find((item) => item.provider === 'cenobots') || null;
  return { summary:{ total:fleet.length,online:fleet.filter((item) => item.online === true).length,offline:fleet.filter((item) => item.online === false).length,charging:fleet.filter((item) => item.charging === true).length,docked:fleet.filter((item) => item.docked === true).length,maintenanceDue:fleet.reduce((sum,item) => sum+item.maintenanceDueCount,0),errors:fleet.reduce((sum,item) => sum+item.errorCount,0) },fleet,alerts:alerts.sort((a,b) => Date.parse(b.occurredAt || 0)-Date.parse(a.occurredAt || 0)),control:{ ...cenoBotsControlConfiguration(),canControl:canControlCenoBots(actor) },diagnostics:{ liveEnabled:cenoBotsLiveEnabled(),status:adapter.status,lastSyncAt:adapter.lastSyncAt,lastSyncStatus:adapter.lastSyncStatus,lastError:adapter.lastError ? 'Synchronization failed. Retry or inspect the protected server log.' : null,lastSyncDurationMs:adapter.lastSyncDurationMs,lastSyncCount:adapter.lastSyncCount,lastSyncWarnings:adapter.lastSyncWarnings || 0,minimumRequestIntervalSeconds:Number(process.env.CENOBOTS_MIN_REQUEST_INTERVAL_SECONDS || 1.05),secretPolicy:policy,webhook:cenoBotsWebhookConfiguration(),syncHistory:clone(adapter.syncHistory || []) },generatedAt:timestamp() };
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
    captureTrackingSample(robot,robot.updatedAt);
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
    const externalId = String(externalRobot.externalId || '').trim();
    if (!externalId) continue;
    const serialNumber = String(externalRobot.serialNumber || externalRobot.licensePlate || `CB-${externalId}`).trim().slice(0, 120);
    const canonicalStatus = externalRobot.activated === false ? 'draft' : 'active';
    let robot = [...state.robots.values()].find((item) => item.externalIdentities.some((identity) => identity.system === 'cenobots' && identity.externalId === externalId));
    if (!robot) {
      robot = { id:ids(), tenantId:actor.tenantId, organizationId:process.env.CENOBOTS_DEFAULT_ORGANIZATION_ID || 'org-demo', operatorOrganizationId:process.env.CENOBOTS_DEFAULT_OPERATOR_ORGANIZATION_ID || 'org-service', siteId:process.env.CENOBOTS_DEFAULT_SITE_ID || 'site-berlin', modelId:'model-cenobots-c1', serialNumber, status:canonicalStatus, externalIdentities:[{ system:'cenobots', externalId }], createdAt:timestamp(), updatedAt:timestamp() };
      state.robots.set(robot.id, robot);
      appendPassportEntry(robot.id, { type:'registration', source:'cenobots', data:{ externalId, serialNumber, licensePlate:externalRobot.licensePlate || null } }, actor);
    }
    Object.assign(robot, { serialNumber, status:canonicalStatus, online:externalRobot.online, battery:externalRobot.battery, charging:externalRobot.charging, position:externalRobot.position || null, speed:externalRobot.speed ?? null, emergencyStop:externalRobot.emergencyStop, manualMode:externalRobot.manualMode, docked:externalRobot.docked, statusDetails:externalRobot.statusDetails || {}, providerTask:externalRobot.task || null, providerMapId:externalRobot.mapId || null, providerMapName:externalRobot.mapName || null, providerMapVersion:externalRobot.mapVersion || null, providerVersion:externalRobot.version || null, providerBuildingName:externalRobot.buildingName || null, maintenance:externalRobot.maintenance || null, errors:externalRobot.errors || [], lastProviderError:externalRobot.stateErrors?.length ? `${externalRobot.stateErrors.length} provider warning(s)` : null, updatedAt:timestamp() });
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
    captureTrackingSample(robot,robot.updatedAt);
    synced.push(getPassport(robot.id));
  }
  const resourceErrors = bridge.resourceErrors || bridge.warnings || [];
  recordAdapterSync(adapter, { status:'success', startedAt:syncStartedAt, count:synced.length, warnings:resourceErrors.length, trigger:'manual' });
  return { provider:'cenobots', adapterVersion:'open-api-v1.0.16', source:bridge.wrapper || 'integrations/cenobots/client.py', robots:synced, count:synced.length, resources:clone(bridge.resources || {}), resourceErrors:clone(resourceErrors), commandCapabilitiesEnabled:cenoBotsControlConfiguration().ready };
}

async function executeProviderSync(provider,actor,trigger='manual') {
  if (!state.adapters.has(provider)) throw httpError(404,`Unknown adapter: ${provider}`);
  const started=Date.now();
  try {
    if (provider === 'autoxing' && autoXingLiveEnabled()) return await syncAutoXingLive(actor);
    if (provider === 'cenobots' && cenoBotsLiveEnabled()) return await syncCenoBotsLive(actor);
    return syncAdapter(provider,actor.id);
  } catch(error) {
    recordAdapterSync(state.adapters.get(provider),{ status:'error',startedAt:started,error:error.message,trigger });
    throw error;
  }
}

async function enqueueProviderSync(provider,actor,trigger='manual') {
  if (!databaseStore) throw httpError(503,'Synchronization queue is not initialized');
  const job=await databaseStore.enqueueSyncJob({ provider,tenantId:actor.tenantId,actor:publicUser(actor),trigger });
  recordAudit(actor,'adapter.sync.queued','adapter',provider,'success',{ jobId:job.id,alreadyQueued:Boolean(job.alreadyQueued) });
  return job;
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
  return hasPermission(actor,'robot.write');
}

function canRegisterRobot(actor) {
  return hasPermission(actor,'robot.register');
}

function canExport(actor) {
  return hasPermission(actor,'report.export');
}

function canControlCenoBots(actor) {
  return hasPermission(actor,'robot.control');
}

function canUseSupportPortal(actor) {
  return hasPermission(actor,'support.create') || hasPermission(actor,'support.manage');
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

function robotProvider(robot) {
  return robot.externalIdentities?.find((identity) => ['autoxing','cenobots'].includes(identity.system))?.system || 'manual';
}

function normalizedPosition(position) {
  if (!position || typeof position !== 'object') return null; const x=Number(position.x ?? position.posX ?? position.longitude); const y=Number(position.y ?? position.posY ?? position.latitude); const yaw=Number(position.yaw ?? position.angle ?? position.heading);
  return Number.isFinite(x) && Number.isFinite(y) ? { x,y,yaw:Number.isFinite(yaw) ? yaw : null } : null;
}

function captureTrackingSample(robot,sampledAt=timestamp()) {
  const position=normalizedPosition(robot.position); if (!position) return null; const samples=state.trackingSamples.get(robot.id) || []; const previous=samples[samples.length-1];
  if (previous && previous.sampledAt === sampledAt) return previous; const sample={ ...position,speed:Number.isFinite(Number(robot.speed)) ? Number(robot.speed) : null,battery:Number.isFinite(Number(robot.battery)) ? Number(robot.battery) : null,online:robot.online ?? null,sampledAt };
  if (!previous || previous.x !== sample.x || previous.y !== sample.y || previous.online !== sample.online || Date.parse(sample.sampledAt)-Date.parse(previous.sampledAt) >= 60000) { samples.push(sample); state.trackingSamples.set(robot.id,samples.slice(-120)); }
  return sample;
}

function fleetTrackingSnapshot(actor) {
  const robots=[...state.robots.values()].filter((robot) => visibleToActor(actor,robot)); const now=Date.now();
  const fleet=robots.map((robot) => { const position=normalizedPosition(robot.position); const trail=(state.trackingSamples.get(robot.id) || []).slice(-20); const updatedAt=robot.updatedAt || robot.createdAt; const ageSeconds=Math.max(0,Math.floor((now-Date.parse(updatedAt || timestamp()))/1000)); return { id:robot.id,serialNumber:robot.serialNumber,provider:robotProvider(robot),siteId:robot.siteId,online:robot.online ?? null,battery:Number.isFinite(Number(robot.battery)) ? Number(robot.battery) : null,charging:robot.charging ?? null,speed:Number.isFinite(Number(robot.speed)) ? Number(robot.speed) : null,position,heading:position?.yaw ?? null,currentTask:clone(robot.providerTask || null),updatedAt,ageSeconds,stale:ageSeconds > Math.max(60,Number(process.env.TRACKING_STALE_AFTER_SECONDS || 180)),trail:clone(trail) }; });
  return { summary:{ total:fleet.length,online:fleet.filter((item) => item.online === true).length,moving:fleet.filter((item) => Number(item.speed) > 0.05).length,located:fleet.filter((item) => item.position).length,stale:fleet.filter((item) => item.stale).length },fleet,refreshIntervalMs:Math.max(5000,Number(process.env.TRACKING_BROWSER_REFRESH_MS || 10000)),generatedAt:timestamp() };
}

function serviceCasesForActor(actor) {
  const robotIds = visibleRobotIds(actor);
  return [...state.serviceCases.values()].filter((item) => robotIds.has(item.robotId));
}

function supportTicketView(ticket) {
  const robot=state.robots.get(ticket.robotId);
  return { ...clone(ticket),robotSerialNumber:robot?.serialNumber || null,category:ticket.category || 'technical',requesterName:ticket.requesterName || null,messages:Array.isArray(ticket.messages) ? clone(ticket.messages) : [] };
}

function canManageWorkforce(actor) {
  return hasPermission(actor,'workforce.manage');
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

function technicianAvailabilityView(technician) {
  const activeAssignments=[...state.robotAssignments.values()].filter((item) => item.technicianId === technician.id && item.status === 'active'); const availability=technician.availability || {}; const dailyCapacityHours=Math.max(1,Math.min(24,Number(availability.dailyCapacityHours || 8))); const estimatedHours=activeAssignments.length*2;
  return { status:availability.status || 'available',availableFrom:availability.availableFrom || null,availableUntil:availability.availableUntil || null,workingDays:Array.isArray(availability.workingDays) && availability.workingDays.length ? availability.workingDays : ['Mon.','Tue.','Wed.','Thur.','Fri.'],dailyCapacityHours,timezone:availability.timezone || 'Europe/Berlin',notes:availability.notes || '',activeAssignments:activeAssignments.length,estimatedHours,capacityPercent:Math.min(100,Math.round(estimatedHours/dailyCapacityHours*100)) };
}

function workforceMatrix(actor, robotId = null) {
  if (actor.role === 'robot_user') throw httpError(403, 'Workforce qualification access is not available to robot accounts');
  let robots = [...state.robots.values()].filter((robot) => visibleToActor(actor, robot));
  if (robotId) robots = robots.filter((robot) => robot.id === robotId);
  const technicians = techniciansForActor(actor).filter((technician) => technician.status === 'active');
  const rows = [];
  for (const robot of robots) for (const technician of technicians) {
    const assignment = [...state.robotAssignments.values()].find((item) => item.robotId === robot.id && item.technicianId === technician.id && item.status === 'active') || null;
    rows.push({ robot: { id:robot.id, serialNumber:robot.serialNumber, modelId:robot.modelId }, technician: { id:technician.id, name:technician.name, email:technician.email, jobTitle:technician.jobTitle || 'Service Technician', organizationId:technician.organizationId,availability:technicianAvailabilityView(technician) }, eligibility: technicianEligibility(technician, robot), assignment: assignment ? clone(assignment) : null });
  }
  return { rows, robots: robots.map((robot) => ({ id:robot.id, serialNumber:robot.serialNumber, modelId:robot.modelId, requirements:workRequirementsForRobot(robot) })), technicians:technicians.map((technician) => ({ ...clone(technician),availability:technicianAvailabilityView(technician) })), assignments:clone([...state.robotAssignments.values()].filter((item) => robots.some((robot) => robot.id === item.robotId))), permissions:{ manage:canManageWorkforce(actor) }, generatedAt:timestamp() };
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

function cenoBotsWebhookConfiguration() {
  const configured=Boolean(process.env.CENOBOTS_WEBHOOK_SECRET || process.env.CENOBOTS_WEBHOOK_SECRET_FILE);
  return { configured,endpoint:'/api/v1/webhooks/cenobots',freshnessWindowSeconds:Math.max(30,Number(process.env.CENOBOTS_WEBHOOK_FRESHNESS_SECONDS || 300)),receiptCount:state.cenobotsWebhookReceipts.size,lastReceivedAt:[...state.cenobotsWebhookReceipts.values()].sort((a,b) => Date.parse(b.receivedAt)-Date.parse(a.receivedAt))[0]?.receivedAt || null };
}

function decryptCenoBotsWebhook(envelope,secret) {
  if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.encrypt !== 'string') throw httpError(401,'Invalid encrypted webhook envelope');
  try {
    const iv=Buffer.from(envelope.iv,'base64url'); const encrypted=Buffer.from(envelope.encrypt,'base64url');
    if (iv.length !== 12 || encrypted.length <= 16) throw new Error('invalid encrypted payload length');
    const ciphertext=encrypted.subarray(0,encrypted.length-16); const authTag=encrypted.subarray(encrypted.length-16);
    const key=crypto.createHash('sha256').update(secret,'utf8').digest(); const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv); decipher.setAuthTag(authTag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));
  } catch { throw httpError(401,'Unable to decrypt webhook message'); }
}

function ingestCenoBotsWebhook(message,traceId) {
  if (!message || message.messageType !== 'event' || !message.data?.id) throw httpError(400,'Webhook event envelope is invalid');
  const event=message.data; const eventId=String(event.id); const existing=state.cenobotsWebhookReceipts.get(eventId);
  if (existing) return { duplicate:true,receipt:existing };
  const deviceOpenId=String(event.device?.openId || '').trim(); const robot=[...state.robots.values()].find((item) => item.externalIdentities?.some((identity) => identity.system === 'cenobots' && String(identity.externalId) === deviceOpenId));
  const occurredAt=Number.isFinite(Number(event.occurredAt)) ? new Date(Number(event.occurredAt)).toISOString() : timestamp();
  const receipt={ id:eventId,traceId,type:String(event.type || 'unknown'),deviceOpenId,robotId:robot?.id || null,occurredAt,receivedAt:timestamp(),status:robot ? 'applied' : 'unmatched_robot',event:clone(event) };
  state.cenobotsWebhookReceipts.set(eventId,receipt);
  if (!robot) { appendOutbox('cenobots.webhook.unmatched','cenobots_device',deviceOpenId || 'unknown',{ eventId,type:event.type }); return { duplicate:false,receipt }; }
  const actor={ id:'system-cenobots-webhook',name:'CenoBots Webhook',role:'platform_admin',tenantId:robot.tenantId,organizationId:'org-ef' };
  const newer=!robot.lastWebhookOccurredAt || Date.parse(occurredAt) >= Date.parse(robot.lastWebhookOccurredAt);
  let canonical={ eventType:'provider_event',severity:'info',title:'CenoBots robot event',description:`CenoBots sent ${event.type}.` };
  if (event.type === 'robot.error.changed') {
    const codes=Array.isArray(event.data?.codes) ? event.data.codes : [];
    if (newer) robot.errors=codes.map((item) => ({ code:item.code,name:item.desc || `Error ${item.code}`,description:item.desc || '' }));
    canonical={ eventType:codes.length ? 'error' : 'error_cleared',severity:codes.length ? 'error' : 'info',title:codes.length ? 'CenoBots error state changed' : 'CenoBots errors cleared',description:codes.length ? `${codes.length} active error code${codes.length === 1 ? '' : 's'} reported.` : 'The robot reports no active error codes.' };
  } else if (event.type === 'robot.task.status_changed') {
    if (newer) robot.providerTask=clone(event.data || {});
    canonical={ eventType:'mission_status',severity:event.data?.status?.name === 'ABEND' ? 'error' : 'info',title:'CenoBots task status changed',description:`Task ${event.data?.taskId || event.data?.previousTaskId || 'state'} is ${event.data?.status?.name || (event.data?.isRunning ? 'running' : 'stopped')}.` };
  } else if (event.type === 'robot.maintenance.changed') {
    if (newer) robot.maintenanceWebhook=clone(event.data || {});
    canonical={ eventType:'maintenance',severity:'info',title:'CenoBots maintenance changed',description:`${event.data?.changedItems?.length || 0} maintenance item${event.data?.changedItems?.length === 1 ? '' : 's'} changed.` };
  } else if (event.type === 'robot.need_help_door_call') {
    canonical={ eventType:'assistance_required',severity:'warning',title:'Robot needs door assistance',description:'CenoBots reports that the robot needs help opening a door.' };
  }
  if (newer) { robot.lastWebhookOccurredAt=occurredAt; robot.updatedAt=timestamp(); }
  upsertEvent(robot.id,{ ...canonical,sourceSystem:'cenobots-webhook',sourceEventId:eventId,occurredAt,payload:clone(event) },actor);
  appendOutbox('cenobots.webhook.received','robot',robot.id,{ eventId,type:event.type,occurredAt }); recordAudit(actor,'cenobots.webhook.ingest','robot',robot.id,'success',{ eventId,type:event.type });
  return { duplicate:false,receipt };
}

async function handleCenoBotsWebhook(req,res) {
  const secret=secretEnvValue('CENOBOTS_WEBHOOK_SECRET'); if (!secret) throw httpError(503,'CenoBots webhook secret is not configured');
  if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) throw httpError(415,'CenoBots webhooks require application/json');
  const traceId=String(req.headers['x-webhook-id'] || '').trim(); const rawTimestamp=String(req.headers['x-webhook-timestamp'] || '').trim(); const requestTime=Number(rawTimestamp); const config=cenoBotsWebhookConfiguration();
  if (!traceId || !Number.isFinite(requestTime) || Math.abs(Math.floor(Date.now()/1000)-requestTime) > config.freshnessWindowSeconds) throw httpError(401,'Missing or stale webhook credentials');
  const message=decryptCenoBotsWebhook(await readBody(req),secret);
  if (message.messageType === 'challenge') { const challenge=message.data?.challenge; if (typeof challenge !== 'string' || !challenge) throw httpError(400,'Webhook challenge is missing'); return send(res,200,{ challenge }); }
  const result=ingestCenoBotsWebhook(message,traceId);
  await persistState();
  return send(res,result.receipt.status === 'unmatched_robot' ? 202 : 200,{ received:true,duplicate:result.duplicate,eventId:result.receipt.id,status:result.receipt.status });
}

function notificationWorkflow(notificationId) {
  const workflow=state.notificationWorkflows.get(notificationId); if (workflow?.status === 'snoozed' && workflow.snoozeUntil && Date.parse(workflow.snoozeUntil) <= Date.now()) return { ...workflow,status:'open',snoozeUntil:null };
  return workflow || { status:'open',technicianId:null,technicianName:null,note:'',snoozeUntil:null,updatedAt:null,updatedBy:null };
}

function notificationReadKey(actor,notificationId) { return `${actor.id}:${notificationId}`; }

function notificationsWithReadState(actor,notifications=operationalNotifications(actor)) {
  return notifications.map((item) => { const receipt=state.notificationReads.get(notificationReadKey(actor,item.id)); return { ...item,read:Boolean(receipt),readAt:receipt?.readAt || null }; });
}

function activeNotification(item) {
  return item.workflow.status !== 'resolved' && !(item.workflow.status === 'snoozed' && Date.parse(item.workflow.snoozeUntil) > Date.now());
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
  for (const schedule of state.maintenanceSchedules.values()) {
    if (!robotIds.has(schedule.robotId)) continue; const reminder=maintenanceScheduleView(schedule); if (!['reminder_due','overdue'].includes(reminder.reminderState)) continue; const robot=state.robots.get(schedule.robotId); notifications.push({ id:`maintenance-reminder:${schedule.id}:${schedule.nextDueAt}`,type:'maintenance_reminder',severity:reminder.reminderState === 'overdue' ? 'error' : schedule.priority === 'critical' ? 'critical' : 'warning',title:reminder.reminderState === 'overdue' ? `Maintenance overdue: ${schedule.title}` : `Maintenance reminder: ${schedule.title}`,message:`${robot?.serialNumber || 'Robot'} · service ${reminder.daysUntilDue === 0 ? 'is due today' : reminder.daysUntilDue > 0 ? `is due in ${reminder.daysUntilDue} days` : `was due ${Math.abs(reminder.daysUntilDue)} days ago`}${reminder.technicianName ? ` · assigned to ${reminder.technicianName}` : ' · technician not assigned'}.`,robotId:schedule.robotId,occurredAt:schedule.nextDueAt });
  }
  for (const robot of robots) { const prediction=maintenancePrediction(robot); if (prediction.score < 45) continue; notifications.push({ id:`prediction:${robot.id}`,type:'predictive_maintenance',severity:prediction.risk === 'critical' ? 'critical' : 'warning',title:`Predictive maintenance: ${robot.serialNumber}`,message:`${prediction.risk} risk (${prediction.score}%). Service is recommended within ${prediction.predictedWindowDays} days.`,robotId:robot.id,occurredAt:prediction.generatedAt }); }
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
  return notifications.slice(0, 100).map((item) => ({ ...item,workflow:clone(notificationWorkflow(item.id)) }));
}

function operationalReport(actor,days=30) {
  days=Math.min(365,Math.max(1,Number(days) || 30)); const since=Date.now()-days*86400000; const robots=[...state.robots.values()].filter((robot) => visibleToActor(actor,robot)); const robotIds=new Set(robots.map((robot) => robot.id)); const events=state.events.filter((event) => robotIds.has(event.robotId) && Date.parse(event.occurredAt) >= since);
  const externalIds=new Set(robots.flatMap((robot) => robot.externalIdentities || []).filter((identity) => identity.system === 'autoxing').map((identity) => String(identity.externalId))); const tasks=[...state.autoxing.tasks.values()].filter((task) => externalIds.has(String(taskRobotExternalId(task)))); const taskSummary=autoXingTaskSummary(tasks); const periodTasks=taskSummary.tasks.filter((task) => !task.occurredAt || Date.parse(task.occurredAt) >= since); const completed=periodTasks.filter((task) => task.completed).length; const failed=periodTasks.filter((task) => task.failed).length; const batteryValues=robots.map((robot) => Number(robot.battery)).filter(Number.isFinite); const serviceCases=[...state.serviceCases.values()].filter((item) => robotIds.has(item.robotId) && Date.parse(item.createdAt) >= since); const schedules=[...state.maintenanceSchedules.values()].filter((item) => robotIds.has(item.robotId));
  const daily=[]; for (let offset=days-1;offset>=0;offset-=1) { const day=new Date(); day.setUTCHours(0,0,0,0); day.setUTCDate(day.getUTCDate()-offset); const next=new Date(day); next.setUTCDate(next.getUTCDate()+1); const dayEvents=events.filter((item) => Date.parse(item.occurredAt) >= day.getTime() && Date.parse(item.occurredAt) < next.getTime()); daily.push({ date:day.toISOString().slice(0,10),events:dayEvents.length,errors:dayEvents.filter((item) => ['error','critical'].includes(item.severity)).length,maintenance:dayEvents.filter((item) => item.eventType.includes('maintenance')).length,tasks:periodTasks.filter((item) => item.occurredAt && Date.parse(item.occurredAt) >= day.getTime() && Date.parse(item.occurredAt) < next.getTime()).length }); }
  const providerBreakdown=['autoxing','cenobots','manual'].map((provider) => ({ provider,count:robots.filter((robot) => robotProvider(robot) === provider).length }));
  const availabilityPercent=robots.length ? Math.round(robots.filter((item) => item.online === true).length/robots.length*100) : null; const successRate=completed+failed ? Math.round(completed/(completed+failed)*100) : null; const overdue=schedules.map(maintenanceScheduleView).filter((item) => item.dueState === 'overdue').length; const closedCases=serviceCases.filter((item) => item.closedAt && Date.parse(item.closedAt) >= Date.parse(item.createdAt)); const resolutionHours=closedCases.map((item) => (Date.parse(item.closedAt)-Date.parse(item.createdAt))/3600000).filter(Number.isFinite); const technicians=techniciansForActor(actor).filter((item) => item.status === 'active'); const availableTechnicians=technicians.filter((item) => ['available','busy'].includes(technicianAvailabilityView(item).status)); const criticalEvents=events.filter((item) => item.severity === 'critical').length; const lowBattery=robots.filter((item) => item.battery != null && Number.isFinite(Number(item.battery)) && Number(item.battery) <= 20).length; const attentionRobots=robots.filter((robot) => robot.online === false || robot.battery != null && Number(robot.battery) <= 20 || events.some((event) => event.robotId === robot.id && ['error','critical'].includes(event.severity))).length; const healthInputs=[availabilityPercent,successRate,Math.max(0,100-(robots.length ? overdue/robots.length*100 : 0)),Math.max(0,100-Math.min(100,criticalEvents*10))].filter(Number.isFinite); const healthScore=healthInputs.length ? Math.round(healthInputs.reduce((sum,value) => sum+value,0)/healthInputs.length) : null; const predictions=robots.map(maintenancePrediction);
  return { period:{ days,from:new Date(since).toISOString(),to:timestamp() },fleet:{ total:robots.length,online:robots.filter((item) => item.online === true).length,offline:robots.filter((item) => item.online === false).length,availabilityPercent,averageBattery:batteryValues.length ? Math.round(batteryValues.reduce((sum,value) => sum+value,0)/batteryValues.length) : null,lowBattery,attentionRobots,healthScore,providers:providerBreakdown },tasks:{ total:periodTasks.length,completed,failed,running:periodTasks.filter((item) => item.running).length,successRate,cleanedArea:Math.round(periodTasks.map((item) => item.cleanedArea).filter(Number.isFinite).reduce((sum,value) => sum+value,0)),averageDurationMinutes:(() => { const values=periodTasks.map((item) => item.durationMinutes).filter(Number.isFinite); return values.length ? Math.round(values.reduce((sum,value) => sum+value,0)/values.length) : null; })() },service:{ casesOpened:serviceCases.length,casesClosed:closedCases.length,caseClosureRate:serviceCases.length ? Math.round(closedCases.length/serviceCases.length*100) : null,averageResolutionHours:resolutionHours.length ? Math.round(resolutionHours.reduce((sum,value) => sum+value,0)/resolutionHours.length*10)/10 : null,schedules:schedules.length,overdue,costTrackingAvailable:false },maintenance:{ predictedAttention:predictions.filter((item) => item.score >= 25).length,predictedHighRisk:predictions.filter((item) => ['high','critical'].includes(item.risk)).length,highestRiskScore:Math.max(0,...predictions.map((item) => item.score)) },workforce:{ technicians:technicians.length,available:availableTechnicians.length,onLeave:technicians.filter((item) => technicianAvailabilityView(item).status === 'on_leave').length,availabilityPercent:technicians.length ? Math.round(availableTechnicians.length/technicians.length*100) : null },events:{ total:events.length,critical:criticalEvents,errors:events.filter((item) => item.severity === 'error').length,incidentsPerRobot:robots.length ? Math.round(events.filter((item) => ['error','critical'].includes(item.severity)).length/robots.length*10)/10 : null },daily,generatedAt:timestamp() };
}

function pdfText(value) {
  return String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7e]/g,'?').replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');
}

function wrapReportLine(value,width=92) {
  const words=String(value ?? '').replace(/\s+/g,' ').trim().split(' '); const lines=[]; let current='';
  for (const word of words) { if (!word) continue; if (`${current} ${word}`.trim().length > width && current) { lines.push(current); current=word; } else current=`${current} ${word}`.trim(); }
  if (current || !lines.length) lines.push(current); return lines;
}

function simplePdf(title,reportLines) {
  const lines=[title,'Generated by Altegro',...reportLines].flatMap((line) => wrapReportLine(line)); const pageLines=[];
  for (let index=0;index<lines.length;index+=42) pageLines.push(lines.slice(index,index+42));
  const objects=[null]; const pageIds=pageLines.map((_,index) => 4+index*2);
  objects[1]='<< /Type /Catalog /Pages 2 0 R >>';
  objects[2]=`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  objects[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pageLines.forEach((page,index) => {
    const pageId=pageIds[index]; const contentId=pageId+1; const commands=['BT','/F1 11 Tf','50 792 Td','14 TL'];
    page.forEach((line,lineIndex) => { if (lineIndex) commands.push('T*'); commands.push(`(${pdfText(line)}) Tj`); }); commands.push('ET');
    const stream=commands.join('\n'); objects[pageId]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`; objects[contentId]=`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  let output='%PDF-1.4\n'; const offsets=[0]; for (let id=1;id<objects.length;id+=1) { offsets[id]=Buffer.byteLength(output); output += `${id} 0 obj\n${objects[id]}\nendobj\n`; }
  const xref=Buffer.byteLength(output); output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`; for (let id=1;id<objects.length;id+=1) output += `${String(offsets[id]).padStart(10,'0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(output,'ascii');
}

function robotPdfReport(actor,robot,type) {
  const passport=getPassport(robot.id); const model=state.models.get(robot.modelId); const site=state.sites.get(robot.siteId); const lines=[
    `Report type: ${type === 'maintenance' ? 'Maintenance report' : 'Compliance report'}`,
    `Generated: ${timestamp()}`,
    `Generated by: ${actor.name} (${actor.role})`,
    '',`Robot: ${robot.serialNumber}`,
    `Manufacturer / model: ${model?.manufacturer || '-'} ${model?.model || robot.modelId}`,
    `Site: ${site?.name || robot.siteId}`,
    `Status: ${robot.status}; online: ${robot.online ?? 'unknown'}; battery: ${robot.battery ?? 'unknown'}`,
    `Passport completeness: ${passport.completeness?.percentage ?? 0}%`,''
  ];
  if (type === 'compliance') {
    lines.push(`Certificates (${passport.certificates.length})`);
    for (const item of passport.certificates) lines.push(`- ${item.title}; issuer ${item.issuer || '-'}; valid until ${item.validUntil || '-'}; status ${item.status || '-'}`);
    lines.push('',`Documents (${passport.documents.length})`); for (const item of passport.documents) lines.push(`- ${item.title}; type ${item.documentType || 'general'}; version ${item.version || '-'}`);
    lines.push('',`Deployments (${passport.deployments.length})`); for (const item of passport.deployments) lines.push(`- ${item.title}; version ${item.version || '-'}; status ${item.status || '-'}`);
    lines.push('',`Qualified assignments (${passport.workforce?.assignedTechnicians?.length || 0})`); for (const item of passport.workforce?.assignedTechnicians || []) lines.push(`- ${item.technician?.name || item.technicianId}; eligibility ${item.eligibility?.status || '-'}`);
  } else {
    const providerItems=Array.isArray(robot.maintenance?.maintenanceItems) ? robot.maintenance.maintenanceItems : []; const schedules=[...state.maintenanceSchedules.values()].filter((item) => item.robotId === robot.id).map(maintenanceScheduleView); const cases=serviceCasesForActor(actor).filter((item) => item.robotId === robot.id);
    lines.push(`Provider maintenance items (${providerItems.length})`); for (const item of providerItems) lines.push(`- ${item.name || 'Item'}; remaining ${item.remainPercent ?? item.remainingPercentage ?? '-'}; hours ${item.remainHours ?? '-'}; overdue ${item.overDueHours ?? 0}`);
    lines.push('',`Maintenance schedules (${schedules.length})`); for (const item of schedules) lines.push(`- ${item.title}; next ${item.nextDueAt}; state ${item.dueState}; technician ${item.technicianName || 'unassigned'}`);
    lines.push('',`Service history (${cases.length})`); for (const item of cases) lines.push(`- ${item.externalId}; ${item.title}; ${item.status}; opened ${item.createdAt}; action ${item.action || '-'}`);
    const maintenanceEvents=state.events.filter((item) => item.robotId === robot.id && String(item.eventType).includes('maintenance')).slice(-30); lines.push('',`Maintenance events (${maintenanceEvents.length})`); for (const item of maintenanceEvents) lines.push(`- ${item.occurredAt}; ${item.title}; ${item.description || ''}`);
  }
  lines.push('','Integrity note: This report is generated from the Altegro Robot Passport and audit-scoped operational data.');
  return simplePdf(`Altegro ${type === 'maintenance' ? 'Maintenance' : 'Compliance'} Report`,lines);
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

async function storeAttachment(attachment,{ tenantId,robotId }) {
  if (!attachment) return null;
  if (OBJECT_STORAGE_DRIVER !== 's3') return attachment;
  if (!objectStore) throw httpError(503,'Object storage is not initialized');
  const id=ids(); const objectKey=`${tenantId}/${robotId}/${new Date().toISOString().slice(0,10)}/${id}/${attachment.name}`;
  const metadata={ id,tenantId,robotId,objectKey,name:attachment.name,contentType:attachment.contentType,size:attachment.size,sha256:attachment.sha256 };
  await objectStore.put(objectKey,Buffer.from(attachment.contentBase64,'base64'),{ ...metadata,serverSideEncryption:process.env.OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION || undefined });
  if (databaseStore) await databaseStore.recordAttachment(metadata);
  return metadata;
}

async function attachmentContent(attachment) {
  if (attachment?.objectKey) {
    if (!objectStore) throw httpError(503,'Object storage is not initialized');
    return objectStore.get(attachment.objectKey);
  }
  if (attachment?.contentBase64) return Buffer.from(attachment.contentBase64,'base64');
  throw httpError(404,'Attachment content is unavailable');
}

function publicAttachment(attachment) {
  return attachment ? { name:attachment.name,contentType:attachment.contentType,size:attachment.size,sha256:attachment.sha256 } : null;
}

function securityHeaders(contentType, extra = {}) {
  const headers={ 'content-type': contentType, 'cache-control': 'no-store', 'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'${process.env.NODE_ENV === 'production' ? '; upgrade-insecure-requests' : ''}`, 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'cross-origin-resource-policy':'same-origin','cross-origin-opener-policy':'same-origin','origin-agent-cluster':'?1','x-permitted-cross-domain-policies':'none' };
  if (process.env.NODE_ENV === 'production' || enabled(process.env.ALTEGRO_HSTS_ENABLED)) headers['strict-transport-security']=`max-age=${Math.max(300,Number(process.env.ALTEGRO_HSTS_MAX_AGE || 31536000))}; includeSubDomains`;
  return { ...headers,...extra };
}

function commaSeparatedSet(value,{ lower=true }={}) { return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean).map((item) => lower ? item.toLowerCase() : item)); }

function requestIsSecure(req) {
  if (req.socket.encrypted) return true; if (!enabled(process.env.ALTEGRO_TRUST_PROXY)) return false; return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function validateProductionRequest(req) {
  const allowedHosts=commaSeparatedSet(process.env.ALTEGRO_ALLOWED_HOSTS); const host=String(req.headers.host || '').split(':')[0].toLowerCase(); if (allowedHosts.size && !allowedHosts.has(host)) throw httpError(421,'Request host is not allowed');
  const enforceHttps=process.env.NODE_ENV === 'production' ? !['0','false','no'].includes(String(process.env.ALTEGRO_ENFORCE_HTTPS ?? 'true').toLowerCase()) : enabled(process.env.ALTEGRO_ENFORCE_HTTPS); if (enforceHttps && !requestIsSecure(req)) throw httpError(400,'HTTPS is required');
  if (['POST','PUT','PATCH','DELETE'].includes(req.method) && !String(req.url || '').startsWith('/api/v1/webhooks/')) { const origin=String(req.headers.origin || '').trim(); if (origin) { const allowedOrigins=commaSeparatedSet(process.env.ALTEGRO_ALLOWED_ORIGINS,{ lower:false }); if (allowedOrigins.size && !allowedOrigins.has(origin)) throw httpError(403,'Request origin is not allowed'); } }
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
  let storageOk=true; let persistenceDetail='disabled';
  if (filePersistenceEnabled()) {
    try { fs.accessSync(pathUtil.dirname(DATA_FILE), fs.constants.R_OK | fs.constants.W_OK); }
    catch { storageOk = false; }
    persistenceDetail=storageOk ? 'file read-write (legacy/test mode)' : 'file unavailable';
  } else if (postgresPersistenceEnabled()) {
    const health=databaseStore?.health() || { ready:false,error:'not initialized' }; storageOk=health.ready; persistenceDetail=health.ready ? 'postgres ready' : `postgres unavailable: ${health.error}`;
  }
  checks.push({ name:'persistence',ok:storageOk,detail:persistenceDetail });
  if (OBJECT_STORAGE_DRIVER === 's3') { const health=objectStore?.health() || { ready:false,error:'not initialized' }; checks.push({ name:'object-storage',ok:health.ready,detail:health.ready ? `s3 bucket ${health.bucket} ready` : `s3 unavailable: ${health.error}` }); }
  else checks.push({ name:'object-storage',ok:process.env.NODE_ENV !== 'production',detail:'inline legacy/test mode' });
  return { ready:checks.every((check) => check.ok), checks };
}

function monitoringSnapshot(actor = null) {
  const uptimeSeconds = Math.max(0,Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const robots=actor ? [...state.robots.values()].filter((robot) => visibleToActor(actor,robot)) : [...state.robots.values()]; const robotIds=new Set(robots.map((robot) => robot.id));
  const email=emailDeliverySummary(); const sms=smsDeliverySummary();
  return { service:'altegro-prototype', uptimeSeconds, startedAt, readiness:systemReadiness(), requests:{ total:runtimeMetrics.requestsTotal, active:runtimeMetrics.activeRequests, errors:runtimeMetrics.errorsTotal, averageResponseTimeMs:runtimeMetrics.requestsTotal ? Math.round(runtimeMetrics.responseTimeMsTotal/runtimeMetrics.requestsTotal) : 0, maxResponseTimeMs:runtimeMetrics.responseTimeMsMax, byStatus:clone(runtimeMetrics.byStatus) }, fleet:{ robots:robots.length, events:state.events.filter((event) => robotIds.has(event.robotId)).length, openServiceCases:[...state.serviceCases.values()].filter((item) => robotIds.has(item.robotId) && !['resolved','closed'].includes(item.status)).length }, adapters:actor && ['robot_user','auditor'].includes(actor.role) ? [] : [...state.adapters.values()].map((adapter) => ({ provider:adapter.provider,status:adapter.status,lastSyncStatus:adapter.lastSyncStatus,lastSyncAt:adapter.lastSyncAt,lastSyncDurationMs:adapter.lastSyncDurationMs,lastSyncWarnings:adapter.lastSyncWarnings || 0 })),email:actor && ['platform_admin','data_admin','support_admin'].includes(actor.role) ? { configuration:email.configuration,counts:email.counts } : null,sms:actor && ['platform_admin','data_admin','support_admin'].includes(actor.role) ? { configuration:sms.configuration,counts:sms.counts } : null };
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
  const dashboardRoute=/^\/dashboard(?:\/(overview|tracking|robots|operations|autoxing|cenobots|workforce|reports|support|admin))?\/?$/.test(pathname); const requested = pathname === '/' || dashboardRoute ? 'index.html' : pathname.slice(1);
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
  validateProductionRequest(req);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok', service: 'altegro-prototype', startedAt, now: timestamp() });
  if (req.method === 'GET' && path === '/ready') { const readiness=systemReadiness(); return send(res,readiness.ready ? 200 : 503,{ status:readiness.ready ? 'ready' : 'not_ready',...readiness,now:timestamp() }); }
  if (req.method === 'GET' && path === '/metrics') { if (!metricsAuthorized(req)) throw httpError(401,'A valid monitoring token is required'); return sendPrometheusMetrics(res); }
  if (req.method === 'POST' && path === '/api/v1/webhooks/cenobots') return handleCenoBotsWebhook(req,res);
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
  if (req.method === 'GET' && path === '/api/v1/tracking/live') return send(res,200,{ data:fleetTrackingSnapshot(actor) });
  if (req.method === 'GET' && path === '/api/v1/permissions') return send(res,200,{ data:{ role:actor.role,permissions:permissionsFor(actor),roles:Object.entries(ROLE_PERMISSIONS).map(([role,permissions]) => ({ role,permissions:[...permissions] })) } });
  if (req.method === 'GET' && path === '/api/v1/customer-dashboard') return send(res,200,{ data:customerDashboard(actor,url.searchParams.get('organizationId')) });
  if (req.method === 'GET' && path === '/api/v1/maintenance/predictions') return send(res,200,maintenancePredictions(actor));
  if (req.method === 'GET' && path === '/api/v1/notifications') {
    let data=notificationsWithReadState(actor); const q=String(url.searchParams.get('q') || '').trim().toLowerCase(); const severity=url.searchParams.get('severity'); const status=url.searchParams.get('status');
    if (q) data=data.filter((item) => [item.title,item.message,item.type,item.workflow?.technicianName].some((value) => String(value || '').toLowerCase().includes(q)));
    if (severity) data=data.filter((item) => item.severity === severity);
    if (status) data=data.filter((item) => item.workflow.status === status);
    const activeCount=data.filter(activeNotification).length; const unreadCount=data.filter((item) => activeNotification(item) && !item.read).length;
    return send(res, 200, { data, count:data.length,activeCount,unreadCount,generatedAt:timestamp() });
  }
  if (req.method === 'POST' && path === '/api/v1/notifications/read') {
    const notifications=notificationsWithReadState(actor); const requestedIds=Array.isArray(body.notificationIds) ? new Set(body.notificationIds.map(String)) : null; const visibleIds=new Set(notifications.map((item) => item.id)); const readAt=timestamp(); let readCount=0;
    if (requestedIds && [...requestedIds].some((id) => !visibleIds.has(id))) throw httpError(400,'One or more notifications are not visible');
    for (const notification of notifications) { if (requestedIds && !requestedIds.has(notification.id)) continue; state.notificationReads.set(notificationReadKey(actor,notification.id),{ userId:actor.id,notificationId:notification.id,readAt }); readCount += 1; }
    const unreadCount=notifications.filter((item) => activeNotification(item) && !state.notificationReads.has(notificationReadKey(actor,item.id))).length;
    recordAudit(actor,'notification.read','user',actor.id,'success',{ readCount });
    return send(res,200,{ readCount,unreadCount,readAt });
  }
  const notificationUpdate=route(req.method,path,/^\/api\/v1\/notifications\/([^/]+)$/);
  if (notificationUpdate && req.method === 'PATCH') {
    if (!hasPermission(actor,'notification.manage')) throw httpError(403,'Notification management permission required'); const notificationId=decodeURIComponent(notificationUpdate.id); const notification=operationalNotifications(actor).find((item) => item.id === notificationId); if (!notification) throw httpError(404,'Notification not found'); const allowed=['open','acknowledged','snoozed','resolved']; if (!allowed.includes(body.status)) throw httpError(400,'Notification status must be open, acknowledged, snoozed, or resolved');
    let technician=null; if (body.technicianId) { technician=state.technicians.get(body.technicianId); if (!technician || technician.tenantId !== actor.tenantId || technician.status !== 'active') throw httpError(400,'Select an active technician'); if (notification.robotId && !technicianEligibility(technician,state.robots.get(notification.robotId)).eligible) throw httpError(400,'The technician is not qualified for this robot'); }
    const snoozeUntil=body.status === 'snoozed' ? new Date(body.snoozeUntil || Date.now()+3600000) : null; if (snoozeUntil && Number.isNaN(snoozeUntil.getTime())) throw httpError(400,'Provide a valid snooze time');
    const workflow={ notificationId,status:body.status,technicianId:technician?.id || null,technicianName:technician?.name || null,note:String(body.note || '').trim().slice(0,2000),snoozeUntil:snoozeUntil?.toISOString() || null,updatedAt:timestamp(),updatedBy:actor.name }; state.notificationWorkflows.set(notificationId,workflow); appendOutbox('notification.workflow.updated','notification',notificationId,workflow); recordAudit(actor,'notification.workflow.update',notification.robotId ? 'robot' : 'notification',notification.robotId || notificationId,'success',{ notificationId,status:workflow.status }); return send(res,200,{ data:workflow });
  }
  if (req.method === 'GET' && path === '/api/v1/reports/operations') return send(res,200,{ data:operationalReport(actor,url.searchParams.get('days')) });
  if (req.method === 'GET' && path === '/api/v1/reports/operations.json') { const report=operationalReport(actor,url.searchParams.get('days')); recordAudit(actor,'report.operations.export','tenant',actor.tenantId,'success',{ format:'json',days:report.period.days }); return sendDownload(res,'application/json; charset=utf-8',`altegro-operations-${report.period.days}d.json`,JSON.stringify(report,null,2)); }
  if (req.method === 'GET' && path === '/api/v1/reports/operations.csv') { const report=operationalReport(actor,url.searchParams.get('days')); const rows=[['date','events','errors','maintenance','tasks'],...report.daily.map((day) => [day.date,day.events,day.errors,day.maintenance,day.tasks])]; recordAudit(actor,'report.operations.export','tenant',actor.tenantId,'success',{ format:'csv',days:report.period.days }); return sendDownload(res,'text/csv; charset=utf-8',`altegro-operations-${report.period.days}d.csv`,`${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`); }
  if (req.method === 'GET' && path === '/api/v1/cenobots/webhooks/status') { if (['robot_user','auditor'].includes(actor.role)) throw httpError(403,'Webhook configuration access is unavailable'); return send(res,200,{ data:cenoBotsWebhookConfiguration() }); }
  if (req.method === 'GET' && path === '/api/v1/workforce/matrix') { const data = workforceMatrix(actor, url.searchParams.get('robotId')); return send(res, 200, { data }); }
  if (req.method === 'GET' && path === '/api/v1/work-orders') { if (!hasPermission(actor,'work_order.read')) throw httpError(403,'Work-order access permission required'); const data=workOrdersForActor(actor); return send(res,200,{ data,count:data.length,permissions:{ manage:hasPermission(actor,'work_order.manage'),updateAssigned:hasPermission(actor,'work_order.update_assigned') } }); }
  if (req.method === 'POST' && path === '/api/v1/work-orders') {
    if (!hasPermission(actor,'work_order.manage')) throw httpError(403,'Work-order management permission required'); const robot=state.robots.get(body.robotId); const technician=state.technicians.get(body.technicianId); if (!robot || !visibleToActor(actor,robot)) throw httpError(404,'Robot not found'); if (!technician || technician.tenantId !== actor.tenantId || technician.status !== 'active') throw httpError(400,'Select an active technician'); if (!technicianEligibility(technician,robot).eligible) throw httpError(400,'The technician is not qualified for this robot'); if (['off_duty','on_leave'].includes(technicianAvailabilityView(technician).status)) throw httpError(400,'The technician is not available for work orders'); const startsAt=new Date(body.startsAt); const endsAt=new Date(body.endsAt); if (!body.title || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) throw httpError(400,'Title and a valid start/end window are required'); const conflict=[...state.workOrders.values()].find((item) => item.technicianId === technician.id && !['cancelled','completed'].includes(item.status) && Date.parse(item.startsAt) < endsAt.getTime() && Date.parse(item.endsAt) > startsAt.getTime()); if (conflict) throw httpError(409,'The technician already has a work order during this time'); const order={ id:ids(),tenantId:actor.tenantId,robotId:robot.id,technicianId:technician.id,title:String(body.title).trim().slice(0,160),description:String(body.description || '').trim().slice(0,2000),priority:['low','normal','high','critical'].includes(body.priority) ? body.priority : 'normal',status:'scheduled',startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString(),createdAt:timestamp(),updatedAt:timestamp(),createdBy:actor.id }; state.workOrders.set(order.id,order); appendPassportEntry(robot.id,{ type:'work_order_scheduled',source:'altegro',data:{ workOrderId:order.id,technicianId:technician.id,startsAt:order.startsAt,endsAt:order.endsAt,title:order.title } },actor); appendOutbox('work_order.created','work_order',order.id,order); recordAudit(actor,'work_order.create','robot',robot.id,'success',{ workOrderId:order.id,technicianId:technician.id }); return send(res,201,{ data:workOrderView(order) });
  }
  const workOrderUpdate=route(req.method,path,/^\/api\/v1\/work-orders\/([^/]+)$/);
  if (workOrderUpdate && req.method === 'PATCH') {
    const order=state.workOrders.get(workOrderUpdate.id); const robot=order ? state.robots.get(order.robotId) : null; if (!order || !robot || !visibleToActor(actor,robot)) throw httpError(404,'Work order not found'); const assignedTechnician=state.technicians.get(order.technicianId); const assignedUser=order.technicianId === actor.technicianId || assignedTechnician?.email === actor.email; if (!hasPermission(actor,'work_order.manage') && !(hasPermission(actor,'work_order.update_assigned') && assignedUser)) throw httpError(403,'Work-order update permission required'); const allowed=['scheduled','in_progress','blocked','completed','cancelled']; if (!allowed.includes(body.status)) throw httpError(400,'Invalid work-order status'); order.status=body.status; order.completionNote=String(body.completionNote || order.completionNote || '').trim().slice(0,2000); order.updatedAt=timestamp(); if (body.status === 'completed') { order.completedAt=timestamp(); appendPassportEntry(robot.id,{ type:'work_order_completed',source:'altegro',data:{ workOrderId:order.id,technicianId:order.technicianId,completionNote:order.completionNote,completedAt:order.completedAt } },actor); } appendOutbox('work_order.updated','work_order',order.id,{ status:order.status }); recordAudit(actor,'work_order.update','robot',robot.id,'success',{ workOrderId:order.id,status:order.status }); return send(res,200,{ data:workOrderView(order) });
  }
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
  const technicianAvailability=route(req.method,path,/^\/api\/v1\/technicians\/([^/]+)\/availability$/);
  if (technicianAvailability && req.method === 'PATCH') {
    if (!canManageWorkforce(actor)) throw httpError(403,'Workforce administration permission required'); const technician=state.technicians.get(technicianAvailability.id); if (!technician || technician.tenantId !== actor.tenantId) throw httpError(404,'Technician not found'); const status=String(body.status || 'available'); if (!['available','busy','off_duty','on_leave'].includes(status)) throw httpError(400,'Invalid availability status'); const workingDays=Array.isArray(body.workingDays) ? [...new Set(body.workingDays.filter((day) => ['Mon.','Tue.','Wed.','Thur.','Fri.','Sat.','Sun.'].includes(day)))] : [];
    const availableFrom=body.availableFrom ? new Date(body.availableFrom) : null; const availableUntil=body.availableUntil ? new Date(body.availableUntil) : null; if (availableFrom && Number.isNaN(availableFrom.getTime()) || availableUntil && Number.isNaN(availableUntil.getTime())) throw httpError(400,'Availability dates must be valid'); if (availableFrom && availableUntil && availableUntil <= availableFrom) throw httpError(400,'Available-until must be after available-from');
    technician.availability={ status,availableFrom:availableFrom?.toISOString() || null,availableUntil:availableUntil?.toISOString() || null,workingDays:workingDays.length ? workingDays : ['Mon.','Tue.','Wed.','Thur.','Fri.'],dailyCapacityHours:Math.max(1,Math.min(24,Number(body.dailyCapacityHours || 8))),timezone:String(body.timezone || 'Europe/Berlin').slice(0,80),notes:String(body.notes || '').trim().slice(0,1000) }; technician.updatedAt=timestamp(); appendOutbox('technician.availability.updated','technician',technician.id,technician.availability); recordAudit(actor,'technician.availability.update','technician',technician.id,'success',{ status }); return send(res,200,{ data:{ ...clone(technician),availability:technicianAvailabilityView(technician) } });
  }
  if (req.method === 'POST' && path === '/api/v1/robot-assignments') {
    if (!canManageWorkforce(actor)) throw httpError(403, 'Workforce administration permission required');
    const robot = state.robots.get(body.robotId); if (!robot || !visibleToActor(actor,robot)) throw httpError(404,'Robot not found');
    const technician = state.technicians.get(body.technicianId); if (!technician || technician.tenantId !== actor.tenantId || technician.status !== 'active') throw httpError(404,'Technician not found');
    const eligibility = technicianEligibility(technician,robot); if (!eligibility.eligible) throw httpError(409,'Technician is missing required qualifications',{ missingSkills:eligibility.missingSkills, missingCertificates:eligibility.missingCertificates });
    const availability=technicianAvailabilityView(technician); if (['off_duty','on_leave'].includes(availability.status)) throw httpError(409,`Technician is ${availability.status.replaceAll('_',' ')} and cannot receive a new assignment`);
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
  if (req.method === 'GET' && path === '/api/v1/support/tickets') {
    const data=serviceCasesForActor(actor).map(supportTicketView).sort((a,b) => Date.parse(b.updatedAt)-Date.parse(a.updatedAt)); return send(res,200,{ data,count:data.length,permissions:{ create:canUseSupportPortal(actor),reply:canUseSupportPortal(actor),manage:canWrite(actor) } });
  }
  if (req.method === 'POST' && path === '/api/v1/support/tickets') {
    if (!canUseSupportPortal(actor)) throw httpError(403,'Support ticket creation is unavailable');
    const robot=state.robots.get(body.robotId); if (!robot || !visibleToActor(actor,robot)) throw httpError(404,'Robot not found');
    const title=String(body.title || '').trim().slice(0,160); const description=String(body.description || '').trim().slice(0,4000); if (!title || !description) throw httpError(400,'Title and description are required');
    const category=String(body.category || 'technical'); if (!['technical','maintenance','integration','account','other'].includes(category)) throw httpError(400,'Invalid support category'); const severity=String(body.severity || 'warning'); if (!['info','warning','error','critical'].includes(severity)) throw httpError(400,'Invalid support priority');
    const externalId=`SUP-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; const createdAt=timestamp(); const ticket={ id:ids(),robotId:robot.id,tenantId:robot.tenantId,provider:'altegro-support',externalId,title,description,severity,status:'open',category,requesterId:actor.id,requesterName:actor.name,cause:null,action:null,parts:[],assignedTo:null,messages:[{ id:ids(),authorId:actor.id,authorName:actor.name,authorRole:actor.role,message:description,createdAt }],createdAt,updatedAt:createdAt,closedAt:null };
    state.serviceCases.set(`${ticket.provider}:${externalId}`,ticket); appendPassportEntry(robot.id,{ type:'support_ticket_opened',source:'altegro-support',data:{ serviceCaseId:ticket.id,externalId,title,category,severity } },actor); upsertEvent(robot.id,{ eventType:'support_ticket',sourceSystem:'altegro-support',sourceEventId:externalId,severity,title,description,payload:{ serviceCaseId:ticket.id,category } },actor); appendOutbox('support.ticket.opened','service_case',ticket.id,ticket); recordAudit(actor,'support.ticket.create','robot',robot.id,'success',{ ticketId:ticket.id,externalId }); return send(res,201,{ data:supportTicketView(ticket) });
  }
  const supportMessage=path.match(/^\/api\/v1\/support\/tickets\/([^/]+)\/messages$/);
  if (supportMessage && req.method === 'POST') {
    if (!canUseSupportPortal(actor)) throw httpError(403,'Support replies are unavailable'); const ticket=[...state.serviceCases.values()].find((item) => item.id === decodeURIComponent(supportMessage[1])); const robot=ticket ? state.robots.get(ticket.robotId) : null; if (!ticket || !robot || !visibleToActor(actor,robot)) throw httpError(404,'Support ticket not found');
    const message=String(body.message || '').trim().slice(0,4000); if (!message) throw httpError(400,'A reply message is required'); const update={ id:ids(),authorId:actor.id,authorName:actor.name,authorRole:actor.role,message,createdAt:timestamp() }; ticket.messages=[...(ticket.messages || []),update]; ticket.updatedAt=update.createdAt;
    if (body.status !== undefined) { if (!canWrite(actor)) throw httpError(403,'Only service staff can change ticket status'); if (!['open','in_progress','waiting','resolved','closed'].includes(body.status)) throw httpError(400,'Invalid support-ticket status'); ticket.status=body.status; if (body.status === 'closed') ticket.closedAt=timestamp(); }
    appendPassportEntry(robot.id,{ type:'support_ticket_updated',source:'altegro-support',data:{ serviceCaseId:ticket.id,externalId:ticket.externalId,messageId:update.id,status:ticket.status } },actor); appendOutbox('support.ticket.updated','service_case',ticket.id,{ messageId:update.id,status:ticket.status }); recordAudit(actor,'support.ticket.reply','robot',robot.id,'success',{ ticketId:ticket.id,status:ticket.status }); return send(res,201,{ data:supportTicketView(ticket) });
  }
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
  if (req.method === 'GET' && path === '/api/v1/sms-notifications') {
    if (!['platform_admin','data_admin','support_admin'].includes(actor.role)) throw httpError(403,'SMS notification administration permission required'); return send(res,200,{ data:smsDeliverySummary() });
  }
  if (req.method === 'POST' && path === '/api/v1/sms-notifications/test') {
    if (!['platform_admin','support_admin'].includes(actor.role)) throw httpError(403,'SMS notification test permission required'); const config=smsAlertConfiguration(); if (!config.enabled || !config.configured) throw httpError(400,config.configurationError || 'SMS alerts are disabled'); const delivery=createSmsDelivery({ notificationKey:`test:${ids()}`,type:'test',severity:'info',title:'Altegro SMS notification test',message:`Test requested by ${actor.name}.`,occurredAt:timestamp() }); try { await deliverSmsNotification(delivery); } catch(error) { throw httpError(503,`Test SMS delivery failed: ${error.message}`); } recordAudit(actor,'sms_notification.test','tenant',actor.tenantId,'success',{ deliveryId:delivery.id,recipientCount:delivery.recipients.length }); return send(res,200,{ data:{ id:delivery.id,status:delivery.status,sentAt:delivery.sentAt,recipientCount:delivery.recipients.length } });
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
  if (req.method === 'GET' && path === '/api/v1/cenobots/operations') return send(res, 200, { data:cenoBotsOperations(actor) });
  const cenoBotsSchedules=path.match(/^\/api\/v1\/cenobots\/robots\/([^/]+)\/schedules$/);
  if (cenoBotsSchedules && req.method === 'GET') {
    const robot=state.robots.get(decodeURIComponent(cenoBotsSchedules[1])); if (!robot || !visibleToActor(actor,robot)) throw httpError(404,'CenoBots robot not found');
    const result=await listCenoBotsSchedules(robot); return send(res,200,{ ...result,control:cenoBotsControlConfiguration() });
  }
  const cenoBotsCommand=path.match(/^\/api\/v1\/cenobots\/robots\/([^/]+)\/commands$/);
  if (cenoBotsCommand && req.method === 'POST') {
    const robot=state.robots.get(decodeURIComponent(cenoBotsCommand[1])); if (!robot || !visibleToActor(actor,robot) || !robot.externalIdentities?.some((item) => item.system === 'cenobots')) throw httpError(404,'CenoBots robot not found');
    if (!canControlCenoBots(actor)) { recordAudit(actor,'cenobots.command','robot',robot.id,'rejected',{ reason:'permission' }); throw httpError(403,'CenoBots control requires platform or support administration permission'); }
    const action=String(body.action || ''); const allowed=['clean','schedule','go-home','pause','continue','stop']; if (!allowed.includes(action)) throw httpError(400,'Unsupported CenoBots command'); const execute=body.execute === true;
    if (execute) {
      const config=cenoBotsControlConfiguration(); if (!config.ready) { recordAudit(actor,'cenobots.command','robot',robot.id,'rejected',{ action,reason:'disabled' }); throw httpError(503,'Live CenoBots control is disabled or credentials are incomplete'); }
      if (String(body.confirmation || '') !== robot.serialNumber) { recordAudit(actor,'cenobots.command','robot',robot.id,'rejected',{ action,reason:'confirmation' }); throw httpError(400,`Type ${robot.serialNumber} exactly to confirm this live command`); }
      if (action !== 'schedule' && robot.online !== true) throw httpError(409,'The robot must be online before a live command can be sent');
      if (['clean','go-home'].includes(action) && (robot.emergencyStop === true || robot.manualMode === true)) throw httpError(409,'Clear emergency-stop and manual mode before sending this command');
    }
    const result=await runCenoBotsTask(action,robot,body,execute); recordAudit(actor,`cenobots.${action}`,'robot',robot.id,'success',{ execute,dryRun:result.dryRun,providerRequestId:result.result?.rid || null });
    if (execute) { appendPassportEntry(robot.id,{ type:action === 'schedule' ? 'provider_schedule_created' : 'provider_command',source:'cenobots',data:{ action,providerRequestId:result.result?.rid || null,task:result.task } },actor); upsertEvent(robot.id,{ eventType:action === 'schedule' ? 'schedule_created' : 'robot_command',sourceSystem:'cenobots',sourceEventId:`command:${action}:${result.result?.rid || ids()}`,severity:'info',title:`CenoBots ${action.replaceAll('-',' ')} accepted`,description:`Live command requested by ${actor.name}.`,payload:{ action,providerRequestId:result.result?.rid || null } },actor); }
    return send(res,execute ? 202 : 200,{ data:result,robot:{ id:robot.id,serialNumber:robot.serialNumber },control:cenoBotsControlConfiguration() });
  }
  if (req.method === 'GET' && path === '/api/v1/autoxing/maintenance-schedules') {
    const robotIds=visibleRobotIds(actor); const schedules=[...state.maintenanceSchedules.values()].filter((schedule) => robotIds.has(schedule.robotId)).map(maintenanceScheduleView).sort((a,b) => Date.parse(a.nextDueAt)-Date.parse(b.nextDueAt)); return send(res,200,{ data:schedules,count:schedules.length,permissions:{ manage:canWrite(actor) } });
  }
  if (req.method === 'POST' && path === '/api/v1/autoxing/maintenance-schedules') {
    if (!canWrite(actor)) throw httpError(403,'Maintenance scheduling permission required'); for (const field of ['robotId','title','nextDueAt','intervalDays']) if (!body[field]) throw httpError(400,`Missing required field: ${field}`);
    const robot=state.robots.get(body.robotId); if (!robot || !visibleToActor(actor,robot) || !robot.externalIdentities?.some((identity) => identity.system === 'autoxing')) throw httpError(404,'AutoXing robot not found'); const nextDueAt=new Date(body.nextDueAt); if (Number.isNaN(nextDueAt.getTime())) throw httpError(400,'nextDueAt must be a valid date'); const intervalDays=Number(body.intervalDays); if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 730) throw httpError(400,'intervalDays must be between 1 and 730');
    let technician=null; if (body.assignedTechnicianId) { technician=state.technicians.get(body.assignedTechnicianId); if (!technician || technician.tenantId !== actor.tenantId || !technicianEligibility(technician,robot).eligible) throw httpError(409,'Assigned technician must be qualified for this robot'); }
    const reminderDays=body.reminderDays == null ? 7 : Number(body.reminderDays); if (!Number.isInteger(reminderDays) || reminderDays < 1 || reminderDays > 90) throw httpError(400,'reminderDays must be between 1 and 90');
    const schedule={ id:ids(),tenantId:robot.tenantId,robotId:robot.id,title:String(body.title).trim().slice(0,160),description:String(body.description || '').trim().slice(0,2000),intervalDays,reminderDays,nextDueAt:nextDueAt.toISOString(),priority:['low','normal','high','critical'].includes(body.priority) ? body.priority : 'normal',assignedTechnicianId:technician?.id || null,status:'active',lastCompletedAt:null,createdAt:timestamp(),updatedAt:timestamp(),createdBy:actor.id };
    state.maintenanceSchedules.set(schedule.id,schedule); appendPassportEntry(robot.id,{ type:'maintenance_scheduled',source:'altegro',data:{ scheduleId:schedule.id,title:schedule.title,nextDueAt:schedule.nextDueAt,intervalDays,reminderDays,assignedTechnicianId:schedule.assignedTechnicianId } },actor); appendOutbox('maintenance.schedule.created','maintenance_schedule',schedule.id,schedule); recordAudit(actor,'maintenance.schedule.create','robot',robot.id,'success',{ scheduleId:schedule.id,reminderDays }); return send(res,201,{ data:maintenanceScheduleView(schedule) });
  }
  const maintenanceScheduleUpdate=route(req.method,path,/^\/api\/v1\/autoxing\/maintenance-schedules\/([^/]+)$/);
  if (maintenanceScheduleUpdate && req.method === 'PATCH') {
    if (!canWrite(actor)) throw httpError(403,'Maintenance scheduling permission required'); const schedule=state.maintenanceSchedules.get(maintenanceScheduleUpdate.id); const robot=schedule ? state.robots.get(schedule.robotId) : null; if (!schedule || !robot || !visibleToActor(actor,robot)) throw httpError(404,'Maintenance schedule not found');
    if (body.status && !['active','paused','cancelled'].includes(body.status)) throw httpError(400,'Invalid maintenance schedule status'); if (body.status) schedule.status=body.status; if (body.nextDueAt) { const next=new Date(body.nextDueAt); if (Number.isNaN(next.getTime())) throw httpError(400,'nextDueAt must be a valid date'); schedule.nextDueAt=next.toISOString(); } if (body.reminderDays != null) { const reminderDays=Number(body.reminderDays); if (!Number.isInteger(reminderDays) || reminderDays < 1 || reminderDays > 90) throw httpError(400,'reminderDays must be between 1 and 90'); schedule.reminderDays=reminderDays; }
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
    if (!event.attachment) throw httpError(404, 'Event has no downloadable attachment');
    recordAudit(actor, 'event.attachment.download', 'robot', robot.id, 'success', { eventId: event.eventId });
    return sendDownload(res,event.attachment.contentType,event.attachment.name,await attachmentContent(event.attachment));
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
    return send(res,200,{ data:data.slice(0,limit).map((event) => ({ ...clone(event),attachment:publicAttachment(event.attachment) })),count });
  }
  if (req.method === 'GET' && path === '/api/v1/audit') {
    if (!hasPermission(actor,'audit.read')) throw httpError(403,'Audit access permission required'); const filtered=filteredAudit(actor,url.searchParams); const total=filtered.length; const limit=Math.min(500,Math.max(1,Number(url.searchParams.get('limit') || 100))); const data=filtered.slice(0,limit); const source=filteredAudit(actor,new URLSearchParams()); return send(res,200,{ data,count:data.length,total,facets:{ actions:[...new Set(source.map((item) => item.action))].sort(),actors:[...new Map(source.map((item) => [item.actorId,{ id:item.actorId,name:item.actorName }])).values()].sort((a,b) => a.name.localeCompare(b.name)),objectTypes:[...new Set(source.map((item) => item.objectType))].sort(),results:[...new Set(source.map((item) => item.result))].sort() },generatedAt:timestamp() });
  }
  if (req.method === 'GET' && path === '/api/v1/audit.csv') { if (!hasPermission(actor,'audit.export')) throw httpError(403,'Audit export permission required'); const data=filteredAudit(actor,url.searchParams); const rows=[['occurredAt','actor','action','objectType','objectId','result'],...data.map((item) => [item.occurredAt,item.actorName,item.action,item.objectType,item.objectId,item.result])]; recordAudit(actor,'audit.export','tenant',actor.tenantId,'success',{ count:data.length }); return sendDownload(res,'text/csv; charset=utf-8','altegro-audit.csv',`${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`); }
  if (req.method === 'GET' && path === '/api/v1/robots') {
    const allVisible = [...state.robots.values()].filter((robot) => visibleToActor(actor, robot)); let data = [...allVisible];
    for (const field of ['status', 'modelId', 'siteId']) if (url.searchParams.get(field)) data = data.filter((robot) => robot[field] === url.searchParams.get(field));
    if (url.searchParams.get('provider')) data=data.filter((robot) => robotProvider(robot) === url.searchParams.get('provider'));
    if (url.searchParams.get('serialNumber')) { const serial = url.searchParams.get('serialNumber').trim().toLowerCase(); data = data.filter((robot) => robot.serialNumber.toLowerCase() === serial); }
    const live = url.searchParams.get('live');
    if (live === 'online') data = data.filter((robot) => robot.online === true);
    if (live === 'offline') data = data.filter((robot) => robot.online === false);
    if (live === 'unknown') data = data.filter((robot) => robot.online == null);
    if (url.searchParams.get('q')) {
      const q = url.searchParams.get('q').trim().toLowerCase();
      data = data.filter((robot) => [robot.id, robot.serialNumber, robot.modelId, robot.siteId, robot.organizationId, robot.operatorOrganizationId, ...(robot.externalIdentities || []).flatMap((identity) => [identity.system, identity.externalId])].some((value) => String(value || '').toLowerCase().includes(q)));
    }
    const batteryMin=Number(url.searchParams.get('batteryMin')); const batteryMax=Number(url.searchParams.get('batteryMax')); if (url.searchParams.has('batteryMin') && Number.isFinite(batteryMin)) data=data.filter((robot) => Number.isFinite(Number(robot.battery)) && Number(robot.battery) >= Math.max(0,batteryMin)); if (url.searchParams.has('batteryMax') && Number.isFinite(batteryMax)) data=data.filter((robot) => Number.isFinite(Number(robot.battery)) && Number(robot.battery) <= Math.min(100,batteryMax));
    if (url.searchParams.get('attention') === 'true') data=data.filter((robot) => maintenancePrediction(robot).score >= 25 || robot.online === false || meaningful(robot.errors));
    const sort = ['serialNumber', 'modelId', 'siteId', 'status', 'updatedAt'].includes(url.searchParams.get('sort')) ? url.searchParams.get('sort') : 'serialNumber';
    const direction = url.searchParams.get('order') === 'desc' ? -1 : 1;
    data.sort((a, b) => String(a[sort] || '').localeCompare(String(b[sort] || ''), undefined, { numeric: true, sensitivity: 'base' }) * direction);
    const count = data.length; const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('pageSize') || 10))); const pageCount = Math.max(1, Math.ceil(count / pageSize)); const requestedPage = Math.max(1, Number(url.searchParams.get('page') || 1)); const page = Math.min(requestedPage, pageCount);
    const countedFacet=(values,labelFor=(value) => value) => [...new Set(values.filter(Boolean))].sort().map((value) => ({ value,label:labelFor(value),count:values.filter((item) => item === value).length })); const providers=allVisible.map(robotProvider); const sites=allVisible.map((robot) => robot.siteId); const models=allVisible.map((robot) => robot.modelId);
    const facets = { total: allVisible.length, active: allVisible.filter((robot) => robot.status === 'active').length, draft: allVisible.filter((robot) => robot.status === 'draft').length, online: allVisible.filter((robot) => robot.online === true).length, offline: allVisible.filter((robot) => robot.online === false).length,providers:countedFacet(providers,(value) => value === 'manual' ? 'Manual' : value === 'autoxing' ? 'AutoXing' : value === 'cenobots' ? 'CenoBots' : value),sites:countedFacet(sites,(value) => state.sites.get(value)?.name || value),models:countedFacet(models,(value) => state.models.get(value)?.model || value.replace('model-','').replaceAll('-',' ')) };
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
    if (!state.adapters.has(sync.id)) throw httpError(404,`Unknown adapter: ${sync.id}`);
    if (asyncSyncEnabled()) { if (!['autoxing','cenobots'].includes(sync.id)) throw httpError(400,'Only live provider adapters can be queued'); const job=await enqueueProviderSync(sync.id,actor); return send(res,202,{ data:job }); }
    const result=await executeProviderSync(sync.id,actor); recordAudit(actor,'adapter.sync','adapter',sync.id,'success',{ count:result.count ?? 1 }); return send(res,200,{ data:result });
  }

  if (req.method === 'GET' && path === '/api/v1/sync-jobs') {
    if (!asyncSyncEnabled()) return send(res,200,{ data:[],count:0,mode:'inline' });
    const jobs=await databaseStore.listSyncJobs(actor.tenantId,Number(url.searchParams.get('limit') || 25)); return send(res,200,{ data:jobs,count:jobs.length,mode:'async' });
  }
  const syncJob=route(req.method,path,/^\/api\/v1\/sync-jobs\/([^/]+)$/);
  if (syncJob && req.method === 'GET') {
    if (!asyncSyncEnabled()) throw httpError(404,'Synchronization job not found');
    const job=await databaseStore.getSyncJob(syncJob.id,actor.tenantId); if (!job) throw httpError(404,'Synchronization job not found'); return send(res,200,{ data:job });
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
  const robotPdf=path.match(/^\/api\/v1\/robots\/([^/]+)\/reports\/(maintenance|compliance)\.pdf$/);
  if (robotPdf && req.method === 'GET') {
    const item=state.robots.get(decodeURIComponent(robotPdf[1])); if (!item || !visibleToActor(actor,item)) throw httpError(404,'Robot not found'); const reportType=robotPdf[2]; const report=robotPdfReport(actor,item,reportType); recordAudit(actor,`report.${reportType}.pdf`,'robot',item.id,'success',{ bytes:report.length }); return sendDownload(res,'application/pdf',`altegro-${reportType}-${item.serialNumber}.pdf`,report);
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
      record = { ...common, documentType:body.documentType || 'general',version:body.version || '1.0',attachment:await storeAttachment(validateEventAttachment(body.attachment),{ tenantId:item.tenantId,robotId:item.id }) };
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
    appendPassportEntry(item.id,{ type:body.recordType,source:record.source,data:{ ...record,attachment:publicAttachment(record.attachment) || undefined } },actor);
    appendOutbox(`${body.recordType}.created`, body.recordType, record.id, { robotId: item.id, title: record.title }); recordAudit(actor, `${body.recordType}.create`, 'robot', item.id, 'success', { recordId: record.id });
    return send(res,201,{ data:{ ...record,attachment:publicAttachment(record.attachment) || undefined } });
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
      const attachment=await storeAttachment(validateEventAttachment(body.attachment),{ tenantId:item.tenantId,robotId:item.id });
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
if (filePersistenceEnabled()) persistState();
const server = http.createServer(async (req, res) => {
  const requestStartedAt=Date.now(); runtimeMetrics.activeRequests += 1;
  res.once('finish',() => { const duration=Date.now()-requestStartedAt; runtimeMetrics.activeRequests=Math.max(0,runtimeMetrics.activeRequests-1); runtimeMetrics.requestsTotal += 1; runtimeMetrics.responseTimeMsTotal += duration; runtimeMetrics.responseTimeMsMax=Math.max(runtimeMetrics.responseTimeMsMax,duration); const statusClass=`${Math.floor(res.statusCode/100)}xx`; runtimeMetrics.byStatus[statusClass]=(runtimeMetrics.byStatus[statusClass] || 0)+1; if (res.statusCode >= 500) runtimeMetrics.errorsTotal += 1; });
  try {
    await handle(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') await persistState();
  } catch (error) {
    const status = Number(error.status) || 500; const correlationId = ids();
    if (status >= 500) console.error(`[${correlationId}] ${req.method} ${req.url}:`, error);
    if (res.headersSent) return;
    const code = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : status === 409 ? 'CONFLICT' : status === 429 ? 'RATE_LIMITED' : status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
    send(res, status, { error: { code, message: status >= 500 ? 'The operation could not be completed. Retry or contact support with the correlation ID.' : error.message, details: status < 500 ? error.details : undefined, correlationId } });
  }
});

const notificationSocketClients=new Set();
function webSocketFrame(value) { const payload=Buffer.from(JSON.stringify(value)); let header; if (payload.length < 126) header=Buffer.from([0x81,payload.length]); else if (payload.length <= 65535) { header=Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(payload.length,2); } else { header=Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(payload.length),2); } return Buffer.concat([header,payload]); }
function sendNotificationSocketSnapshot(client,force=false) { if (client.socket.destroyed) return; const notifications=notificationsWithReadState(client.actor); const active=notifications.filter(activeNotification); const unreadCount=active.filter((item) => !item.read).length; const signature=JSON.stringify(active.map((item) => [item.id,item.read,item.workflow.status,item.workflow.updatedAt])); if (!force && signature === client.signature) return; client.signature=signature; client.socket.write(webSocketFrame({ type:'notifications.changed',unreadCount,count:active.length,latest:active.slice(0,5).map((item) => ({ id:item.id,title:item.title,severity:item.severity,occurredAt:item.occurredAt,read:item.read })),generatedAt:timestamp() })); }
function broadcastNotificationUpdates() { for (const client of notificationSocketClients) { try { sendNotificationSocketSnapshot(client); } catch { client.socket.destroy(); notificationSocketClients.delete(client); } } }
server.on('upgrade',(req,socket) => { try { validateProductionRequest(req); const url=new URL(req.url,`http://${req.headers.host || 'localhost'}`); if (url.pathname !== '/api/v1/notifications/stream') throw httpError(404,'WebSocket route not found'); const actor=requireActor(req); const key=String(req.headers['sec-websocket-key'] || ''); if (!key || req.headers['sec-websocket-version'] !== '13') throw httpError(400,'Invalid WebSocket handshake'); const accept=crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64'); socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`); const client={ socket,actor,signature:null }; notificationSocketClients.add(client); socket.on('data',(data) => { if ((data[0] & 0x0f) === 0x08) socket.end(); }); socket.on('close',() => notificationSocketClients.delete(client)); socket.on('error',() => notificationSocketClients.delete(client)); sendNotificationSocketSnapshot(client,true); } catch(error) { if (!socket.destroyed) socket.end(`HTTP/1.1 ${error.status || 401} ${error.status === 404 ? 'Not Found' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } });
const notificationSocketTimer=setInterval(broadcastNotificationUpdates,2000); notificationSocketTimer.unref?.();

const providerPollTimers=[];
let emailQueueTimer = null;
function startEmailDeliveryWorker() { if (!emailAlertConfiguration().enabled && !smsAlertConfiguration().enabled) return; processEmailQueue(); const processAlerts=async () => { await processEmailQueue(); for (const delivery of state.smsDeliveries.filter((item) => ['pending','failed'].includes(item.status) && item.attempts < 3 && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= Date.now())).slice(0,20)) await deliverSmsNotification(delivery).catch(() => {}); }; processAlerts(); emailQueueTimer=setInterval(processAlerts,60000); emailQueueTimer.unref?.(); }
let operationsAutomationTimer=null;
function startOperationsAutomationWorker() { operationsAutomationTimer=setInterval(() => { for (const tenantId of state.tenants.keys()) evaluateAlertEscalations(tenantId); },60000); operationsAutomationTimer.unref?.(); }
let syncWorkerTimer=null; let syncWorkerRunning=false;
const syncWorkerId=`${process.env.HOSTNAME || 'altegro'}:${process.pid}:${ids()}`;
async function processSyncJobs() {
  if (!asyncSyncEnabled() || syncWorkerRunning) return; syncWorkerRunning=true;
  try {
    const job=await databaseStore.claimSyncJob(syncWorkerId,Number(process.env.SYNC_JOB_STALE_SECONDS || 900)); if (!job) return;
    const actor={ ...job.actor,tenantId:job.tenantId };
    try {
      const result=await executeProviderSync(job.provider,actor,job.trigger); await persistState();
      const compact={ provider:job.provider,count:result.count ?? 1,resources:result.resources || null,resourceErrors:result.resourceErrors || [],completedAt:timestamp() };
      await databaseStore.completeSyncJob(job.id,compact); recordAudit(actor,'adapter.sync.completed','adapter',job.provider,'success',{ jobId:job.id,count:compact.count }); await persistState();
    } catch(error) { await databaseStore.failSyncJob(job.id,error.message); recordAudit(actor,'adapter.sync.completed','adapter',job.provider,'error',{ jobId:job.id }); await persistState().catch(() => {}); }
  } finally { syncWorkerRunning=false; }
}
function startSyncJobWorker() { if (!asyncSyncEnabled()) return; processSyncJobs(); syncWorkerTimer=setInterval(processSyncJobs,Math.max(250,Number(process.env.SYNC_JOB_POLL_INTERVAL_MS || 1000))); syncWorkerTimer.unref?.(); }
function startProviderPolling() {
  const configurations=[
    { provider:'autoxing',enabled:autoXingLiveEnabled(),interval:autoXingPollIntervalMs() },
    { provider:'cenobots',enabled:cenoBotsLiveEnabled(),interval:cenoBotsPollIntervalMs() },
  ];
  for (const config of configurations) {
    if (!config.enabled || !config.interval) continue;
    const actor={ id:`system-${config.provider}-poller`,name:`${config.provider} Poller`,role:'platform_admin',tenantId:'tenant-demo',organizationId:'org-ef' };
    let running=false;
    const timer=setInterval(async () => {
      if (running) return; running=true;
      try { if (asyncSyncEnabled()) await enqueueProviderSync(config.provider,actor,'poll'); else { await executeProviderSync(config.provider,actor,'poll'); await persistState(); } }
      catch(error) { console.error(`${config.provider} polling failed: ${error.message}`); }
      finally { running=false; }
    },config.interval);
    timer.unref?.(); providerPollTimers.push(timer);
  }
}

if (require.main === module) {
  initializeInfrastructure().then(() => server.listen(PORT,BIND_HOST,() => { startProviderPolling(); startSyncJobWorker(); startEmailDeliveryWorker(); startOperationsAutomationWorker(); console.log(`Altegro listening on http://${BIND_HOST}:${PORT} (${PERSISTENCE_DRIVER} persistence, ${SYNC_MODE} sync)`); })).catch((error) => { console.error(`Altegro startup failed: ${error.message}`); process.exit(1); });
  const shutdown = async (signal) => { console.log(`${signal} received; saving state and shutting down.`); for (const timer of providerPollTimers) clearInterval(timer); if (syncWorkerTimer) clearInterval(syncWorkerTimer); if (emailQueueTimer) clearInterval(emailQueueTimer); if (operationsAutomationTimer) clearInterval(operationsAutomationTimer); clearInterval(notificationSocketTimer); for (const client of notificationSocketClients) client.socket.destroy(); try { await persistState(); } catch (error) { console.error(`Final persistence failed: ${error.message}`); } server.close(async () => { await databaseStore?.close().catch(() => {}); await objectStore?.close().catch(() => {}); process.exit(0); }); };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports={ server,state,persistState,DATA_FILE,initializeInfrastructure };
