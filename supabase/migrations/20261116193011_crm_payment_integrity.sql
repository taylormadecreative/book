-- Payment and booking integrity. Prepared against the live schema on 2026-11-16.
-- Does not send messages or charge cards. Deploy separately after review.
begin;

alter table public.bk_projects
  add column if not exists billing_provider text not null default 'unassigned'
    check (billing_provider in ('unassigned','stripe','honeybook')),
  add column if not exists external_billing_url text
    check (external_billing_url is null or (length(external_billing_url) <= 1200 and external_billing_url ~ '^https://[^[:space:]"<>]+$')),
  add column if not exists external_billing_ref text check (length(external_billing_ref) <= 200),
  add column if not exists billing_locked_at timestamptz,
  add column if not exists billing_requires_reconciliation boolean not null default false;
alter table public.bk_invoices add column if not exists source text;
alter table public.bk_invoices add column if not exists paid_amount_cents integer
 check(paid_amount_cents is null or paid_amount_cents>=0);
-- The old webhook stored an explicit collected amount for approved promotions.
-- Preserve that evidence; other legacy paid invoices keep a nullable amount.
with collected as (
 select id,replace((regexp_match(payment_note,'\(collected \$([0-9,]+\.[0-9]{2})\)'))[1],',','')::numeric*100 cents
 from bk_invoices where status='paid' and payment_note like 'Paid via Stripe Checkout%'
)
update bk_invoices i set paid_amount_cents=c.cents::integer from collected c
where i.id=c.id and i.paid_amount_cents is null and c.cents between 0 and i.amount_cents;
alter table public.bk_bookings
  add column if not exists payment_review_required boolean not null default false,
  add column if not exists payment_review_reason text;

create table if not exists public.bk_checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.bk_invoices(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  params jsonb not null,
  stripe_session_id text unique,
  legacy_session_id text,
  state text not null default 'open' check (state in ('open','expired','paid'))
);
create unique index if not exists bk_checkout_one_open on public.bk_checkout_attempts(invoice_id) where state='open';
create table if not exists public.bk_payment_events (
  event_id text primary key,
  session_id text not null unique,
  invoice_id uuid references public.bk_invoices(id) on delete set null,
  project_id uuid references public.bk_projects(id) on delete set null,
  created_at timestamptz not null default now(),
  amount_cents integer,
  currency text,
  result text not null check (result in ('processing','applied','attention','duplicate')),
  reason text
);
alter table public.bk_checkout_attempts enable row level security;
alter table public.bk_payment_events enable row level security;
revoke all on public.bk_checkout_attempts, public.bk_payment_events from public, anon, authenticated;
grant all on public.bk_checkout_attempts, public.bk_payment_events to service_role;
create table if not exists public.bk_billing_resolutions (
 project_id uuid primary key references public.bk_projects(id),
 provider text not null check(provider in ('stripe','honeybook')),
 actor_id uuid not null,
 resolved_at timestamptz not null default now(),
 note text not null check(length(trim(note)) between 20 and 400),
 archived_links jsonb not null default '[]'::jsonb check(jsonb_typeof(archived_links)='array')
);
alter table public.bk_billing_resolutions enable row level security;
revoke all on public.bk_billing_resolutions from public,anon,authenticated;
grant select on public.bk_billing_resolutions to authenticated;
grant all on public.bk_billing_resolutions to service_role;
create policy bk_billing_resolution_admin on public.bk_billing_resolutions for select
to authenticated using ((select public.bk_is_admin()));
create or replace function public.bk_keep_billing_resolution()
returns trigger language plpgsql set search_path=public as $$
begin raise exception 'billing_resolution_immutable'; end $$;
revoke all on function public.bk_keep_billing_resolution() from public,anon,authenticated;
create trigger bk_keep_billing_resolution before update or delete on public.bk_billing_resolutions
for each row execute function public.bk_keep_billing_resolution();

