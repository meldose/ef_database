'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const testDataFile = path.join('/tmp', `altegro-test-state-${process.pid}.json`);
fs.rmSync(testDataFile, { force: true });
process.env.ALTEGRO_DATA_FILE = testDataFile;
process.env.ALTEGRO_PERSISTENCE = 'true';
process.env.ALTEGRO_PERSISTENCE_DRIVER = 'file';
process.env.OBJECT_STORAGE_DRIVER = 'inline';
process.env.ALTEGRO_SYNC_MODE = 'inline';
process.env.AUTOXING_LIVE = 'false';
process.env.CENOBOTS_LIVE = 'false';
process.env.CENOBOTS_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.EMAIL_ALERTS_ENABLED = 'true';
process.env.EMAIL_ALERT_TRANSPORT = 'capture';
process.env.EMAIL_ALERT_FROM = 'altegro-alerts@example.test';
process.env.EMAIL_ALERT_RECIPIENTS = 'operations@example.test,service@example.test';
process.env.EMAIL_ALERT_MIN_SEVERITY = 'error';
process.env.SMS_ALERTS_ENABLED = 'true';
process.env.SMS_ALERT_TRANSPORT = 'capture';
process.env.SMS_ALERT_RECIPIENTS = '+491701234567,+491709876543';
process.env.SMS_ALERT_MIN_SEVERITY = 'critical';
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

function encryptedWebhook(message) {
  const iv=crypto.randomBytes(12); const key=crypto.createHash('sha256').update(process.env.CENOBOTS_WEBHOOK_SECRET,'utf8').digest(); const cipher=crypto.createCipheriv('aes-256-gcm',key,iv); const ciphertext=Buffer.concat([cipher.update(JSON.stringify(message),'utf8'),cipher.final(),cipher.getAuthTag()]); return { iv:iv.toString('base64url'),encrypt:ciphertext.toString('base64url') };
}

