import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db = new PGlite();
try {
  await db.exec(`create role anon; create role authenticated;
    grant usage on schema public to anon,authenticated;
    alter default privileges in schema public grant all on tables to anon,authenticated;
    create table bk_projects(id uuid primary key default gen_random_uuid(),access_token uuid not null default gen_random_uuid(),
      client_name text,client_email text,client_phone text,company text,service text,event_date date,event_time text,
      location text,budget_range text,details text,referral_source text,title text);
    create table bk_email_queue(id uuid default gen_random_uuid(),project_id uuid,kind text,payload jsonb);
    create table bk_invoices(id uuid default gen_random_uuid(),project_id uuid,title text,amount_cents int,kind text,status text,source text,line_items jsonb);
  `);
  const migration=readFileSync(new URL('../supabase/migrations/20261116193012_crm_intake_retries.sql',import.meta.url),'utf8');
  await db.exec(migration); await db.exec(migration);
  const call=(id,name='Sample Lead',email='sample@example.test')=>db.query(`select bk_submit_inquiry_once($1,$2,$3,'photography') result`,[id,name,email]);
  await db.exec('set role anon');
  const id='aaaaaaaa-1111-4111-8111-111111111111';
  const first=(await call(id)).rows[0].result;
  const again=(await call(id)).rows[0].result;
  assert.deepEqual(first,again,'retry returns same private portal capability');
  await assert.rejects(call(id,'Someone Else'),/submission_changed/);
  await assert.rejects(db.query('select * from bk_intake_receipts'),/permission denied/);
  await assert.rejects(call('aaaaaaaa-1111-4111-8111-111111111112','Sample','broken'),/valid_email_required/);
  const dgId='bbbbbbbb-2222-4222-8222-222222222222';
  const digital=()=>db.query(`select bk_book_digitals_once($1,'Sample Digitals','digitals@example.test') result`,[dgId]);
  const dg=(await digital()).rows[0].result;
  assert.deepEqual((await digital()).rows[0].result,dg);
  await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int n from bk_projects')).rows[0].n,2);
  assert.equal((await db.query('select count(*)::int n from bk_email_queue')).rows[0].n,2,'one acknowledgment and staff alert per inquiry');
  const inv=(await db.query('select * from bk_invoices')).rows;
  assert.equal(inv.length,1); assert.equal(inv[0].amount_cents,10000); assert.equal(inv[0].source,'digitals');
  await db.exec('set role anon');
  await call('cccccccc-3333-4333-8333-333333333333');
  await db.exec('reset role');
  assert.equal((await db.query('select count(*)::int n from bk_projects')).rows[0].n,3,'same customer can submit a separate legitimate job');
  console.log('intake-retries.pglite: 12 retry, price, validation and privacy checks passed');
} finally { await db.close(); }