-- Evidence is deliberately narrow: a video-unlock invoice or a project amount is
-- not enough to guess the payment provider.
create or replace function public.bk_billing_evidence(p_project uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object(
  'stripe', exists(select 1 from bk_invoices where project_id=p_project
    and (stripe_session_id is not null or source in ('stripe','stripe_checkout','stripe_balance','digitals'))),
  'honeybook', exists(select 1 from bk_galleries where project_id=p_project
    and lower(pay_url) ~ '^https://([a-z0-9-]+\.)*(hbportal\.co|honeybook\.com)(/|$)'))
$$;
revoke all on function public.bk_billing_evidence(uuid) from public,anon,authenticated;
grant execute on function public.bk_billing_evidence(uuid) to service_role;

update public.bk_projects p set
 billing_provider=case when (e.v->>'stripe')::boolean then 'stripe' else 'honeybook' end,
 external_billing_url=case when (e.v->>'honeybook')::boolean then
  (select g.pay_url from public.bk_galleries g where g.project_id=p.id
   and lower(g.pay_url) ~ '^https://([a-z0-9-]+\.)*(hbportal\.co|honeybook\.com)(/|$)'
   order by g.created_at desc,g.id limit 1) else null end
from (select id, public.bk_billing_evidence(id) v from public.bk_projects) e
where p.id=e.id and p.billing_provider='unassigned'
 and ((e.v->>'stripe')::boolean <> (e.v->>'honeybook')::boolean);
update bk_projects p set billing_requires_reconciliation=true
where (bk_billing_evidence(p.id)->>'stripe')::boolean and (bk_billing_evidence(p.id)->>'honeybook')::boolean
 and p.billing_provider='unassigned';

update bk_projects p set billing_locked_at=now()
where billing_locked_at is null and
 (exists(select 1 from bk_invoices i where i.project_id=p.id and (i.status in ('sent','paid') or i.stripe_session_id is not null))
  or (bk_billing_evidence(p.id)->>'honeybook')::boolean);

create or replace function public.bk_project_billing_locked(p_project uuid)
returns boolean language plpgsql stable security definer set search_path=public as $$
begin
 if not bk_is_staff() then raise exception 'forbidden'; end if;
 return exists(select 1 from bk_projects p where p.id=p_project and p.billing_provider<>'unassigned'
   and (p.billing_locked_at is not null or exists(select 1 from bk_invoices i where i.project_id=p.id and (i.status in ('sent','paid') or i.stripe_session_id is not null))
     or (bk_billing_evidence(p.id)->>'honeybook')::boolean));
end $$;
revoke all on function public.bk_project_billing_locked(uuid) from public,anon;
grant execute on function public.bk_project_billing_locked(uuid) to authenticated;

create or replace function public.bk_guard_billing_provider()
returns trigger language plpgsql security definer set search_path=public as $$
declare e jsonb; committed boolean;
begin
 e:=bk_billing_evidence(old.id);
 if new.billing_provider='honeybook' and new.external_billing_url is not null
    and lower(new.external_billing_url) !~ '^https://([a-z0-9-]+\.)*(hbportal\.co|honeybook\.com)(/|$)' then
  raise exception 'valid_honeybook_invoice_link_required';
 end if;
 new.billing_requires_reconciliation:=new.billing_provider='unassigned' and (e->>'stripe')::boolean and (e->>'honeybook')::boolean;
 if old.billing_locked_at is not null and new.billing_locked_at is distinct from old.billing_locked_at then
  raise exception 'billing_provider_locked';
 end if;
 if new.billing_provider is distinct from old.billing_provider then
  committed:=old.billing_locked_at is not null or exists(select 1 from bk_invoices where project_id=old.id and
    (status in ('sent','paid') or stripe_session_id is not null))
    or (e->>'honeybook')::boolean;
  if old.billing_provider<>'unassigned' and committed then raise exception 'billing_provider_locked'; end if;
  if new.billing_provider='stripe' and (e->>'honeybook')::boolean then raise exception 'billing_evidence_conflict'; end if;
  if new.billing_provider='honeybook' and (e->>'stripe')::boolean
   and not exists(select 1 from bk_billing_resolutions r where r.project_id=old.id and r.provider=new.billing_provider)
   then raise exception 'billing_evidence_conflict'; end if;
 end if;
 return new;
end $$;
drop trigger if exists bk_guard_billing_provider on public.bk_projects;
create trigger bk_guard_billing_provider before update on public.bk_projects
for each row execute function public.bk_guard_billing_provider();

create or replace function public.bk_set_project_billing(p_project uuid,p_provider text,p_url text default null,p_ref text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare p bk_projects%rowtype;
begin
 if not bk_is_staff() then raise exception 'forbidden'; end if;
 if p_provider not in ('unassigned','stripe','honeybook') or p_provider is null then raise exception 'invalid_provider'; end if;
 select * into p from bk_projects where id=p_project for update;
 if not found then raise exception 'not_found'; end if;
 update bk_projects set billing_provider=p_provider,
   external_billing_url=nullif(trim(p_url),''),
   external_billing_ref=nullif(trim(p_ref),'')
 where id=p_project returning * into p;
 return jsonb_build_object('id',p.id,'billing_provider',p.billing_provider,
  'external_billing_url',p.external_billing_url,'external_billing_ref',p.external_billing_ref,
  'billing_locked',bk_project_billing_locked(p.id));
end $$;
revoke all on function public.bk_set_project_billing(uuid,text,text,text) from public,anon;
grant execute on function public.bk_set_project_billing(uuid,text,text,text) to authenticated;

-- Explicit one-time reconciliation. Keeps historical payments unchanged, never
-- sends/voids/charges, and records who chose the future route and why.
create or replace function public.bk_reconcile_project_billing(
 p_project uuid,p_provider text,p_note text,p_url text default null,p_ref text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare p bk_projects%rowtype; e jsonb; link text; archived jsonb:='[]'::jsonb;
begin
 if not bk_is_admin() or auth.uid() is null then raise exception 'admin_required'; end if;
 if p_provider is null or p_provider not in ('stripe','honeybook') then raise exception 'invalid_provider'; end if;
 if p_note is null or length(trim(p_note)) not between 20 and 400 then raise exception 'reconciliation_note_required_20_400'; end if;
 perform pg_advisory_xact_lock(hashtextextended('bk_calendar',42));
 select * into p from bk_projects where id=p_project for update;
 if not found then raise exception 'not_found'; end if;
 if p.billing_provider<>'unassigned' then raise exception 'billing_provider_locked'; end if;
 e:=bk_billing_evidence(p.id);
 if not (e->>'stripe')::boolean or not (e->>'honeybook')::boolean then raise exception 'billing_reconciliation_not_required'; end if;
 if p_provider='stripe' then
  -- Narrow correction for an owner-confirmed fully settled Stripe project
  -- whose historical storyboard links were never cleared. No payment changes.
  if not exists(select 1 from bk_invoices where project_id=p.id and status='paid'
      and (stripe_session_id is not null or source in ('stripe','stripe_checkout','stripe_balance','digitals')))
     or exists(select 1 from bk_invoices where project_id=p.id and status not in ('paid','void'))
     or exists(select 1 from bk_bookings where project_id=p.id and status<>'cancelled'
       and balance_cents>0 and coalesce(balance_status,'scheduled') not in ('paid','waived')) then
   raise exception 'stripe_reconciliation_requires_fully_settled_project';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'url',g.pay_url) order by g.id),'[]'::jsonb) into archived
  from (select id,pay_url from bk_galleries where project_id=p.id
    and lower(pay_url) ~ '^https://([a-z0-9-]+\.)*(hbportal\.co|honeybook\.com)(/|$)' for update) g;
  link:=null;
 else
  if exists(select 1 from bk_invoices where project_id=p.id and status in ('draft','sent') and stripe_session_id is not null) then
   raise exception 'unpaid_stripe_sessions_require_external_review';
  end if;
  -- A historical gallery link may already be paid. Only use a link deliberately
  -- supplied for this billing route; otherwise the portal asks staff to confirm it.
  link:=coalesce(nullif(trim(p_url),''),p.external_billing_url);
 end if;
 insert into bk_billing_resolutions(project_id,provider,actor_id,note,archived_links)
 values(p.id,p_provider,auth.uid(),trim(p_note),archived);
 if p_provider='stripe' then
  update bk_galleries set pay_url=null where id in
    (select (value->>'id')::uuid from jsonb_array_elements(archived));
 end if;
 update bk_projects set billing_provider=p_provider,external_billing_url=link,
  external_billing_ref=nullif(trim(p_ref),''),billing_locked_at=coalesce(billing_locked_at,now()),
  billing_requires_reconciliation=false where id=p.id returning * into p;
 insert into bk_activities(project_id,contact_id,actor_id,kind,summary)
 values(p.id,p.contact_id,auth.uid(),'billing_reconciled','Billing reconciled to '||p_provider||
  case when p_provider='stripe' then '. Owner confirmed fully paid Stripe history; '||jsonb_array_length(archived)||' historical HoneyBook links archived.'
   else '. Reason recorded by administrator.' end);
 return jsonb_build_object('id',p.id,'billing_provider',p.billing_provider,
  'external_billing_url',p.external_billing_url,'external_billing_ref',p.external_billing_ref,
  'billing_locked',true,'billing_requires_reconciliation',false);
