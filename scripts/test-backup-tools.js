'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { spawnSync }=require('node:child_process');

const root=path.join(__dirname,'..'); const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'altegro-backup-test-')); const binaries=path.join(temporary,'bin'); fs.mkdirSync(binaries);
function executable(name,content) { const target=path.join(binaries,name); fs.writeFileSync(target,content,{ mode:0o755 }); }
executable('pg_dump',`#!/bin/sh\nfor value in "$@"; do case "$value" in --file=*) target=\${value#--file=};; esac; done\nprintf 'synthetic-postgres-dump' > "$target"\n`);
executable('pg_restore',`#!/bin/sh\ncase " $* " in *" --list "*) exit 0;; esac\nprintf 'restore-called\\n' >> "$ALTEGRO_TEST_RESTORE_LOG"\n`);
executable('psql',`#!/bin/sh\ncase "$*" in *application_snapshots*) printf 'snapshot-ok\\n';; *cost_entries*) printf 'schema-ok\\n';; *) printf 'robots=3\\n';; esac\n`);
const backup=path.join(temporary,'backup'); const restoreLog=path.join(temporary,'restore.log'); const environment={ ...process.env,PATH:`${binaries}:${process.env.PATH}`,DATABASE_URL:'postgres://source/altegro',ALTEGRO_BACKUP_DIR:backup,OBJECT_STORAGE_DRIVER:'inline',ALTEGRO_TEST_RESTORE_LOG:restoreLog };
function run(script,args=[],extra={}) { return spawnSync('sh',[path.join(root,'scripts',script),...args],{ cwd:root,env:{ ...environment,...extra },encoding:'utf8' }); }
try {
  let result=run('backup.sh'); assert.equal(result.status,0,result.stderr); assert.match(fs.readFileSync(path.join(backup,'manifest.txt'),'utf8'),/format=altegro-backup-v1/); assert.match(fs.readFileSync(path.join(backup,'checksums.sha256'),'utf8'),/altegro\.dump/); assert.match(fs.readFileSync(path.join(backup,'checksums.sha256'),'utf8'),/manifest\.txt/);
  result=run('restore.sh',[backup]); assert.notEqual(result.status,0); assert.equal(fs.existsSync(restoreLog),false);
  result=run('restore.sh',[backup],{ ALTEGRO_RESTORE_CONFIRM:'RESTORE' }); assert.equal(result.status,0,result.stderr); assert.equal(fs.readFileSync(restoreLog,'utf8').trim(),'restore-called');
  result=run('verify-backup.sh',[backup],{ ALTEGRO_DRILL_DATABASE_URL:'postgres://drill/altegro' }); assert.equal(result.status,0,result.stderr); assert.match(result.stdout,/Restore drill passed/);
  fs.appendFileSync(path.join(backup,'altegro.dump'),'tampered'); result=run('restore.sh',[backup],{ ALTEGRO_RESTORE_CONFIRM:'RESTORE' }); assert.notEqual(result.status,0); assert.match(result.stdout+result.stderr,/FAILED/);
  result=run('verify-backup.sh',[backup],{ ALTEGRO_DRILL_DATABASE_URL:'postgres://source/altegro' }); assert.notEqual(result.status,0); assert.match(result.stderr,/must not be the source/);
  console.log('Backup, checksum, restore confirmation and isolated drill tests passed.');
} finally { fs.rmSync(temporary,{ recursive:true,force:true }); }
