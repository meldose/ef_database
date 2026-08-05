'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
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
      passportEntries: mapEntries(state.passportEntries), serviceCases: mapEntries(state.serviceCases), technicians: mapEntries(state.technicians), modelRequirements: mapEntries(state.modelRequirements), robotAssignments: mapEntries(state.robotAssignments), documents: state.documents, certificates: state.certificates,
      deployments: state.deployments, compatibilityRecords: state.compatibilityRecords, events: state.events, audit: state.audit, outbox: state.outbox,
      autoxing: { ...state.autoxing, pois: mapEntries(state.autoxing.pois), areas: mapEntries(state.autoxing.areas), maps: mapEntries(state.autoxing.maps), tasks: mapEntries(state.autoxing.tasks) },
      adapterRuntime: mapEntries(state.adapters).map(([provider, adapter]) => [provider, { lastSyncAt: adapter.lastSyncAt || null, lastSyncStatus: adapter.lastSyncStatus || 'never', lastError: adapter.lastError || null }])
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
    for (const name of ['tenants', 'organizations', 'sites', 'models', 'robots', 'passportEntries', 'serviceCases', 'technicians', 'modelRequirements', 'robotAssignments']) replaceMap(state[name], saved.state[name]);
    for (const name of ['documents', 'certificates', 'deployments', 'compatibilityRecords', 'events', 'audit', 'outbox']) if (Array.isArray(saved.state[name])) state[name] = saved.state[name];
    const autoXing = saved.state.autoxing || {};
    state.autoxing.businesses = autoXing.businesses || []; state.autoxing.buildings = autoXing.buildings || []; state.autoxing.lastSyncAt = autoXing.lastSyncAt || null; state.autoxing.resourceErrors = autoXing.resourceErrors || [];
    for (const name of ['pois', 'areas', 'maps', 'tasks']) replaceMap(state.autoxing[name], autoXing[name]);
    for (const [provider, runtime] of saved.state.adapterRuntime || []) Object.assign(state.adapters.get(provider) || {}, runtime);
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
    provider: 'autoxing', version: 'wrapper-backed', status: autoXingLiveEnabled() ? 'live-wrapper-enabled' : 'mock-fallback', integration: 'autoxing/lib/api_lib.py', lastSyncAt: null, lastSyncStatus: 'never', lastError: null, pollingIntervalMs: autoXingPollIntervalMs(),
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
  return fullEvent;
}

function syncAdapter(provider, actorId = 'system') {
  const adapter = state.adapters.get(provider);
  if (!adapter) throw httpError(404, `Unknown adapter: ${provider}`);
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
  return { provider, adapterVersion: adapter.version, robot: getPassport(robot.id), commandCapabilitiesEnabled: false };
}

