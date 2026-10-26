-- 2026-10-26 · Studio: the content calendar (content.html).
-- One row per post: the day it goes out, the script he reads in Taylormade Camera, the shot list,
-- the caption for each platform, and where it stands (planned → filmed → edited → posted).
-- Admin only, like bk_projects. The posts themselves are written in through the API, never committed:
-- this repo is public and unreleased scripts don't belong in it.

create table if not exists public.bk_content_posts (
  id uuid primary key default gen_random_uuid(),
  post_date date not null,
  sort int not null default 0,
  lane text not null default 'other' check (lane in ('apps','photo','direction','other')),
  pillar text,
  format text not null default 'talking_head' check (format in ('talking_head','bts_reel','carousel','still')),
  title text not null check (char_length(title) between 1 and 160),
  hook text,
  script text,
  shots text,
  cover text,
  cta text,
  checks text[] not null default '{}',
  -- { instagram, tiktok, linkedin, threads }
  captions jsonb not null default '{}'::jsonb,
  -- the Apple Notes title the script was filed under, so he can find it on his phone
  notes_title text,
  status text not null default 'planned' check (status in ('planned','filmed','edited','posted')),
  notes text not null default '' check (char_length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bk_content_posts_date on public.bk_content_posts (post_date, sort);

drop trigger if exists bk_content_posts_touch on public.bk_content_posts;
create trigger bk_content_posts_touch before update on public.bk_content_posts
  for each row execute function public.bk_touch();

alter table public.bk_content_posts enable row level security;
drop policy if exists bk_content_posts_admin on public.bk_content_posts;
create policy bk_content_posts_admin on public.bk_content_posts for all
  using (public.bk_is_admin()) with check (public.bk_is_admin());
