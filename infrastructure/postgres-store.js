'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class PostgresStore {
  constructor(options = {}) {
    let Pool; if (!options.pool) { try { ({ Pool } = require('pg')); } catch { throw new Error('PostgreSQL persistence requires the "pg" package. Run npm install.'); } }
    this.pool=options.pool || new Pool({
      connectionString:options.connectionString || undefined,
      host:options.host || undefined,port:options.port || undefined,database:options.database || undefined,
      user:options.user || undefined,password:options.password || undefined,
      ssl:options.ssl ? { rejectUnauthorized:options.sslRejectUnauthorized !== false } : undefined,
      max:Math.max(2,Number(options.maxConnections || 10)),application_name:'altegro',
    });
    this.migrationsDirectory=options.migrationsDirectory; this.ready=false; this.lastError=null; this.saveChain=Promise.resolve();
    this.pool.on?.('error',(error) => { this.ready=false; this.lastError=error.message; });
  }

  async initialize() {
    try { await this.pool.query('SELECT 1'); await this.runMigrations(); this.ready=true; this.lastError=null; }
    catch(error) { this.ready=false; this.lastError=error.message; throw error; }
  }

  async runMigrations() {
    await this.pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files=fs.readdirSync(this.migrationsDirectory).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
    for (const file of files) {
      const version=file.replace(/\.sql$/,''); const applied=await this.pool.query('SELECT 1 FROM schema_migrations WHERE version=$1',[version]);
      if (applied.rowCount) continue;
      const client=await this.pool.connect();
      try { await client.query('BEGIN'); await client.query(fs.readFileSync(path.join(this.migrationsDirectory,file),'utf8')); await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[version]); await client.query('COMMIT'); }
      catch(error) { await client.query('ROLLBACK'); throw new Error(`Database migration ${version} failed: ${error.message}`); }
      finally { client.release(); }
    }
  }

  async loadSnapshot() { const result=await this.pool.query('SELECT payload FROM application_snapshots WHERE id=1'); return result.rows[0]?.payload || null; }

  saveSnapshot(snapshot) {
    const operation=this.saveChain.then(() => this._saveSnapshot(snapshot));
    this.saveChain=operation.catch(() => {});
    return operation;
  }

  async _saveSnapshot(snapshot) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO application_snapshots(id,payload,saved_at) VALUES(1,$1,now()) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,saved_at=excluded.saved_at`,[snapshot]);
      await this.replaceCoreProjections(client,snapshot); await client.query('COMMIT'); this.ready=true; this.lastError=null; return true;
    } catch(error) { await client.query('ROLLBACK'); this.ready=false; this.lastError=error.message; throw error; }
    finally { client.release(); }
  }

  async replaceCoreProjections(client,snapshot) {
    const state=snapshot.state || {}; const users=Object.entries(snapshot.users || {}); const sessions=snapshot.sessions || []; const robots=state.robots || [];
    const passports=(state.passportEntries || []).flatMap(([robotId,entries]) => (entries || []).map((entry) => ({ robotId,entry })));
    const events=state.events || []; const audit=state.audit || []; const tasks=state.autoxing?.tasks || [];
    for (const table of ['users','authenticated_sessions','robots','passport_entries','events','audit_entries','provider_tasks']) await client.query(`DELETE FROM ${table}`);
    for (const [key,value] of users) await client.query('INSERT INTO users(user_token,id,email,tenant_id,role,data) VALUES($1,$2,$3,$4,$5,$6)',[key,value.id,value.email,value.tenantId,value.role,value]);
    for (const [tokenHash,value] of sessions) await client.query('INSERT INTO authenticated_sessions(token_hash,user_token,expires_at,data) VALUES($1,$2,to_timestamp($3 / 1000.0),$4)',[tokenHash,value.userToken,value.expiresAt,value]);
    for (const [id,value] of robots) await client.query('INSERT INTO robots(id,tenant_id,serial_number,model_id,status,data,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,value.tenantId,value.serialNumber,value.modelId,value.status,value,value.updatedAt || new Date().toISOString()]);
    for (const { robotId,entry } of passports) await client.query('INSERT INTO passport_entries(id,robot_id,tenant_id,entry_type,occurred_at,data) VALUES($1,$2,$3,$4,$5,$6)',[entry.id || crypto.randomUUID(),robotId,entry.tenantId || null,entry.type || 'unknown',entry.occurredAt || entry.createdAt || new Date().toISOString(),entry]);
    for (const value of events) await client.query('INSERT INTO events(id,tenant_id,robot_id,event_type,severity,occurred_at,data) VALUES($1,$2,$3,$4,$5,$6,$7)',[value.eventId,value.tenantId,value.robotId,value.eventType,value.severity,value.occurredAt,value]);
    for (const value of audit) await client.query('INSERT INTO audit_entries(id,tenant_id,actor_id,action,object_type,object_id,occurred_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[value.id || crypto.randomUUID(),value.tenantId || null,value.actorId,value.action,value.objectType,value.objectId,value.occurredAt || value.createdAt || new Date().toISOString(),value]);
    for (const [taskId,value] of tasks) await client.query('INSERT INTO provider_tasks(provider,task_id,robot_external_id,data) VALUES($1,$2,$3,$4)', ['autoxing',String(taskId),String(value.robotId || value.deviceId || value.robot_id || ''),value]);
  }

  async recordAttachment(metadata) {
    await this.pool.query(`INSERT INTO attachments(id,tenant_id,robot_id,object_key,filename,content_type,size_bytes,sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(object_key) DO UPDATE SET filename=excluded.filename,content_type=excluded.content_type,size_bytes=excluded.size_bytes,sha256=excluded.sha256`,[metadata.id,metadata.tenantId,metadata.robotId,metadata.objectKey,metadata.name,metadata.contentType,metadata.size,metadata.sha256]);
  }

  async enqueueSyncJob({ provider,tenantId,actor,trigger='manual' }) {
    const id=crypto.randomUUID();
    try { const result=await this.pool.query(`INSERT INTO sync_jobs(id,provider,tenant_id,actor,trigger,status) VALUES($1,$2,$3,$4,$5,'queued') RETURNING *`,[id,provider,tenantId,actor,trigger]); return normalizeJob(result.rows[0]); }
    catch(error) {
      if (error.code !== '23505') throw error;
      const existing=await this.pool.query(`SELECT * FROM sync_jobs WHERE provider=$1 AND tenant_id=$2 AND status IN ('queued','running') ORDER BY created_at LIMIT 1`,[provider,tenantId]);
      if (!existing.rowCount) throw error; return { ...normalizeJob(existing.rows[0]),alreadyQueued:true };
    }
  }

  async claimSyncJob(workerId,staleAfterSeconds=900) {
    const result=await this.pool.query(`WITH candidate AS (SELECT id FROM sync_jobs WHERE status='queued' OR (status='running' AND locked_at < now() - ($2 * interval '1 second')) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE sync_jobs SET status='running',worker_id=$1,locked_at=now(),started_at=COALESCE(started_at,now()),attempts=attempts+1,updated_at=now() WHERE id IN (SELECT id FROM candidate) RETURNING *`,[workerId,staleAfterSeconds]);
    return result.rowCount ? normalizeJob(result.rows[0]) : null;
  }

  async completeSyncJob(id,result,status='completed') { if (!['completed','partial'].includes(status)) throw new Error('Invalid synchronization terminal status'); const response=await this.pool.query(`UPDATE sync_jobs SET status=$3,result=$2,error=NULL,completed_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[id,result,status]); return response.rowCount ? normalizeJob(response.rows[0]) : null; }
  async failSyncJob(id,error) { const response=await this.pool.query(`UPDATE sync_jobs SET status='failed',error=$2,completed_at=now(),updated_at=now() WHERE id=$1 RETURNING *`,[id,String(error || 'Synchronization failed').slice(0,1000)]); return response.rowCount ? normalizeJob(response.rows[0]) : null; }
  async getSyncJob(id,tenantId) { const result=await this.pool.query('SELECT * FROM sync_jobs WHERE id=$1 AND tenant_id=$2',[id,tenantId]); return result.rowCount ? normalizeJob(result.rows[0]) : null; }
  async listSyncJobs(tenantId,limit=25) { const result=await this.pool.query('SELECT * FROM sync_jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2',[tenantId,Math.min(100,Math.max(1,limit))]); return result.rows.map(normalizeJob); }

  async enqueueEmailJob(delivery) {
    await this.pool.query(`INSERT INTO email_jobs(id,notification_key,status,attempts,next_attempt_at,delivery,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(id) DO UPDATE SET status=excluded.status,attempts=excluded.attempts,next_attempt_at=excluded.next_attempt_at,delivery=excluded.delivery,updated_at=now()`,[delivery.id,delivery.notificationKey,delivery.status,delivery.attempts || 0,delivery.nextAttemptAt || null,delivery,delivery.createdAt]);
    return delivery;
  }
  async claimEmailJob(workerId,staleAfterSeconds=300) {
    const result=await this.pool.query(`WITH candidate AS (SELECT id FROM email_jobs WHERE ((status IN ('pending','failed') AND attempts < 3 AND (next_attempt_at IS NULL OR next_attempt_at <= now())) OR (status='sending' AND locked_at < now() - ($2 * interval '1 second'))) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE email_jobs SET status='sending',worker_id=$1,locked_at=now(),updated_at=now() WHERE id IN (SELECT id FROM candidate) RETURNING *`,[workerId,staleAfterSeconds]);
    return result.rowCount ? normalizeEmailJob(result.rows[0]) : null;
  }
  async finishEmailJob(delivery) {
    const result=await this.pool.query(`UPDATE email_jobs SET status=$2,attempts=$3,next_attempt_at=$4,delivery=$5,locked_at=NULL,updated_at=now() WHERE id=$1 RETURNING *`,[delivery.id,delivery.status,delivery.attempts || 0,delivery.nextAttemptAt || null,delivery]);
    return result.rowCount ? normalizeEmailJob(result.rows[0]) : null;
  }
  health() { return { driver:'postgres',ready:this.ready,error:this.lastError }; }
  async close() { await this.pool.end(); }
}

function normalizeJob(row) {
  if (!row) return null;
  return { id:row.id,provider:row.provider,tenantId:row.tenant_id,actor:row.actor,trigger:row.trigger,status:row.status,attempts:row.attempts,result:row.result,error:row.error,createdAt:row.created_at,updatedAt:row.updated_at,startedAt:row.started_at,completedAt:row.completed_at };
}
function normalizeEmailJob(row) { return row ? { id:row.id,status:row.status,attempts:row.attempts,delivery:{ ...(row.delivery || {}),status:row.status,attempts:row.attempts,nextAttemptAt:row.next_attempt_at } } : null; }

module.exports={ PostgresStore };
