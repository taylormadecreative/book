-- BOOKING SYSTEM (bk_*) — Taylormade photo/video booking, HoneyBook replacement
-- Applied to Supabase project pgqdmnmessbbzyszjfvr as migration 20260612013219.
create extension if not exists pgcrypto;

create table public.bk_projects (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  access_token uuid not null default gen_random_uuid(),
  client_name text not null check (length(client_name) between 1 and 120),
  client_email text not null check (length(client_email) between 3 and 200),
  client_phone text check (client_phone is null or length(client_phone) <= 40),
  company text check (company is null or length(company) <= 160),
  service text not null check (service in ('music_video','brand_content','photography','event','other')),
  title text,
  event_date date,
  event_time text,
  location text check (location is null or length(location) <= 240),
  budget_range text,
  details text check (details is null or length(details) <= 4000),
  referral_source text,
  status text not null default 'new' check (status in ('new','quoted','booked','in_production','delivered','archived','lost')),
  notes_internal text
);
create index bk_projects_status_idx on public.bk_projects(status);
create index bk_projects_email_idx on public.bk_projects(client_email);

create table public.bk_invoices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid not null references public.bk_projects(id) on delete cascade,
  title text not null default 'Invoice',
  line_items jsonb not null default '[]'::jsonb,
  amount_cents integer not null check (amount_cents >= 0),
  kind text not null default 'deposit' check (kind in ('deposit','balance','full','custom')),
  status text not null default 'draft' check (status in ('draft','sent','paid','void')),
  due_date date,
  stripe_session_id text,
  paid_at timestamptz,
  payment_note text
);
create index bk_invoices_project_idx on public.bk_invoices(project_id);

create table public.bk_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid not null references public.bk_projects(id) on delete cascade,
  sender text not null check (sender in ('studio','client')),
  body text not null check (length(body) between 1 and 4000),
  read_at timestamptz
);
create index bk_messages_project_idx on public.bk_messages(project_id, created_at);

create table public.bk_files (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid not null references public.bk_projects(id) on delete cascade,
  label text not null,
  url text not null
);
create index bk_files_project_idx on public.bk_files(project_id);

-- updated_at touch
create or replace function public.bk_touch() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger bk_projects_touch before update on public.bk_projects
  for each row execute function public.bk_touch();

-- RLS
alter table public.bk_projects enable row level security;
alter table public.bk_invoices enable row level security;
alter table public.bk_messages enable row level security;
alter table public.bk_files enable row level security;

-- admin helper (reuses existing profiles table)
create or replace function public.bk_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create policy bk_projects_admin on public.bk_projects for all
  using (public.bk_is_admin()) with check (public.bk_is_admin());
create policy bk_invoices_admin on public.bk_invoices for all
  using (public.bk_is_admin()) with check (public.bk_is_admin());
create policy bk_messages_admin on public.bk_messages for all
  using (public.bk_is_admin()) with check (public.bk_is_admin());
create policy bk_files_admin on public.bk_files for all
  using (public.bk_is_admin()) with check (public.bk_is_admin());

-- Public inquiry submission (RPC only; no direct anon table access)
create or replace function public.bk_submit_inquiry(
  p_name text, p_email text, p_service text,
  p_phone text default null, p_company text default null,
  p_event_date date default null, p_location text default null,
  p_budget text default null, p_details text default null,
  p_source text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_token uuid;
begin
  if p_name is null or length(trim(p_name)) < 1 then raise exception 'name required'; end if;
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'valid email required'; end if;
  if p_service not in ('music_video','brand_content','photography','event','other') then raise exception 'invalid service'; end if;
  insert into public.bk_projects (client_name, client_email, client_phone, company, service, event_date, location, budget_range, details, referral_source, title)
  values (trim(p_name), lower(trim(p_email)), p_phone, p_company, p_service, p_event_date, p_location, p_budget, p_details, p_source,
          trim(p_name) || ' — ' || replace(initcap(replace(p_service,'_',' ')),'Of','of'))
  returning id, access_token into v_id, v_token;
  return jsonb_build_object('id', v_id, 'token', v_token);
end $$;

-- Client portal: read everything for one project via token
create or replace function public.bk_portal(p_project uuid, p_token uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not exists (select 1 from public.bk_projects where id = p_project and access_token = p_token) then
    raise exception 'not found';
  end if;
  -- mark studio messages as read (client has now seen them)
  update public.bk_messages set read_at = now()
    where project_id = p_project and sender = 'studio' and read_at is null;
  select jsonb_build_object(
    'project', (select jsonb_build_object(
        'id', id, 'title', title, 'client_name', client_name, 'service', service,
        'event_date', event_date, 'event_time', event_time, 'location', location,
        'status', status, 'created_at', created_at)
      from public.bk_projects where id = p_project),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'title', title, 'line_items', line_items, 'amount_cents', amount_cents,
        'kind', kind, 'status', status, 'due_date', due_date, 'paid_at', paid_at)
        order by created_at)
      from public.bk_invoices where project_id = p_project and status in ('sent','paid')), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'sender', sender, 'body', body, 'created_at', created_at) order by created_at)
      from public.bk_messages where project_id = p_project), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'label', label, 'url', url) order by created_at)
      from public.bk_files where project_id = p_project), '[]'::jsonb)
  ) into v;
  return v;
end $$;

-- Client portal: send a message via token
create or replace function public.bk_portal_send(p_project uuid, p_token uuid, p_body text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.bk_projects where id = p_project and access_token = p_token) then
    raise exception 'not found';
  end if;
  if p_body is null or length(trim(p_body)) < 1 or length(p_body) > 4000 then
    raise exception 'invalid message';
  end if;
  insert into public.bk_messages (project_id, sender, body)
  values (p_project, 'client', trim(p_body)) returning id into v_id;
  return v_id;
end $$;

grant execute on function public.bk_submit_inquiry(text,text,text,text,text,date,text,text,text,text) to anon;
grant execute on function public.bk_portal(uuid,uuid) to anon;
grant execute on function public.bk_portal_send(uuid,uuid,text) to anon;
