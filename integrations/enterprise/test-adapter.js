'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fetchProviderRecords, normalizeCrmOrganization, normalizeServiceCase, providerConfiguration, verifySignedWebhook } = require('./adapter');

async function run() {
  const crm = normalizeCrmOrganization({ id:'CRM-42',companyName:'Example GmbH',sites:[{ id:'SITE-1',name:'Berlin',country:'de' }] });
  assert.equal(crm.externalId, 'CRM-42');
  assert.equal(crm.sites[0].country, 'DE');
  const service = normalizeServiceCase({ ticketId:'T-7',status:'assigned',serialNumber:'AX-1',subject:'Inspection' });
  assert.equal(service.status, 'in_progress');
  assert.throws(() => normalizeServiceCase({ id:'bad',status:'unknown',serialNumber:'AX-1' }), /mapped status/);

  const environment = { CRM_INTEGRATION_LIVE:'true',CRM_INTEGRATION_BASE_URL:'https://crm.example.test',CRM_INTEGRATION_TOKEN:'secret' };
  assert.equal(providerConfiguration('crm', environment).ready, true);
  const result = await fetchProviderRecords('crm', { environment, fetchImpl:async () => ({ ok:true,status:200,json:async () => ({ data:[{ id:'C-1',name:'Customer One' }] }) }) });
  assert.equal(result.records[0].externalId, 'C-1');

  const raw = '{"id":"T-7"}'; const timestamp = Math.floor(Date.now() / 1000); const signingSecret = 'webhook-test-secret';
  const signature = crypto.createHmac('sha256', signingSecret).update(`${timestamp}.${raw}`).digest('hex');
  assert.equal(verifySignedWebhook(raw, { signature, timestamp, secret:signingSecret }), true);
  assert.equal(verifySignedWebhook(`${raw} `, { signature, timestamp, secret:signingSecret }), false);
  console.log('Enterprise adapter contract tests passed.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
