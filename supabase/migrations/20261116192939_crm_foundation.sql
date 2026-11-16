-- CRM foundation. Additive; does not send emails, charge clients, or change payment routing.
-- Existing bk_* schema was inspected read-only on 2026-11-16 before authoring.
begin;
create schema if not exists bk_crm_private;
revoke all on schema bk_crm_private from public, anon, authenticated;

-- Keep the pre-release operational records inside the protected database.
-- No customer rows or portal capabilities are exported into this repository.
create table bk_crm_private.release_projects_before as table public.bk_projects;
create table bk_crm_private.release_invoices_before as table public.bk_invoices;
create table bk_crm_private.release_bookings_before as table public.bk_bookings;
create table bk_crm_private.release_email_queue_before as table public.bk_email_queue;
alter table bk_crm_private.release_projects_before enable row level security;
alter table bk_crm_private.release_invoices_before enable row level security;
alter table bk_crm_private.release_bookings_before enable row level security;
alter table bk_crm_private.release_email_queue_before enable row level security;
revoke all on all tables in schema bk_crm_private from public,anon,authenticated;
-- Capture the verified shared prerequisite here: the older definition lives in
-- another repository. No JWT user-editable metadata is used for authorization.
create or replace function public.bk_is_staff() returns boolean
language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','employee'));
$$;
revoke all on function public.bk_is_staff() from public,anon,authenticated;
-- Existing public RLS policies call this harmless boolean predicate even for
-- anonymous reads. Anonymous callers always receive false.
grant execute on function public.bk_is_staff() to anon,authenticated,service_role;

create function bk_crm_private.require_staff() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.bk_is_staff() then
    raise exception 'Staff access required' using errcode = '42501';
  end if;
end $$;
revoke all on function bk_crm_private.require_staff() from public, anon, authenticated;

create table public.bk_contacts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  name text not null check (length(trim(name)) between 1 and 120),
  email text check (email is null or (length(email) <= 200 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  phone text check (phone is null or length(phone) <= 40),
  company text check (company is null or length(company) <= 160),
  instagram text check (instagram is null or instagram ~ '^[A-Za-z0-9._]{1,30}$'),
  source text check (source is null or length(source) <= 240),
  notes text not null default '' check (length(notes) <= 4000)
);
create unique index bk_contacts_email_unique on public.bk_contacts(lower(email)) where email is not null;
create index bk_contacts_name_idx on public.bk_contacts(lower(name));
alter table public.bk_projects
  alter column client_email drop not null,
  add column contact_id uuid references public.bk_contacts(id),
  add column owner_id uuid references public.profiles(id),
  add column lost_reason text check (lost_reason is null or length(lost_reason) <= 1000),
  add column delivery_target date;
create index bk_projects_contact_idx on public.bk_projects(contact_id);
create index bk_projects_owner_idx on public.bk_projects(owner_id);
create table bk_crm_private.project_requests (
  user_id uuid not null references public.profiles(id),request_id uuid not null,
  fingerprint text not null,project_id uuid not null references public.bk_projects(id),
  created_at timestamptz not null default now(),primary key(user_id,request_id)
);
alter table bk_crm_private.project_requests enable row level security;
revoke all on bk_crm_private.project_requests from public,anon,authenticated;
alter table public.bk_projects drop constraint bk_projects_service_check;
alter table public.bk_projects add constraint bk_projects_service_check
check(service in ('music_video','brand_content','photography','event','digitals','other'));

-- One customer may have many jobs. Never merge the jobs themselves by email.
insert into public.bk_contacts(name,email,phone,company,source)
select distinct on (lower(trim(client_email))) client_name,lower(trim(client_email)),client_phone,company,referral_source
from public.bk_projects where client_email is not null
order by lower(trim(client_email)),updated_at desc,id;
-- Linking historical jobs must not make old deliveries look newly delivered.
alter table public.bk_projects disable trigger bk_projects_touch;
update public.bk_projects p set contact_id = c.id from public.bk_contacts c
where lower(trim(p.client_email)) = c.email;
update public.bk_projects set owner_id=(select id from public.profiles where role in ('admin','employee') order by case role when 'admin' then 0 else 1 end,id limit 1)
where owner_id is null;
alter table public.bk_projects enable trigger bk_projects_touch;

create table public.bk_tasks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  project_id uuid references public.bk_projects(id), contact_id uuid references public.bk_contacts(id),
  title text not null check (length(trim(title)) between 1 and 180),
  kind text not null default 'followup' check (kind in ('followup','production','delivery','rebook','other')),
  status text not null default 'open' check (status in ('open','done','cancelled')),
  due_at timestamptz, owner_id uuid references public.profiles(id),
  notes text not null default '' check (length(notes) <= 4000), completed_at timestamptz,
  automation_key text,
  check (project_id is not null or contact_id is not null),
  unique(project_id,automation_key)
);
create index bk_tasks_due_idx on public.bk_tasks(due_at,id) where status='open';
create index bk_tasks_project_idx on public.bk_tasks(project_id);

create table public.bk_quotes (
  id uuid primary key default gen_random_uuid(), version uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  project_id uuid not null references public.bk_projects(id),
  title text not null default 'Project quote' check (length(trim(title)) between 1 and 180),
  status text not null default 'draft' check (status in ('draft','sent','accepted','declined','void')),
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines)='array'),
  total_cents bigint not null default 0 check (total_cents between 0 and 999999999999),
  notes text not null default '' check (length(notes) <= 12000), valid_until date,
  sent_at timestamptz, accepted_at timestamptz, accepted_by text,
  declined_at timestamptz, decline_note text
);
create index bk_quotes_project_idx on public.bk_quotes(project_id,created_at desc);

