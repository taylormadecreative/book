-- Staff follow-up cadence and acquisition attribution. No outbound messages.
begin;
create table public.bk_followup_plans (
  project_id uuid primary key references public.bk_projects(id),
  enabled boolean not null default false,
  lead_days integer[] not null default array[1,3,7],
  quote_days integer[] not null default array[3,7,14],
  phase text not null default 'lead' check(phase in ('lead','quote')),
  state text not null default 'paused' check(state in ('active','paused','client_replied','complete','stopped')),
  cycle_id uuid not null default gen_random_uuid(),
  anchor_at timestamptz not null default now(),
  step integer not null default 0 check(step>=0 and step<=8),
  current_task_id uuid references public.bk_tasks(id),
  quote_id uuid references public.bk_quotes(id),
  last_action_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.bk_lead_attribution (
  project_id uuid primary key references public.bk_projects(id),
  source_raw text not null default '',
  source_normalized text not null,
  declared_source text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  referrer_host text,
  landing_path text,
  capture_method text not null check(capture_method in ('legacy','declared','website','staff')),
  first_captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bk_lead_attribution_source on public.bk_lead_attribution(source_normalized,utm_campaign);
alter table public.bk_followup_plans enable row level security;
alter table public.bk_lead_attribution enable row level security;
revoke all on public.bk_followup_plans,public.bk_lead_attribution from public,anon,authenticated;
grant select on public.bk_followup_plans,public.bk_lead_attribution to authenticated;
create policy bk_followup_read_staff on public.bk_followup_plans
  for select to authenticated using((select public.bk_is_staff()));
create policy bk_attribution_read_staff on public.bk_lead_attribution
  for select to authenticated using((select public.bk_is_staff()));

create table bk_crm_private.growth_requests(
  user_id uuid not null,
  request_id uuid not null,
  scope text not null,
  fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,request_id)
);
create table bk_crm_private.website_attribution_receipts(
  submission_id uuid primary key,
  project_id uuid not null references public.bk_projects(id),
  created_at timestamptz not null default now()
);
alter table bk_crm_private.growth_requests enable row level security;
alter table bk_crm_private.website_attribution_receipts enable row level security;
revoke all on bk_crm_private.growth_requests,bk_crm_private.website_attribution_receipts from public,anon,authenticated;

create function bk_crm_private.growth_request(p_request uuid,p_scope text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  r bk_crm_private.growth_requests;
begin
  perform bk_crm_private.require_staff();
  if p_request is null then
    raise exception 'request_id_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bk-growth-request:'||auth.uid()::text||p_request::text,0));
  select * into r from bk_crm_private.growth_requests where user_id=auth.uid() and request_id=p_request;
  if found then
    if r.scope<>p_scope or r.fingerprint<>md5(p_data::text) then
      raise exception 'request_changed';
    end if;
    return r.result;
  end if;
  return null;
end $$;

create function bk_crm_private.growth_remember(
  p_request uuid,
  p_scope text,
  p_data jsonb,
  p_result jsonb
) returns void
language sql security definer set search_path='' as $$
  insert into bk_crm_private.growth_requests(user_id,request_id,scope,fingerprint,result)
  values(auth.uid(),p_request,p_scope,md5(p_data::text),p_result)
$$;

create function bk_crm_private.growth_source(p_value text) returns text
language sql immutable set search_path='' as $$
  select case
  when trim(coalesce(p_value,''))='' then 'Unknown'
  when lower(p_value) ~ 'instagram|(^|[^a-z])ig([^a-z]|$)' then 'Instagram'
  when lower(p_value) ~ 'facebook|(^|[^a-z])fb([^a-z]|$)|(^|[.])meta[.]' then 'Facebook'
  when lower(p_value) ~ 'tiktok|tik[ -]?tok' then 'TikTok'
  when lower(p_value) ~ 'linkedin' then 'LinkedIn'
  when lower(p_value) ~ 'youtube|youtu[.]be' then 'YouTube'
  when lower(p_value) ~ 'google|bing|search|duckduckgo' then 'Search'
  when lower(p_value) ~ 'referr|friend|word.of.mouth|recommend' then 'Referral'
  when lower(p_value) ~ 'email|newsletter' then 'Email'
  when lower(p_value) ~ 'phone|call|text|sms' then 'Phone / text'
  when lower(p_value) ~ 'website|direct|web|taylormadecreative' then 'Website / direct'
  else 'Other' end
