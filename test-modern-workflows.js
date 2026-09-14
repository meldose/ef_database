'use strict';

const assert = require('node:assert/strict');
Object.assign(process.env, { NODE_ENV:'test', ALTEGRO_ENV_FILE:'/dev/null', ALTEGRO_PERSISTENCE_DRIVER:'memory', ALTEGRO_PERSISTENCE:'false', OBJECT_STORAGE_DRIVER:'inline', ALTEGRO_SYNC_MODE:'inline', AUTOXING_LIVE:'false', CENOBOTS_LIVE:'false', EMAIL_ALERTS_ENABLED:'false', SMS_ALERTS_ENABLED:'false' });
const { server, state } = require('./server');

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const sessions=new Map();
  async function tokenFor(role) {
    if (!sessions.has(role)) { const credentials={ 'demo-platform-admin':['admin','efrobotics'], 'demo-owner':['owner','efrobotics'], 'demo-auditor':['auditor','efrobotics'], 'demo-robot-ax-001':['robot-ax-001','AX-robot-001-demo'], 'demo-robot-cb-001':['robot-cb-001','CB-robot-001-demo'] }; const [name,password]=credentials[role]; const response=await fetch(origin+'/api/v1/auth/login',{ method:'POST',headers:{ 'content-type':'application/json' },body:JSON.stringify({ email:`${name}@demo.altegro.local`,password }) }); assert.equal(response.status,200); sessions.set(role,(await response.json()).token); }
    return sessions.get(role);
  }
  async function request(path, method = 'GET', body, token = 'demo-platform-admin') {
    const response = await fetch(origin + path, { method, headers:{ authorization:`Bearer ${await tokenFor(token)}`, 'content-type':'application/json' }, ...(body ? { body:JSON.stringify(body) } : {}) });
    return { status:response.status, body:await response.json() };
  }
  try {
    const ax = [...state.robots.values()].find((robot) => robot.serialNumber === 'AX-DEMO-001'); const cb = [...state.robots.values()].find((robot) => robot.serialNumber === 'CB-DEMO-001');
    const attachment = { name:'inspection.txt', contentType:'text/plain', contentBase64:Buffer.from('Inspection evidence').toString('base64') };
    let result = await request('/api/v1/support/tickets', 'POST', { robotId:ax.id, title:'Sensor inspection', description:'Please inspect the sensor', attachment }); assert.equal(result.status,201);
    const ticket = result.body.data; assert.equal(ticket.messages[0].attachment.contentBase64,undefined); assert.equal(ticket.messages[0].attachment.size,19);
    const downloadPath = `/api/v1/support/tickets/${ticket.id}/messages/${ticket.messages[0].id}/attachment`;
    let download = await fetch(origin + downloadPath, { headers:{ authorization:`Bearer ${await tokenFor('demo-platform-admin')}` } }); assert.equal(download.status,200); assert.equal(await download.text(),'Inspection evidence');
    download = await fetch(origin + downloadPath, { headers:{ authorization:`Bearer ${await tokenFor('demo-robot-cb-001')}` } }); assert.equal(download.status,404);
    result = await request(`/api/v1/support/tickets/${ticket.id}/messages`, 'POST', { message:'Unauthorized status change', status:'closed' }, 'demo-robot-ax-001'); assert.equal(result.status,403);
    result = await request('/api/v1/support/tickets'); assert.equal(result.body.data.find((item) => item.id === ticket.id).messages.length,1);
    result = await request(`/api/v1/support/tickets/${ticket.id}/messages`, 'POST', { message:'Owner status change', status:'closed' }, 'demo-owner'); assert.equal(result.status,403);
    result = await request(`/api/v1/service-cases/${ticket.id}`, 'PATCH', { status:'closed' }, 'demo-owner'); assert.equal(result.status,403);
    result = await request('/api/v1/support/tickets', 'GET', undefined, 'demo-owner'); assert.equal(result.body.permissions.manage,false);
    result = await request(`/api/v1/support/tickets/${ticket.id}/messages`, 'POST', { message:'Unsafe file', attachment:{ ...attachment,name:'unsafe.html' } }); assert.equal(result.status,400);
    result = await request(`/api/v1/support/tickets/${ticket.id}/messages`, 'POST', { message:'Oversized file', attachment:{ ...attachment,contentBase64:Buffer.alloc(2*1024*1024+1).toString('base64') } }); assert.equal(result.status,413);
    result = await request(`/api/v1/support/tickets/${ticket.id}/messages`, 'POST', { message:'Invalid status', status:'invalid' }); assert.equal(result.status,400);
    result = await request(`/api/v1/support/tickets/${ticket.id}/messages`, 'POST', { message:'Inspection complete', status:'closed', attachment }); assert.equal(result.status,201); assert.equal(result.body.data.messages.length,2); assert.ok(result.body.data.closedAt);
    result = await request(`/api/v1/support/tickets/${ticket.id}/messages`, 'POST', { message:'Reopen', status:'open' }); assert.equal(result.body.data.closedAt,null);
    result = await request('/api/v1/service-cases'); assert.ok(result.body.data.every((item) => item.messages.every((message) => !message.attachment?.contentBase64)));
    result = await request('/api/v1/service-cases','POST',{ robotId:ax.id,provider:'altegro-support',externalId:ticket.externalId,status:'open' }); assert.equal(result.status,200); assert.ok(!result.body.data.messages[0].attachment.contentBase64);
    result = await request(`/api/v1/robots/${ax.id}/passport`); assert.ok(result.body.data.serviceCases.every((item) => item.messages.every((message) => !message.attachment?.contentBase64)));
    result = await request(`/api/v1/robots/${ax.id}/lifecycle-records`, 'POST', { recordType:'document', title:'Inspection evidence', attachment }); assert.equal(result.status,201); const documentId=result.body.data.id;
    const documentPath=`/api/v1/robots/${ax.id}/documents/${documentId}/attachment`; download=await fetch(origin+documentPath,{ headers:{ authorization:`Bearer ${await tokenFor('demo-platform-admin')}` } }); assert.equal(download.status,200); assert.equal(await download.text(),'Inspection evidence');
    download=await fetch(origin+documentPath,{ headers:{ authorization:`Bearer ${await tokenFor('demo-robot-cb-001')}` } }); assert.equal(download.status,404);
    result=await request('/api/v1/maintenance-schedules','POST',{ robotId:cb.id,title:'CenoBots inspection',nextDueAt:new Date().toISOString(),intervalDays:30,reminderDays:7 }); assert.equal(result.status,201); const scheduleId=result.body.data.id;
    result=await request('/api/v1/autoxing/maintenance-schedules','POST',{ robotId:cb.id,title:'Invalid legacy target',nextDueAt:new Date().toISOString(),intervalDays:30 }); assert.equal(result.status,404);
    result=await request(`/api/v1/maintenance-schedules/${scheduleId}`,'PATCH',{ status:'paused',nextDueAt:'invalid' }); assert.equal(result.status,400); assert.equal(state.maintenanceSchedules.get(scheduleId).status,'active');
    result=await request(`/api/v1/maintenance-schedules/${scheduleId}`,'PATCH',{ complete:true },'demo-auditor'); assert.equal(result.status,403);
    result=await request(`/api/v1/maintenance-schedules/${scheduleId}`,'PATCH',{ complete:true,completionNote:'All brands supported' }); assert.equal(result.status,200); assert.ok(Date.parse(result.body.data.nextDueAt)>Date.now());
    result=await request('/api/v1/maintenance-schedules','GET',undefined,'demo-robot-ax-001'); assert.equal(result.body.count,0);
    state.robots.set('manual-maintenance',{ ...cb,id:'manual-maintenance',externalIdentities:[] });
    result=await request('/api/v1/maintenance-schedules','POST',{ robotId:'manual-maintenance',title:'Manual robot inspection',nextDueAt:new Date().toISOString(),intervalDays:60 }); assert.equal(result.status,201);
    cb.siteId='site-comparison'; state.sites.set('site-comparison',{ id:'site-comparison',tenantId:cb.tenantId,name:'Comparison site' });
    state.events.push({ robotId:cb.id,occurredAt:new Date(Date.now()-2*86400000).toISOString(),severity:'critical',eventType:'error' },{ robotId:cb.id,occurredAt:new Date(Date.now()-35*86400000).toISOString(),severity:'error',eventType:'error' });
    state.robots.set('foreign-robot',{ ...cb,id:'foreign-robot',tenantId:'other-tenant',siteId:'foreign-site' });
    result=await request('/api/v1/reports/comparison?groupBy=site&days=30'); assert.equal(result.status,200); const group=result.body.data.data.find((item)=>item.id==='site-comparison'); assert.equal(group.current.incidents,1); assert.equal(group.previous.incidents,1); assert.equal(group.change.incidents,0); assert.ok(!result.body.data.data.some((item)=>item.id==='foreign-site'));
    result=await request('/api/v1/reports/comparison?groupBy=provider&days=30','GET',undefined,'demo-robot-ax-001'); assert.equal(result.body.data.data.length,1); assert.equal(result.body.data.data[0].id,'autoxing');
    for (const query of ['days=1.5','days=366','days=invalid','groupBy=tenant']) { result=await request(`/api/v1/reports/comparison?${query}`); assert.equal(result.status,400); }
    console.log('Modern workflow API tests passed: attachments, authorization, atomic validation, cross-provider maintenance and period comparisons.');
  } finally { await new Promise((resolve)=>server.close(resolve)); }
})().catch((error)=>{ console.error(error); process.exitCode=1; });
