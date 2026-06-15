-- GALLERIES: proofing (client selects), finals (edited photos), video deliverables.
-- Clients reach these ONLY through the bk-media edge function (service role).
-- Staff (admin/employee) manage directly via authenticated SDK + the RLS below.
-- Applied to Supabase project pgqdmnmessbbzyszjfvr 2026-06-15.

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role = any (array['client','admin','employee']));

create or replace function public.bk_is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role in ('admin','employee'));
$$;

create table public.bk_galleries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid not null references public.bk_projects(id) on delete cascade,
  kind text not null check (kind in ('proof','final','video')),
  title text not null default 'Gallery',
  selection_limit integer check (selection_limit is null or selection_limit >= 0),
  locked boolean not null default false
);
create index bk_galleries_project_idx on public.bk_galleries(project_id);

create table public.bk_gallery_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  gallery_id uuid not null references public.bk_galleries(id) on delete cascade,
  project_id uuid not null references public.bk_projects(id) on delete cascade,
  storage_path text not null,
  filename text, content_type text, size_bytes bigint,
  sort integer not null default 0,
  selected boolean not null default false,
  selected_at timestamptz
);
create index bk_gallery_items_gallery_idx on public.bk_gallery_items(gallery_id);
create index bk_gallery_items_project_idx on public.bk_gallery_items(project_id);

alter table public.bk_galleries enable row level security;
alter table public.bk_gallery_items enable row level security;
create policy bk_galleries_staff on public.bk_galleries for all using (public.bk_is_staff()) with check (public.bk_is_staff());
create policy bk_gallery_items_staff on public.bk_gallery_items for all using (public.bk_is_staff()) with check (public.bk_is_staff());

insert into storage.buckets (id, name, public) values ('project-media','project-media', false) on conflict (id) do nothing;
create policy "bk_media staff read" on storage.objects for select to authenticated using (bucket_id='project-media' and public.bk_is_staff());
create policy "bk_media staff insert" on storage.objects for insert to authenticated with check (bucket_id='project-media' and public.bk_is_staff());
create policy "bk_media staff update" on storage.objects for update to authenticated using (bucket_id='project-media' and public.bk_is_staff()) with check (bucket_id='project-media' and public.bk_is_staff());
create policy "bk_media staff delete" on storage.objects for delete to authenticated using (bucket_id='project-media' and public.bk_is_staff());
