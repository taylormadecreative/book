-- Synthetic pre-migration schema: matches relevant live schema metadata, no production rows.
create role anon; create role authenticated; create role service_role;
grant usage on schema public to anon,authenticated,service_role;
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on functions to anon,authenticated,service_role;
create schema auth; grant usage on schema auth to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create table public.profiles(id uuid primary key,role text not null,full_name text);
create function public.bk_is_staff() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from profiles where id=auth.uid() and role in ('admin','employee')) $$;
create function public.bk_is_admin() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from profiles where id=auth.uid() and role='admin') $$;
create function public.bk_touch() returns trigger language plpgsql as $$ begin new.updated_at:=now(); return new; end $$;
create table public.bk_projects (
 id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),access_token uuid not null default gen_random_uuid(),
 client_name text not null check(length(client_name) between 1 and 120),client_email text not null check(length(client_email) between 3 and 200),client_phone text check(client_phone is null or length(client_phone)<=40),company text check(company is null or length(company)<=160),
 service text not null check(service in ('music_video','brand_content','photography','event','digitals','other')),title text,event_date date,event_time text,location text check(location is null or length(location)<=240),budget_range text,details text check(details is null or length(details)<=4000),referral_source text,
 status text not null default 'new' check(status in ('new','quoted','booked','in_production','delivered','archived','lost')),notes_internal text,inbox_handled_at timestamptz
);
create trigger bk_projects_touch before update on public.bk_projects for each row execute function public.bk_touch();
alter table public.bk_projects enable row level security;
create policy bk_projects_admin on public.bk_projects for all using(bk_is_admin()) with check(bk_is_admin());
create table public.bk_invoices(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),project_id uuid references public.bk_projects(id),title text default 'Invoice',line_items jsonb default '[]',amount_cents int not null,kind text default 'deposit',status text default 'draft',due_date date,stripe_session_id text,paid_at timestamptz,payment_note text);
alter table public.bk_invoices enable row level security;
create policy bk_invoices_admin on public.bk_invoices for all using(bk_is_admin()) with check(bk_is_admin());
create table public.bk_messages(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),project_id uuid references public.bk_projects(id),sender text,body text,read_at timestamptz);
alter table public.bk_messages enable row level security;
create table public.bk_services(id uuid primary key default gen_random_uuid(),name text,slug text,kind text,price_cents int,deposit_cents int);
create table public.bk_bookings(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),project_id uuid references public.bk_projects(id),service_id uuid references public.bk_services(id),invoice_id uuid,starts_at timestamptz,duration_min int,status text default 'requested',expires_at timestamptz,location text,balance_cents int,balance_status text);
alter table public.bk_bookings enable row level security;
create table public.bk_email_queue(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now(),project_id uuid references public.bk_projects(id),booking_id uuid,kind text,send_at timestamptz default now(),sent_at timestamptz,attempts int default 0,last_error text,payload jsonb default '{}');
alter table public.bk_email_queue enable row level security;
create table public.bk_files(id uuid primary key default gen_random_uuid(),project_id uuid references public.bk_projects(id),label text,url text);
create table public.bk_galleries(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),project_id uuid references public.bk_projects(id),kind text,pay_url text);
create table public.bk_gallery_items(id uuid primary key default gen_random_uuid(),project_id uuid references public.bk_projects(id),gallery_id uuid references public.bk_galleries(id));
create table public.bk_contracts(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),project_id uuid references public.bk_projects(id),status text);
alter table public.bk_files enable row level security; alter table public.bk_galleries enable row level security; alter table public.bk_gallery_items enable row level security; alter table public.bk_contracts enable row level security;