end $$;
revoke all on function public.bk_reconcile_project_billing(uuid,text,text,text,text) from public,anon;
grant execute on function public.bk_reconcile_project_billing(uuid,text,text,text,text) to authenticated;

create or replace function public.bk_crm_portal_billing(p_project uuid,p_token uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare p bk_projects%rowtype;
begin
 select * into p from bk_projects where id=p_project and access_token=p_token;
 if not found then raise exception 'not_found'; end if;
 return jsonb_build_object('billing_provider',p.billing_provider,'external_billing_url',p.external_billing_url,
  'paid_amounts',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'paid_amount_cents',coalesce(i.paid_amount_cents,i.amount_cents)) order by i.created_at,i.id)
    from bk_invoices i where i.project_id=p.id and i.status='paid'),'[]'::jsonb));
end $$;
revoke all on function public.bk_crm_portal_billing(uuid,uuid) from public;
grant execute on function public.bk_crm_portal_billing(uuid,uuid) to anon,authenticated;

create or replace function public.bk_audit_billing_change()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.billing_provider is distinct from old.billing_provider
    or new.external_billing_url is distinct from old.external_billing_url
    or new.external_billing_ref is distinct from old.external_billing_ref then
  insert into bk_activities(project_id,contact_id,actor_id,kind,summary)
  values(new.id,new.contact_id,auth.uid(),'billing_updated','Billing route updated: '||new.billing_provider);
 end if;
 return new;
