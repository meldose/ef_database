'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const dataFile=path.join('/tmp',`altegro-e2e-${process.pid}.json`);
process.env.ALTEGRO_DATA_FILE=dataFile;
process.env.ALTEGRO_PERSISTENCE_DRIVER='memory';
process.env.OBJECT_STORAGE_DRIVER='inline';
process.env.ALTEGRO_SYNC_MODE='inline';
process.env.AUTOXING_LIVE='false';
process.env.CENOBOTS_LIVE='false';
process.env.EMAIL_ALERTS_ENABLED='false';
const { server }=require('./server');

async function timed(url,options) {
  const started=performance.now(); const response=await fetch(url,options); return { response,duration:performance.now()-started };
}

(async () => {
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const page=await fetch(`${base}/`); assert.equal(page.status,200); const html=await page.text();
    for (const id of ['loginForm','dashboardTabs','languageSelect','supportView','reportsView','cenoBotsControlSection']) assert.match(html,new RegExp(`id="${id}"`));
    const [script,style]=await Promise.all([fetch(`${base}/app.js`),fetch(`${base}/styles.css`)]); assert.equal(script.status,200); assert.equal(style.status,200);
    const [scriptText,styleText]=await Promise.all([script.text(),style.text()]); assert.ok(Buffer.byteLength(scriptText)<250_000,'app.js exceeded the 250 KB performance budget'); assert.ok(Buffer.byteLength(styleText)<120_000,'styles.css exceeded the 120 KB performance budget');

    const login=await fetch(`${base}/api/v1/auth/login`,{ method:'POST',headers:{ 'content-type':'application/json' },body:JSON.stringify({ email:'owner@demo.altegro.local',password:'efrobotics' }) }); assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0]; const headers={ cookie,'content-type':'application/json' };
    const robots=await fetch(`${base}/api/v1/robots?pageSize=10`,{ headers }); assert.equal(robots.status,200); const robot=(await robots.json()).data[0]; assert.ok(robot?.id);
    const ticket=await fetch(`${base}/api/v1/support/tickets`,{ method:'POST',headers,body:JSON.stringify({ robotId:robot.id,title:'End-to-end support journey',description:'Automated browser-facing workflow validation.',category:'technical',severity:'info' }) }); assert.equal(ticket.status,201); const createdTicket=(await ticket.json()).data;
    const reply=await fetch(`${base}/api/v1/support/tickets/${createdTicket.id}/messages`,{ method:'POST',headers,body:JSON.stringify({ message:'Customer workflow completed successfully.' }) }); assert.equal(reply.status,201); assert.equal((await reply.json()).data.messages.length,2);
    const pdf=await fetch(`${base}/api/v1/robots/${robot.id}/reports/compliance.pdf`,{ headers }); assert.equal(pdf.status,200); assert.match(pdf.headers.get('content-type'),/application\/pdf/); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');

    const samples=await Promise.all(Array.from({ length:30 },(_,index) => timed(`${base}${index%2 ? '/api/v1/operations/summary' : '/api/v1/robots?pageSize=10'}`,{ headers })));
    assert.ok(samples.every((sample) => sample.response.status===200)); const durations=samples.map((sample) => sample.duration).sort((a,b) => a-b); const p95=durations[Math.floor(durations.length*.95)]; assert.ok(p95<1500,`p95 API response time ${p95.toFixed(1)} ms exceeded 1500 ms`);
    console.log(`End-to-end and performance checks passed (p95 ${p95.toFixed(1)} ms, JS ${Buffer.byteLength(scriptText)} bytes, CSS ${Buffer.byteLength(styleText)} bytes).`);
  } finally { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dataFile,{ force:true }); }
})().catch((error) => { console.error(error); process.exitCode=1; });