create table public.bk_activities (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
  project_id uuid references public.bk_projects(id), contact_id uuid references public.bk_contacts(id),
  actor_id uuid, kind text not null, summary text not null,
  check (length(summary) between 1 and 500)
);
create index bk_activities_project_idx on public.bk_activities(project_id,created_at desc);

-- Expose only staff data; clients use narrow token functions, never table policies.
alter table public.bk_contacts enable row level security;
alter table public.bk_tasks enable row level security;
alter table public.bk_quotes enable row level security;
alter table public.bk_activities enable row level security;
revoke all on public.bk_contacts,public.bk_tasks,public.bk_quotes,public.bk_activities from public,anon,authenticated;
grant select,insert,update,delete on public.bk_contacts,public.bk_tasks to authenticated;
grant select on public.bk_quotes,public.bk_activities to authenticated;
create policy bk_contacts_staff on public.bk_contacts for all to authenticated
using ((select public.bk_is_staff())) with check ((select public.bk_is_staff()));
create policy bk_tasks_staff on public.bk_tasks for all to authenticated
using ((select public.bk_is_staff())) with check ((select public.bk_is_staff()));
create policy bk_quotes_staff on public.bk_quotes for select to authenticated using ((select public.bk_is_staff()));
create policy bk_activities_staff on public.bk_activities for select to authenticated using ((select public.bk_is_staff()));

-- Employees already operate the Inbox. Give the same staff predicate to its related data.
-- Never grant bk_config: it contains server secrets.
do $$ declare t text; begin
  foreach t in array array['bk_projects','bk_invoices','bk_messages','bk_files','bk_galleries','bk_gallery_items','bk_contracts','bk_bookings'] loop
    if to_regclass('public.'||t) is not null then
      execute format('grant select,insert,update,delete on public.%I to authenticated',t);
      execute format('create policy %I on public.%I for all to authenticated using ((select public.bk_is_staff())) with check ((select public.bk_is_staff()))',t||'_crm_staff',t);
    end if;
  end loop;
end $$;

create function bk_crm_private.contact_prepare() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.name := trim(new.name); new.email := nullif(lower(trim(new.email)),'');
  new.phone := nullif(trim(new.phone),''); new.instagram := nullif(ltrim(trim(new.instagram),'@'),'');
  new.updated_at := now(); return new;
end $$;
create trigger bk_contacts_prepare before insert or update on public.bk_contacts
for each row execute function bk_crm_private.contact_prepare();

create function bk_crm_private.next_business_day(p_at timestamptz) returns timestamptz
language plpgsql immutable set search_path='' as $$
declare local_due timestamp:=(p_at at time zone 'America/Chicago')+interval '1 day';
begin
  while extract(isodow from local_due)>5 loop local_due:=local_due+interval '1 day'; end loop;
  return local_due at time zone 'America/Chicago';
end $$;

create function bk_crm_private.project_contact() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c public.bk_contacts;
begin
  new.client_email := nullif(lower(trim(new.client_email)),'');
  if tg_op='INSERT' and new.owner_id is null then
    if public.bk_is_staff() then new.owner_id:=auth.uid();
    else select id into new.owner_id from public.profiles where role in ('admin','employee') order by case role when 'admin' then 0 else 1 end,id limit 1;
    end if;
  end if;
  if new.status='lost' and nullif(trim(new.lost_reason),'') is null and
    (tg_op='INSERT' or old.status is distinct from new.status) then
    raise exception 'Record why this opportunity was lost';
  end if;
  if new.owner_id is not null and not exists(select 1 from public.profiles where id=new.owner_id and role in ('admin','employee')) then
    raise exception 'Owner must be studio staff';
  end if;
  if new.contact_id is not null then
    select * into c from public.bk_contacts where id=new.contact_id;
    if not found then raise exception 'Contact not found'; end if;
  elsif new.client_email is not null then
    insert into public.bk_contacts(name,email,phone,company,source)
    values(new.client_name,new.client_email,new.client_phone,new.company,new.referral_source)
    on conflict (lower(email)) where email is not null do update set email=excluded.email
    returning * into c;
    new.contact_id := c.id;
  else
    insert into public.bk_contacts(name,phone,company,source)
    values(new.client_name,new.client_phone,new.company,new.referral_source) returning * into c;
    new.contact_id := c.id;
  end if;
  return new;
end $$;
create trigger bk_crm_project_contact before insert or update of contact_id,client_email,owner_id,status on public.bk_projects
for each row execute function bk_crm_private.project_contact();

create function bk_crm_private.task_prepare() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  new.title:=trim(new.title); new.updated_at:=now();
  if new.owner_id is not null and not exists(select 1 from public.profiles where id=new.owner_id and role in ('admin','employee')) then raise exception 'Owner must be studio staff'; end if;
  if new.project_id is not null then
    select contact_id into cid from public.bk_projects where id=new.project_id;
    if not found then raise exception 'Project not found'; end if;
    if new.contact_id is not null and new.contact_id is distinct from cid then raise exception 'Contact does not match project'; end if;
    new.contact_id:=cid;
  end if;
  new.completed_at := case when new.status='done' then coalesce(new.completed_at,now()) else null end;
  if tg_op='UPDATE' then new.automation_key:=old.automation_key; end if;
  return new;
end $$;
create trigger bk_tasks_prepare before insert or update on public.bk_tasks for each row execute function bk_crm_private.task_prepare();

create function bk_crm_private.activity_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Activity history is immutable'; end $$;
create trigger bk_activities_immutable before update or delete on public.bk_activities for each row execute function bk_crm_private.activity_immutable();

