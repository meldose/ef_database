'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');

const html=fs.readFileSync('public/index.html','utf8');
const docs=fs.readFileSync('public/docs.html','utf8');
const openapi=JSON.parse(fs.readFileSync('public/openapi.json','utf8'));

assert.equal(openapi.openapi,'3.1.0');
for (const path of ['/ready','/api/v1/robots','/api/v1/adapters/{provider}/sync','/api/v1/sync-jobs/{jobId}','/api/v1/cenobots/robots/{robotId}/commands']) assert.ok(openapi.paths[path],`OpenAPI path missing: ${path}`);
assert.match(html,/<a class="skip-link" href="#mainContent"/);
assert.match(html,/<main[^>]+id="mainContent"[^>]+tabindex="-1"/);
assert.match(html,/id="syncStatus"[^>]+role="status"[^>]+aria-live="polite"/);
assert.match(html,/id="commandMenuButton"[^>]+aria-controls="commandMenuDialog"/);
assert.match(html,/id="commandMenuDialog"[^>]+aria-labelledby="commandMenuTitle"/);
assert.match(html,/id="dataFreshness"[^>]+role="status"[^>]+aria-live="polite"/);
for (const id of ['cenoBotsControlReason','cenoBotsCommandResult','cenoBotsCleanDialog','cenoBotsCleanForm','cenoBotsCleanConfirmation']) assert.match(html,new RegExp(`id="${id}"`));
for (const dialog of html.matchAll(/<dialog id="([^"]+)"[^>]*aria-labelledby="([^"]+)"/g)) assert.match(html,new RegExp(`id="${dialog[2]}"`),`${dialog[1]} references a missing label`);
assert.match(docs,/<main[^>]+id="apiContent"/);
assert.match(docs,/href="\/openapi.json"/);

console.log('OpenAPI and accessibility contract checks passed.');