end $$;
drop trigger if exists bk_audit_billing_change on public.bk_projects;
create trigger bk_audit_billing_change after update on public.bk_projects
for each row execute function public.bk_audit_billing_change();

create or replace function public.bk_guard_invoice_billing()
returns trigger language plpgsql security definer set search_path=public as $$
declare provider text; stripe_evidence boolean;
begin
 select billing_provider into provider from bk_projects where id=new.project_id for update;
 if new.status='paid' and new.paid_amount_cents is null then new.paid_amount_cents:=new.amount_cents; end if;
 stripe_evidence:=new.stripe_session_id is not null or new.source in ('stripe','stripe_checkout','stripe_balance','digitals');
 if coalesce(stripe_evidence,false) and not (tg_op='UPDATE' and new.status='void'
    and new.stripe_session_id is not distinct from old.stripe_session_id
    and new.source is not distinct from old.source) then
  if provider='honeybook' then raise exception 'honeybook_project_requires_honeybook'; end if;
  if provider='unassigned' then
   update bk_projects set billing_provider='stripe' where id=new.project_id;
   provider:='stripe';
  end if;
 end if;
 if tg_op='UPDATE' then
  if (old.stripe_session_id is not null or old.status='paid'
      or exists(select 1 from bk_checkout_attempts where invoice_id=old.id and state='open'))
   and (new.amount_cents is distinct from old.amount_cents or new.project_id is distinct from old.project_id) then
   raise exception 'issued_payment_amount_locked';
  end if;
 end if;
 -- Legacy unassigned invoices remain readable; new payable invoices need a
 -- deliberate route. Existing sent invoices can still be voided safely.
 if new.status in ('sent','paid') and provider='unassigned'
   and (tg_op='INSERT' or new.status is distinct from old.status) then
   raise exception 'billing_provider_required';
 end if;
 if new.status in ('sent','paid') or new.stripe_session_id is not null then
  update bk_projects set billing_locked_at=now() where id=new.project_id and billing_locked_at is null;
 end if;
 return new;
end $$;
drop trigger if exists bk_guard_invoice_billing on public.bk_invoices;
create trigger bk_guard_invoice_billing before insert or update on public.bk_invoices
for each row execute function public.bk_guard_invoice_billing();

-- A HoneyBook invoice pasted into an existing client review is also a billing
-- commitment. Preserve that route even after the review/gallery is removed.
create or replace function public.bk_guard_gallery_billing()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if lower(new.pay_url) ~ '^https://([a-z0-9-]+\.)*(hbportal\.co|honeybook\.com)(/|$)' then
  update bk_projects set billing_provider='honeybook',billing_locked_at=coalesce(billing_locked_at,now())
   where id=new.project_id;
 end if;
 return new;
end $$;
drop trigger if exists bk_guard_gallery_billing on public.bk_galleries;
create trigger bk_guard_gallery_billing before insert or update of pay_url on public.bk_galleries
for each row execute function public.bk_guard_gallery_billing();

-- Every writer, including staff edits and payment confirmation, shares the same
-- calendar lock. Unlike an exact-start/day lock it also covers travel across midnight.
create or replace function public.bk_lock_payment_calendar()
returns trigger language plpgsql set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('bk_calendar',42));
 return null;
end $$;
drop trigger if exists bk_lock_payment_calendar on public.bk_invoices;
create trigger bk_lock_payment_calendar before insert or update on public.bk_invoices
for each statement execute function public.bk_lock_payment_calendar();
drop trigger if exists bk_lock_booking_calendar on public.bk_bookings;
create trigger bk_lock_booking_calendar before insert or update on public.bk_bookings
for each statement execute function public.bk_lock_payment_calendar();
drop trigger if exists bk_lock_gallery_billing_calendar on public.bk_galleries;
create trigger bk_lock_gallery_billing_calendar before insert or update of pay_url on public.bk_galleries
for each statement execute function public.bk_lock_payment_calendar();

create or replace function public.bk_guard_booking_slot()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_buffer int;
begin
 perform pg_advisory_xact_lock(hashtextextended('bk_calendar',42));
 if new.status='confirmed' or (new.status='pending_payment' and new.expires_at>now()) then
  v_buffer:=greatest(bk_cfg_int('buffer_min',30),0);
  if exists(select 1 from bk_bookings b where b.id<>new.id and
   (b.status='confirmed' or (b.status='pending_payment' and b.expires_at>now()))
   and tstzrange(b.starts_at-make_interval(mins=>greatest(v_buffer,b.travel_min,new.travel_min)),
       b.starts_at+make_interval(mins=>b.duration_min+greatest(v_buffer,b.travel_min,new.travel_min)),'[)')
       && tstzrange(new.starts_at,new.starts_at+make_interval(mins=>new.duration_min),'[)')) then
   raise exception 'slot no longer available';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists bk_guard_booking_slot on public.bk_bookings;