create function bk_crm_private.project_workflow() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text; label text; due timestamptz;
begin
  if tg_op='UPDATE' then
    if new.owner_id is distinct from old.owner_id then
      update public.bk_tasks set owner_id=new.owner_id where project_id=new.id and status='open' and automation_key is not null;
    end if;
    if new.delivery_target is distinct from old.delivery_target and new.status='in_production' then
      update public.bk_tasks set due_at=coalesce(new.delivery_target::timestamp at time zone 'America/Chicago',now()+interval '7 days') where project_id=new.id and status='open' and automation_key='production_delivery';
    end if;
    if new.event_date is distinct from old.event_date and new.status='booked' then
      update public.bk_tasks set due_at=coalesce((new.event_date::timestamp at time zone 'America/Chicago')-interval '2 days',now()+interval '1 day') where project_id=new.id and status='open' and automation_key='production_prep';
    end if;
  end if;
  if tg_op='INSERT' then
    insert into public.bk_activities(project_id,contact_id,actor_id,kind,summary) values(new.id,new.contact_id,auth.uid(),'project_created','Project created');
  elsif new.status is distinct from old.status then
    insert into public.bk_activities(project_id,contact_id,actor_id,kind,summary)
    values(new.id,new.contact_id,auth.uid(),'stage_changed','Stage: '||old.status||' → '||new.status);
  elsif row(new.owner_id,new.delivery_target,new.lost_reason,new.contact_id,new.title,new.notes_internal) is distinct from row(old.owner_id,old.delivery_target,old.lost_reason,old.contact_id,old.title,old.notes_internal) then
    insert into public.bk_activities(project_id,contact_id,actor_id,kind,summary) values(new.id,new.contact_id,auth.uid(),'project_updated','Project details updated');
  end if;
  if tg_op='INSERT' or new.status is distinct from old.status then
    if new.status in ('new','quoted','booked','in_production') then
      update public.bk_tasks set status='cancelled' where contact_id=new.contact_id and kind='rebook' and status='open' and automation_key='rebook';
    end if;
    if new.status='new' then k:='initial_followup'; label:='Reply to new inquiry'; due:=bk_crm_private.next_business_day(now());
    elsif new.status='quoted' then k:='quote_followup'; label:='Follow up on proposal'; due:=now()+interval '3 days';
    elsif new.status='booked' then k:='production_prep'; label:='Confirm brief, agreement and shoot preparation'; due:=coalesce((new.event_date::timestamp at time zone 'America/Chicago')-interval '2 days',now()+interval '1 day');
    elsif new.status='in_production' then k:='production_delivery'; label:='Prepare work for client review'; due:=coalesce(new.delivery_target::timestamp at time zone 'America/Chicago',now()+interval '7 days');
    elsif new.status='delivered' then k:='rebook'; label:='Check in about the next project'; due:=now()+interval '60 days'; end if;
    -- Close the previous automatic stage task, leaving all manual tasks untouched.
    if tg_op='UPDATE' then
      update public.bk_tasks set status='done' where project_id=new.id and status='open' and automation_key in ('initial_followup','quote_followup','production_prep','production_delivery') and automation_key is distinct from k;
    end if;
    if new.status in ('lost','archived') then
      update public.bk_tasks set status='cancelled' where project_id=new.id and status='open' and automation_key is not null;
    elsif k is not null then
      insert into public.bk_tasks(project_id,contact_id,title,kind,due_at,owner_id,automation_key)
      values(new.id,new.contact_id,label,case when k='rebook' then 'rebook' when k in ('production_prep','production_delivery') then 'production' else 'followup' end,greatest(due,now()),new.owner_id,k)
      on conflict(project_id,automation_key) do update set status='open',due_at=excluded.due_at,owner_id=excluded.owner_id;
    end if;
  end if;
  return new;
end $$;
create trigger bk_crm_project_workflow after insert or update on public.bk_projects for each row execute function bk_crm_private.project_workflow();

create function bk_crm_private.task_audit() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.bk_activities(project_id,contact_id,actor_id,kind,summary)
  values(coalesce(new.project_id,old.project_id),coalesce(new.contact_id,old.contact_id),auth.uid(),'task_'||lower(tg_op),
    left(case when tg_op='DELETE' then 'Task removed: '||old.title when tg_op='INSERT' then 'Task added: '||new.title else 'Task '||new.status||': '||new.title end,500));
  return coalesce(new,old);
end $$;
create trigger bk_tasks_audit after insert or update or delete on public.bk_tasks for each row execute function bk_crm_private.task_audit();

create function bk_crm_private.contact_audit() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if row(new.name,new.email,new.phone,new.company,new.instagram,new.source,new.notes) is distinct from row(old.name,old.email,old.phone,old.company,old.instagram,old.source,old.notes) then
    insert into public.bk_activities(contact_id,actor_id,kind,summary) values(new.id,auth.uid(),'contact_updated','Contact details updated');
  end if;
  return new;
end $$;
create trigger bk_contacts_audit after update on public.bk_contacts for each row execute function bk_crm_private.contact_audit();

create function bk_crm_private.quote_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if old.status<>'draft' and row(new.project_id,new.version,new.title,new.lines,new.total_cents,new.notes,new.valid_until) is distinct from row(old.project_id,old.version,old.title,old.lines,old.total_cents,old.notes,old.valid_until) then
    raise exception 'Published quote contents are immutable; create a revised draft';
  end if;
  if old.status in ('accepted','declined','void') and row(new.status,new.accepted_by,new.accepted_at,new.declined_at,new.decline_note) is distinct from row(old.status,old.accepted_by,old.accepted_at,old.declined_at,old.decline_note) then
    raise exception 'A closed quote cannot be changed';
  end if;
  return new;
end $$;
create trigger bk_quotes_guard before update on public.bk_quotes for each row execute function bk_crm_private.quote_guard();

