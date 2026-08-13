#!/usr/bin/env node
'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const { PostgresStore }=require('../infrastructure/postgres-store');
const { S3ObjectStore }=require('../infrastructure/object-store');

const enabled=(value) => ['1','true','yes'].includes(String(value || '').toLowerCase());
const secret=(name) => process.env[`${name}_FILE`] ? fs.readFileSync(process.env[`${name}_FILE`],'utf8').trim() : process.env[name] || '';
const source=path.resolve(process.argv[2] || process.env.ALTEGRO_DATA_FILE || path.join(__dirname,'..','data','altegro-state.json'));

async function moveAttachment(record,objects,database) {
  const attachment=record?.attachment;
  if (!attachment?.contentBase64) return;
  const id=crypto.randomUUID(); const tenantId=record.tenantId || 'tenant-unknown'; const robotId=record.robotId || 'robot-unknown';
  const objectKey=`${tenantId}/${robotId}/legacy/${id}/${attachment.name}`;
  const content=Buffer.from(attachment.contentBase64,'base64');
  const metadata={ id,tenantId,robotId,objectKey,name:attachment.name,contentType:attachment.contentType,size:attachment.size ?? content.length,sha256:attachment.sha256 || crypto.createHash('sha256').update(content).digest('hex') };
  await objects.put(objectKey,content,metadata); await database.recordAttachment(metadata); record.attachment=metadata;
}

(async () => {
  if (!fs.existsSync(source)) throw new Error(`Legacy state file not found: ${source}`);
  const snapshot=JSON.parse(fs.readFileSync(source,'utf8'));
  if (snapshot.schemaVersion !== 1 || !snapshot.state) throw new Error('Legacy state file has an unsupported schema');
  const database=new PostgresStore({ connectionString:process.env.DATABASE_URL,host:process.env.PGHOST,port:Number(process.env.PGPORT || 5432),database:process.env.PGDATABASE,user:process.env.PGUSER,password:secret('PGPASSWORD'),ssl:process.env.PGSSLMODE === 'require',migrationsDirectory:path.join(__dirname,'..','migrations') });
  const objects=new S3ObjectStore({ endpoint:process.env.OBJECT_STORAGE_ENDPOINT,region:process.env.OBJECT_STORAGE_REGION || 'eu-central-1',bucket:process.env.OBJECT_STORAGE_BUCKET || 'altegro-attachments',accessKeyId:secret('OBJECT_STORAGE_ACCESS_KEY'),secretAccessKey:secret('OBJECT_STORAGE_SECRET_KEY'),forcePathStyle:enabled(process.env.OBJECT_STORAGE_FORCE_PATH_STYLE),createBucket:enabled(process.env.OBJECT_STORAGE_CREATE_BUCKET) });
  try {
    await database.initialize(); await objects.initialize();
    for (const event of snapshot.state.events || []) await moveAttachment(event,objects,database);
    for (const document of snapshot.state.documents || []) await moveAttachment(document,objects,database);
    snapshot.savedAt=new Date().toISOString(); await database.saveSnapshot(snapshot);
    console.log(`Imported ${snapshot.state.robots?.length || 0} robots from ${source}.`);
  } finally { await database.close(); await objects.close(); }
})().catch((error) => { console.error(error.message); process.exitCode=1; });