create trigger bk_guard_booking_slot before insert or update of starts_at,duration_min,status,expires_at,travel_min
on public.bk_bookings for each row execute function public.bk_guard_booking_slot();

create or replace function public.bk_on_invoice_paid()
returns trigger language plpgsql security definer set search_path=public as $$
declare b bk_bookings%rowtype; reason text; v_buffer int; review boolean:=false;
begin
 perform pg_advisory_xact_lock(hashtextextended('bk_calendar',42));
 v_buffer:=greatest(bk_cfg_int('buffer_min',30),0);
 for b in select * from bk_bookings where invoice_id=new.id for update loop
  reason:=null;
  if b.status='pending_payment' then
   if b.expires_at is null or b.expires_at<=now() then reason:='Payment arrived after the booking hold expired. Confirm a new time or refund after review.';
   elsif exists(select 1 from bk_bookings other where other.id<>b.id and
    (other.status='confirmed' or (other.status='pending_payment' and other.expires_at>now()))
    and tstzrange(other.starts_at-make_interval(mins=>greatest(v_buffer,other.travel_min,b.travel_min)),
      other.starts_at+make_interval(mins=>other.duration_min+greatest(v_buffer,other.travel_min,b.travel_min)),'[)')
      && tstzrange(b.starts_at,b.starts_at+make_interval(mins=>b.duration_min),'[)')) then
    reason:='Payment arrived for a slot that conflicts with another booking. Confirm a new time or refund after review.';
   end if;
   if reason is null then update bk_bookings set status='confirmed',payment_review_required=false,payment_review_reason=null where id=b.id;
   end if;
  elsif b.status not in ('confirmed','completed') then reason:='Payment arrived for a booking that is not active. Review before confirming.';
  end if;
  if reason is not null then
   review:=true;
   update bk_bookings set payment_review_required=true,payment_review_reason=reason,
    balance_status=case when balance_status='scheduled' then 'attention' else balance_status end
    where id=b.id;
   insert into bk_email_queue(project_id,booking_id,kind,payload) values(new.project_id,b.id,'nelson_alert',
    jsonb_build_object('type','payment_unreconciled','subject','Payment received — booking needs review',
      'detail',reason,'invoice_id',new.id,'amount_cents',new.amount_cents));
  end if;
 end loop;
 if not review and new.kind in ('deposit','full') then
  update bk_projects set status='booked' where id=new.project_id and status in ('new','quoted');
 end if;
 insert into bk_email_queue(project_id,kind,payload) values(new.project_id,'nelson_alert',
  jsonb_build_object('type','payment','invoice_title',new.title,'amount_cents',new.amount_cents));
 return new;
end $$;

