'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const enabled = (value) => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

function secret(name, environment = process.env) {
  const file = environment[`${name}_FILE`];
  if (file) return fs.readFileSync(path.resolve(file), 'utf8').trim();
  return String(environment[name] || '').trim();
}

function providerConfiguration(kind, environment = process.env) {
  if (!['crm', 'service'].includes(kind)) throw new Error(`Unsupported enterprise provider: ${kind}`);
  const prefix = kind.toUpperCase();
  const liveEnabled = enabled(environment[`${prefix}_INTEGRATION_LIVE`]);
  const baseUrl = String(environment[`${prefix}_INTEGRATION_BASE_URL`] || '').trim().replace(/\/$/, '');
  let tokenConfigured=false; let tokenError=null;
  try { tokenConfigured=Boolean(secret(`${prefix}_INTEGRATION_TOKEN`, environment)); } catch(error) { tokenError=error.message; }
  const recordsPath = String(environment[`${prefix}_INTEGRATION_RECORDS_PATH`] || (kind === 'crm' ? '/organizations' : '/service-cases')).trim();
  const timeoutMs = Math.max(1000, Math.min(120000, Number(environment[`${prefix}_INTEGRATION_TIMEOUT_MS`] || 15000)));
  const reasons = [];
  if (liveEnabled && !baseUrl) reasons.push('base URL is missing');
  if (liveEnabled && !tokenConfigured) reasons.push('managed API token is missing');
  if (liveEnabled && tokenError) reasons.push('managed API token file is unreadable');
  if (liveEnabled && environment.NODE_ENV === 'production' && !baseUrl.startsWith('https://')) reasons.push('production URL must use HTTPS');
  if (!recordsPath.startsWith('/')) reasons.push('records path must start with /');
  return { kind, provider:`${kind}-reference`, liveEnabled, mode:liveEnabled ? 'live' : 'mock', baseUrlConfigured:Boolean(baseUrl), tokenConfigured, recordsPath, timeoutMs, ready:reasons.length === 0, reasons, baseUrl };
}

function arrayPayload(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['data', 'items', 'records', 'results']) if (Array.isArray(payload?.[key])) return payload[key];
  throw new Error('Provider response must contain an array in data, items, records, or results');
}

function text(value, maximum = 200) {
  const result = String(value ?? '').trim();
  return result ? result.slice(0, maximum) : null;
}

function normalizeCrmOrganization(record) {
  const externalId = text(record.externalId ?? record.id ?? record.customerId, 200);
  const name = text(record.name ?? record.companyName ?? record.accountName, 200);
  if (!externalId || !name) throw new Error('CRM record requires externalId/id and name/companyName');
  const sites = Array.isArray(record.sites) ? record.sites.map((site) => ({
    externalId:text(site.externalId ?? site.id, 200) || `${externalId}:default`,
    name:text(site.name, 200) || `${name} site`,
    country:(text(site.country, 2) || 'DE').toUpperCase(),
    timezone:text(site.timezone, 80) || 'Europe/Berlin',
    status:['active', 'inactive'].includes(site.status) ? site.status : 'active'
  })) : [];
  return { externalId, name, type:['customer', 'servicepartner', 'ef_unit'].includes(record.type) ? record.type : 'customer', accountOwner:text(record.accountOwner ?? record.owner, 200), status:['active', 'inactive'].includes(record.status) ? record.status : 'active', sites, rawVersion:text(record.version ?? record.updatedAt, 100) };
}

const serviceStatuses = Object.freeze({
  new:'open', open:'open', assigned:'in_progress', working:'in_progress', in_progress:'in_progress', pending:'waiting', waiting:'waiting', resolved:'resolved', completed:'closed', closed:'closed'
});

function normalizeServiceCase(record) {
  const externalId = text(record.externalId ?? record.id ?? record.ticketId, 200);
  const providerStatus = text(record.status, 50)?.toLowerCase().replace(/[\s-]+/g, '_');
  const status = serviceStatuses[providerStatus];
  const robotSerialNumber = text(record.robotSerialNumber ?? record.serialNumber, 120);
  const robotExternalId = text(record.robotExternalId ?? record.deviceId, 200);
  if (!externalId || !status || (!robotSerialNumber && !robotExternalId)) throw new Error('Service record requires an ID, mapped status, and robot serial or external ID');
  return { externalId, status, robotSerialNumber, robotExternalId, title:text(record.title ?? record.subject, 200) || `Service case ${externalId}`, description:text(record.description, 4000) || '', severity:['info', 'warning', 'error', 'critical'].includes(record.severity) ? record.severity : 'info', cause:text(record.cause, 1000), action:text(record.action ?? record.resolution, 2000), assignedTo:text(record.assignedTo ?? record.assignee, 200), parts:Array.isArray(record.parts) ? record.parts.slice(0, 100).map((item) => text(item, 200)).filter(Boolean) : [], rawVersion:text(record.version ?? record.updatedAt, 100) };
}

async function fetchProviderRecords(kind, { environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = providerConfiguration(kind, environment);
  if (!config.ready) throw new Error(`${kind} integration is not ready: ${config.reasons.join('; ')}`);
  if (!config.liveEnabled) return { provider:config.provider, mode:'mock', records:[], receivedAt:new Date().toISOString() };
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch API implementation is required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}${config.recordsPath}`, { headers:{ accept:'application/json', authorization:`Bearer ${secret(`${kind.toUpperCase()}_INTEGRATION_TOKEN`, environment)}`, 'user-agent':'Altegro-Enterprise-Adapter/1.0' }, signal:controller.signal });
    if (!response.ok) throw new Error(`${kind} provider returned HTTP ${response.status}`);
    const payload = await response.json();
    const normalize = kind === 'crm' ? normalizeCrmOrganization : normalizeServiceCase;
    const records = arrayPayload(payload).map((record, index) => {
      try { return normalize(record); }
      catch (error) { error.message = `Record ${index + 1}: ${error.message}`; throw error; }
    });
    return { provider:config.provider, mode:'live', records, receivedAt:new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}

function verifySignedWebhook(rawBody, { signature, timestamp, secret: signingSecret, toleranceSeconds = 300, now = Date.now() }) {
  const seconds = Number(timestamp);
  if (!signingSecret || !signature || !Number.isFinite(seconds)) return false;
  if (Math.abs(Math.floor(now / 1000) - seconds) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', signingSecret).update(`${seconds}.${rawBody}`).digest('hex');
  const supplied = String(signature).replace(/^sha256=/i, '').trim();
  const left = Buffer.from(supplied, 'hex'); const right = Buffer.from(expected, 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

module.exports = { fetchProviderRecords, normalizeCrmOrganization, normalizeServiceCase, providerConfiguration, verifySignedWebhook };