$$;

create function bk_crm_private.growth_clean_attribution(p_data jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare
  result jsonb:='{}';
  k text;
  v text;
  maxlen int;
begin
  if p_data is null then
    return result;
  end if;
  if jsonb_typeof(p_data)<>'object' then
    raise exception 'invalid_attribution';
  end if;
  for k in select jsonb_object_keys(p_data) loop
    if k not in ('source','utm_source','utm_medium','utm_campaign','utm_content','utm_term','referrer_host','landing_path') then
      raise exception 'unsupported_attribution_field';
    end if;
    if jsonb_typeof(p_data->k) not in ('string','null') then
      raise exception 'invalid_attribution';
    end if;
    maxlen:=case when k='source' then 240 when k='referrer_host' then 253 when k='landing_path' then 500 else 180 end;
    v:=nullif(left(trim(regexp_replace(p_data->>k,'[[:cntrl:]]','','g')),maxlen),'');
    if k='referrer_host' and v is not null then
      v:=lower(v);
      if v !~ '^[a-z0-9.-]+$' or v like '%..%' or v like '.%' or v like '%.' then
        raise exception 'invalid_referrer_host';
      end if;
    elsif k='landing_path' and v is not null then
      v:=split_part(split_part(v,'?',1),'#',1);
      if v not like '/%' or v like '//%' then
        raise exception 'invalid_landing_path';
      end if;
    end if;
    result:=result||jsonb_build_object(k,v);
  end loop;
  return result;
end $$;

create function bk_crm_private.growth_record_attribution(
  p_project uuid,
  p_data jsonb,
  p_method text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  a jsonb:=bk_crm_private.growth_clean_attribution(p_data);
  p public.bk_projects;
  r public.bk_lead_attribution;
  raw text;
begin
  select * into p from public.bk_projects where id=p_project;
  if not found then
    raise exception 'project_not_found';
  end if;
  if p_method='staff' then
    raw:=coalesce(a->>'source',a->>'utm_source',p.referral_source,'');
  else
    raw:=coalesce(a->>'utm_source',
    case when bk_crm_private.growth_source(a->>'referrer_host') not in ('Other','Unknown') then a->>'referrer_host' end,
    a->>'source',p.referral_source,'');
  end if;
  insert into public.bk_lead_attribution(
    project_id,source_raw,source_normalized,declared_source,
    utm_source,utm_medium,utm_campaign,utm_content,utm_term,
    referrer_host,landing_path,capture_method
  )
  values(p.id,left(raw,240),bk_crm_private.growth_source(raw),p.referral_source,
  a->>'utm_source',a->>'utm_medium',a->>'utm_campaign',a->>'utm_content',a->>'utm_term',a->>'referrer_host',a->>'landing_path',p_method)
  on conflict(project_id) do update set source_raw=excluded.source_raw,source_normalized=excluded.source_normalized,
  declared_source=excluded.declared_source,utm_source=excluded.utm_source,utm_medium=excluded.utm_medium,
  utm_campaign=excluded.utm_campaign,utm_content=excluded.utm_content,utm_term=excluded.utm_term,
  referrer_host=excluded.referrer_host,landing_path=excluded.landing_path,capture_method=excluded.capture_method,updated_at=now()
  returning * into r;
  return to_jsonb(r);
end $$;
insert into public.bk_lead_attribution(project_id,source_raw,source_normalized,declared_source,capture_method,first_captured_at)
select id,coalesce(referral_source,''),bk_crm_private.growth_source(referral_source),referral_source,'legacy',created_at from public.bk_projects;
insert into public.bk_followup_plans(project_id,phase,state,anchor_at)
select id,case when status='quoted' then 'quote' else 'lead' end,'paused',created_at from public.bk_projects;

create function public.bk_crm_set_attribution(
  p_project uuid,
  p_attribution jsonb,
  p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  payload jsonb:=jsonb_build_object('project',p_project,'attribution',p_attribution);
  r jsonb;
begin
  r:=bk_crm_private.growth_request(p_request_id,'attribution',payload);
  if r is not null then
    return r;
  end if;
  r:=bk_crm_private.growth_record_attribution(p_project,p_attribution,'staff');
  insert into public.bk_activities(project_id,contact_id,actor_id,kind,summary)
  select id,contact_id,auth.uid(),'attribution_updated','Lead attribution reviewed by staff' from public.bk_projects where id=p_project;
  perform bk_crm_private.growth_remember(p_request_id,'attribution',payload,r);
  return r;
end $$;

create function bk_crm_private.growth_website_attribution(
  p_submission uuid,
  p_project uuid,
  p_attribution jsonb
) returns void
language plpgsql security definer set search_path='' as $$
declare
  existing_method text;
begin
  -- The caller just resolved this exact intake capability. Public clients never
  -- receive an attach-to-existing-project RPC and cannot overwrite a first touch.
  if exists(select 1 from bk_crm_private.website_attribution_receipts where submission_id=p_submission) then
    return;
  end if;
  -- Serialize against a staff attribution review before testing first-touch
  -- eligibility, so a concurrent public retry cannot replace a reviewed source.
  select capture_method into existing_method
  from public.bk_lead_attribution
  where project_id=p_project
  for update;
  if existing_method='declared' then
    perform bk_crm_private.growth_record_attribution(p_project,p_attribution,'website');
  end if;
  insert into bk_crm_private.website_attribution_receipts(submission_id,project_id) values(p_submission,p_project);
end $$;

create function public.bk_submit_inquiry_attributed(
  p_submission_id uuid,
  p_name text,
  p_email text,
  p_service text,
  p_phone text default null,
  p_company text default null,
  p_event_date date default null,
  p_location text default null,
  p_budget text default null,
  p_details text default null,
  p_source text default null,
  p_event_time text default null,
  p_attribution jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  r jsonb;
begin
  perform bk_crm_private.growth_clean_attribution(p_attribution);
  r:=public.bk_submit_inquiry_once(p_submission_id,p_name,p_email,p_service,p_phone,p_company,p_event_date,p_location,p_budget,p_details,p_source,p_event_time);
  perform bk_crm_private.growth_website_attribution(p_submission_id,(r->>'id')::uuid,p_attribution);
  return r;
end $$;

create function public.bk_book_digitals_attributed(
  p_submission_id uuid,
  p_name text,
  p_email text,
  p_phone text default null,
  p_event_date date default null,
  p_location text default null,
  p_notes text default null,
  p_attribution jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  r jsonb;
begin
  perform bk_crm_private.growth_clean_attribution(p_attribution);
  r:=public.bk_book_digitals_once(p_submission_id,p_name,p_email,p_phone,p_event_date,p_location,p_notes);
  perform bk_crm_private.growth_website_attribution(p_submission_id,(r->>'id')::uuid,p_attribution);
  return r;
end $$;

create function bk_crm_private.growth_due(p_anchor timestamptz,p_days int) returns timestamptz
language plpgsql immutable set search_path='' as $$
declare
  d date:=(p_anchor at time zone 'America/Chicago')::date;
  n int:=0;
begin
  while n<p_days loop
    d:=d+1;
    if extract(isodow from d)<6 then
      n:=n+1;
    end if;
  end loop;
  while extract(isodow from d)>5 loop
    d:=d+1;
  end loop;
  return (d+time '09:00') at time zone 'America/Chicago';
end $$;

create function bk_crm_private.growth_ensure_task(p_project uuid) returns void
language plpgsql security definer set search_path='' as $$
declare
  f public.bk_followup_plans;
  p public.bk_projects;
  days int[];
  due timestamptz;
  k text;
  t uuid;
begin
  select * into f from public.bk_followup_plans where project_id=p_project for update;
  if not found then
    return;
  end if;
  select * into p from public.bk_projects where id=p_project;
  if not found or not f.enabled or f.state<>'active' or p.status not in ('new','quoted') then
    return;
  end if;
  -- Preserve a staff-selected due date or snooze on the current real task.
  if exists(select 1 from public.bk_tasks where id=f.current_task_id and status='open') then
    return;
  end if;
  days:=case when f.phase='lead' then f.lead_days else f.quote_days end;
  if f.step>=array_length(days,1) then
    update public.bk_followup_plans set state='complete',current_task_id=null,updated_at=now() where project_id=p.id;
    return;
  end if;
  due:=bk_crm_private.growth_due(f.anchor_at,days[f.step+1]);
  -- A rescheduled first touch or a snooze shifts later touches forward while
  -- preserving the configured business-day gap between adjacent steps.
  if f.step>0 and f.last_action_at is not null then
    due:=greatest(
      due,
      bk_crm_private.growth_due(f.last_action_at,days[f.step+1]-days[f.step])
    );
  end if;
  if due<now() then
    due:=case when f.step=0 then now() else bk_crm_private.growth_due(now(),1) end;
  end if;
  k:=case when f.step=0 then case when f.phase='lead' then 'initial_followup' else 'quote_followup' end
  else 'cadence:'||f.cycle_id::text||':'||f.step::text end;
  insert into public.bk_tasks(project_id,contact_id,title,kind,due_at,owner_id,automation_key,notes)
  values(p.id,p.contact_id,case when f.phase='lead' and f.step=0 then 'Reply to new inquiry'
  when f.phase='quote' and f.step=0 then 'Follow up on proposal'
  else 'Follow up on '||case when f.phase='lead' then 'inquiry' else 'proposal' end||' ('||(f.step+1)||'/'||array_length(days,1)||')' end,
  'followup',due,p.owner_id,k,'Review the conversation and follow up with this client.')
  on conflict(project_id,automation_key) do update set status='open',due_at=excluded.due_at,owner_id=excluded.owner_id
  returning id into t;
  update public.bk_followup_plans set current_task_id=t,updated_at=now() where project_id=p.id;
end $$;

create function bk_crm_private.growth_stop(p_project uuid,p_state text) returns void
language plpgsql security definer set search_path='' as $$
declare
  f public.bk_followup_plans;
begin
  select * into f from public.bk_followup_plans where project_id=p_project for update;
  if not found then
    return;
  end if;
  update public.bk_followup_plans set state=p_state,current_task_id=null,updated_at=now() where project_id=p_project;
  update public.bk_tasks set status='cancelled' where id=f.current_task_id and status='open';
end $$;

create function bk_crm_private.growth_restart(
  p_project uuid,
  p_anchor timestamptz,
  p_quote uuid default null
) returns void
language plpgsql security definer set search_path='' as $$
declare
  p public.bk_projects;
  f public.bk_followup_plans;
begin
  select * into p from public.bk_projects where id=p_project;
  select * into f from public.bk_followup_plans where project_id=p_project for update;
  if not found or not f.enabled then
    return;
  end if;
  perform bk_crm_private.growth_stop(p_project,'paused');
  update public.bk_followup_plans set phase=case when p.status='quoted' then 'quote' else 'lead' end,
  state=case when p.status in ('new','quoted') then 'active' else 'stopped' end,
  cycle_id=gen_random_uuid(),anchor_at=p_anchor,step=0,quote_id=p_quote,
  last_action_at=null,updated_at=now() where project_id=p_project;
  perform bk_crm_private.growth_ensure_task(p_project);
end $$;

create function bk_crm_private.growth_project() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    perform bk_crm_private.growth_record_attribution(new.id,'{}','declared');
    insert into public.bk_followup_plans(project_id,enabled,phase,state,anchor_at)
    values(new.id,new.status in ('new','quoted'),case when new.status='quoted' then 'quote' else 'lead' end,
    case when new.status in ('new','quoted') then 'active' else 'stopped' end,new.created_at);
    perform bk_crm_private.growth_ensure_task(new.id);
  else
    if new.referral_source is distinct from old.referral_source then
      -- A correction to a manually declared source should reach reports.
      -- Website first-touch and an explicit attribution review remain intact.
      update public.bk_lead_attribution
      set source_raw=coalesce(new.referral_source,''),
          source_normalized=bk_crm_private.growth_source(new.referral_source),
          declared_source=new.referral_source,
          updated_at=now()
      where project_id=new.id and capture_method in ('legacy','declared');
    end if;
    if new.status is distinct from old.status then
      if new.status in ('new','quoted') then
        perform bk_crm_private.growth_restart(new.id,now());
      else
        perform bk_crm_private.growth_stop(new.id,'stopped');
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger bk_growth_followup_project after insert or update of status,referral_source on public.bk_projects
for each row execute function bk_crm_private.growth_project();

create function bk_crm_private.growth_task_done() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  f public.bk_followup_plans;
  p public.bk_projects;
begin
  if new.status<>'done' or old.status='done' or new.project_id is null then
    return new;
  end if;
  select * into f from public.bk_followup_plans where project_id=new.project_id for update;
  if not found then
    return new;
  end if;
  select * into p from public.bk_projects where id=new.project_id;
  if not f.enabled or p.status not in ('new','quoted') then
    return new;
  end if;
  if f.state='client_replied' and new.automation_key='client_reply' then
    perform bk_crm_private.growth_restart(p.id,coalesce(new.completed_at,now()));
    return new;
  end if;
  if f.state<>'active' or f.current_task_id is distinct from new.id
    or (f.phase='lead' and p.status<>'new') or (f.phase='quote' and p.status<>'quoted') then
    return new;
  end if;
  update public.bk_followup_plans
  set current_task_id=null,
      step=step+1,
      last_action_at=greatest(coalesce(new.completed_at,now()),new.due_at),
      updated_at=now()
  where project_id=p.id;
  perform bk_crm_private.growth_ensure_task(p.id);
  return new;
end $$;

create trigger bk_growth_followup_task after update of status on public.bk_tasks
for each row execute function bk_crm_private.growth_task_done();

create function bk_crm_private.growth_message() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  f public.bk_followup_plans;
  t public.bk_tasks;
  p public.bk_projects;
begin
  select * into f from public.bk_followup_plans where project_id=new.project_id for update;
  if not found or not f.enabled then
    return new;
  end if;
  if new.sender='client' then
    perform bk_crm_private.growth_stop(new.project_id,'client_replied');
    return new;
  end if;
  if new.sender<>'studio' then
    return new;
  end if;
  select * into p from public.bk_projects where id=new.project_id;
  if p.status not in ('new','quoted') then
    return new;
  end if;
  if exists(select 1 from public.bk_messages where project_id=p.id and sender='client' and created_at>new.created_at) then
    return new;
  end if;
  if f.state='client_replied' then
    update public.bk_tasks set status='done' where project_id=p.id and automation_key='client_reply' and status='open';
    if not found then
      perform bk_crm_private.growth_restart(p.id,new.created_at);
    end if;
  elsif f.state='active' then
    select * into t from public.bk_tasks where id=f.current_task_id;
    if t.status='open' and (f.step=0 or t.due_at<=new.created_at) then
      update public.bk_tasks set status='done' where id=t.id and status='open';
    end if;
  end if;
  return new;
end $$;

create trigger bk_growth_followup_message after insert on public.bk_messages
for each row execute function bk_crm_private.growth_message();

create function bk_crm_private.growth_quote() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  p public.bk_projects;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  select * into p from public.bk_projects where id=new.project_id;
  if new.status in ('accepted','declined') then
    perform bk_crm_private.growth_stop(p.id,'client_replied');
  elsif new.status='sent' and p.status='quoted' then
    perform bk_crm_private.growth_restart(p.id,coalesce(new.sent_at,now()),new.id);
  elsif new.status='void' then
    if exists(select 1 from public.bk_followup_plans where project_id=p.id and quote_id=new.id) then
      perform bk_crm_private.growth_stop(p.id,'paused');
    end if;
  end if;
  return new;
end $$;

create trigger bk_growth_followup_quote after update of status on public.bk_quotes
for each row execute function bk_crm_private.growth_quote();

create function bk_crm_private.growth_client_activity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.project_id is not null
    and new.kind in ('prep_answers_saved','prep_submitted','video_note_added',
    'video_note_updated','video_approved','video_changes')
    and exists(select 1 from public.bk_projects where id=new.project_id and status in ('new','quoted')) then
    perform bk_crm_private.growth_stop(new.project_id,'client_replied');
  end if;
  return new;
end $$;

create trigger bk_growth_client_activity after insert on public.bk_activities
for each row execute function bk_crm_private.growth_client_activity();

create function public.bk_crm_followup_settings(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  r jsonb;
begin
  perform bk_crm_private.require_staff();
  select to_jsonb(f)||jsonb_build_object('next_due_at',t.due_at,'cadence_total',array_length(case when f.phase='lead' then f.lead_days else f.quote_days end,1))
  into r from public.bk_followup_plans f left join public.bk_tasks t on t.id=f.current_task_id where f.project_id=p_project;
  if r is null then
    raise exception 'project_not_found';
  end if;
  return r;
end $$;

create function public.bk_crm_set_followup(p_project uuid,p_settings jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  payload jsonb:=jsonb_build_object('project',p_project,'settings',p_settings);
  r jsonb;
  f public.bk_followup_plans;
  k text;
  days int[];
  n int;
begin
  r:=bk_crm_private.growth_request(p_request_id,'followup',payload);
  if r is not null then
    return r;
  end if;
  if jsonb_typeof(p_settings) is distinct from 'object' then
    raise exception 'invalid_followup_settings';
  end if;
  if exists(select 1 from jsonb_object_keys(p_settings) x where x not in ('enabled','lead_days','quote_days','restart')) then
    raise exception 'invalid_followup_settings';
  end if;
  select * into f from public.bk_followup_plans where project_id=p_project for update;
  if not found then
    raise exception 'project_not_found';
  end if;
  foreach k in array array['lead_days','quote_days'] loop
    if p_settings?k then
      if jsonb_typeof(p_settings->k)<>'array' then
        raise exception 'invalid_cadence_days';
      end if;
      select array_agg(value::int order by ordinality) into days from jsonb_array_elements_text(p_settings->k) with ordinality;
      if coalesce(array_length(days,1),0) not between 1 and 8 or exists(select 1 from unnest(days) v where v<1 or v>60)
        or cardinality(days)<>(select count(distinct v) from unnest(days)v)
        or days is distinct from (select array_agg(v order by v) from unnest(days)v) then
        raise exception 'cadence_days_must_increase_1_60';
      end if;
      if k='lead_days' then
        f.lead_days:=days;
      else
        f.quote_days:=days;
      end if;
    end if;
  end loop;
  f.enabled:=coalesce((p_settings->>'enabled')::boolean,f.enabled);
  update public.bk_followup_plans set enabled=f.enabled,lead_days=f.lead_days,quote_days=f.quote_days,updated_at=now() where project_id=p_project;
  if not f.enabled then
    perform bk_crm_private.growth_stop(p_project,'paused');
  elsif not exists(select 1 from public.bk_projects where id=p_project and status in ('new','quoted')) then
    perform bk_crm_private.growth_stop(p_project,'stopped');
  elsif exists(select 1 from public.bk_messages where project_id=p_project and sender='client') and
      (select max(created_at) from public.bk_messages where project_id=p_project and sender='client')>
      coalesce((select max(created_at) from public.bk_messages where project_id=p_project and sender='studio'),'-infinity'::timestamptz) then
    perform bk_crm_private.growth_stop(p_project,'client_replied');
  elsif not f.enabled or f.state<>'active' or coalesce((p_settings->>'restart')::boolean,false) then
    perform bk_crm_private.growth_restart(p_project,now());
  else
    perform bk_crm_private.growth_ensure_task(p_project);
  end if;
  insert into public.bk_activities(project_id,contact_id,actor_id,kind,summary)
  select id,contact_id,auth.uid(),'followup_settings','Staff follow-up cadence updated' from public.bk_projects where id=p_project;
  r:=public.bk_crm_followup_settings(p_project);
  perform bk_crm_private.growth_remember(p_request_id,'followup',payload,r);
  return r;
end $$;

create function public.bk_crm_followup_action(
  p_task uuid,
  p_action text,
  p_request_id uuid,
  p_due_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  payload jsonb:=jsonb_build_object('task',p_task,'action',p_action,'due_at',p_due_at);
  r jsonb;
  t public.bk_tasks;
begin
  r:=bk_crm_private.growth_request(p_request_id,'followup_action',payload);
  if r is not null then
    return r;
  end if;
  select * into t from public.bk_tasks where id=p_task for update;
  if not found or t.kind<>'followup' then
    raise exception 'followup_task_not_found';
  end if;
  if p_action='done' then
    if t.status='cancelled' then
      raise exception 'task_no_longer_open';
    end if;
    if t.status='open' then
      update public.bk_tasks set status='done' where id=t.id returning * into t;
    end if;
  elsif p_action='snooze' then
    p_due_at:=coalesce(p_due_at,bk_crm_private.growth_due(now(),1));
    if t.status<>'open' or p_due_at is null or p_due_at<=now() or p_due_at>now()+interval '90 days' then
      raise exception 'invalid_snooze';
    end if;
    update public.bk_tasks set due_at=p_due_at where id=t.id returning * into t;
  else
    raise exception 'invalid_followup_action';
  end if;
  r:=to_jsonb(t);
  perform bk_crm_private.growth_remember(p_request_id,'followup_action',payload,r);
  return r;
end $$;

create function public.bk_crm_morning(
  p_day date default null,
  p_owner uuid default null,
  p_offset int default 0,
  p_limit int default 50
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  d date:=coalesce(p_day,(now() at time zone 'America/Chicago')::date);
  result jsonb;
begin
  perform bk_crm_private.require_staff();
  with tasks as(
    select
      t.id,t.project_id,t.title,t.due_at,t.owner_id,
      p.client_name,p.title project_title,p.status stage,
      p.client_email email,p.client_phone phone,
      coalesce(a.source_normalized,'Unknown') source,
      '/inbox/?p='||p.id::text conversation_url,
      '/inbox/?p='||p.id::text||'&template=call' template_url,
      case when f.current_task_id=t.id then f.step+1 end cadence_step,
      case when f.current_task_id=t.id then
        array_length(case when f.phase='lead' then f.lead_days else f.quote_days end,1)
      end cadence_total
    from public.bk_tasks t
    join public.bk_projects p on p.id=t.project_id
    left join public.bk_followup_plans f on f.project_id=p.id
    left join public.bk_lead_attribution a on a.project_id=p.id
    where t.status='open'
      and t.kind='followup'
      and p.status not in ('lost','archived')
      and (p_owner is null or t.owner_id=p_owner)
      and t.due_at<(d+1)::timestamp at time zone 'America/Chicago'
  )
  select jsonb_build_object(
    'day',d,
    'timezone','America/Chicago',
    'total',(select count(*) from tasks),
    'counts',jsonb_build_object(
      'overdue',(select count(*) from tasks where due_at<d::timestamp at time zone 'America/Chicago'),
      'today',(select count(*) from tasks where due_at>=d::timestamp at time zone 'America/Chicago'),
      'unassigned',(select count(*) from tasks where owner_id is null)
    ),
    'rows',coalesce((
      select jsonb_agg(to_jsonb(x))
      from(
        select * from tasks
        order by due_at,id
        limit least(greatest(p_limit,1),100)
        offset greatest(p_offset,0)
      )x
    ),'[]'::jsonb)
  ) into result;
  return result;
end $$;

create function public.bk_crm_source_report(
  p_from date default null,
  p_to date default null,
  p_source text default null,
  p_campaign text default null
) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  first_day date:=coalesce(p_from,((now() at time zone 'America/Chicago')::date-interval '90 days')::date);
  last_day date:=coalesce(p_to,(now() at time zone 'America/Chicago')::date);
  r jsonb;
begin
  perform bk_crm_private.require_staff();
  if last_day<first_day or last_day-first_day>3660 then
    raise exception 'invalid_report_dates';
  end if;
  with cohort as(
    select
      p.id,
      coalesce(a.source_normalized,bk_crm_private.growth_source(p.referral_source)) source,
      coalesce(a.utm_campaign,'Unspecified') campaign,
      (
        p.status in ('booked','in_production','delivered')
        or exists(
          select 1 from public.bk_bookings b
          where b.project_id=p.id and b.status in ('confirmed','completed')
        )
      ) booked,
      coalesce((
        select sum(coalesce(i.paid_amount_cents,i.amount_cents))
        from public.bk_invoices i
        where i.project_id=p.id and i.status='paid'
      ),0) receipts_cents,
      (
        select extract(epoch from(min(m.created_at)-p.created_at))/3600
        from public.bk_messages m
        where m.project_id=p.id and m.sender='studio' and m.created_at>=p.created_at
      ) response_hours
    from public.bk_projects p
    left join public.bk_lead_attribution a on a.project_id=p.id
    where p.created_at>=first_day::timestamp at time zone 'America/Chicago'
      and p.created_at<(last_day+1)::timestamp at time zone 'America/Chicago'
      and (
        nullif(trim(p_source),'') is null
        or coalesce(a.source_normalized,bk_crm_private.growth_source(p.referral_source))=p_source
      )
      and (
        nullif(trim(p_campaign),'') is null
        or lower(coalesce(a.utm_campaign,''))=lower(trim(p_campaign))
      )
  ),sources as(
    select
      source,
      count(*) leads,
      count(*) filter(where booked) booked,
      sum(receipts_cents) receipts_cents,
      count(response_hours) responded,
      percentile_cont(0.5) within group(order by response_hours) median_response_hours,
      round(100.0*count(*) filter(where booked)/nullif(count(*),0),1) conversion_pct
    from cohort
    group by source
  ),campaigns as(
    select
      source,campaign,
      count(*) leads,
      count(*) filter(where booked) booked,
      sum(receipts_cents) receipts_cents,
      count(response_hours) responded,
      percentile_cont(0.5) within group(order by response_hours) median_response_hours,
      round(100.0*count(*) filter(where booked)/nullif(count(*),0),1) conversion_pct
    from cohort
    group by source,campaign
  )
  select jsonb_build_object(
    'from',first_day,
    'to',last_day,
    'as_of',now(),
    'basis','lead_created_date',
    'unit','project_opportunity',
    'totals',(
      select jsonb_build_object(
        'leads',count(*),
        'booked',count(*) filter(where booked),
        'receipts_cents',coalesce(sum(receipts_cents),0),
        'responded',count(response_hours),
        'median_response_hours',percentile_cont(0.5) within group(order by response_hours)
      ) from cohort
    ),
    'rows',coalesce((
      select jsonb_agg(to_jsonb(s) order by s.leads desc,s.source)
      from sources s
    ),'[]'::jsonb),
    'campaigns',coalesce((
      select jsonb_agg(to_jsonb(c))
      from(
        select * from campaigns
        order by leads desc,source,campaign
        limit 100
      )c
    ),'[]'::jsonb),
    'campaign_total',(select count(*) from campaigns)
  ) into r;
  return r;
end $$;

-- No internal helper or staff report is a public endpoint.
do $$
declare
  f record;
begin
  for f in select p.oid::regprocedure sig,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='bk_crm_private' and p.proname like 'growth_%') or
    (n.nspname='public' and p.proname in (
      'bk_crm_set_attribution','bk_submit_inquiry_attributed','bk_book_digitals_attributed',
      'bk_crm_followup_settings','bk_crm_set_followup','bk_crm_followup_action',
      'bk_crm_morning','bk_crm_source_report'
    )) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    if f.nspname='public' then
      execute format('grant execute on function %s to authenticated',f.sig);
      if f.proname in ('bk_submit_inquiry_attributed','bk_book_digitals_attributed') then
        execute format('grant execute on function %s to anon',f.sig);
      end if;
    end if;
  end loop;
end $$;
commit;

