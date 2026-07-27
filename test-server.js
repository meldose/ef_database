'use strict';

const assert = require('node:assert/strict');
const { server } = require('./server');

const port = 3107;
server.close();
server.listen(port);

async function request(path, options = {}) {
  const response = await fetch(`http://localhost:${port}${path}`, { ...options, headers: { authorization: 'Bearer demo-platform-admin', 'content-type': 'application/json', ...(options.headers || {}) } });
  return { status: response.status, body: await response.json() };
}

(async () => {
  try {
    let result = await request('/health', { headers: {} });
    assert.equal(result.status, 200);

    let loginResponse = await fetch(`http://localhost:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo.altegro.local', password: 'demo' }) });
    let loginBody = await loginResponse.json();
    assert.equal(loginResponse.status, 200);
    assert.equal(loginBody.user.role, 'platform_admin');
    assert.equal(loginBody.token, 'demo-platform-admin');

    result = await request('/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 2);
    const robotId = result.body.data[0].id;

    result = await request(`/api/v1/robots/${robotId}/passport`);
    assert.equal(result.status, 200);
    assert.ok(result.body.data.completeness.percentage >= 80);

    result = await request(`/api/v1/robots/${robotId}/events`, { method: 'POST', body: JSON.stringify({ title: 'Battery inspection completed', description: 'Battery and charging dock inspected.', eventType: 'inspection', sourceSystem: 'manual-test', severity: 'info', occurredAt: '2026-07-27T14:00:00.000Z', attachment: { name: 'inspection.txt', contentType: 'text/plain', contentBase64: Buffer.from('inspection evidence').toString('base64') } }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.title, 'Battery inspection completed');
    assert.equal(result.body.data.attachment.name, 'inspection.txt');

    result = await request(`/api/v1/robots/${robotId}/events`);
    assert.equal(result.status, 200);
    assert.ok(result.body.data.some((event) => event.title === 'Battery inspection completed'));

    result = await request('/api/v1/adapters/mock-oem/sync', { method: 'POST', body: '{}' });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.commandCapabilitiesEnabled, false);

    result = await request(`/api/v1/robots/${robotId}/commands`, { method: 'POST', body: JSON.stringify({ command: 'move' }) });
    assert.equal(result.status, 403);

    result = await request('/api/v1/robots', { headers: { authorization: 'Bearer demo-owner', 'x-tenant-id': 'tenant-other' } });
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 3);

    console.log('All Altegro prototype tests passed.');
  } finally {
    server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
