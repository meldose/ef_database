'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const pathUtil = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const PORT = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
const MAX_EVENT_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const ids = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const publicDir = pathUtil.join(__dirname, 'public');
const execFileAsync = promisify(execFile);
const AUTOXING_BRIDGE = pathUtil.join(__dirname, 'integrations', 'autoxing_bridge.py');
const AUTOXING_REPO = process.env.AUTOXING_REPO_PATH || pathUtil.resolve(__dirname, '..', 'autoxing');
const AUTOXING_LIB = process.env.AUTOXING_LIB_PATH || pathUtil.join(AUTOXING_REPO, 'lib');
const autoXingLiveEnabled = () => ['1', 'true', 'yes'].includes(String(process.env.AUTOXING_LIVE || '').toLowerCase());
const autoXingPollIntervalMs = () => Math.max(0, Number(process.env.AUTOXING_POLL_INTERVAL_MS || 300000));
const parseJsonEnv = (name, fallback = {}) => { try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; } catch { return fallback; } };
const autoXingMappingRequired = () => ['1', 'true', 'yes'].includes(String(process.env.AUTOXING_REQUIRE_MAPPING || '').toLowerCase());

const state = {
  tenants: new Map(),
  organizations: new Map(),
  sites: new Map(),
  models: new Map(),
  robots: new Map(),
  passportEntries: new Map(),
  serviceCases: new Map(),
  events: [],
  audit: [],
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
  // Robot accounts are intentionally read-only prototype accounts. In production,
  // replace these demo passwords with OIDC/SSO identities and database memberships.
  'demo-robot-ax-001': { id: 'user-robot-ax-001', name: 'AX-DEMO-001 User', email: 'robot-ax-001@demo.altegro.local', demoPassword: 'AX-robot-001-demo', role: 'robot_user', tenantId: 'tenant-demo', organizationId: 'org-demo', robotSystem: 'autoxing', robotExternalId: 'AX-1001', robotSerialNumber: 'AX-DEMO-001' },
  'demo-robot-cb-001': { id: 'user-robot-cb-001', name: 'CB-DEMO-001 User', email: 'robot-cb-001@demo.altegro.local', demoPassword: 'CB-robot-001-demo', role: 'robot_user', tenantId: 'tenant-demo', organizationId: 'org-demo', robotSystem: 'cenobots', robotExternalId: 'CB-1001', robotSerialNumber: 'CB-DEMO-001' },
  'demo-robot-se52512706922ne': { id: 'user-robot-se52512706922ne', name: 'SE52512706922NE User', email: 'robot-se52512706922ne@demo.altegro.local', demoPassword: 'SE-robot-001-demo', role: 'robot_user', tenantId: 'tenant-demo', organizationId: 'org-demo', robotSystem: 'autoxing', robotSerialNumber: 'SE52512706922NE' }
};

