-- Optional authenticated incoming email. No account/DNS changes, outbound messages,
-- or attachment downloads. Mailer opt-in is controlled by CRM_INBOUND_DOMAIN.
begin;
create table public.bk_email_routes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.bk_projects(id),
  domain text not null check (length(domain)<=253 and domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$'),
  route_token uuid not null unique default gen_random_uuid(),
  active boolean not null default true,created_at timestamptz not null default now(),
  unique(project_id,domain)
);
create table public.bk_email_receipts (
  event_id text primary key check(length(event_id) between 1 and 200),
  email_id uuid not null unique,
  project_id uuid not null references public.bk_projects(id),
  message_id text check(message_id is null or length(message_id)<=1000),
  crm_message_id uuid references public.bk_messages(id),
  status text not null default 'received' check(status in ('received','review','ignored')),
  reason text,reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index bk_email_receipts_message_unique on public.bk_email_receipts(project_id,message_id) where message_id is not null;
alter table public.bk_email_routes enable row level security;
alter table public.bk_email_receipts enable row level security;
revoke all on public.bk_email_routes,public.bk_email_receipts from public,anon,authenticated;
grant all on public.bk_email_routes,public.bk_email_receipts to service_role;

create function public.bk_crm_email_reply_route(p_project uuid,p_domain text) returns text
language plpgsql security definer set search_path='' as $$
declare route public.bk_email_routes; d text:=lower(trim(p_domain));
begin
  if d is null or length(d)>253 or d !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$' or d like '%..%' then raise exception 'invalid_inbound_domain'; end if;
  if not exists(select 1 from public.bk_projects where id=p_project and client_email is not null) then raise exception 'recipient_required'; end if;
  insert into public.bk_email_routes(project_id,domain) values(p_project,d)
  on conflict(project_id,domain) do update set domain=excluded.domain returning * into route;
  if not route.active then raise exception 'email_route_disabled'; end if;
  return 'reply+'||route.route_token::text||'@'||route.domain;
end $$;
revoke all on function public.bk_crm_email_reply_route(uuid,text) from public,anon,authenticated;
grant execute on function public.bk_crm_email_reply_route(uuid,text) to service_role;

create function public.bk_crm_ingest_email(p_event_id text,p_email_id uuid,p_route_token uuid,p_domain text,p_from text,p_body text,p_message_id text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.bk_projects; message uuid; message_key text:=nullif(trim(p_message_id),'');
begin
  if p_event_id is null or length(p_event_id) not between 1 and 200 or p_email_id is null or p_route_token is null
    or p_body is null or length(trim(p_body)) not between 1 and 4000 or length(coalesce(message_key,''))>1000 then raise exception 'invalid_inbound_message'; end if;
  select p0.* into p from public.bk_email_routes r join public.bk_projects p0 on p0.id=r.project_id
    where r.route_token=p_route_token and r.domain=lower(trim(p_domain)) and r.active
      and lower(trim(p0.client_email))=lower(trim(p_from));
  if not found then return jsonb_build_object('ok',true,'status','ignored'); end if;
  -- Serialize duplicate provider deliveries and message-id redeliveries.
  perform pg_advisory_xact_lock(hashtextextended('bk-inbound:'||p.id::text,0));
  if exists(select 1 from public.bk_email_receipts where event_id=p_event_id or email_id=p_email_id or (project_id=p.id and message_id=message_key)) then
    return jsonb_build_object('ok',true,'status','duplicate');
  end if;
  insert into public.bk_messages(project_id,sender,body) values(p.id,'client',trim(p_body)) returning id into message;
  insert into public.bk_email_receipts(event_id,email_id,project_id,message_id,crm_message_id) values(p_event_id,p_email_id,p.id,message_key,message);
  return jsonb_build_object('ok',true,'status','received');
end $$;
revoke all on function public.bk_crm_ingest_email(text,uuid,uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.bk_crm_ingest_email(text,uuid,uuid,text,text,text,text) to service_role;

-- Hold unsupported/unauthenticated replies for human review without trusting
-- their body or sender. Receipt metadata contains no route/portal capability.
create function public.bk_crm_note_email(p_event_id text,p_email_id uuid,p_route_token uuid,p_domain text,p_reason text,p_review boolean default true) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.bk_projects;
begin
  if p_event_id is null or length(p_event_id) not between 1 and 200 or p_email_id is null or p_reason not in ('sender_authentication_failed','sender_mismatch','invalid_sender','empty_message','automatic_message') then raise exception 'invalid_inbound_review'; end if;
  select p0.* into p from public.bk_email_routes r join public.bk_projects p0 on p0.id=r.project_id where r.route_token=p_route_token and r.domain=lower(trim(p_domain)) and r.active;
  if not found then return jsonb_build_object('ok',true); end if;
  perform pg_advisory_xact_lock(hashtextextended('bk-inbound:'||p.id::text,0));
  if exists(select 1 from public.bk_email_receipts where event_id=p_event_id or email_id=p_email_id) then return jsonb_build_object('ok',true); end if;
  insert into public.bk_email_receipts(event_id,email_id,project_id,status,reason)
  values(p_event_id,p_email_id,p.id,case when p_review then 'review' else 'ignored' end,p_reason);
  if p_review then
    insert into public.bk_tasks(project_id,contact_id,title,kind,due_at,owner_id,automation_key,notes)
    values(p.id,p.contact_id,'Review an email held by inbound verification','followup',now(),p.owner_id,'email_review_'||p_email_id::text,
      'Review the original email in the Resend Receiving inbox. Reason: '||p_reason||'. Provider email ID: '||p_email_id::text||'. No message body or attachments were imported.')
    on conflict(project_id,automation_key) do nothing;
    insert into public.bk_activities(project_id,contact_id,kind,summary) values(p.id,p.contact_id,'email_review','Incoming email needs review: '||p_reason);
  end if;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.bk_crm_note_email(text,uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.bk_crm_note_email(text,uuid,uuid,text,text,boolean) to service_role;

create function public.bk_crm_email_review(p_offset int default 0,p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform bk_crm_private.require_staff();
  with held as(select e.email_id,e.project_id,p.title project_title,p.client_name,e.reason,e.created_at from public.bk_email_receipts e join public.bk_projects p on p.id=e.project_id where e.status='review' and e.reviewed_at is null)
  select jsonb_build_object('total',(select count(*) from held),'rows',coalesce((select jsonb_agg(to_jsonb(r)) from(select * from held order by created_at,email_id limit least(greatest(p_limit,1),100) offset greatest(p_offset,0))r),'[]'::jsonb)) into result;
  return result;
end $$;
revoke all on function public.bk_crm_email_review(int,int) from public,anon,authenticated;
grant execute on function public.bk_crm_email_review(int,int) to authenticated;

create function bk_crm_private.email_review_complete() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='done' and new.automation_key like 'email_review_%' then
    update public.bk_email_receipts set reviewed_at=now() where project_id=new.project_id and email_id::text=substr(new.automation_key,14) and status='review';
  end if;
  return new;
end $$;
revoke all on function bk_crm_private.email_review_complete() from public,anon,authenticated;
create trigger bk_crm_email_review_complete after update of status on public.bk_tasks for each row execute function bk_crm_private.email_review_complete();

-- Every real client reply, whether submitted in the portal or verified email,
-- returns to attention even if the previous reply task was already completed.
create function bk_crm_private.client_reply_task() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.bk_projects;
begin
  if new.sender<>'client' then return new; end if;
  select * into p from public.bk_projects where id=new.project_id;
  if not found then return new; end if;
  update public.bk_projects set inbox_handled_at=null where id=p.id;
  insert into public.bk_tasks(project_id,contact_id,title,kind,due_at,owner_id,automation_key)
  values(p.id,p.contact_id,'Reply to client message','followup',bk_crm_private.next_business_day(now()),p.owner_id,'client_reply')
  on conflict(project_id,automation_key) do update set status='open',due_at=excluded.due_at,owner_id=excluded.owner_id;
  insert into public.bk_activities(project_id,contact_id,kind,summary) values(p.id,p.contact_id,'client_message','Client reply received');
  return new;
end $$;
revoke all on function bk_crm_private.client_reply_task() from public,anon,authenticated;
create trigger bk_crm_client_reply after insert on public.bk_messages for each row execute function bk_crm_private.client_reply_task();
commit;