async function runAutoXingBridge(command = 'snapshot') {
  const env = { ...process.env, AUTOXING_REPO_PATH: AUTOXING_REPO, AUTOXING_LIB_PATH: AUTOXING_LIB };
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
    const result = await execFileAsync(process.env.PYTHON_BIN || 'python3', [CENOBOTS_CLIENT, command], { cwd: __dirname, env:process.env, timeout:Math.max(20000, Number(process.env.CENOBOTS_BRIDGE_TIMEOUT_MS || 120000)), maxBuffer:32 * 1024 * 1024 });
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

async function syncAutoXingLive(actor) {
  const adapter = state.adapters.get('autoxing');
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
    if (externalRobot.errors && JSON.stringify(externalRobot.errors) !== '[]' && JSON.stringify(externalRobot.errors) !== '{}') upsertEvent(robot.id, { eventType: 'error', sourceSystem: 'autoxing', sourceEventId: `${externalId}:errors:${JSON.stringify(externalRobot.errors)}`, title: 'AutoXing alert or error', description: 'An alert or error was received from AutoXing.', severity: 'error', payload: { errors: externalRobot.errors } }, actor);
    if (externalRobot.emergencyStop === true) upsertEvent(robot.id, { eventType: 'emergency_stop', sourceSystem: 'autoxing', sourceEventId: `${externalId}:emergency-stop:true`, title: 'AutoXing emergency stop active', description: 'The emergency-stop state is active according to AutoXing.', severity: 'critical', payload: { emergencyStop: true, statusDetails: externalRobot.statusDetails } }, actor);
    if (externalRobot.obstruction === true) upsertEvent(robot.id, { eventType: 'obstruction', sourceSystem: 'autoxing', sourceEventId: `${externalId}:obstruction:true`, title: 'AutoXing obstruction detected', description: 'The robot reports an obstruction according to AutoXing.', severity: 'warning', payload: { obstruction: true, statusDetails: externalRobot.statusDetails } }, actor);
    if (externalRobot.stateError) upsertEvent(robot.id, { eventType: 'error', sourceSystem: 'autoxing', sourceEventId: `${externalId}:state-error:${externalRobot.stateError}`, title: 'AutoXing status read failed', description: externalRobot.stateError, severity: 'warning', payload: { stateError: externalRobot.stateError } }, actor);
    synced.push(getPassport(robot.id));
  }
  storeAutoXingResources(bridge.resources, bridge.resourceErrors);
  if (adapter) { adapter.lastSyncAt = timestamp(); adapter.lastSyncStatus = 'success'; adapter.lastError = bridge.resourceErrors?.length ? `${bridge.resourceErrors.length} resource warnings` : null; }
  return { provider: 'autoxing', adapterVersion: 'wrapper-backed', source: bridge.wrapper, robots: synced, count: synced.length, resources: { businesses: state.autoxing.businesses.length, buildings: state.autoxing.buildings.length, poiRobotScopes: state.autoxing.pois.size, areaRobotScopes: state.autoxing.areas.size, maps: state.autoxing.maps.size, tasks: state.autoxing.tasks.size, warnings: state.autoxing.resourceErrors.length }, resourceErrors: clone(state.autoxing.resourceErrors), commandCapabilitiesEnabled: false };
}

async function syncCenoBotsLive(actor) {
  const adapter = state.adapters.get('cenobots');
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
  if (adapter) { adapter.lastSyncAt = timestamp(); adapter.lastSyncStatus = 'success'; adapter.lastError = null; }
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
      try {
        const result = await syncAutoXingLive(actor); recordAudit(actor, 'adapter.sync.live', 'adapter', sync.id, 'success', { count: result.count }); return send(res, 200, { data: result });
      } catch (error) {
        const adapter = state.adapters.get('autoxing'); if (adapter) { adapter.lastSyncStatus = 'error'; adapter.lastError = error.message; }
        throw error;
      }
    }
    if (sync.id === 'cenobots' && cenoBotsLiveEnabled()) {
      try {
        const result = await syncCenoBotsLive(actor); recordAudit(actor, 'adapter.sync.live', 'adapter', sync.id, 'success', { count:result.count, warnings:result.resourceErrors.length }); return send(res, 200, { data:result });
      } catch (error) {
        const adapter = state.adapters.get('cenobots'); if (adapter) { adapter.lastSyncStatus = 'error'; adapter.lastError = error.message; }
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
if (persistenceEnabled()) persistState();
const server = http.createServer(async (req, res) => {
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
function startAutoXingPolling() {
  if (!autoXingLiveEnabled() || autoXingPollIntervalMs() === 0) return;
  const pollActor = { id: 'system-autoxing-poller', name: 'AutoXing Poller', role: 'platform_admin', tenantId: 'tenant-demo', organizationId: 'org-ef' };
  autoXingPollTimer = setInterval(async () => {
    if (autoXingPollRunning) return;
    autoXingPollRunning = true;
    try { await syncAutoXingLive(pollActor); } catch (error) { const adapter = state.adapters.get('autoxing'); if (adapter) { adapter.lastSyncStatus = 'error'; adapter.lastError = error.message; } }
    finally { autoXingPollRunning = false; try { persistState(); } catch (error) { console.error(`Could not persist AutoXing synchronization: ${error.message}`); } }
  }, autoXingPollIntervalMs());
  autoXingPollTimer.unref?.();
}

if (require.main === module) {
  server.listen(PORT, BIND_HOST, () => { startAutoXingPolling(); console.log(`Altegro prototype listening on http://${BIND_HOST}:${PORT}`); });
  const shutdown = (signal) => { console.log(`${signal} received; saving state and shutting down.`); try { persistState(); } catch (error) { console.error(`Final persistence failed: ${error.message}`); } server.close(() => process.exit(0)); };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { server, state, persistState, DATA_FILE };
