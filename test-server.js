'use strict';

const assert = require('node:assert/strict');
const { server, state } = require('./server');

const port = 3107;
server.close();
server.listen(port);

async function request(path, options = {}) {
  const response = await fetch(`http://localhost:${port}${path}`, { ...options, headers: { authorization: 'Bearer demo-platform-admin', 'content-type': 'application/json', ...(options.headers || {}) } });
  return { status: response.status, body: await response.json() };
}

async function requestAs(token, path, options = {}) {
  return request(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
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
    const cenobotsRobotId = result.body.data[1].id;

    loginResponse = await fetch(`http://localhost:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'robot-ax-001@demo.altegro.local', password: 'AX-robot-001-demo' }) });
    loginBody = await loginResponse.json();
    assert.equal(loginResponse.status, 200);
    assert.equal(loginBody.user.role, 'robot_user');
    assert.equal(loginBody.user.scope.serialNumber, 'AX-DEMO-001');

    result = await requestAs('demo-robot-ax-001', '/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 1);
    assert.equal(result.body.data[0].serialNumber, 'AX-DEMO-001');

    result = await requestAs('demo-robot-ax-001', `/api/v1/robots/${cenobotsRobotId}/passport`);
    assert.equal(result.status, 404);

    result = await requestAs('demo-robot-ax-001', '/api/v1/events');
    assert.equal(result.status, 200);
    assert.ok(result.body.data.every((event) => event.robotId === robotId));

    result = await requestAs('demo-robot-ax-001', `/api/v1/robots/${robotId}/events`, { method: 'POST', body: JSON.stringify({ title: 'Should be blocked', description: 'Robot accounts are read-only.', eventType: 'note', sourceSystem: 'manual-test', severity: 'info', occurredAt: '2026-07-27T14:00:00.000Z' }) });
    assert.equal(result.status, 403);

    result = await request(`/api/v1/robots/${robotId}/passport`);
    assert.equal(result.status, 200);
    assert.ok(result.body.data.completeness.percentage >= 80);

    result = await request(`/api/v1/robots/${robotId}/autoxing`);
    assert.equal(result.status, 200);
    assert.ok('status' in result.body.data);
    assert.ok(Array.isArray(result.body.data.resources.tasks));

    result = await request('/api/v1/adapters/autoxing/resources');
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.data.maps));

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

    state.robots.set('autoxing-dynamic-test', { id: 'autoxing-dynamic-test', tenantId: 'tenant-demo', organizationId: 'org-demo', operatorOrganizationId: 'org-service', siteId: 'site-berlin', modelId: 'model-autoxing-a1', serialNumber: 'AX-PILOT-016', status: 'draft', externalIdentities: [{ system: 'autoxing', externalId: 'AX-PILOT-016-EXT' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    result = await request('/api/v1/robot-accounts');
    assert.equal(result.status, 200);
    assert.ok(result.body.data.some((account) => account.serialNumber === 'CB-DEMO-001'));
    const dynamicAccount = result.body.data.find((account) => account.serialNumber === 'AX-PILOT-016');
    assert.ok(dynamicAccount);
    assert.equal(dynamicAccount.created, false);
    assert.match(dynamicAccount.email, /@demo\.altegro\.local$/);

    loginResponse = await fetch(`http://localhost:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: dynamicAccount.email, password: dynamicAccount.password }) });
    assert.equal(loginResponse.status, 200);
    result = await requestAs(dynamicAccount.token, '/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 1);
    assert.equal(result.body.data[0].serialNumber, 'AX-PILOT-016');

    result = await request('/api/v1/robots', { method: 'POST', body: JSON.stringify({ modelId: 'model-mock-m3', siteId: 'site-berlin', organizationId: 'org-demo', operatorOrganizationId: 'org-service', serialNumber: 'MANUAL-ROBOT-001', username: 'manual-robot-001@demo.altegro.local', password: 'Manual-robot-001' }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.account.username, 'manual-robot-001@demo.altegro.local');

    loginResponse = await fetch(`http://localhost:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'manual-robot-001@demo.altegro.local', password: 'Manual-robot-001' }) });
    assert.equal(loginResponse.status, 200);
    result = await requestAs('demo-robot-manual-robot-001', '/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 1);
    assert.equal(result.body.data[0].serialNumber, 'MANUAL-ROBOT-001');

    console.log('All Altegro prototype tests passed.');
  } finally {
    server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
