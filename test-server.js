'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const testDataFile = path.join('/tmp', `altegro-test-state-${process.pid}.json`);
fs.rmSync(testDataFile, { force: true });
process.env.ALTEGRO_DATA_FILE = testDataFile;
process.env.ALTEGRO_PERSISTENCE = 'true';
const { server, state, DATA_FILE } = require('./server');

const port = 3107;
let defaultToken = 'demo-platform-admin';
server.close();
server.listen(port);

async function request(path, options = {}) {
  const response = await fetch(`http://localhost:${port}${path}`, { ...options, headers: { authorization: `Bearer ${defaultToken}`, 'content-type': 'application/json', ...(options.headers || {}) } });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function requestAs(token, path, options = {}) {
  return request(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
}

async function loginWithPassword(email, password) {
  const response = await fetch(`http://localhost:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

(async () => {
  try {
    let result = await request('/health', { headers: {} });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('x-frame-options'), 'DENY');
    assert.match(result.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const frontendResponse = await fetch(`http://localhost:${port}/`);
    assert.equal(frontendResponse.status, 200);
    const frontendHtml = await frontendResponse.text();
    for (const controlId of ['dashboardTabs', 'exportRobotsCsv', 'resourceExplorer', 'taskHistoryList', 'robotAccountsList', 'compatibilityForm']) assert.match(frontendHtml, new RegExp(`id="${controlId}"`));
    for (const view of ['overview', 'robots', 'operations', 'autoxing', 'admin']) assert.match(frontendHtml, new RegExp(`data-dashboard-tab="${view}"`));

    const oldPasswordLogin = await loginWithPassword('admin@demo.altegro.local', 'demo');
    assert.equal(oldPasswordLogin.status, 401);
    let loginResult = await loginWithPassword('admin@demo.altegro.local', 'efrobotics');
    let loginBody = loginResult.body;
    assert.equal(loginResult.status, 200);
    assert.equal(loginBody.user.role, 'platform_admin');
    assert.notEqual(loginBody.token, 'demo-platform-admin');
    assert.match(loginResult.headers.get('set-cookie'), /HttpOnly/);
    assert.match(loginResult.headers.get('set-cookie'), /SameSite=Strict/);
    const browserCookie = loginResult.headers.get('set-cookie').split(';')[0];
    const cookieSessionResponse = await fetch(`http://localhost:${port}/api/v1/auth/session`, { headers: { cookie: browserCookie } });
    assert.equal(cookieSessionResponse.status, 200);
    assert.equal((await cookieSessionResponse.json()).user.role, 'platform_admin');
    defaultToken = loginBody.token;
    result = await request('/api/v1/auth/session');
    assert.equal(result.status, 200);
    assert.equal(result.body.user.role, 'platform_admin');
    result = await requestAs('demo-platform-admin', '/api/v1/robots');
    assert.equal(result.status, 401);
    result = await request('/api/v1/demo/tokens');
    assert.equal(result.status, 404);

    result = await request('/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 2);
    assert.equal(result.body.pagination.page, 1);
    assert.equal(result.body.facets.total, 2);
    const robotId = result.body.data[0].id;
    const cenobotsRobotId = result.body.data[1].id;

    result = await request('/api/v1/robots?pageSize=1&page=2&sort=serialNumber&order=asc');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.length, 1);
    assert.equal(result.body.pagination.pageCount, 2);
    result = await request('/api/v1/robots?q=site-berlin');
    assert.equal(result.body.count, 2);

    loginResult = await loginWithPassword('robot-ax-001@demo.altegro.local', 'AX-robot-001-demo');
    loginBody = loginResult.body;
    assert.equal(loginResult.status, 200);
    assert.equal(loginBody.user.role, 'robot_user');
    assert.equal(loginBody.user.scope.serialNumber, 'AX-DEMO-001');
    const robotAxSessionToken = loginBody.token;

    result = await requestAs(robotAxSessionToken, '/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 1);
    assert.equal(result.body.data[0].serialNumber, 'AX-DEMO-001');

    result = await requestAs(robotAxSessionToken, `/api/v1/robots/${cenobotsRobotId}/passport`);
    assert.equal(result.status, 404);

    result = await requestAs(robotAxSessionToken, '/api/v1/events');
    assert.equal(result.status, 200);
    assert.ok(result.body.data.every((event) => event.robotId === robotId));

    state.autoxing.tasks.set('task-ax-scope', { taskId: 'task-ax-scope', raw: { robotId: 'AX-1001' } });
    state.autoxing.tasks.set('task-cb-scope', { taskId: 'task-cb-scope', raw: { robotId: 'CB-1001' } });
    result = await requestAs(robotAxSessionToken, '/api/v1/autoxing/tasks');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.map((task) => task.taskId), ['task-ax-scope']);

    result = await requestAs(robotAxSessionToken, `/api/v1/robots/${robotId}/events`, { method: 'POST', body: JSON.stringify({ title: 'Should be blocked', description: 'Robot accounts cannot create events.', eventType: 'note', sourceSystem: 'manual-test', severity: 'info', occurredAt: '2026-07-27T14:00:00.000Z' }) });
    assert.equal(result.status, 403);

    result = await requestAs(robotAxSessionToken, '/api/v1/robots', { method: 'POST', body: JSON.stringify({ modelId: 'model-mock-m3', siteId: 'site-berlin', organizationId: 'org-demo', operatorOrganizationId: 'org-service', serialNumber: 'ROBOT-USER-CREATED-001' }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.account, null);
    assert.equal(result.body.accountReused, true);
    result = await requestAs(robotAxSessionToken, '/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 2);
    assert.ok(result.body.data.some((robot) => robot.serialNumber === 'ROBOT-USER-CREATED-001'));

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
    const attachmentEventId = result.body.data.eventId;
    let attachmentResponse = await fetch(`http://localhost:${port}/api/v1/events/${attachmentEventId}/attachment`, { headers: { authorization: `Bearer ${defaultToken}` } });
    assert.equal(attachmentResponse.status, 200);
    assert.equal(await attachmentResponse.text(), 'inspection evidence');

    result = await request('/api/v1/events?severity=info&eventType=inspection');
    assert.equal(result.status, 200);
    assert.ok(result.body.data.some((event) => event.eventId === attachmentEventId));
    assert.ok(result.body.data.every((event) => event.severity === 'info' && event.eventType === 'inspection'));

    result = await request(`/api/v1/robots/${robotId}/events`, { method: 'POST', body: JSON.stringify({ title: 'Blocked upload', description: 'Executable files are not accepted.', eventType: 'inspection', sourceSystem: 'manual-test', severity: 'info', occurredAt: '2026-07-27T14:00:00.000Z', attachment: { name: 'unsafe.exe', contentType: 'application/octet-stream', contentBase64: Buffer.from('unsafe').toString('base64') } }) });
    assert.equal(result.status, 400);

    result = await request(`/api/v1/robots/${robotId}/events`);
    assert.equal(result.status, 200);
    assert.ok(result.body.data.some((event) => event.title === 'Battery inspection completed'));

    result = await request('/api/v1/adapters/mock-oem/sync', { method: 'POST', body: '{}' });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.commandCapabilitiesEnabled, false);

    result = await request(`/api/v1/robots/${robotId}/commands`, { method: 'POST', body: JSON.stringify({ command: 'move' }) });
    assert.equal(result.status, 403);

    loginResult = await loginWithPassword('owner@demo.altegro.local', 'efrobotics');
    assert.equal(loginResult.status, 200);
    result = await requestAs(loginResult.body.token, '/api/v1/robots', { headers: { 'x-tenant-id': 'tenant-other' } });
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 4);

    state.robots.set('autoxing-dynamic-test', { id: 'autoxing-dynamic-test', tenantId: 'tenant-demo', organizationId: 'org-demo', operatorOrganizationId: 'org-service', siteId: 'site-berlin', modelId: 'model-autoxing-a1', serialNumber: 'AX-PILOT-016', status: 'draft', externalIdentities: [{ system: 'autoxing', externalId: 'AX-PILOT-016-EXT' }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    result = await request('/api/v1/robot-accounts');
    assert.equal(result.status, 200);
    assert.ok(result.body.data.some((account) => account.serialNumber === 'CB-DEMO-001'));
    const dynamicAccount = result.body.data.find((account) => account.serialNumber === 'AX-PILOT-016');
    assert.ok(dynamicAccount);
    assert.equal(dynamicAccount.created, false);
    assert.match(dynamicAccount.email, /@demo\.altegro\.local$/);
    assert.equal(dynamicAccount.password, undefined);
    assert.equal(dynamicAccount.credentialStatus, 'password-set');

    loginResult = await loginWithPassword(dynamicAccount.email, 'Robot-ax-pilot-016-demo');
    assert.equal(loginResult.status, 200);
    result = await requestAs(loginResult.body.token, '/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 1);
    assert.equal(result.body.data[0].serialNumber, 'AX-PILOT-016');

    result = await request('/api/v1/robots', { method: 'POST', body: JSON.stringify({ modelId: 'model-mock-m3', siteId: 'site-berlin', organizationId: 'org-demo', operatorOrganizationId: 'org-service', serialNumber: 'MANUAL-ROBOT-001', username: 'manual-robot-001@demo.altegro.local', password: 'Manual-robot-001' }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.account.username, 'manual-robot-001@demo.altegro.local');

    loginResult = await loginWithPassword('manual-robot-001@demo.altegro.local', 'Manual-robot-001');
    assert.equal(loginResult.status, 200);
    result = await requestAs(loginResult.body.token, '/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 1);
    assert.equal(result.body.data[0].serialNumber, 'MANUAL-ROBOT-001');

    result = await request(`/api/v1/robots/${robotId}/lifecycle-records`, { method: 'POST', body: JSON.stringify({ recordType: 'document', title: 'Commissioning report', version: '1.0', description: 'Signed commissioning evidence.', attachment: { name: 'commissioning.txt', contentType: 'text/plain', contentBase64: Buffer.from('commissioned').toString('base64') } }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.attachment.name, 'commissioning.txt');
    assert.ok(result.body.data.attachment.sha256);

    result = await request(`/api/v1/robots/${robotId}/lifecycle-records`, { method: 'POST', body: JSON.stringify({ recordType: 'certificate', title: 'Electrical safety certificate', issuer: 'Demo Certification GmbH', validUntil: '2027-07-30T00:00:00.000Z', status: 'valid' }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.status, 'valid');

    result = await request(`/api/v1/robots/${robotId}/lifecycle-records`, { method: 'POST', body: JSON.stringify({ recordType: 'deployment', title: 'Navigation package', packageName: 'navigation-core', version: '2.1.0', status: 'verified', rollbackVersion: '2.0.0' }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.rollbackVersion, '2.0.0');

    result = await request(`/api/v1/robots/${robotId}/passport`);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.documents.length, 1);
    assert.equal(result.body.data.certificates.length, 1);
    assert.equal(result.body.data.deployments.length, 1);
    assert.equal(result.body.data.documents[0].attachment.contentBase64, undefined);

    result = await request('/api/v1/incidents', { method: 'POST', body: JSON.stringify({ robotId, title: 'Robot stopped during operation', description: 'Operator secured the affected area.', severity: 'error', assignedTo: 'Robot Care Berlin' }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.serviceCase.status, 'open');
    const incidentServiceCaseId = result.body.data.serviceCase.id;

    result = await request(`/api/v1/service-cases/${incidentServiceCaseId}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed', cause: 'Obstruction sensor contamination', action: 'Sensor cleaned and verified', parts: [] }) });
    assert.equal(result.status, 200);
    assert.ok(result.body.data.closedAt);

    result = await request(`/api/v1/robots/${robotId}/passport`);
    assert.ok(result.body.data.entries.some((entry) => entry.type === 'service_completion'));
    result = await request('/api/v1/operations/summary');
    assert.equal(result.status, 200);
    assert.ok(result.body.data.passport.percentage >= 0);
    assert.ok(result.body.data.service.closed >= 1);
    result = await request('/api/v1/notifications');
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.data));
    assert.equal(result.body.count, result.body.data.length);

    result = await request('/api/v1/compatibility');
    assert.equal(result.status, 200);
    assert.ok(result.body.count >= 3);
    result = await request('/api/v1/compatibility', { method: 'POST', body: JSON.stringify({ modelId: 'model-autoxing-a1', capability: 'event.alert', versionConstraint: 'wrapper-backed', status: 'compatible', evidence: 'Contract test fixture' }) });
    assert.equal(result.status, 201);

    let exportResponse = await fetch(`http://localhost:${port}/api/v1/exports/robots.csv`, { headers: { authorization: `Bearer ${defaultToken}` } });
    assert.equal(exportResponse.status, 200);
    assert.match(await exportResponse.text(), /robot_id.*serial_number/);
    exportResponse = await fetch(`http://localhost:${port}/api/v1/robots/${robotId}/export`, { headers: { authorization: `Bearer ${defaultToken}` } });
    assert.equal(exportResponse.status, 200);
    assert.equal((await exportResponse.json()).passport.robot.id, robotId);

    loginResult = await loginWithPassword('auditor@demo.altegro.local', 'efrobotics');
    assert.equal(loginResult.status, 200);
    loginBody = loginResult.body;
    assert.equal(loginBody.user.role, 'auditor');
    const auditorSessionToken = loginBody.token;
    result = await requestAs(auditorSessionToken, '/api/v1/adapters');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.length, 0);
    result = await requestAs(auditorSessionToken, '/api/v1/incidents', { method: 'POST', body: JSON.stringify({ robotId, title: 'Must be blocked', description: 'Auditors are read-only.', severity: 'warning' }) });
    assert.equal(result.status, 403);
    exportResponse = await fetch(`http://localhost:${port}/api/v1/exports/tenant.json`, { headers: { authorization: `Bearer ${auditorSessionToken}` } });
    assert.equal(exportResponse.status, 200);
    assert.equal((await exportResponse.json()).tenantId, 'tenant-demo');

    result = await request('/api/v1/robots', { method: 'POST', body: JSON.stringify({ modelId: 'model-mock-m3', siteId: 'site-berlin', organizationId: 'org-demo', serialNumber: 'manual-robot-001', username: 'duplicate-robot@demo.altegro.local', password: 'Duplicate-robot-001' }) });
    assert.equal(result.status, 409);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failedLogin = await loginWithPassword('rate-limit-test@demo.altegro.local', 'wrong-password');
      assert.equal(failedLogin.status, 401);
    }
    const rateLimitedLogin = await loginWithPassword('rate-limit-test@demo.altegro.local', 'wrong-password');
    assert.equal(rateLimitedLogin.status, 429);

    result = await request('/api/v1/outbox');
    assert.equal(result.status, 200);
    assert.ok(result.body.count > 0);

    assert.equal(DATA_FILE, testDataFile);
    const persisted = fs.readFileSync(testDataFile, 'utf8');
    assert.match(persisted, /MANUAL-ROBOT-001/);
    assert.match(persisted, /scrypt\$/);
    assert.doesNotMatch(persisted, /Manual-robot-001/);
    assert.doesNotMatch(persisted, /efrobotics/);
    const restoredSerials = execFileSync(process.execPath, ['-e', "const { state } = require('./server'); process.stdout.write(JSON.stringify([...state.robots.values()].map((robot) => robot.serialNumber)));"], { cwd: __dirname, env: { ...process.env, ALTEGRO_DATA_FILE: testDataFile, ALTEGRO_PERSISTENCE: 'true' }, encoding: 'utf8' });
    assert.ok(JSON.parse(restoredSerials).includes('MANUAL-ROBOT-001'));

    console.log('All Altegro prototype tests passed.');
  } finally {
    server.close();
    fs.rmSync(testDataFile, { force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
