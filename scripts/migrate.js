#!/usr/bin/env node
'use strict';
const path=require('node:path'); const fs=require('node:fs'); const { PostgresStore }=require('../infrastructure/postgres-store');
const secret=(name) => process.env[`${name}_FILE`] ? fs.readFileSync(process.env[`${name}_FILE`],'utf8').trim() : process.env[name] || '';
const store=new PostgresStore({ connectionString:process.env.DATABASE_URL,host:process.env.PGHOST,port:Number(process.env.PGPORT || 5432),database:process.env.PGDATABASE,user:process.env.PGUSER,password:secret('PGPASSWORD'),ssl:process.env.PGSSLMODE === 'require',migrationsDirectory:path.join(__dirname,'..','migrations') });
store.initialize().then(() => console.log('Altegro database migrations completed.')).catch((error) => { console.error(error.message); process.exitCode=1; }).finally(() => store.close());