-- Resolves the payment migration's helper when installed, while keeping this
-- foundation independently testable and allowing either migration order.
create function bk_crm_private.project_json(p public.bk_projects) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare locked boolean:=false;
begin
  if to_regprocedure('public.bk_project_billing_locked(uuid)') is not null then
    execute 'select public.bk_project_billing_locked($1)' into locked using p.id;
  end if;
  return to_jsonb(p)||jsonb_build_object('billing_locked',locked);
end $$;

create function public.bk_crm_create_project(p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.bk_projects; c public.bk_contacts; v_name text; v_email text; v_phone text; v_ig text;
  v_request uuid:=nullif(p_data->>'request_id','')::uuid; v_fingerprint text; receipt bk_crm_private.project_requests;
begin
  perform bk_crm_private.require_staff();
  if v_request is not null then
    v_fingerprint:=md5((p_data-'request_id')::text);
    perform pg_advisory_xact_lock(hashtextextended('bk-crm-create:'||auth.uid()::text||':'||v_request::text,0));
    select * into receipt from bk_crm_private.project_requests where user_id=auth.uid() and request_id=v_request;
    if found then
      if receipt.fingerprint is distinct from v_fingerprint then raise exception 'request_changed'; end if;
      select * into p from public.bk_projects where id=receipt.project_id;
      return bk_crm_private.project_json(p);
    end if;
  end if;
  v_name:=nullif(trim(p_data->>'client_name'),''); v_email:=nullif(lower(trim(p_data->>'client_email')),''); v_phone:=nullif(trim(p_data->>'client_phone'),''); v_ig:=nullif(ltrim(trim(p_data->>'instagram'),'@'),'');
  if nullif(trim(p_data->>'referral_source'),'') is null then raise exception 'Choose a lead source'; end if;
  if nullif(p_data->>'contact_id','') is not null then
    select * into c from public.bk_contacts where id=(p_data->>'contact_id')::uuid;
    if not found then raise exception 'Contact not found'; end if;
    v_name:=coalesce(v_name,c.name); v_email:=coalesce(v_email,c.email); v_phone:=coalesce(v_phone,c.phone); v_ig:=coalesce(v_ig,c.instagram);
  end if;
  if v_name is null or (v_email is null and v_phone is null and v_ig is null) then raise exception 'Name and an email, phone or Instagram are required'; end if;
  if c.id is null and v_email is not null then select * into c from public.bk_contacts where lower(email)=v_email; end if;
  if c.id is null then
    insert into public.bk_contacts(name,email,phone,company,instagram,source)
    values(v_name,v_email,v_phone,p_data->>'company',v_ig,p_data->>'referral_source') returning * into c;
  end if;
  insert into public.bk_projects(client_name,client_email,client_phone,company,contact_id,service,title,event_date,location,details,referral_source,owner_id,delivery_target)
  values(v_name,v_email,v_phone,coalesce(p_data->>'company',c.company),c.id,coalesce(nullif(p_data->>'service',''),'other'),coalesce(nullif(trim(p_data->>'title'),''),v_name||' — New project'),nullif(p_data->>'event_date','')::date,p_data->>'location',p_data->>'details',trim(p_data->>'referral_source'),coalesce(nullif(p_data->>'owner_id','')::uuid,auth.uid()),nullif(p_data->>'delivery_target','')::date)
  returning * into p;
  if v_request is not null then insert into bk_crm_private.project_requests(user_id,request_id,fingerprint,project_id) values(auth.uid(),v_request,v_fingerprint,p.id); end if;
  return bk_crm_private.project_json(p);
end $$;

create function public.bk_crm_save_project(p_project uuid,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.bk_projects; c public.bk_contacts;
begin
  perform bk_crm_private.require_staff();
  select * into p from public.bk_projects where id=p_project for update;
  if not found then raise exception 'Project not found'; end if;
  if p_data ? 'status' and p_data->>'status'='lost' and nullif(trim(coalesce(p_data->>'lost_reason',p.lost_reason)),'') is null then raise exception 'Record why this opportunity was lost'; end if;
  select * into c from public.bk_contacts where id=coalesce(nullif(p_data->>'contact_id','')::uuid,p.contact_id) for update;
  if not found then raise exception 'Contact not found'; end if;
  if p_data ?| array['client_name','client_email','client_phone','company','instagram'] then
    -- Updating a contact never silently links it to a different customer's email.
    if p_data?'client_email' and nullif(lower(trim(p_data->>'client_email')),'') is not null and exists(select 1 from public.bk_contacts where id<>c.id and lower(email)=lower(trim(p_data->>'client_email'))) then
      raise exception 'That email belongs to another contact. Choose that contact or correct the email.';
    end if;
    update public.bk_contacts set
      name=case when p_data?'client_name' then trim(p_data->>'client_name') else name end,
      email=case when p_data?'client_email' then nullif(lower(trim(p_data->>'client_email')),'') else email end,
      phone=case when p_data?'client_phone' then nullif(trim(p_data->>'client_phone'),'') else phone end,
      company=case when p_data?'company' then nullif(trim(p_data->>'company'),'') else company end,
      instagram=case when p_data?'instagram' then nullif(ltrim(trim(p_data->>'instagram'),'@'),'') else instagram end
    where id=c.id returning * into c;
    if c.email is null and c.phone is null and c.instagram is null then raise exception 'Keep an email, phone or Instagram for this contact'; end if;
  end if;
  update public.bk_projects set
    client_name=c.name,client_email=c.email,client_phone=c.phone,company=c.company,
    service=case when p_data?'service' then p_data->>'service' else service end,
    status=case when p_data?'status' then p_data->>'status' else status end,
    title=case when p_data?'title' then nullif(trim(p_data->>'title'),'') else title end,
    owner_id=case when p_data?'owner_id' then nullif(p_data->>'owner_id','')::uuid else owner_id end,
    delivery_target=case when p_data?'delivery_target' then nullif(p_data->>'delivery_target','')::date else delivery_target end,
    lost_reason=case when p_data?'lost_reason' then nullif(trim(p_data->>'lost_reason'),'') else lost_reason end,
    event_date=case when p_data?'event_date' then nullif(p_data->>'event_date','')::date else event_date end,
    event_time=case when p_data?'event_time' then p_data->>'event_time' else event_time end,
    location=case when p_data?'location' then p_data->>'location' else location end,
    budget_range=case when p_data?'budget_range' then p_data->>'budget_range' else budget_range end,
    referral_source=case when p_data?'referral_source' then p_data->>'referral_source' else referral_source end,
    notes_internal=case when p_data?'notes_internal' then p_data->>'notes_internal' else notes_internal end,
    details=case when p_data?'details' then p_data->>'details' else details end,
    contact_id=c.id
  where id=p_project returning * into p;
  return bk_crm_private.project_json(p);
end $$;

-- All quote totals are calculated on the server, never trusted from the browser.
create function public.bk_crm_save_quote(p_project uuid,p_data jsonb,p_quote uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.bk_quotes; x jsonb; total numeric:=0; qty numeric; cents numeric; clean jsonb:='[]';
begin
  perform bk_crm_private.require_staff();
  if not exists(select 1 from public.bk_projects where id=p_project) then raise exception 'Project not found'; end if;
  if jsonb_typeof(p_data->'lines') is distinct from 'array' or jsonb_array_length(p_data->'lines') not between 1 and 50 then raise exception 'Add 1–50 quote items'; end if;
  for x in select value from jsonb_array_elements(p_data->'lines') loop
    qty:=(x->>'quantity')::numeric; cents:=(x->>'unit_cents')::numeric;
    if nullif(trim(x->>'description'),'') is null or length(x->>'description')>500 or qty is null or qty<>trunc(qty) or qty not between 1 and 10000 or cents is null or cents<>trunc(cents) or cents not between 0 and 999999999 then raise exception 'Invalid quote item'; end if;
    total:=total+qty*cents;
    clean:=clean||jsonb_build_array(jsonb_build_object('description',trim(x->>'description'),'quantity',qty::int,'unit_cents',cents::bigint));
  end loop;
  if total>999999999999 then raise exception 'Quote total is too large'; end if;
  if p_quote is null then
    insert into public.bk_quotes(project_id,title,lines,total_cents,notes,valid_until)
    values(p_project,coalesce(nullif(trim(p_data->>'title'),''),'Project quote'),clean,total,coalesce(p_data->>'notes',''),nullif(p_data->>'valid_until','')::date) returning * into q;
  else
    select * into q from public.bk_quotes where id=p_quote and project_id=p_project for update;
    if not found or q.status<>'draft' then raise exception 'Only a draft quote can be edited'; end if;
    update public.bk_quotes set title=coalesce(nullif(trim(p_data->>'title'),''),'Project quote'),lines=clean,total_cents=total,notes=coalesce(p_data->>'notes',''),valid_until=nullif(p_data->>'valid_until','')::date,version=gen_random_uuid(),updated_at=now() where id=p_quote returning * into q;
  end if;
  insert into public.bk_activities(project_id,contact_id,actor_id,kind,summary)
  select p.id,p.contact_id,auth.uid(),'quote_saved','Quote draft saved: '||left(q.title,180) from public.bk_projects p where p.id=p_project;
  return to_jsonb(q);
end $$;

create function public.bk_crm_quote_status(p_quote uuid,p_status text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.bk_quotes;
begin
  perform bk_crm_private.require_staff();
  select * into q from public.bk_quotes where id=p_quote for update;
  if not found then raise exception 'Quote not found'; end if;
  if not ((q.status='draft' and p_status in ('sent','void')) or (q.status='sent' and p_status='void')) then raise exception 'Quote transition not allowed'; end if;
  if p_status='sent' and (q.total_cents<=0 or (q.valid_until is not null and q.valid_until < (now() at time zone 'America/Chicago')::date)) then raise exception 'A quote needs a positive total and a current expiry date'; end if;
  update public.bk_quotes set status=p_status,sent_at=case when p_status='sent' then now() else sent_at end,updated_at=now() where id=p_quote returning * into q;
  if p_status='sent' then
    update public.bk_projects set status='quoted' where id=q.project_id and status='new';
  end if;
  insert into public.bk_activities(project_id,contact_id,actor_id,kind,summary) select p.id,p.contact_id,auth.uid(),'quote_'||p_status,'Quote '||p_status||': '||left(q.title,180) from public.bk_projects p where p.id=q.project_id;
  -- Publish to the portal only. Deliberately no message/email queue writes.
  return to_jsonb(q);
end $$;

create function public.bk_crm_portal_quotes(p_project uuid,p_token uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.bk_projects where id=p_project and access_token=p_token) then raise exception 'not_found'; end if;
  return jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from public.bk_quotes q where q.project_id=p_project and q.status in ('sent','accepted','declined')),'[]'::jsonb));
end $$;

create function bk_crm_private.quote_decision(p_project uuid,p_token uuid,p_quote uuid,p_version uuid,p_decision text,p_signer text,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.bk_quotes; p public.bk_projects;
begin
  select * into p from public.bk_projects where id=p_project and access_token=p_token;
  if not found then raise exception 'not_found'; end if;
  select * into q from public.bk_quotes where id=p_quote and project_id=p_project for update;
  if not found then raise exception 'not_found'; end if;
  if q.version is distinct from p_version then raise exception 'quote_changed'; end if;
  if q.status=p_decision then return jsonb_build_object('ok',true,'quote_id',q.id,'status',q.status); end if;
  if q.status<>'sent' then raise exception 'Quote is no longer open'; end if;
  if q.valid_until is not null and q.valid_until < (now() at time zone 'America/Chicago')::date then raise exception 'Quote has expired'; end if;
  if p_decision='accepted' and (p_signer is null or length(trim(p_signer)) not between 1 and 120) then raise exception 'Your name is required'; end if;
  if length(coalesce(p_note,''))>1000 then raise exception 'Keep your note under 1000 characters'; end if;
  update public.bk_quotes set status=p_decision,accepted_at=case when p_decision='accepted' then now() end,accepted_by=case when p_decision='accepted' then trim(p_signer) end,declined_at=case when p_decision='declined' then now() end,decline_note=case when p_decision='declined' then nullif(trim(p_note),'') end,updated_at=now() where id=q.id;
  insert into public.bk_activities(project_id,contact_id,kind,summary) values(p.id,p.contact_id,'quote_'||p_decision,'Client '||p_decision||' quote: '||left(q.title,180));
  insert into public.bk_tasks(project_id,contact_id,title,kind,due_at,owner_id,automation_key)
  values(p.id,p.contact_id,case when p_decision='accepted' then 'Prepare agreement and correct-provider invoice for accepted quote' else 'Review declined quote and next steps' end,'followup',now()+interval '1 day',p.owner_id,'quote_decision_'||q.id::text) on conflict(project_id,automation_key) do nothing;
  return jsonb_build_object('ok',true,'quote_id',q.id,'status',p_decision);
end $$;
create function public.bk_crm_accept_quote(p_project uuid,p_token uuid,p_quote uuid,p_version uuid,p_signer text) returns jsonb language sql security definer set search_path='' as $$
select bk_crm_private.quote_decision(p_project,p_token,p_quote,p_version,'accepted',p_signer,null) $$;
create function public.bk_crm_decline_quote(p_project uuid,p_token uuid,p_quote uuid,p_version uuid,p_note text default '') returns jsonb language sql security definer set search_path='' as $$
select bk_crm_private.quote_decision(p_project,p_token,p_quote,p_version,'declined',null,p_note) $$;

create function public.bk_crm_staff() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin perform bk_crm_private.require_staff(); return coalesce((select jsonb_agg(jsonb_build_object('id',id,'full_name',full_name,'role',role) order by full_name) from public.profiles where role in ('admin','employee')),'[]'::jsonb); end $$;

create function public.bk_crm_projects(p_query text default '',p_status text default 'all',p_offset int default 0,p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform bk_crm_private.require_staff();
  with filtered as (
    select p.*,coalesce((bk_crm_private.project_json(p)->>'billing_locked')::boolean,false) billing_locked,to_jsonb(c) as contact,
      (select to_jsonb(t) from public.bk_tasks t where t.project_id=p.id and t.status='open' order by t.due_at nulls last,t.id limit 1) next_task,
      coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'amount_cents',i.amount_cents,'paid_amount_cents',coalesce((to_jsonb(i)->>'paid_amount_cents')::bigint,i.amount_cents),'status',i.status,'paid_at',i.paid_at)) from public.bk_invoices i where i.project_id=p.id),'[]'::jsonb) bk_invoices
    from public.bk_projects p left join public.bk_contacts c on c.id=p.contact_id
    where (p_status in ('all','') or p.status=p_status or (p_status='active' and p.status in ('new','quoted','booked','in_production')))
      and not exists(select 1 from regexp_split_to_table(lower(trim(coalesce(p_query,''))),'\s+') w where w<>'' and lower(concat_ws(' ',p.client_name,p.client_email,p.client_phone,p.company,p.title,p.service,p.referral_source,c.instagram)) not like '%'||replace(replace(replace(w,'\','\\'),'%','\%'),'_','\_')||'%')
  ) select jsonb_build_object('total',(select count(*) from filtered),'rows',coalesce((select jsonb_agg(to_jsonb(r)) from (select * from filtered order by updated_at desc,id limit least(greatest(p_limit,1),100) offset greatest(p_offset,0))r),'[]'::jsonb)) into result;
  return result;
end $$;

create function public.bk_crm_contacts(p_query text default '',p_offset int default 0,p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform bk_crm_private.require_staff();
  with filtered as(select c.*,(select count(*) from public.bk_projects p where p.contact_id=c.id) project_count from public.bk_contacts c
    where lower(concat_ws(' ',c.name,c.email,c.phone,c.company,c.instagram)) like '%'||lower(coalesce(p_query,''))||'%')
  select jsonb_build_object('total',(select count(*) from filtered),'rows',coalesce((select jsonb_agg(to_jsonb(r)) from (select * from filtered order by updated_at desc,id limit least(greatest(p_limit,1),100) offset greatest(p_offset,0))r),'[]'::jsonb)) into result;
  return result;
end $$;

create function public.bk_crm_tasks(p_filter text default 'all',p_offset int default 0,p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform bk_crm_private.require_staff();
  with filtered as (
    select t.*,p.title project_title,coalesce(p.client_name,c.name) client_name
    from public.bk_tasks t left join public.bk_projects p on p.id=t.project_id left join public.bk_contacts c on c.id=t.contact_id
    where t.status='open' and case p_filter
      when 'due' then (t.due_at at time zone 'America/Chicago')::date <= (now() at time zone 'America/Chicago')::date
      when 'upcoming' then (t.due_at at time zone 'America/Chicago')::date > (now() at time zone 'America/Chicago')::date
      else true end
  ) select jsonb_build_object('total',(select count(*) from filtered),'rows',coalesce((select jsonb_agg(to_jsonb(r)) from (select * from filtered order by due_at nulls last,id limit least(greatest(p_limit,1),100) offset greatest(p_offset,0))r),'[]'::jsonb)) into result;
  return result;
end $$;

create function public.bk_crm_project(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare p public.bk_projects;
begin
  perform bk_crm_private.require_staff(); select * into p from public.bk_projects where id=p_project;
  if not found then raise exception 'Project not found'; end if;
  return jsonb_build_object(
    'project',bk_crm_private.project_json(p),'contact',(select to_jsonb(c) from public.bk_contacts c where c.id=p.contact_id),
    'tasks',coalesce((select jsonb_agg(to_jsonb(t) order by t.due_at nulls last,t.created_at) from public.bk_tasks t where t.project_id=p.id),'[]'::jsonb),
    'quotes',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from public.bk_quotes q where q.project_id=p.id),'[]'::jsonb),
    'activities',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc,a.id) from public.bk_activities a where a.project_id=p.id or (a.project_id is null and a.contact_id=p.contact_id)),'[]'::jsonb),
    'history',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'title',h.title,'status',h.status,'created_at',h.created_at) order by h.created_at desc) from public.bk_projects h where h.contact_id=p.contact_id and h.id<>p.id),'[]'::jsonb),
    'invoices',coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at desc) from public.bk_invoices i where i.project_id=p.id),'[]'::jsonb),
    'bookings',coalesce((select jsonb_agg(to_jsonb(b) order by b.starts_at) from public.bk_bookings b where b.project_id=p.id),'[]'::jsonb),
    'messages',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'sender',m.sender,'body',m.body,'created_at',m.created_at) order by m.created_at) from public.bk_messages m where m.project_id=p.id),'[]'::jsonb)
  );