function seed() {
  state.tenants.set('tenant-demo', { id: 'tenant-demo', name: 'Demo Customer Tenant', status: 'active' });
  state.organizations.set('org-demo', { id: 'org-demo', tenantId: 'tenant-demo', type: 'customer', name: 'Demo Customer GmbH', externalIdentities: [{ system: 'crm-demo', externalId: 'CRM-1001' }] });
  state.organizations.set('org-service', { id: 'org-service', tenantId: 'tenant-demo', type: 'servicepartner', name: 'Demo Robot Care' });
  state.organizations.set('org-ef', { id: 'org-ef', tenantId: 'tenant-demo', type: 'ef_unit', name: 'EF Systemhaus' });
  state.sites.set('site-berlin', { id: 'site-berlin', tenantId: 'tenant-demo', organizationId: 'org-demo', name: 'Berlin Operations Site', country: 'DE', timezone: 'Europe/Berlin', status: 'active' });
  state.models.set('model-autoxing-a1', { id: 'model-autoxing-a1', manufacturer: 'AutoXing', model: 'A1', category: 'cleaning', capabilities: ['read.status', 'read.battery', 'event.alert'] });
  state.models.set('model-cenobots-c1', { id: 'model-cenobots-c1', manufacturer: 'CenoBots', model: 'C1', category: 'cleaning', capabilities: ['read.status', 'read.battery', 'read.service_history'] });
  state.models.set('model-mock-m3', { id: 'model-mock-m3', manufacturer: 'Mock OEM', model: 'M3', category: 'transport', capabilities: ['read.status', 'event.status'] });

  state.adapters.set('autoxing', {
    provider: 'autoxing', version: 'wrapper-backed', status: autoXingLiveEnabled() ? 'live-wrapper-enabled' : 'mock-fallback', integration: 'autoxing/lib/api_lib.py', lastSyncAt: null, lastSyncStatus: 'never', lastError: null, pollingIntervalMs: autoXingPollIntervalMs(),
    capabilities: { read: ['identity', 'status', 'battery', 'position', 'emergency_stop', 'obstruction', 'detailed_errors', 'pois', 'areas', 'maps', 'task_history', 'task_status'], event: ['alert', 'status', 'task_status'], command: [] },
    sync: () => ({ externalId: 'AX-1001', modelId: 'model-autoxing-a1', serialNumber: 'AX-DEMO-001', status: 'active', battery: 87, eventType: 'online' })
  });
  state.adapters.set('cenobots', {
    provider: 'cenobots', version: 'mock-1.0.0', status: 'mock-only',
    capabilities: { read: ['identity', 'status', 'battery', 'service_history'], event: ['maintenance'], command: [] },
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
}

function appendPassportEntry(robotId, entry, actor = { id: 'system', name: 'System' }) {
  const fullEntry = { id: ids(), robotId, source: entry.source || 'altegro', trustStatus: entry.trustStatus || 'reported', createdBy: actor.id, occurredAt: entry.occurredAt || timestamp(), type: entry.type, data: entry.data || {} };
  const entries = state.passportEntries.get(robotId) || [];
  entries.push(fullEntry);
  state.passportEntries.set(robotId, entries);
  return fullEntry;
}

function robotAccountSlug(value) {
  return String(value || 'robot').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'robot';
}

function createRobotUser(robot, { email, password, system = 'manual', externalId = null } = {}) {
  const existingRobotUser = Object.entries(demoUsers).find(([, user]) => user.role === 'robot_user' && user.robotSystem === system && user.robotSerialNumber === robot.serialNumber);
  if (existingRobotUser) return { token: existingRobotUser[0], email: existingRobotUser[1].email, password: existingRobotUser[1].demoPassword, serialNumber: robot.serialNumber, robotId: robot.id, created: false };
  if (Object.values(demoUsers).some((user) => user.email.toLowerCase() === email.toLowerCase())) throw httpError(409, 'That username/email is already in use');
  const slug = robotAccountSlug(robot.serialNumber);
  let token = `demo-robot-${slug}`;
  let suffix = 2;
  while (demoUsers[token]) token = `demo-robot-${slug}-${suffix++}`;
  const user = { id: `user-${token}`, name: `${robot.serialNumber} User`, email, demoPassword: password, role: 'robot_user', tenantId: robot.tenantId, organizationId: robot.organizationId, robotSystem: system, robotExternalId: externalId, robotSerialNumber: robot.serialNumber };
  demoUsers[token] = user;
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
  return Object.entries(demoUsers).filter(([, user]) => user.role === 'robot_user').map(([token, user]) => ({ token, email: user.email, password: user.demoPassword, serialNumber: user.robotSerialNumber, robotId: [...state.robots.values()].find((robot) => robot.serialNumber === user.robotSerialNumber)?.id || null, created: false }));
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
  return raw.robotId || raw.robot_id || raw.robotSn || raw.robotSN || raw.robot?.robotId || raw.robot?.id || null;
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

function getPassport(robotId) {
  const robot = state.robots.get(robotId);
  const entries = state.passportEntries.get(robotId) || [];
  return {
    robot: clone(robot),
    model: clone(state.models.get(robot.modelId)),
    owner: clone(state.organizations.get(robot.organizationId)),
    operator: clone(state.organizations.get(robot.operatorOrganizationId)),
    site: clone(state.sites.get(robot.siteId)),
    entries: clone(entries),
    completeness: calculateCompleteness(robot, entries)
  };
}

function calculateCompleteness(robot, entries) {
  const checks = {
    robotId: Boolean(robot.id), model: Boolean(robot.modelId), serialNumber: Boolean(robot.serialNumber), owner: Boolean(robot.organizationId), site: Boolean(robot.siteId), registration: entries.some((item) => item.type === 'registration'), configuration: entries.some((item) => item.type === 'configuration_snapshot')
  };
  const complete = Object.values(checks).filter(Boolean).length;
  return { percentage: Math.round((complete / Object.keys(checks).length) * 100), checks };
}

function getActor(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return token && demoUsers[token] ? demoUsers[token] : null;
}

function requireActor(req) {
  const actor = getActor(req);
  if (!actor) throw httpError(401, 'Bearer token required. See /api/v1/demo/tokens.');
  return actor;
}

function canWrite(actor) {
  return ['owner', 'technician', 'platform_admin', 'data_admin', 'support_admin'].includes(actor.role);
}

function matchesRobotScope(actor, robot) {
  if (actor.role !== 'robot_user') return true;
  if (actor.robotSerialNumber && robot.serialNumber !== actor.robotSerialNumber) return false;
  if (actor.robotExternalId) {
    return (robot.externalIdentities || []).some((identity) => identity.system === actor.robotSystem && identity.externalId === actor.robotExternalId);
  }
  return Boolean(actor.robotSerialNumber);
}

function visibleToActor(actor, robot) {
  if (!robot || robot.tenantId !== actor.tenantId) return false;
  if (!matchesRobotScope(actor, robot)) return false;
  if (actor.role === 'robot_user') return true;
  if (['platform_admin', 'data_admin', 'support_admin'].includes(actor.role)) return true;
  if (actor.role === 'owner') return robot.organizationId === actor.organizationId;
  if (actor.role === 'technician') return robot.operatorOrganizationId === actor.organizationId || robot.organizationId === actor.tenantId;
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 5_000_000) reject(httpError(413, 'Request body too large; event attachments are limited to 2 MB')); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(httpError(400, 'Request body must be valid JSON')); }
    });
    req.on('error', reject);
  });
}

