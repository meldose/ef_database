'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { PostgresStore }=require('./postgres-store');
const { S3ObjectStore }=require('./object-store');

class Command { constructor(input) { this.input=input; } }

(async () => {
  const migration=fs.readFileSync(path.join(__dirname,'..','migrations','001_initial_infrastructure.sql'),'utf8');
  for (const table of ['application_snapshots','robots','passport_entries','attachments','sync_jobs']) assert.match(migration,new RegExp(`CREATE TABLE ${table}`));
  assert.match(migration,/WHERE status IN \('queued','running'\)/);
  assert.match(fs.readFileSync(path.join(__dirname,'..','migrations','002_email_jobs.sql'),'utf8'),/CREATE TABLE email_jobs/);

  const sent=[]; const client={ send:async (command) => { sent.push(command); if (command instanceof GetObjectCommand) return { Body:{ transformToByteArray:async () => Uint8Array.from([65,66]) } }; return {}; },destroy:() => {} };
  class HeadBucketCommand extends Command {} class CreateBucketCommand extends Command {} class PutObjectCommand extends Command {} class GetObjectCommand extends Command {}
  const objects=new S3ObjectStore({ bucket:'attachments',client,sdk:{ S3Client:class {},HeadBucketCommand,CreateBucketCommand,PutObjectCommand,GetObjectCommand } });
  await objects.initialize(); await objects.put('tenant/robot/file.txt',Buffer.from('AB'),{ contentType:'text/plain',sha256:'digest',name:'file.txt' });
  assert.equal(sent[1].input.Bucket,'attachments'); assert.equal(sent[1].input.Key,'tenant/robot/file.txt'); assert.deepEqual(await objects.get('tenant/robot/file.txt'),Buffer.from('AB'));

  const queries=[]; const pool={ on:() => {},query:async (sql,params=[]) => { queries.push({ sql,params }); if (sql.startsWith('INSERT INTO sync_jobs')) return { rowCount:1,rows:[{ id:params[0],provider:params[1],tenant_id:params[2],actor:params[3],trigger:params[4],status:'queued',attempts:0 }] }; if (sql.includes('UPDATE email_jobs SET status=\'sending\'')) return { rowCount:1,rows:[{ id:'00000000-0000-0000-0000-000000000001',status:'sending',attempts:0,delivery:{ id:'00000000-0000-0000-0000-000000000001',notificationKey:'test' } }] }; if (sql.startsWith('WITH candidate')) return { rowCount:1,rows:[{ id:'job-1',provider:'cenobots',tenant_id:'tenant-1',actor:{ id:'actor-1' },trigger:'manual',status:'running',attempts:1 }] }; return { rowCount:0,rows:[] }; },end:async () => {} };
  const store=new PostgresStore({ pool,migrationsDirectory:path.join(__dirname,'..','migrations') });
  const queued=await store.enqueueSyncJob({ provider:'cenobots',tenantId:'tenant-1',actor:{ id:'actor-1' } }); assert.equal(queued.status,'queued');
  const claimed=await store.claimSyncJob('worker-1'); assert.equal(claimed.status,'running'); assert.ok(queries.some((query) => query.sql.includes('FOR UPDATE SKIP LOCKED')));
  const email={ id:'00000000-0000-0000-0000-000000000001',notificationKey:'test',status:'pending',attempts:0,createdAt:new Date().toISOString() };
  await store.enqueueEmailJob(email); const claimedEmail=await store.claimEmailJob('worker-1'); assert.equal(claimedEmail.status,'sending'); assert.ok(queries.some((query) => query.sql.includes("status IN ('pending','failed')") && query.sql.includes('FOR UPDATE SKIP LOCKED')));
  console.log('Infrastructure adapter tests passed.');
})().catch((error) => { console.error(error); process.exitCode=1; });