-- service-role only. The edge function authenticates a portal token; the DB
-- repeats that check and atomically fixes one canonical set of Stripe parameters.
create or replace function public.bk_prepare_checkout(p_invoice uuid,p_token uuid,p_params jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare i bk_invoices%rowtype; p bk_projects%rowtype; b bk_bookings%rowtype; a bk_checkout_attempts%rowtype; expiry timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended('bk_calendar',42));
 select * into i from bk_invoices where id=p_invoice for update;
 if not found then return jsonb_build_object('error','not_found'); end if;
 select * into p from bk_projects where id=i.project_id for update;
 if p.access_token is distinct from p_token then return jsonb_build_object('error','not_found'); end if;
 if p.billing_provider='honeybook' then return jsonb_build_object('error','external_payment_required','url',p.external_billing_url); end if;
 if p.billing_provider<>'stripe' then return jsonb_build_object('error','billing_provider_required'); end if;
 if i.status='paid' then return jsonb_build_object('error','already_paid'); end if;
 if i.status<>'sent' then return jsonb_build_object('error','not_payable'); end if;
 if (p_params#>>'{line_items,0,price_data,unit_amount}')::bigint is distinct from i.amount_cents
    or p_params#>>'{metadata,invoice_id}' is distinct from i.id::text
    or p_params#>>'{metadata,project_id}' is distinct from p.id::text then
   return jsonb_build_object('error','invoice_changed');
 end if;
 select * into b from bk_bookings where invoice_id=i.id for update;
 if found and (b.status not in ('pending_payment','confirmed','completed')
   or (b.status='pending_payment' and (b.expires_at is null or b.expires_at<=now()))) then
   return jsonb_build_object('error','booking_hold_expired');
 end if;
 select * into a from bk_checkout_attempts where invoice_id=i.id and state='open' for update;
 if found and a.expires_at>now() then return to_jsonb(a); end if;
 if found then update bk_checkout_attempts set state='expired' where id=a.id; end if;
 expiry:=date_trunc('second',clock_timestamp()+interval '31 minutes');
 insert into bk_checkout_attempts(invoice_id,expires_at,params,legacy_session_id)
 values(i.id,expiry,p_params||jsonb_build_object('expires_at',extract(epoch from expiry)::bigint),i.stripe_session_id)
 returning * into a;
 if b.id is not null and b.status='pending_payment' then
  update bk_bookings set expires_at=expiry where id=b.id;
 end if;
 return to_jsonb(a);
end $$;
revoke all on function public.bk_prepare_checkout(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.bk_prepare_checkout(uuid,uuid,jsonb) to service_role;

create or replace function public.bk_finish_checkout(p_attempt uuid,p_session text)
returns boolean language plpgsql security definer set search_path=public as $$
declare a bk_checkout_attempts%rowtype; n int;
begin
 perform pg_advisory_xact_lock(hashtextextended('bk_calendar',42));
 select * into a from bk_checkout_attempts where id=p_attempt for update;
 if not found or a.state<>'open' or a.expires_at<=now() then raise exception 'checkout_expired'; end if;
 if a.stripe_session_id is not null and a.stripe_session_id<>p_session then raise exception 'checkout_session_conflict'; end if;
 update bk_invoices set stripe_session_id=p_session where id=a.invoice_id and status='sent';
 get diagnostics n=row_count;
 if n<>1 then raise exception 'invoice_not_payable'; end if;
 update bk_checkout_attempts set stripe_session_id=p_session where id=a.id;
 return true;
end $$;
revoke all on function public.bk_finish_checkout(uuid,text) from public,anon,authenticated;
grant execute on function public.bk_finish_checkout(uuid,text) to service_role;

create or replace function public.bk_record_checkout_payment(p_event_id text,p_session jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare sid text:=p_session->>'id'; iid text:=p_session#>>'{metadata,invoice_id}';
 pid text:=p_session#>>'{metadata,project_id}'; i bk_invoices%rowtype; p bk_projects%rowtype;
 e bk_payment_events%rowtype; why text; amount int; discount int; n int; review boolean;
begin
 if p_event_id is null or length(p_event_id)>255 or sid is null or length(sid)>255 then raise exception 'invalid_event'; end if;
 perform pg_advisory_xact_lock(hashtextextended('bk_calendar',42));
 insert into bk_payment_events(event_id,session_id,result) values(p_event_id,sid,'processing')
 on conflict do nothing returning * into e;
 if not found then
  select * into e from bk_payment_events where event_id=p_event_id or session_id=sid limit 1;
  return jsonb_build_object('status','duplicate','result',e.result,'reason',e.reason);
 end if;
 amount:=(p_session->>'amount_total')::int;
 discount:=coalesce((p_session#>>'{total_details,amount_discount}')::int,0);
 if p_session->>'payment_status' is distinct from 'paid' or p_session->>'mode' is distinct from 'payment' then why:='Stripe session is not a settled payment.';
 elsif p_session->>'currency' is distinct from 'usd' then why:='Currency mismatch — expected USD.';
 elsif iid is null or iid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then why:='Paid Stripe session has no valid invoice reference.';
 else
  select * into i from bk_invoices where id=iid::uuid for update;
  if not found then why:='Paid invoice does not exist.';
  else
   select * into p from bk_projects where id=i.project_id for update;
   if pid is distinct from i.project_id::text then why:='Project reference does not match this invoice.';
   elsif p.billing_provider<>'stripe' then why:='Project billing provider is not Stripe. Payment needs manual reconciliation.';
   elsif i.stripe_session_id is distinct from sid then why:='Checkout session does not match this invoice. Check for an extra payment.';
   elsif amount is null or amount+discount<>i.amount_cents or discount not in (0,2000) then why:='Payment amount or discount does not match this invoice.';
   elsif i.status='paid' then
    update bk_payment_events set invoice_id=i.id,project_id=i.project_id,amount_cents=amount,currency='usd',result='duplicate' where event_id=p_event_id;
    return jsonb_build_object('status','duplicate');
   elsif i.status<>'sent' then why:='Payment arrived for an invoice that is not sent. Review before applying.';
   else
    update bk_invoices set status='paid',paid_at=now(),paid_amount_cents=amount,source=coalesce(source,'stripe_checkout'),
      payment_note=case when discount>0 then 'Paid via Stripe Checkout — approved promotion applied (collected $'||to_char(amount::numeric/100,'FM9999999990.00')||')' else 'Paid via Stripe Checkout' end
      where id=i.id;
    update bk_checkout_attempts set state='paid' where invoice_id=i.id and stripe_session_id=sid;
    select exists(select 1 from bk_bookings where invoice_id=i.id and payment_review_required) into review;
    update bk_payment_events set invoice_id=i.id,project_id=i.project_id,amount_cents=amount,currency='usd',
      result=case when review then 'attention' else 'applied' end,
      reason=case when review then 'Payment recorded; booking hold needs manual review.' else null end
      where event_id=p_event_id;
    return jsonb_build_object('status',case when review then 'attention' else 'applied' end);
   end if;
  end if;
 end if;
 update bk_payment_events set invoice_id=i.id,project_id=i.project_id,amount_cents=amount,currency=p_session->>'currency',
   result='attention',reason=why where event_id=p_event_id;
 -- Alert + event are one transaction: a queue failure causes a retry, not a lost payment.
 insert into bk_email_queue(project_id,kind,payload) values(i.project_id,'nelson_alert',
   jsonb_build_object('type','payment_unreconciled','subject','Stripe payment needs review','detail',why,
     'session_id',sid,'invoice_id',iid,'amount_cents',amount));
 return jsonb_build_object('status','attention','reason',why);
end $$;
revoke all on function public.bk_record_checkout_payment(text,jsonb) from public,anon,authenticated;
grant execute on function public.bk_record_checkout_payment(text,jsonb) to service_role;

-- Current production booking implementation, retaining add-ons, weekend pricing,
-- service-specific availability, location validation, and travel buffers.
-- Remove the obsolete seven-argument overload when installing from old source.
drop function if exists public.bk_create_booking(text,timestamptz,text,text,text,text,text);
CREATE OR REPLACE FUNCTION public.bk_create_booking(p_service text, p_starts_at timestamp with time zone, p_name text, p_email text, p_phone text DEFAULT NULL::text, p_location text DEFAULT NULL::text, p_details text DEFAULT NULL::text, p_addons text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_svc bk_services%rowtype;
  v_tz text; v_base int; v_amount int; v_kind text;
  v_project uuid; v_token uuid; v_booking uuid; v_invoice uuid;
  v_day date; v_open jsonb; v_weekend boolean;
  v_addon_lines jsonb := '[]'::jsonb;
  v_addon_total int := 0;
  v_addon_names text := '';
  r record; v_requested int;
  v_location text;
  v_on_location boolean := false;
  v_travel int := 0;
  v_place text;
begin
  if p_name is null or length(trim(p_name)) < 1 then raise exception 'name required'; end if;
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'valid email required'; end if;
  if p_details is not null and length(p_details) > 4000 then raise exception 'details too long'; end if;

  select * into v_svc from bk_services where slug = p_service and active and kind = 'session';
  if not found then raise exception 'service not bookable'; end if;

  v_tz := coalesce((select value from bk_config where key = 'timezone'), 'America/Chicago');
  v_weekend := extract(dow from (p_starts_at at time zone v_tz))::int in (0, 6);
  v_base := case when v_weekend then coalesce(v_svc.weekend_price_cents, v_svc.price_cents)
                 else v_svc.price_cents end;
  v_amount := coalesce(v_svc.deposit_cents, v_base);
  if v_amount is null or v_amount <= 0 then raise exception 'service not bookable'; end if;
  v_kind := case when v_svc.deposit_cents is null then 'full' else 'deposit' end;

  -- location_ok services (senior-*): a typed location = on location, travel
  -- blocked both sides; blank = the studio. Edge whitespace (incl. non-breaking
  -- and zero-width spaces) is stripped, and a location only counts if it has a
  -- real letter or digit in it.
  v_place := regexp_replace(coalesce(p_location, ''), '^[\s\u00a0\u200b\ufeff]+|[\s\u00a0\u200b\ufeff]+$', '', 'g');
  if v_svc.location_ok and v_place ~ '[[:alnum:]]' then
    if length(v_place) > 200 then raise exception 'location too long'; end if;
    v_on_location := true;
    v_travel := least(greatest(bk_cfg_int('travel_min', 60), 0), 240);
  end if;

  -- studio sessions happen AT the studio: stamp the address so the emails carry it
  v_location := case
    when v_on_location then v_place
    when v_svc.slug like 'studio-%' or v_svc.slug like 'birthday-%' or v_svc.location_ok
         or v_svc.slug in ('digitals', 'headshots')
      then coalesce((select value from bk_config where key = 'studio_address'), p_location)
    else p_location end;

  -- add-ons: validate every requested slug, price server-side
  if p_addons is not null and array_length(p_addons, 1) > 0 then
    v_requested := (select count(distinct s) from unnest(p_addons) as s);
    for r in select * from bk_addons where active and slug = any(p_addons)
        and (services is null or p_service = any(services)) order by sort loop
      v_addon_total := v_addon_total + coalesce(r.price_cents, 0);
      v_addon_lines := v_addon_lines || jsonb_build_object(
        'title', r.name || case when r.price_cents is null then ' — priced on request' else '' end,
        'amount_cents', coalesce(r.price_cents, 0));
      v_addon_names := v_addon_names || case when v_addon_names = '' then '' else ', ' end
        || r.name || case when r.price_cents is null then ' (priced on request)' else '' end;
    end loop;
    if (select count(*) from bk_addons where active and slug = any(p_addons)
        and (services is null or p_service = any(services))) <> v_requested then
      raise exception 'unknown add-on';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('bk_calendar', 42));

  -- one booking writer per calendar day: serializes every booking whose slot
  -- could overlap another (different start times + buffers), not just
  -- exact-instant collisions
  v_day := (p_starts_at at time zone v_tz)::date;
  perform pg_advisory_xact_lock(hashtextextended('bk_day:' || v_day::text, 42));

  -- the requested slot must still be open (with travel, if on location)
  v_open := bk_open_slots_where(p_service, v_day, v_day, v_on_location) -> 'slots';
  if not (v_open @> jsonb_build_array(to_jsonb(p_starts_at))) then
    raise exception 'slot no longer available';
  end if;

  insert into public.bk_projects
    (client_name, client_email, client_phone, service, title, event_date, event_time,
     location, details, referral_source, billing_provider)
  values
    (trim(p_name), lower(trim(p_email)), p_phone, v_svc.legacy_service,
     trim(p_name) || ' — ' || v_svc.name || case when v_on_location then ' (on location)' else '' end,
     v_day, trim(to_char(p_starts_at at time zone v_tz, 'FMHH12:MI AM')),
     v_location,
     case when v_addon_names = '' then p_details
          else 'Add-ons: ' || v_addon_names || E'\n\n' || coalesce(p_details, '') end,
     'website-booking', 'stripe')
  returning id, access_token into v_project, v_token;

  insert into public.bk_bookings
    (project_id, service_id, starts_at, duration_min, status, expires_at, location, travel_min)
  values
    (v_project, v_svc.id, p_starts_at, v_svc.duration_min, 'pending_payment',
     now() + interval '30 minutes', v_location, v_travel)
  returning id into v_booking;

  insert into public.bk_invoices (project_id, title, line_items, amount_cents, kind, status, due_date)
  values
    (v_project,
     case when v_kind = 'full' then 'Session payment' else 'Booking deposit' end,
     jsonb_build_array(jsonb_build_object(
       'title', v_svc.name || ' · ' || to_char(p_starts_at at time zone v_tz, 'FMMon DD, YYYY FMHH12:MI AM')
                || case when v_on_location then ' · on location' else '' end,
       'amount_cents', v_amount)) || v_addon_lines,
     v_amount + v_addon_total, v_kind, 'sent', v_day)
  returning id into v_invoice;

  update public.bk_bookings set invoice_id = v_invoice where id = v_booking;

  return jsonb_build_object(
    'project_id', v_project, 'token', v_token, 'booking_id', v_booking,
    'invoice_id', v_invoice, 'amount_cents', v_amount + v_addon_total,
    'addon_cents', v_addon_total,
    'starts_at', p_starts_at, 'service_name', v_svc.name,
    'on_location', v_on_location);
end $function$;

revoke all on function public.bk_create_booking(text,timestamptz,text,text,text,text,text,text[]) from public;
grant execute on function public.bk_create_booking(text,timestamptz,text,text,text,text,text,text[]) to anon,authenticated;

-- Cached public forms keep their original RPC. Price and payment route remain
-- server-owned; the new retry-safe intake RPC is preferred by current clients.
create or replace function public.bk_book_digitals(
 p_name text,p_email text,p_phone text default null,p_event_date date default null,
 p_location text default null,p_notes text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_token uuid;
begin
 if p_name is null or length(trim(p_name)) not between 1 and 120 then raise exception 'name required'; end if;
 if p_email is null or length(p_email)>200 or trim(p_email) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'valid email required'; end if;
 if length(coalesce(p_phone,''))>40 or length(coalesce(p_location,''))>240 or length(coalesce(p_notes,''))>4000 then raise exception 'input too long'; end if;
 insert into bk_projects(client_name,client_email,client_phone,service,event_date,location,details,status,title,billing_provider)
 values(trim(p_name),lower(trim(p_email)),p_phone,'digitals',p_event_date,p_location,p_notes,'new',trim(p_name)||' — Digitals','stripe')
 returning id,access_token into v_id,v_token;
 insert into bk_invoices(project_id,title,amount_cents,kind,status,line_items,source)
 values(v_id,'Digitals session',10000,'full','sent','[{"label":"Digitals session — flat rate","amount_cents":10000}]'::jsonb,'digitals');
 return jsonb_build_object('id',v_id,'token',v_token);
end $$;
revoke all on function public.bk_book_digitals(text,text,text,date,text,text) from public;
grant execute on function public.bk_book_digitals(text,text,text,date,text,text) to anon,authenticated;

commit;