function httpError(status, message, details) {
  const error = new Error(message); error.status = status; error.details = details; return error;
}

function validateEventAttachment(attachment) {
  if (!attachment) return null;
  if (!attachment.name || !attachment.contentType || !attachment.contentBase64) throw httpError(400, 'Attachment requires name, contentType, and contentBase64');
  const content = Buffer.from(attachment.contentBase64, 'base64');
  if (content.length > MAX_EVENT_ATTACHMENT_BYTES) throw httpError(413, 'Event attachment is limited to 2 MB');
  return { name: String(attachment.name).slice(0, 255), contentType: String(attachment.contentType).slice(0, 120), size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex'), contentBase64: attachment.contentBase64 };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function serveFrontend(pathname, res) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const allowed = new Set(['index.html', 'app.js', 'styles.css']);
  if (!allowed.has(requested)) return false;
  const filePath = pathUtil.join(publicDir, requested);
  try {
    const body = fs.readFileSync(filePath);
    const contentTypes = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'content-type': contentTypes[requested], 'content-length': body.length });
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
  if (req.method === 'GET' && path === '/api/v1/demo/tokens') return send(res, 200, { warning: 'Demo tokens only. Do not use in production.', tokens: Object.fromEntries(Object.entries(demoUsers).map(([token, user]) => [token, { role: user.role, tenantId: user.tenantId, robotSerialNumber: user.robotSerialNumber || null }])) });
  if (req.method === 'POST' && path === '/api/v1/auth/login') {
    const login = await readBody(req);
    const match = Object.entries(demoUsers).find(([, user]) => user.email.toLowerCase() === String(login.email || '').toLowerCase());
    if (!match || String(login.password || '') !== (match[1].demoPassword || 'demo')) throw httpError(401, 'Invalid email or password');
    const [token, user] = match;
    return send(res, 200, { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId, scope: user.robotSerialNumber ? { type: 'robot', system: user.robotSystem, externalId: user.robotExternalId || null, serialNumber: user.robotSerialNumber } : { type: 'tenant' } } });
  }
  if (req.method === 'GET' && serveFrontend(path, res)) return;

  const actor = requireActor(req);
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

  if (req.method === 'GET' && path === '/api/v1/tenants') return send(res, 200, { data: [...state.tenants.values()].filter((tenant) => tenant.id === actor.tenantId) });
  if (req.method === 'GET' && path === '/api/v1/robot-accounts') {
    if (actor.role !== 'platform_admin') throw httpError(403, 'Platform administrator permission required');
    const accounts = ensureAllRobotUsers().map(({ token, email, password, serialNumber, robotId, created }) => ({ token, email, password, serialNumber, robotId, created }));
    return send(res, 200, { warning: 'Prototype credentials only. Do not use in production.', data: accounts, count: accounts.length });
  }
  if (req.method === 'GET' && path === '/api/v1/adapters') return send(res, 200, { data: actor.role === 'robot_user' ? [] : [...state.adapters.values()].map(({ sync, ...adapter }) => adapter) });
  if (req.method === 'GET' && path === '/api/v1/adapters/autoxing/resources') {
    if (actor.role === 'robot_user') return send(res, 200, { data: { businesses: [], buildings: [], maps: [], syncedAt: state.autoxing.lastSyncAt, resourceErrors: [] } });
    return send(res, 200, { data: { businesses: clone(state.autoxing.businesses), buildings: clone(state.autoxing.buildings), maps: clone([...state.autoxing.maps.values()]), syncedAt: state.autoxing.lastSyncAt, resourceErrors: clone(state.autoxing.resourceErrors) } });
  }
  if (req.method === 'GET' && path === '/api/v1/autoxing/tasks') {
    let tasks = [...state.autoxing.tasks.values()];
    const robotId = url.searchParams.get('robotId');
    if (robotId) {
      const item = state.robots.get(robotId);
      if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
      const externalId = item.externalIdentities?.find((identity) => identity.system === 'autoxing')?.externalId;
      tasks = tasks.filter((task) => String(taskRobotExternalId(task)) === String(externalId));
    }
    return send(res, 200, { data: clone(tasks), count: tasks.length, syncedAt: state.autoxing.lastSyncAt });
  }
  if (req.method === 'GET' && path === '/api/v1/events') {
    const visibleRobotIds = new Set([...state.robots.values()].filter((robot) => visibleToActor(actor, robot)).map((robot) => robot.id));
    const data = state.events.filter((event) => visibleRobotIds.has(event.robotId)).filter((event) => !url.searchParams.get('robotId') || event.robotId === url.searchParams.get('robotId'));
    return send(res, 200, { data });
  }
  if (req.method === 'GET' && path === '/api/v1/audit') return send(res, 200, { data: state.audit.filter((item) => item.actorId === actor.id || ['platform_admin', 'data_admin', 'support_admin'].includes(actor.role)) });
  if (req.method === 'GET' && path === '/api/v1/robots') {
    let data = [...state.robots.values()].filter((robot) => visibleToActor(actor, robot));
    for (const field of ['status', 'modelId', 'siteId', 'serialNumber']) if (url.searchParams.get(field)) data = data.filter((robot) => robot[field] === url.searchParams.get(field));
    if (url.searchParams.get('q')) { const q = url.searchParams.get('q').toLowerCase(); data = data.filter((robot) => JSON.stringify(robot).toLowerCase().includes(q)); }
    return send(res, 200, { data: data.map(clone), count: data.length });
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
    const result = syncAdapter(sync.id, actor.id); recordAudit(actor, 'adapter.sync', 'adapter', sync.id); return send(res, 200, { data: result });
  }

  if (req.method === 'POST' && path === '/api/v1/robots') {
    if (!canWrite(actor)) throw httpError(403, 'Write permission required');
    for (const field of ['modelId', 'siteId', 'organizationId', 'serialNumber', 'username', 'password']) if (!body[field]) throw httpError(400, `Missing required field: ${field}`);
    if (!state.models.has(body.modelId) || !state.sites.has(body.siteId) || !state.organizations.has(body.organizationId)) throw httpError(400, 'Unknown model, site, or organization');
    const username = String(body.username).trim().toLowerCase();
    const password = String(body.password);
    if (!username.includes('@')) throw httpError(400, 'Username must be an email address');
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    if ([...state.robots.values()].some((item) => item.tenantId === actor.tenantId && item.serialNumber === body.serialNumber)) throw httpError(409, 'A robot with that serial number already exists');
    const robot = { id: ids(), tenantId: actor.tenantId, organizationId: body.organizationId, operatorOrganizationId: body.operatorOrganizationId || body.organizationId, siteId: body.siteId, modelId: body.modelId, serialNumber: body.serialNumber, status: 'draft', externalIdentities: body.externalIdentities || [], createdAt: timestamp(), updatedAt: timestamp() };
    const account = createRobotUser(robot, { email: username, password });
    state.robots.set(robot.id, robot);
    appendPassportEntry(robot.id, { type: 'registration', source: 'manual', data: { serialNumber: robot.serialNumber, username } }, actor);
    recordAudit(actor, 'robot.create', 'robot', robot.id);
    return send(res, 201, { data: getPassport(robot.id), account: { username: account.email, password: account.password } });
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

  if (req.method === 'POST' && path === '/api/v1/service-cases') {
    if (!canWrite(actor)) throw httpError(403, 'Write permission required');
    const item = state.robots.get(body.robotId); if (!item || !visibleToActor(actor, item)) throw httpError(404, 'Robot not found');
    if (!body.externalId || !body.provider || !body.status) throw httpError(400, 'robotId, provider, externalId, and status are required');
    const key = `${body.provider}:${body.externalId}`; if (state.serviceCases.has(key)) return send(res, 200, { data: state.serviceCases.get(key), idempotent: true });
    const serviceCase = { id: ids(), robotId: item.id, tenantId: item.tenantId, provider: body.provider, externalId: body.externalId, status: body.status, cause: body.cause || null, action: body.action || null, parts: body.parts || [], createdAt: timestamp(), updatedAt: timestamp() };
    state.serviceCases.set(key, serviceCase); appendPassportEntry(item.id, { type: 'service_case', source: body.provider, data: serviceCase }, actor); recordAudit(actor, 'service_case.link', 'robot', item.id); return send(res, 201, { data: serviceCase });
  }
  throw httpError(404, 'Route not found');
}

seed();
const server = http.createServer((req, res) => handle(req, res).catch((error) => send(res, error.status || 500, { error: { code: error.status === 401 ? 'UNAUTHENTICATED' : 'REQUEST_FAILED', message: error.message, details: error.details, correlationId: ids() } })));

let autoXingPollTimer = null;
let autoXingPollRunning = false;
function startAutoXingPolling() {
  if (!autoXingLiveEnabled() || autoXingPollIntervalMs() === 0) return;
  const pollActor = { id: 'system-autoxing-poller', name: 'AutoXing Poller', role: 'platform_admin', tenantId: 'tenant-demo', organizationId: 'org-ef' };
  autoXingPollTimer = setInterval(async () => {
    if (autoXingPollRunning) return;
    autoXingPollRunning = true;
    try { await syncAutoXingLive(pollActor); } catch (error) { const adapter = state.adapters.get('autoxing'); if (adapter) { adapter.lastSyncStatus = 'error'; adapter.lastError = error.message; } }
    finally { autoXingPollRunning = false; }
  }, autoXingPollIntervalMs());
}

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => { startAutoXingPolling(); console.log(`Altegro prototype listening on http://127.0.0.1:${PORT}`); });
}

module.exports = { server, state };
