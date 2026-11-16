// Exercises the actual migration order and cross-feature triggers in isolated PostgreSQL.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const q=async(s,p=[])=>(await db.query(s,p)).rows;
const one=async(s,p=[])=>(await q(s,p))[0];
const rpc=async(name,args=[])=>(await one(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).r;
let checks=0; const check=(v,label)=>{assert.ok(v,label);checks++;};
try {
  await db.exec(read('./fixtures/crm-schema.sql'));
  await db.exec(`
    alter table bk_services add column active boolean default true, add column duration_min int default 60,
      add column legacy_service text default 'photography',add column weekend_price_cents int,
      add column location_ok boolean default false,add column auto_balance boolean default false;
    alter table bk_services alter column kind set default 'session';
    alter table bk_bookings add column travel_min int not null default 0,add column balance_invoice_id uuid;
    create table bk_config(key text primary key,value text);
    insert into bk_config values('timezone','America/Chicago'),('buffer_min','30'),('min_notice_hours','0');
    create function bk_cfg_int(p_key text,p_default int) returns int language sql stable as $$ select coalesce((select value::int from bk_config where key=p_key),p_default) $$;
    create table bk_addons(slug text,active bool default true,services text[],sort int,name text,price_cents int);
    create table bk_service_hours(service_id uuid,dow int,start_min int,end_min int,active bool default true);
    create table bk_availability_rules(dow int,start_min int,end_min int,active bool default true);
    create table bk_blackouts(starts_on date,ends_on date);
    insert into bk_availability_rules select n,600,1080,true from generate_series(0,6)n;
  `);
  const paymentFixture=read('./fixtures/payment-schema.sql');
  await db.exec(paymentFixture.slice(paymentFixture.indexOf('CREATE OR REPLACE FUNCTION public.bk_open_slots_where')));
  const legacyQueue=await one(`insert into bk_email_queue(kind,attempts,last_error) values('nelson_alert',1,'Synthetic ambiguous previous attempt') returning id`);
  for(const file of ['20261116192939_crm_foundation.sql','20261116193011_crm_payment_integrity.sql','20261116193012_crm_intake_retries.sql','20261116193952_crm_inbound_email.sql','20261116194013_crm_operational_health.sql']) await db.exec(read('../supabase/migrations/'+file));
  // This trigger already exists in production; the migration replaces its function.
  await db.exec(`create trigger bk_invoice_paid after update on bk_invoices for each row when(new.status='paid' and old.status is distinct from 'paid') execute function bk_on_invoice_paid()`);
  const STAFF='11111111-1111-4111-8111-111111111111';
  await q(`insert into profiles values($1,'employee','Synthetic Staff')`,[STAFF]);
  async function as(role,uid,fn){await db.exec(`set role ${role}`);await q(`select set_config('request.jwt.claim.sub',$1,false)`,[uid||'']);try{return await fn();}finally{await db.exec('reset role');}}
  const staff=fn=>as('authenticated',STAFF,fn);
  const sid='aaaaaaaa-1111-4111-8111-111111111111';
  const inquiry=()=>as('anon',null,()=>rpc('bk_submit_inquiry_once',[sid,'Synthetic Website Lead','website@example.test','brand_content',null,'Example Company',null,null,null,'Synthetic request','Search']));
  const lead=await inquiry();
  assert.deepEqual(await inquiry(),lead);checks++;
  check((await one(`select count(*)::int n from bk_tasks where project_id=$1`,[lead.id])).n===1,'retry-safe intake creates exactly one followup task');
  check((await one(`select count(*)::int n from bk_email_queue where project_id=$1`,[lead.id])).n===2,'one acknowledgment and staff alert queued by existing intake policy');
  check((await staff(()=>rpc('bk_crm_project',[lead.id]))).project.billing_provider==='unassigned','website inquiry does not guess payment route');
  const digital=await as('anon',null,()=>rpc('bk_book_digitals_once',['bbbbbbbb-2222-4222-8222-222222222222','Synthetic Digitals','digital@example.test']));
  check((await staff(()=>rpc('bk_crm_project',[digital.id]))).project.billing_provider==='stripe','fixed-price digitals assigns Stripe and links CRM customer');
  const inv=await one(`select * from bk_invoices where project_id=$1`,[digital.id]);
  check(inv.amount_cents===10000 && (await staff(()=>rpc('bk_crm_project',[digital.id]))).project.billing_locked,'issued digitals invoice locks billing provider');
  await staff(()=>rpc('bk_set_project_billing',[lead.id,'honeybook','https://app.honeybook.com/invoice/example','EXAMPLE-1']));
  const detail=await staff(()=>rpc('bk_crm_project',[lead.id]));
  check(detail.activities.some(a=>a.kind==='billing_updated'),'billing changes share immutable CRM activity history');
  const quote=await staff(()=>rpc('bk_crm_save_quote',[lead.id,{lines:[{description:'Production',quantity:1,unit_cents:100000}],valid_until:'2099-01-01'}]));
  const before=(await one(`select count(*)::int n from bk_email_queue`)).n;
  await staff(()=>rpc('bk_crm_quote_status',[quote.id,'sent']));
  await as('anon',null,()=>rpc('bk_crm_accept_quote',[lead.id,lead.token,quote.id,quote.version,'Synthetic Signer']));
  check((await one(`select status from bk_projects where id=$1`,[lead.id])).status==='quoted','accepted quote still waits for agreement/payment');
  check((await one(`select count(*)::int n from bk_email_queue`)).n===before,'quote workflow creates no new emails');
  check((await staff(()=>rpc('bk_crm_portal_billing',[lead.id,lead.token]))).billing_provider==='honeybook','portal retains correct external billing route');
  await assert.rejects(staff(()=>rpc('bk_set_project_billing',[digital.id,'honeybook'])));checks++;
  await q(`update bk_invoices set stripe_session_id='cs_integration' where id=$1`,[inv.id]);
  const payment=await as('service_role',null,()=>rpc('bk_record_checkout_payment',['evt_integration',{id:'cs_integration',mode:'payment',payment_status:'paid',currency:'usd',amount_total:10000,metadata:{project_id:digital.id,invoice_id:inv.id},total_details:{amount_discount:0}}]));
  check(payment.status==='applied','service payment reconciles into installed CRM workflow');
  const paid=await staff(()=>rpc('bk_crm_project',[digital.id]));
  check(paid.project.status==='booked' && paid.tasks.some(t=>t.automation_key==='production_prep' && t.status==='open'),'paid deposit/full payment schedules production next action');
  const count=paid.activities.length;
  await as('service_role',null,()=>rpc('bk_record_checkout_payment',['evt_integration_retry',{id:'cs_integration',mode:'payment',payment_status:'paid',currency:'usd',amount_total:10000,metadata:{project_id:digital.id,invoice_id:inv.id},total_details:{amount_discount:0}}]));
  check((await staff(()=>rpc('bk_crm_project',[digital.id]))).activities.length===count,'payment replay does not duplicate workflow/audit');
  await q(`update bk_invoices set paid_amount_cents=8000 where id=$1`,[inv.id]);
  const inbox=await staff(()=>rpc('bk_crm_inbox',['all','',0,50]));
  check(inbox.total===2 && Number(inbox.stats.collected)===8000,'employee inbox reports actual collected amounts across the full history');
  // Queue snapshots are service-only, immutable across retries, and held for review
  // after Resend's idempotency window rather than risking a duplicate old email.
  const queue=await one(`select id from bk_email_queue where project_id=$1 order by created_at,id limit 1`,[lead.id]);
  const mail={from:'Studio <studio@example.test>',to:['website@example.test'],reply_to:'reply@example.test',subject:'Synthetic acknowledgment',html:'<p>Synthetic only</p>'};
  check((await one(`select delivery_legacy_review,attempts from bk_email_queue where id=$1`,[legacyQueue.id])).delivery_legacy_review,'recent pre-migration attempted mail is held for review');
  await assert.rejects(as('service_role',null,()=>rpc('bk_crm_mail_request',[legacyQueue.id,mail])),/delivery_review_required/);checks++;
  const canonical=await as('service_role',null,()=>rpc('bk_crm_mail_request',[queue.id,mail]));
  assert.deepEqual(canonical,mail);checks++;
  assert.deepEqual(await as('service_role',null,()=>rpc('bk_crm_mail_request',[queue.id,{...mail,subject:'Changed'}])),mail);checks++;
  await assert.rejects(staff(()=>rpc('bk_crm_mail_request',[queue.id,mail])));checks++;
  await q(`update bk_email_queue set delivery_started_at=now()-interval '25 hours',last_error='Synthetic provider failure',send_at=now()-interval '20 minutes' where id=$1`,[queue.id]);
  await assert.rejects(as('service_role',null,()=>rpc('bk_crm_mail_request',[queue.id,mail])),/delivery_review_required/);checks++;
  const health=await staff(()=>rpc('bk_crm_health'));
  check(health.email_failed>=1 && health.email_stalled>=1 && health.email_issues.some(i=>i.id===queue.id),'failed and stalled queued messages are visible to staff');
  await assert.rejects(as('anon',null,()=>rpc('bk_crm_health')));checks++;
  console.log(`crm-integration.pglite: ${checks} checks passed (all 5 migrations, synthetic records only)`);
} finally { await db.close(); }