async function startFakeSmtpServer() {
  const messages=[]; const smtp=net.createServer((socket) => { let buffer=''; let dataMode=false; let message=[]; socket.setEncoding('utf8'); socket.write('220 smtp.test ESMTP\r\n'); socket.on('data',(chunk) => { buffer += chunk; let index; while ((index=buffer.indexOf('\n')) >= 0) { const line=buffer.slice(0,index+1).trimEnd(); buffer=buffer.slice(index+1); if (dataMode) { if (line === '.') { messages.push(message.join('\n')); message=[]; dataMode=false; socket.write('250 queued\r\n'); } else message.push(line); continue; } if (line.startsWith('EHLO')) socket.write('250-smtp.test\r\n250 OK\r\n'); else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 OK\r\n'); else if (line === 'DATA') { dataMode=true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); } else if (line === 'QUIT') { socket.write('221 Bye\r\n'); socket.end(); } else socket.write('500 Unsupported command\r\n'); } }); });
  await new Promise((resolve,reject) => { smtp.once('error',reject); smtp.listen(0,'127.0.0.1',resolve); });
  return { server:smtp,port:smtp.address().port,messages };
}

(async () => {
  try {
    let result = await request('/health', { headers: {} });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.headers.get('x-frame-options'), 'DENY');
    assert.equal(result.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(result.headers.get('x-permitted-cross-domain-policies'), 'none');
    assert.match(result.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    process.env.ALTEGRO_HSTS_ENABLED='true'; const hstsResponse=await fetch(`http://localhost:${port}/health`); assert.match(hstsResponse.headers.get('strict-transport-security'),/max-age=/); delete process.env.ALTEGRO_HSTS_ENABLED;
    process.env.ALTEGRO_ALLOWED_HOSTS='localhost'; process.env.ALTEGRO_ALLOWED_ORIGINS='https://trusted.example'; let originResponse=await fetch(`http://localhost:${port}/api/v1/auth/logout`,{ method:'POST',headers:{ origin:'https://evil.example' } }); assert.equal(originResponse.status,403); originResponse=await fetch(`http://localhost:${port}/api/v1/auth/logout`,{ method:'POST',headers:{ origin:'https://trusted.example' } }); assert.equal(originResponse.status,200); delete process.env.ALTEGRO_ALLOWED_HOSTS; delete process.env.ALTEGRO_ALLOWED_ORIGINS;
    const readyResponse = await fetch(`http://localhost:${port}/ready`);
    assert.equal(readyResponse.status,200);
    assert.equal((await readyResponse.json()).ready,true);
    const metricsResponse = await fetch(`http://localhost:${port}/metrics`);
    assert.equal(metricsResponse.status,200);
    assert.match(await metricsResponse.text(),/altegro_http_requests_total/);
    const frontendResponse = await fetch(`http://localhost:${port}/`);
    assert.equal(frontendResponse.status, 200);
    const frontendHtml = await frontendResponse.text();
    for (const controlId of ['dashboardTabs', 'roleDashboard', 'customerDashboardPanel', 'customerDashboardContent', 'exportRobotsCsv', 'serviceTechniciansButton', 'themeToggle', 'customizeDashboard', 'dashboardCustomizationDialog', 'advancedRobotSearch', 'providerFilter', 'siteFilter', 'modelFilter', 'batteryMinFilter', 'batteryMaxFilter', 'attentionFilter', 'trackingView', 'trackingMetrics', 'trackingCanvas', 'trackingFleetList', 'accessibilityButton', 'accessibilityDialog', 'accessibilityTheme', 'accessibilitySpacing', 'accessibilityFocus', 'resourceExplorer', 'taskHistoryList', 'taskDetailDialog', 'autoXingLiveFleet', 'autoXingFleetSearch', 'autoXingFleetPrevious', 'autoXingTaskAnalytics', 'autoXingDiagnostics', 'autoXingMonitoring', 'autoXingAlerts', 'alertWorkflowDialog', 'autoXingMaintenancePanel', 'autoXingMaintenanceSummary', 'maintenanceScheduleDialog', 'maintenanceReminderDays', 'autoXingDiagnosticPanel', 'diagnosticRobotSelect', 'autoXingEscalationPanel', 'autoXingEscalationRules', 'escalationRuleDialog', 'autoXingTrends', 'cenoBotsLiveFleet', 'cenoBotsDiagnostics', 'cenoBotsControlSection', 'cenoBotsCommandDialog', 'cenoBotsScheduleDialog', 'reportMetrics', 'advancedAnalytics', 'maintenancePredictions', 'reportTrend', 'pdfReportRobot', 'exportMaintenancePdf', 'exportCompliancePdf', 'supportView', 'supportTicketsList', 'supportTicketDialog', 'supportReplyDialog', 'languageSelect', 'notificationSearch', 'notificationWorkflowDialog', 'onboardingProvider', 'onboardingExternalId', 'robotAccountsList', 'emailNotificationsSection', 'emailNotificationStatus', 'testEmailNotification', 'smsNotificationsSection', 'smsNotificationStatus', 'testSmsNotification', 'compatibilityForm', 'workforceSection', 'technicianAvailabilityList', 'technicianAvailabilityDialog', 'workOrderCalendar', 'workOrderDialog', 'permissionMatrix', 'auditSearch', 'technicianForm', 'qualificationForm']) assert.match(frontendHtml, new RegExp(`id="${controlId}"`));
    for (const view of ['overview', 'tracking', 'robots', 'operations', 'autoxing', 'cenobots', 'workforce', 'reports', 'support', 'admin']) assert.match(frontendHtml, new RegExp(`data-dashboard-tab="${view}"`));
    assert.match(frontendHtml,/data-i18n="support"/);
    const refreshedDashboard=await fetch(`http://localhost:${port}/dashboard/reports`); assert.equal(refreshedDashboard.status,200); assert.match(await refreshedDashboard.text(),/id="reportsView"/);

    const webhookHeaders={ 'content-type':'application/json','x-webhook-id':'trace-test','x-webhook-timestamp':String(Math.floor(Date.now()/1000)) };
    let webhookResponse=await fetch(`http://localhost:${port}/api/v1/webhooks/cenobots`,{ method:'POST',headers:webhookHeaders,body:JSON.stringify(encryptedWebhook({ messageType:'challenge',data:{ challenge:'verify-me' } })) });
    assert.equal(webhookResponse.status,200); assert.equal((await webhookResponse.json()).challenge,'verify-me');
    const webhookEvent={ messageType:'event',data:{ id:'evt-test-cenobots-error',type:'robot.error.changed',apiVersion:'2026-07-01',occurredAt:Date.now(),device:{ openId:'CB-1001',licensePlate:'CB-DEMO-001' },data:{ codes:[{ code:204801,desc:'Emergency stop button is pressed' }],addedCodes:[204801],removedCodes:[],previousCodes:[] } } };
    webhookResponse=await fetch(`http://localhost:${port}/api/v1/webhooks/cenobots`,{ method:'POST',headers:webhookHeaders,body:JSON.stringify(encryptedWebhook(webhookEvent)) });
    assert.equal(webhookResponse.status,200); assert.equal((await webhookResponse.json()).duplicate,false);
    webhookResponse=await fetch(`http://localhost:${port}/api/v1/webhooks/cenobots`,{ method:'POST',headers:webhookHeaders,body:JSON.stringify(encryptedWebhook(webhookEvent)) });
    assert.equal(webhookResponse.status,200); assert.equal((await webhookResponse.json()).duplicate,true); assert.equal(state.cenobotsWebhookReceipts.size,1);
    webhookResponse=await fetch(`http://localhost:${port}/api/v1/webhooks/cenobots`,{ method:'POST',headers:{ ...webhookHeaders,'x-webhook-timestamp':String(Math.floor(Date.now()/1000)-1000) },body:JSON.stringify(encryptedWebhook(webhookEvent)) }); assert.equal(webhookResponse.status,401);

    const oldPasswordLogin = await loginWithPassword('admin@demo.altegro.local', 'demo');
    assert.equal(oldPasswordLogin.status, 401);
    let loginResult = await loginWithPassword('admin@demo.altegro.local', 'efrobotics');
    let loginBody = loginResult.body;
    assert.equal(loginResult.status, 200);
    assert.equal(loginBody.user.role, 'platform_admin');
    assert.ok(loginBody.user.permissions.includes('work_order.manage'));
    assert.notEqual(loginBody.token, 'demo-platform-admin');
    assert.match(loginResult.headers.get('set-cookie'), /HttpOnly/);
    assert.match(loginResult.headers.get('set-cookie'), /SameSite=Strict/);
    const browserCookie = loginResult.headers.get('set-cookie').split(';')[0];
    const wsHandshake=await new Promise((resolve,reject) => { const socket=net.createConnection({ host:'127.0.0.1',port },() => socket.write(`GET /api/v1/notifications/stream HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nCookie: ${browserCookie}\r\n\r\n`)); let response=''; const timer=setTimeout(() => { socket.destroy(); reject(new Error('WebSocket handshake timed out')); },2000); socket.on('data',(chunk) => { response+=chunk.toString('latin1'); if (response.includes('\r\n\r\n')) { clearTimeout(timer); socket.destroy(); resolve(response); } }); socket.on('error',reject); }); assert.match(wsHandshake,/101 Switching Protocols/);
    const cookieSessionResponse = await fetch(`http://localhost:${port}/api/v1/auth/session`, { headers: { cookie: browserCookie } });
    assert.equal(cookieSessionResponse.status, 200);
    assert.equal((await cookieSessionResponse.json()).user.role, 'platform_admin');
    defaultToken = loginBody.token;
    result=await request('/api/v1/sync-jobs'); assert.equal(result.status,200); assert.equal(result.body.mode,'inline'); assert.deepEqual(result.body.data,[]);
    result = await request('/api/v1/auth/session');
    assert.equal(result.status, 200);
    assert.equal(result.body.user.role, 'platform_admin');
    result=await request('/api/v1/permissions'); assert.equal(result.status,200); assert.ok(result.body.data.permissions.includes('audit.export')); assert.ok(result.body.data.roles.some((item) => item.role === 'technician' && item.permissions.includes('work_order.update_assigned')));
    result = await request('/api/v1/email-notifications');
    assert.equal(result.status,200);
    assert.equal(result.body.data.configuration.enabled,true);
    assert.equal(result.body.data.configuration.transport,'capture');
    assert.equal(result.body.data.configuration.recipientCount,2);
    result = await request('/api/v1/email-notifications/test',{ method:'POST',body:'{}' });
    assert.equal(result.status,200);
    assert.equal(result.body.data.status,'sent');
    assert.equal(result.body.data.recipientCount,2);
    result = await request('/api/v1/sms-notifications'); assert.equal(result.status,200); assert.equal(result.body.data.configuration.enabled,true); assert.equal(result.body.data.configuration.transport,'capture'); assert.equal(result.body.data.configuration.recipientCount,2);
    result = await request('/api/v1/sms-notifications/test',{ method:'POST',body:'{}' }); assert.equal(result.status,200); assert.equal(result.body.data.status,'sent'); assert.equal(result.body.data.recipientCount,2);
    const fakeSmtp=await startFakeSmtpServer(); process.env.EMAIL_ALERT_TRANSPORT='smtp'; process.env.EMAIL_SMTP_HOST='127.0.0.1'; process.env.EMAIL_SMTP_PORT=String(fakeSmtp.port); process.env.EMAIL_SMTP_SECURE='false'; delete process.env.EMAIL_SMTP_USERNAME; delete process.env.EMAIL_SMTP_PASSWORD; delete process.env.EMAIL_SMTP_PASSWORD_FILE;
    result=await request('/api/v1/email-notifications/test',{ method:'POST',body:'{}' });
    assert.equal(result.status,200); assert.equal(result.body.data.status,'sent'); assert.equal(fakeSmtp.messages.length,1); assert.match(fakeSmtp.messages[0],/Test requested by Demo Platform Admin/); await new Promise((resolve) => fakeSmtp.server.close(resolve)); process.env.EMAIL_ALERT_TRANSPORT='capture';
    result = await requestAs('demo-platform-admin', '/api/v1/robots');
    assert.equal(result.status, 401);
    result = await request('/api/v1/demo/tokens');
    assert.equal(result.status, 404);

    result = await request('/api/v1/robots');
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 2);
    assert.equal(result.body.pagination.page, 1);
    assert.equal(result.body.facets.total, 2);
    assert.ok(result.body.facets.providers.some((item) => item.value === 'autoxing'));
    assert.ok(result.body.facets.providers.some((item) => item.value === 'cenobots'));
    const robotId = result.body.data[0].id;
    const cenobotsRobotId = result.body.data[1].id;
    state.robots.get(robotId).position={ x:12.5,y:-3.2,yaw:1.2 }; state.robots.get(robotId).speed=0.4; state.robots.get(cenobotsRobotId).position={ x:4.1,y:8.7,yaw:-0.3 };
    result=await request('/api/v1/tracking/live'); assert.equal(result.status,200); assert.equal(result.body.data.summary.total,2); assert.equal(result.body.data.summary.located,2); assert.ok(result.body.data.fleet.find((robot) => robot.id === robotId).position);

    result = await request('/api/v1/cenobots/operations');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.summary.total, 1);
    assert.equal(result.body.data.fleet[0].id, cenobotsRobotId);
    assert.equal(result.body.data.fleet[0].externalId, 'CB-1001');
    assert.equal(result.body.data.diagnostics.liveEnabled, false);
    assert.equal(result.body.data.control.ready,false);
    assert.equal(result.body.data.control.canControl,true);
    assert.ok(Array.isArray(result.body.data.alerts));
    state.robots.get(cenobotsRobotId).battery = 55;
    state.robots.get(cenobotsRobotId).maintenance = { maintenanceItems:[{ name:'Solution Tank Filter',remainPercent:'19%',overDueHours:null }] };
    state.robots.get(cenobotsRobotId).errors = [{ code:'CB-TEST',message:'Synthetic system error' }];
    result = await request('/api/v1/cenobots/operations');
    assert.equal(result.body.data.summary.maintenanceDue, 1);
    assert.equal(result.body.data.summary.errors, 1);
    assert.equal(result.body.data.alerts.length, 2);
    result=await request('/api/v1/robots?provider=cenobots&batteryMax=100&attention=true'); assert.equal(result.status,200); assert.equal(result.body.count,1); assert.equal(result.body.data[0].id,cenobotsRobotId);
    result=await request('/api/v1/maintenance/predictions'); assert.equal(result.status,200); assert.equal(result.body.data.length,2); assert.ok(result.body.data.some((item) => item.robotId === cenobotsRobotId && item.score > 0)); assert.ok(Number.isInteger(result.body.summary.attention));
    result=await request(`/api/v1/cenobots/robots/${cenobotsRobotId}/commands`,{ method:'POST',body:JSON.stringify({ action:'go-home',execute:false }) }); assert.equal(result.status,200); assert.equal(result.body.data.dryRun,true); assert.match(result.body.data.message,/Preview only/);
    result=await request(`/api/v1/cenobots/robots/${cenobotsRobotId}/commands`,{ method:'POST',body:JSON.stringify({ action:'schedule',execute:false,mapId:42,mapVersion:'test.map.version',startTime:'04:52 PM',duration:60,intensity:'MEDIUM',cleanEverywhere:true,repeat:['Mon.','Fri.'] }) }); assert.equal(result.status,200); assert.equal(result.body.data.task.payload.repeat.length,2);
    result=await request(`/api/v1/cenobots/robots/${cenobotsRobotId}/commands`,{ method:'POST',body:JSON.stringify({ action:'go-home',execute:true,confirmation:'CB-DEMO-001' }) }); assert.equal(result.status,503);
    result=await request(`/api/v1/cenobots/robots/${cenobotsRobotId}/schedules`); assert.equal(result.status,200); assert.equal(result.body.available,false); assert.deepEqual(result.body.data,[]);

    result=await request('/api/v1/autoxing/maintenance-schedules',{ method:'POST',body:JSON.stringify({ robotId,title:'Quarterly AutoXing inspection',description:'Inspect sensors and safety systems.',nextDueAt:'2026-07-01T09:00:00.000Z',intervalDays:90,reminderDays:14,priority:'high',assignedTechnicianId:'technician-lena' }) });
    assert.equal(result.status,201); assert.equal(result.body.data.dueState,'overdue'); assert.equal(result.body.data.reminderState,'overdue'); assert.equal(result.body.data.reminderDays,14); assert.equal(result.body.data.technicianName,'Midhun Eldose'); const maintenanceScheduleId=result.body.data.id;
    result=await request('/api/v1/autoxing/maintenance-schedules'); assert.equal(result.status,200); assert.ok(result.body.data.some((item) => item.id === maintenanceScheduleId));
    result=await request('/api/v1/notifications'); assert.equal(result.status,200); assert.ok(result.body.data.some((item) => item.type === 'maintenance_reminder' && item.robotId === robotId));

    result = await request(`/api/v1/workforce/matrix?robotId=${robotId}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.rows.length, 4);
    for (const name of ['Midhun Eldose', 'Ahmed Galai', 'Michell Blawat', 'Elvis Heil']) {
      assert.ok(result.body.data.technicians.some((technician) => technician.name === name && technician.jobTitle === 'Service Technician'));
    }
    result=await request('/api/v1/technicians/technician-lena/availability',{ method:'PATCH',body:JSON.stringify({ status:'busy',workingDays:['Mon.','Tue.','Wed.','Thur.'],dailyCapacityHours:6,notes:'Reserved for field service.' }) }); assert.equal(result.status,200); assert.equal(result.body.data.availability.status,'busy'); assert.equal(result.body.data.availability.dailyCapacityHours,6);
    result=await request(`/api/v1/workforce/matrix?robotId=${robotId}`); assert.equal(result.body.data.technicians.find((technician) => technician.id === 'technician-lena').availability.status,'busy');
    const workOrderStart=new Date(Date.now()+3*86400000); workOrderStart.setUTCHours(9,0,0,0); const workOrderEnd=new Date(workOrderStart.getTime()+2*3600000);
    result=await request('/api/v1/work-orders',{ method:'POST',body:JSON.stringify({ robotId,technicianId:'technician-lena',title:'Predictive sensor inspection',description:'Inspect the risk factors identified by Altegro.',priority:'high',startsAt:workOrderStart.toISOString(),endsAt:workOrderEnd.toISOString() }) }); assert.equal(result.status,201); assert.equal(result.body.data.technicianName,'Midhun Eldose'); const workOrderId=result.body.data.id;
    result=await request('/api/v1/work-orders'); assert.equal(result.status,200); assert.ok(result.body.data.some((item) => item.id === workOrderId)); assert.equal(result.body.permissions.manage,true);
    result=await request(`/api/v1/work-orders/${workOrderId}`,{ method:'PATCH',body:JSON.stringify({ status:'in_progress' }) }); assert.equal(result.status,200); assert.equal(result.body.data.status,'in_progress');
    const technicianLogin=await loginWithPassword('technician@demo.altegro.local','efrobotics'); assert.equal(technicianLogin.status,200); const technicianToken=technicianLogin.body.token;
    result=await requestAs(technicianToken,'/api/v1/work-orders'); assert.equal(result.status,200); assert.ok(result.body.data.some((item) => item.id === workOrderId)); assert.equal(result.body.permissions.manage,false); assert.equal(result.body.permissions.updateAssigned,true);
    result=await requestAs(technicianToken,`/api/v1/work-orders/${workOrderId}`,{ method:'PATCH',body:JSON.stringify({ status:'blocked',completionNote:'Waiting for access.' }) }); assert.equal(result.status,200); assert.equal(result.body.data.status,'blocked');
    result=await requestAs(technicianToken,'/api/v1/work-orders',{ method:'POST',body:JSON.stringify({}) }); assert.equal(result.status,403);
    result=await request(`/api/v1/workforce/matrix?robotId=${robotId}`);
    const lenaRow = result.body.data.rows.find((row) => row.technician.id === 'technician-lena');
    const noraRow = result.body.data.rows.find((row) => row.technician.id === 'technician-nora');
    assert.equal(lenaRow.eligibility.eligible, true);
    assert.equal(noraRow.eligibility.eligible, false);
    result = await request('/api/v1/robot-assignments', { method:'POST', body:JSON.stringify({ robotId, technicianId:'technician-nora' }) });
    assert.equal(result.status, 409);
    result = await request('/api/v1/robot-assignments', { method:'POST', body:JSON.stringify({ robotId, technicianId:'technician-lena' }) });
    assert.equal(result.status, 201);
    const seededAssignmentId = result.body.data.id;
    result = await request(`/api/v1/robots/${robotId}/passport`);
    assert.ok(result.body.data.workforce.assignedTechnicians.some((item) => item.technician.id === 'technician-lena'));
    result = await request(`/api/v1/robot-assignments/${seededAssignmentId}`, { method:'DELETE' });
    assert.equal(result.status, 200);

    result = await request('/api/v1/technicians', { method:'POST', body:JSON.stringify({ name:'Test Qualified Technician', email:'qualified-technician@example.test', organizationId:'org-service' }) });
    assert.equal(result.status, 201);
    const qualifiedTechnicianId = result.body.data.id;
    result = await request(`/api/v1/technicians/${qualifiedTechnicianId}/qualifications`, { method:'POST', body:JSON.stringify({ kind:'skill', code:'autoxing_service', level:'advanced' }) });
    assert.equal(result.status, 201);
    result = await request(`/api/v1/technicians/${qualifiedTechnicianId}/qualifications`, { method:'POST', body:JSON.stringify({ kind:'certificate', code:'robot_electrical_safety', issuer:'Test Academy', validUntil:'2030-12-31T00:00:00.000Z', modelIds:['model-autoxing-a1'] }) });
    assert.equal(result.status, 201);
    result = await request(`/api/v1/workforce/matrix?robotId=${robotId}`);
    assert.equal(result.body.data.rows.find((row) => row.technician.id === qualifiedTechnicianId).eligibility.status, 'qualified');
    result = await request('/api/v1/robot-assignments', { method:'POST', body:JSON.stringify({ robotId, technicianId:qualifiedTechnicianId }) });
    assert.equal(result.status, 201);

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
    result=await requestAs(robotAxSessionToken,'/api/v1/tracking/live'); assert.equal(result.status,200); assert.equal(result.body.data.summary.total,1); assert.equal(result.body.data.fleet[0].serialNumber,'AX-DEMO-001');

    result = await requestAs(robotAxSessionToken, `/api/v1/robots/${cenobotsRobotId}/passport`);
    assert.equal(result.status, 404);

    result = await requestAs(robotAxSessionToken, '/api/v1/events');
    assert.equal(result.status, 200);
    assert.ok(result.body.data.every((event) => event.robotId === robotId));
    result = await requestAs(robotAxSessionToken,'/api/v1/email-notifications');
    assert.equal(result.status,403);
    result = await requestAs(robotAxSessionToken, '/api/v1/workforce/matrix');
    assert.equal(result.status, 403);
    result=await requestAs(robotAxSessionToken,'/api/v1/autoxing/maintenance-schedules'); assert.equal(result.status,200); assert.equal(result.body.count,1);
    result=await requestAs(robotAxSessionToken,'/api/v1/autoxing/maintenance-schedules',{ method:'POST',body:JSON.stringify({}) }); assert.equal(result.status,403);
    result=await requestAs(robotAxSessionToken,'/api/v1/autoxing/escalation-rules'); assert.equal(result.status,403);
    result=await requestAs(robotAxSessionToken,'/api/v1/support/tickets',{ method:'POST',body:JSON.stringify({ robotId,title:'Customer needs assistance',description:'The robot stopped near the loading bay.',category:'technical',severity:'warning' }) }); assert.equal(result.status,201); assert.equal(result.body.data.requesterName,'AX-DEMO-001 User'); const customerSupportTicketId=result.body.data.id;
    result=await requestAs(robotAxSessionToken,`/api/v1/support/tickets/${customerSupportTicketId}/messages`,{ method:'POST',body:JSON.stringify({ message:'The area is secured and ready for inspection.' }) }); assert.equal(result.status,201); assert.equal(result.body.data.messages.length,2);
    result=await requestAs(robotAxSessionToken,'/api/v1/support/tickets'); assert.equal(result.status,200); assert.ok(result.body.data.some((ticket) => ticket.id === customerSupportTicketId));
    let scopedPdf=await fetch(`http://localhost:${port}/api/v1/robots/${robotId}/reports/compliance.pdf`,{ headers:{ authorization:`Bearer ${robotAxSessionToken}` } }); assert.equal(scopedPdf.status,200); assert.match(scopedPdf.headers.get('content-type'),/application\/pdf/); assert.equal(Buffer.from(await scopedPdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');

    state.autoxing.tasks.set('task-ax-scope', { taskId: 'task-ax-scope', raw: { robotId: 'AX-1001', status:'completed', durationSeconds:600, cleanedArea:120, updatedAt:'2026-07-27T14:00:00.000Z' } });
    state.autoxing.tasks.set('task-cb-scope', { taskId: 'task-cb-scope', raw: { robotId: 'CB-1001' } });
    result = await requestAs(robotAxSessionToken, '/api/v1/autoxing/tasks');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.map((task) => task.taskId), ['task-ax-scope']);
    result = await requestAs(robotAxSessionToken, '/api/v1/autoxing/tasks/task-ax-scope');
    assert.equal(result.status,200);
    assert.equal(result.body.data.normalized.completed,true);
    assert.equal(result.body.data.robot.id,robotId);
    result = await requestAs(robotAxSessionToken, '/api/v1/autoxing/tasks/task-cb-scope');
    assert.equal(result.status,404);
    state.robots.get(robotId).online = false; state.robots.get(robotId).battery = 15;
    result = await requestAs(robotAxSessionToken, '/api/v1/autoxing/operations');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.fleet.length, 1);
    assert.equal(result.body.data.taskAnalytics.total, 1);
    assert.equal(result.body.data.taskAnalytics.completed, 1);
    assert.ok(result.body.data.alerts.some((alert) => alert.robotId === robotId && alert.recommendedAction));
    assert.ok(result.body.data.alerts.some((alert) => alert.id === `maintenance:${maintenanceScheduleId}` && alert.type === 'maintenance_due'));
    assert.equal(result.body.data.maintenance.overdue,1);
    assert.equal(result.body.data.trends.length, 7);
    assert.ok(Array.isArray(result.body.data.diagnostics.syncHistory));
    assert.equal(result.body.data.alertWorkflow.canManage,false);
    const workflowAlertId=result.body.data.alerts.find((alert) => alert.robotId === robotId).id;
    result=await request('/api/v1/autoxing/escalation-rules',{ method:'POST',body:JSON.stringify({ name:'Offline robot escalation',minimumSeverity:'warning',alertType:'offline',afterMinutes:0,action:'email_and_service_case',technicianId:'technician-lena' }) });
    assert.equal(result.status,201); const escalationRuleId=result.body.data.id;
    result=await request('/api/v1/autoxing/escalations/evaluate',{ method:'POST',body:'{}' }); assert.equal(result.status,200); assert.ok(result.body.data.created.some((item) => item.ruleId === escalationRuleId && item.actions.includes('service_case') && item.actions.includes('email')));
    assert.ok([...state.alertEscalations.values()].some((item) => item.ruleId === escalationRuleId));
    result=await request('/api/v1/autoxing/escalation-rules'); assert.equal(result.status,200); assert.equal(result.body.data.find((item) => item.id === escalationRuleId).executionCount,1);
    result=await requestAs(robotAxSessionToken,`/api/v1/autoxing/alerts/${encodeURIComponent(workflowAlertId)}`,{ method:'PATCH',body:JSON.stringify({ status:'acknowledged' }) });
    assert.equal(result.status,403);
    result=await request(`/api/v1/autoxing/alerts/${encodeURIComponent(workflowAlertId)}`,{ method:'PATCH',body:JSON.stringify({ status:'acknowledged',technicianId:'technician-lena',note:'Remote triage complete.',createServiceCase:true }) });
    assert.equal(result.status,200);
    assert.equal(result.body.data.workflow.status,'in_progress');
    assert.ok(result.body.data.workflow.serviceCaseId);
    assert.equal(state.alertWorkflows.get(workflowAlertId).technicianName,'Midhun Eldose');
    result=await request('/api/v1/monitoring');
    assert.equal(result.status,200);
    assert.equal(result.body.data.readiness.ready,true);
    assert.ok(result.body.data.requests.total > 0);
    result=await requestAs(robotAxSessionToken,'/api/v1/monitoring');
    assert.equal(result.body.data.fleet.robots,1);
    assert.deepEqual(result.body.data.adapters,[]);
    state.robots.get(robotId).online = true; state.robots.get(robotId).battery = 87;

    const diagnosticResponse=await fetch(`http://localhost:${port}/api/v1/autoxing/diagnostic-reports/${robotId}`,{ headers:{ authorization:`Bearer ${robotAxSessionToken}` } }); assert.equal(diagnosticResponse.status,200); assert.match(diagnosticResponse.headers.get('content-disposition'),/autoxing-diagnostic-AX-DEMO-001/); const diagnostic=await diagnosticResponse.json(); assert.equal(diagnostic.reportType,'autoxing_remote_diagnostic'); assert.equal(diagnostic.robot.id,robotId); assert.ok(Array.isArray(diagnostic.diagnostics.recentEvents)); assert.equal(diagnostic.diagnostics.maintenanceSchedules.length,1);
    result=await request(`/api/v1/autoxing/maintenance-schedules/${maintenanceScheduleId}`,{ method:'PATCH',body:JSON.stringify({ complete:true,completionNote:'Inspection completed during automated test.' }) }); assert.equal(result.status,200); assert.ok(Date.parse(result.body.data.nextDueAt) > Date.now()); assert.ok(result.body.data.lastCompletedAt);
    result=await request(`/api/v1/robots/${robotId}/passport`); assert.ok(result.body.data.entries.some((entry) => entry.type === 'maintenance_completion'));
    result=await request(`/api/v1/autoxing/escalation-rules/${escalationRuleId}`,{ method:'PATCH',body:JSON.stringify({ active:false }) }); assert.equal(result.status,200); assert.equal(result.body.data.active,false);

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

    result = await request('/api/v1/incidents', { method: 'POST', body: JSON.stringify({ robotId, title: 'Robot stopped during operation', description: 'Operator secured the affected area.', severity: 'critical', assignedTo: 'Robot Care Berlin' }) });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.serviceCase.status, 'open');
    await new Promise((resolve) => setImmediate(resolve));
    const incidentEmail=state.emailDeliveries.find((delivery) => delivery.type === 'technical_event' && delivery.title === 'Robot stopped during operation');
    assert.ok(incidentEmail);
    assert.equal(incidentEmail.status,'sent');
    assert.equal(incidentEmail.robotSerialNumber,'AX-DEMO-001');
    const incidentSms=state.smsDeliveries.find((delivery) => delivery.type === 'technical_event' && delivery.title === 'Robot stopped during operation'); assert.ok(incidentSms); assert.equal(incidentSms.status,'sent'); assert.equal(incidentSms.robotSerialNumber,'AX-DEMO-001');
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
    result=await request('/api/v1/customer-dashboard'); assert.equal(result.status,200); assert.equal(result.body.data.customer.id,'org-demo'); assert.ok(result.body.data.fleet.total >= 2); assert.ok(Array.isArray(result.body.data.sites));
    result = await request('/api/v1/notifications');
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.data));
    assert.equal(result.body.count, result.body.data.length);
    assert.ok(Number.isInteger(result.body.activeCount));
    assert.ok(Number.isInteger(result.body.unreadCount));
    assert.ok(result.body.unreadCount > 0);
    const notificationIds=result.body.data.map((item) => item.id);
    result=await request('/api/v1/notifications/read',{ method:'POST',body:JSON.stringify({ notificationIds }) });
    assert.equal(result.status,200); assert.equal(result.body.readCount,notificationIds.length); assert.equal(result.body.unreadCount,0);
    result=await request('/api/v1/notifications'); assert.equal(result.status,200); assert.equal(result.body.unreadCount,0); assert.ok(result.body.data.every((item) => item.read === true));
    const managedNotification=result.body.data.find((item) => item.robotId);
    assert.ok(managedNotification);
    result=await request(`/api/v1/notifications/${encodeURIComponent(managedNotification.id)}`,{ method:'PATCH',body:JSON.stringify({ status:'acknowledged',note:'Reviewed by automated test.' }) });
    assert.equal(result.status,200); assert.equal(result.body.data.status,'acknowledged');
    result=await request('/api/v1/reports/operations?days=30'); assert.equal(result.status,200); assert.equal(result.body.data.period.days,30); assert.ok(Array.isArray(result.body.data.daily)); assert.equal(result.body.data.daily.length,30); assert.ok('healthScore' in result.body.data.fleet); assert.ok('averageResolutionHours' in result.body.data.service); assert.ok('availabilityPercent' in result.body.data.workforce);
    assert.ok('predictedHighRisk' in result.body.data.maintenance);
    result=await request('/api/v1/audit?action=work_order.create'); assert.equal(result.status,200); assert.ok(result.body.data.some((item) => item.action === 'work_order.create')); assert.ok(Array.isArray(result.body.facets.actions));
    const auditExport=await fetch(`http://localhost:${port}/api/v1/audit.csv?result=success`,{ headers:{ authorization:`Bearer ${defaultToken}` } }); assert.equal(auditExport.status,200); assert.match(await auditExport.text(),/occurredAt.*actor.*action.*objectType/);
    const reportExportResponse=await fetch(`http://localhost:${port}/api/v1/reports/operations.csv?days=7`,{ headers:{ authorization:`Bearer ${defaultToken}` } }); assert.equal(reportExportResponse.status,200); assert.match(await reportExportResponse.text(),/date.*events.*errors.*maintenance.*tasks/);
    result=await request('/api/v1/cenobots/webhooks/status'); assert.equal(result.status,200); assert.equal(result.body.data.configured,true); assert.equal(result.body.data.receiptCount,1);

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
    assert.match(persisted, /Altegro email notification test/);
    assert.match(persisted, /Altegro SMS notification test/);
    assert.match(persisted, /Robot stopped during operation/);
    assert.match(persisted, /Quarterly AutoXing inspection/);
    assert.match(persisted, /Predictive sensor inspection/);
    assert.match(persisted, /Offline robot escalation/);
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