end $$;

create function public.bk_crm_inbox(p_filter text default 'needs',p_query text default '',p_offset int default 0,p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform bk_crm_private.require_staff();
  with rows_all as (
    select p.id,p.client_name,p.company,p.client_email as email,p.client_phone as phone,p.title,p.service,p.status,p.created_at,p.inbox_handled_at,
      coalesce(a.at,p.updated_at,p.created_at) as at,a.kind as last_kind,a.summary as last_summary,
      (p.inbox_handled_at is null and p.status not in ('archived','lost')) as waiting,
      coalesce(inv.due,0) due,coalesce(inv.items,'[]'::jsonb) bk_invoices
    from public.bk_projects p
    left join lateral(select e.* from (
      select q.created_at at,'alert'::text kind,coalesce(q.payload->>'type','event') summary from public.bk_email_queue q where q.project_id=p.id and q.kind='nelson_alert'
      union all select m.created_at,'message',left(m.body,140) from public.bk_messages m where m.project_id=p.id and m.sender='client'
    )e order by e.at desc limit 1)a on true
    left join lateral(select sum(i.amount_cents) filter(where i.status='sent') due,jsonb_agg(jsonb_build_object('amount_cents',i.amount_cents,'paid_amount_cents',coalesce((to_jsonb(i)->>'paid_amount_cents')::bigint,i.amount_cents),'status',i.status,'paid_at',i.paid_at)) items from public.bk_invoices i where i.project_id=p.id)inv on true
  ), filtered as (
    select * from rows_all r where
      case p_filter when 'needs' then r.waiting when 'leads' then r.status in ('new','quoted') when 'booked' then r.status in ('booked','in_production') when 'delivered' then r.status='delivered' when 'unpaid' then r.due>0 else true end
      and not exists(select 1 from regexp_split_to_table(lower(trim(coalesce(p_query,''))),'\s+') w where w<>'' and lower(concat_ws(' ',r.client_name,r.company,r.email,r.phone,r.title,r.service,r.status)) not like '%'||replace(replace(replace(w,'\','\\'),'%','\%'),'_','\_')||'%')
  ) select jsonb_build_object(
    'rows',coalesce((select jsonb_agg(to_jsonb(r)) from (select * from filtered order by at desc,id limit least(greatest(p_limit,1),100) offset greatest(p_offset,0))r),'[]'::jsonb),
    'total',(select count(*) from filtered),
    'counts',(select jsonb_build_object('needs',count(*) filter(where waiting),'leads',count(*) filter(where status in ('new','quoted')),'booked',count(*) filter(where status in ('booked','in_production')),'delivered',count(*) filter(where status='delivered'),'unpaid',count(*) filter(where due>0),'all',count(*)) from rows_all),
    'stats',jsonb_build_object('waiting',(select count(*) from rows_all where waiting),'newLeads',(select count(*) from rows_all where created_at>=now()-interval '7 days' and status not in ('lost','archived')),
      'unpaid',(select coalesce(sum(amount_cents),0) from public.bk_invoices where status='sent'),
      'collected',(select coalesce(sum(coalesce((to_jsonb(i)->>'paid_amount_cents')::bigint,i.amount_cents)),0) from public.bk_invoices i where status='paid' and date_trunc('month',paid_at at time zone 'America/Chicago')=date_trunc('month',now() at time zone 'America/Chicago')),
      'monthName',trim(to_char(now() at time zone 'America/Chicago','Month')))
  ) into result;
  return result;
end $$;

create function public.bk_crm_dashboard() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; base jsonb;
begin
  perform bk_crm_private.require_staff(); base:=public.bk_crm_inbox('all','',0,1);
  select jsonb_build_object('stats',(base->'stats')||jsonb_build_object(
    'overdue',(select count(*) from public.bk_tasks where status='open' and due_at<now()),
    'dueToday',(select count(*) from public.bk_tasks where status='open' and (due_at at time zone 'America/Chicago')::date=(now() at time zone 'America/Chicago')::date),
    'activeProjects',(select count(*) from public.bk_projects where status in ('new','quoted','booked','in_production')),
    'noNextAction',(select count(*) from public.bk_projects p where p.status in ('new','quoted','booked','in_production') and not exists(select 1 from public.bk_tasks t where t.project_id=p.id and t.status='open'))),
    'no_next_action_total',(select count(*) from public.bk_projects p where p.status in ('new','quoted','booked','in_production') and not exists(select 1 from public.bk_tasks t where t.project_id=p.id and t.status='open')),
    'no_next_action',coalesce((select jsonb_agg(to_jsonb(r)) from(select p.id,p.client_name,p.title,p.status from public.bk_projects p where p.status in ('new','quoted','booked','in_production') and not exists(select 1 from public.bk_tasks t where t.project_id=p.id and t.status='open') order by p.updated_at,p.id limit 10)r),'[]'::jsonb),
    'stage_counts',coalesce((select jsonb_object_agg(status,n) from(select status,count(*) n from public.bk_projects group by status)s),'{}'::jsonb),
    'sources',coalesce((select jsonb_agg(to_jsonb(s) order by s.count desc,s.source) from(select coalesce(nullif(trim(referral_source),''),'Unknown') source,count(*) count from public.bk_projects group by coalesce(nullif(trim(referral_source),''),'Unknown'))s),'[]'::jsonb),
    'upcoming_bookings_total',(select count(*) from public.bk_bookings where starts_at>=now() and status not in ('cancelled','completed')),
    'upcoming_bookings',coalesce((select jsonb_agg(to_jsonb(b) order by b.starts_at,b.id) from(select b.id,b.project_id,p.title project_title,p.client_name,b.starts_at,b.status from public.bk_bookings b join public.bk_projects p on p.id=b.project_id where b.starts_at>=now() and b.status not in ('cancelled','completed') order by b.starts_at,b.id limit 10)b),'[]'::jsonb),
    'tasks_total',(select count(*) from public.bk_tasks where status='open'),
    'tasks',coalesce((select jsonb_agg(to_jsonb(r)) from(select t.*,p.title project_title,p.client_name from public.bk_tasks t left join public.bk_projects p on p.id=t.project_id where t.status='open' order by t.due_at nulls last,t.id limit 100)r),'[]'::jsonb)
  ) into result; return result;
end $$;

-- The older RPC used email=NULL as its not-found test, which breaks manual phone/DM leads.
-- Retain its response shape and add contact-linked history without exposing portal tokens.
create or replace function public.bk_inbox_item(p_project uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p public.bk_projects;
begin
  perform bk_crm_private.require_staff(); select * into p from public.bk_projects where id=p_project;
  if not found then raise exception 'not found'; end if;
  return jsonb_build_object(
    'project',to_jsonb(p)-'access_token'-'notes_internal',
    'bookings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'starts_at',b.starts_at,'duration_min',b.duration_min,'status',b.status,'balance_cents',to_jsonb(b)->'balance_cents','balance_status',to_jsonb(b)->'balance_status','service',case when s.id is null then null else jsonb_build_object('name',s.name,'slug',s.slug,'kind',s.kind,'price_cents',s.price_cents,'deposit_cents',s.deposit_cents) end) order by b.starts_at) from public.bk_bookings b left join public.bk_services s on s.id=b.service_id where b.project_id=p.id and b.status<>'cancelled'),'[]'::jsonb),
    'messages',coalesce((select jsonb_agg(jsonb_build_object('sender',m.sender,'body',m.body,'created_at',m.created_at) order by m.created_at) from(select * from public.bk_messages where project_id=p.id order by created_at desc limit 10)m),'[]'::jsonb),
    'alerts',coalesce((select jsonb_agg(jsonb_build_object('type',q.payload->>'type','created_at',q.created_at) order by q.created_at desc) from(select * from public.bk_email_queue where project_id=p.id and kind='nelson_alert' order by created_at desc limit 5)q),'[]'::jsonb),
    'past_projects',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'title',h.title,'created_at',h.created_at,'status',h.status) order by h.created_at desc) from public.bk_projects h where h.id<>p.id and (h.contact_id=p.contact_id or (p.client_email is not null and h.client_email=p.client_email))),'[]'::jsonb)
  );
end $$;

-- Lock down every newly created function, including trigger helpers. Defaults may grant
-- functions to PUBLIC, anon AND authenticated in existing Supabase projects.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig,p.proname,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bk_crm_private' or (n.nspname='public' and p.proname like 'bk_crm_%') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    if f.nspname='public' then
      if f.proname in ('bk_crm_portal_quotes','bk_crm_accept_quote','bk_crm_decline_quote') then execute format('grant execute on function %s to anon,authenticated',f.sig);
      else execute format('grant execute on function %s to authenticated',f.sig); end if;
    end if;
  end loop;
end $$;
revoke all on function public.bk_inbox_item(uuid) from public,anon,authenticated;
grant execute on function public.bk_inbox_item(uuid) to authenticated;

-- Seed outstanding actions for current work so the new task view is useful on
-- day one. These are private staff records; no notifications or client sends.
insert into public.bk_tasks(project_id,contact_id,title,kind,due_at,owner_id,automation_key)
select p.id,p.contact_id,
  case p.status when 'new' then 'Reply to new inquiry' when 'quoted' then 'Follow up on proposal' when 'booked' then 'Confirm brief, agreement and shoot preparation' else 'Prepare work for client review' end,
  case when p.status in ('booked','in_production') then 'production' else 'followup' end,
  case p.status when 'new' then bk_crm_private.next_business_day(p.created_at) when 'quoted' then p.updated_at+interval '3 days' when 'booked' then coalesce(p.event_date::timestamp at time zone 'America/Chicago',now())-interval '2 days' else coalesce(p.delivery_target::timestamp at time zone 'America/Chicago',p.updated_at+interval '7 days') end,
  p.owner_id,
  case p.status when 'new' then 'initial_followup' when 'quoted' then 'quote_followup' when 'booked' then 'production_prep' else 'production_delivery' end
from public.bk_projects p where p.status in ('new','quoted','booked','in_production')
on conflict(project_id,automation_key) do nothing;
commit;
