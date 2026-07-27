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

    result = await request('/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 2);
    const robotId = result.body.data[0].id;

    result = await request(`/api/v1/robots/${robotId}/passport`);
    assert.equal(result.status, 200);
    assert.ok(result.body.data.completeness.percentage >= 80);

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
