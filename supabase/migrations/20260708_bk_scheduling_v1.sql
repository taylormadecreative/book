-- BK SCHEDULING v1 — self-serve date/time booking + automated email queue.
-- Extends the live bk_* booking system on Supabase project pgqdmnmessbbzyszjfvr.
-- All slot math runs in the studio timezone (bk_config.timezone, America/Chicago).

-- ============ services ============
create table public.bk_services (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,60}$'),
  name text not null check (length(name) between 2 and 120),
  tagline text check (tagline is null or length(tagline) <= 240),
  -- session = instant-book (pay deposit online, blocks the calendar)
  -- project = inquiry lane (client picks a preferred slot, Nelson confirms + invoices)
  kind text not null default 'project' check (kind in ('session','project')),
  -- maps onto bk_projects.service so the existing admin pipeline keeps working
  legacy_service text not null default 'other'
    check (legacy_service in ('music_video','brand_content','photography','event','other')),
  duration_min integer not null default 60 check (duration_min between 15 and 720),
  price_cents integer check (price_cents is null or price_cents >= 0),
  deposit_cents integer check (deposit_cents is null or deposit_cents >= 0),
  prep_notes text,
  active boolean not null default true,
  sort integer not null default 100
);

-- ============ availability ============
create table public.bk_availability_rules (
  id uuid primary key default gen_random_uuid(),
  dow smallint not null check (dow between 0 and 6), -- 0 = Sunday
  start_min integer not null check (start_min between 0 and 1439),
  end_min integer not null check (end_min between 1 and 1440),
  active boolean not null default true,
  check (end_min > start_min)
);

create table public.bk_blackouts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  starts_on date not null,
  ends_on date not null,
  reason text,
  check (ends_on >= starts_on)
);

-- ============ bookings ============
create table public.bk_bookings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid not null references public.bk_projects(id) on delete cascade,
  service_id uuid not null references public.bk_services(id),
  invoice_id uuid references public.bk_invoices(id) on delete set null,
  starts_at timestamptz not null,
  duration_min integer not null check (duration_min between 15 and 720),
  -- requested = inquiry preference (does NOT block the calendar)
  status text not null default 'pending_payment'
    check (status in ('requested','pending_payment','confirmed','completed','cancelled')),
  expires_at timestamptz, -- pending_payment hold expiry
  location text check (location is null or length(location) <= 240)
);
create index bk_bookings_starts_idx on public.bk_bookings(starts_at);
create index bk_bookings_invoice_idx on public.bk_bookings(invoice_id);
create index bk_bookings_project_idx on public.bk_bookings(project_id);

-- ============ email queue ============
create table public.bk_email_queue (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  project_id uuid references public.bk_projects(id) on delete cascade,
  booking_id uuid references public.bk_bookings(id) on delete cascade,
  kind text not null check (kind in ('confirmation','prep','reminder','nelson_alert','inquiry_ack')),
  send_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 0,
  last_error text,
  payload jsonb not null default '{}'::jsonb
);
create index bk_email_queue_due_idx on public.bk_email_queue(send_at) where sent_at is null;

-- ============ config ============
create table public.bk_config (
  key text primary key,
  value text not null
);
insert into public.bk_config (key, value) values
  ('timezone', 'America/Chicago'),
  ('min_notice_hours', '24'),
  ('max_advance_days', '60'),
  ('slot_step_min', '30'),
  ('buffer_min', '30'),
  ('mailer_secret', gen_random_uuid()::text);

-- ============ RLS (staff-only; anon goes through RPCs) ============
alter table public.bk_services enable row level security;
alter table public.bk_availability_rules enable row level security;
alter table public.bk_blackouts enable row level security;
alter table public.bk_bookings enable row level security;
alter table public.bk_email_queue enable row level security;
alter table public.bk_config enable row level security;

create policy bk_services_staff on public.bk_services for all
  using (public.bk_is_staff()) with check (public.bk_is_staff());
create policy bk_availability_staff on public.bk_availability_rules for all
  using (public.bk_is_staff()) with check (public.bk_is_staff());
create policy bk_blackouts_staff on public.bk_blackouts for all
  using (public.bk_is_staff()) with check (public.bk_is_staff());
create policy bk_bookings_staff on public.bk_bookings for all
  using (public.bk_is_staff()) with check (public.bk_is_staff());
create policy bk_email_queue_staff on public.bk_email_queue for all
  using (public.bk_is_staff()) with check (public.bk_is_staff());
create policy bk_config_staff on public.bk_config for all
  using (public.bk_is_staff()) with check (public.bk_is_staff());

-- ============ helpers ============
create or replace function public.bk_cfg_int(p_key text, p_default integer) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select value::integer from bk_config where key = p_key), p_default);
$$;

-- ============ public: list bookable services ============
create or replace function public.bk_public_services() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', slug, 'name', name, 'tagline', tagline, 'kind', kind,
    'duration_min', duration_min, 'price_cents', price_cents, 'deposit_cents', deposit_cents
  ) order by sort, name), '[]'::jsonb)
  from bk_services where active;
$$;

-- ============ public: open slots for a service over a date window ============
create or replace function public.bk_open_slots(p_service text, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_svc bk_services%rowtype;
  v_tz text; v_step int; v_buffer int; v_notice int; v_advance int;
  v_today date; v_from date; v_to date;
  v_slots jsonb;
begin
  select * into v_svc from bk_services where slug = p_service and active;
  if not found then raise exception 'service not found'; end if;

  v_tz := coalesce((select value from bk_config where key = 'timezone'), 'America/Chicago');
  v_step := bk_cfg_int('slot_step_min', 30);
  v_buffer := bk_cfg_int('buffer_min', 30);
  v_notice := bk_cfg_int('min_notice_hours', 24);
  v_advance := bk_cfg_int('max_advance_days', 60);

  v_today := (now() at time zone v_tz)::date;
  v_from := greatest(coalesce(p_from, v_today), v_today);
  v_to := least(coalesce(p_to, v_from + 41), v_today + v_advance, v_from + 41);
  if v_to < v_from then
    return jsonb_build_object('timezone', v_tz, 'slots', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(to_jsonb(s.slot_start) order by s.slot_start), '[]'::jsonb)
  into v_slots
  from (
    select ((d.d::date)::timestamp + make_interval(mins => m.m)) at time zone v_tz as slot_start
    from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as d(d)
    join bk_availability_rules r
      on r.active and r.dow = extract(dow from d.d)::int
    cross join lateral generate_series(r.start_min, r.end_min - v_svc.duration_min, v_step) as m(m)
    where not exists (
      select 1 from bk_blackouts b where d.d::date between b.starts_on and b.ends_on
    )
  ) s
  where s.slot_start >= now() + make_interval(hours => v_notice)
    and not exists (
      select 1 from bk_bookings bk
      where (bk.status = 'confirmed'
             or (bk.status = 'pending_payment' and bk.expires_at > now()))
        and tstzrange(bk.starts_at - make_interval(mins => v_buffer),
                      bk.starts_at + make_interval(mins => bk.duration_min + v_buffer))
            && tstzrange(s.slot_start, s.slot_start + make_interval(mins => v_svc.duration_min))
    );

  return jsonb_build_object(
    'service', jsonb_build_object('slug', v_svc.slug, 'name', v_svc.name, 'kind', v_svc.kind,
      'duration_min', v_svc.duration_min, 'price_cents', v_svc.price_cents,
      'deposit_cents', v_svc.deposit_cents),
    'timezone', v_tz, 'from', v_from, 'to', v_to, 'slots', v_slots);
end $$;

-- ============ public: create an instant booking (session lane) ============
create or replace function public.bk_create_booking(
  p_service text, p_starts_at timestamptz,
  p_name text, p_email text,
  p_phone text default null, p_location text default null, p_details text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_svc bk_services%rowtype;
  v_tz text; v_amount int; v_kind text;
  v_project uuid; v_token uuid; v_booking uuid; v_invoice uuid;
  v_day date; v_open jsonb;
begin
  if p_name is null or length(trim(p_name)) < 1 then raise exception 'name required'; end if;
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'valid email required'; end if;
  if p_details is not null and length(p_details) > 4000 then raise exception 'details too long'; end if;

  select * into v_svc from bk_services where slug = p_service and active and kind = 'session';
  if not found then raise exception 'service not bookable'; end if;
  v_amount := coalesce(v_svc.deposit_cents, v_svc.price_cents);
  if v_amount is null or v_amount <= 0 then raise exception 'service not bookable'; end if;
  v_kind := case when v_svc.deposit_cents is null then 'full' else 'deposit' end;

  v_tz := coalesce((select value from bk_config where key = 'timezone'), 'America/Chicago');

  -- one booking writer per slot instant; prevents double-booking races
  perform pg_advisory_xact_lock(hashtextextended('bk_slot:' || p_starts_at::text, 42));

  -- the requested slot must still be open
  v_day := (p_starts_at at time zone v_tz)::date;
  v_open := bk_open_slots(p_service, v_day, v_day) -> 'slots';
  if not (v_open @> jsonb_build_array(to_jsonb(p_starts_at))) then
    raise exception 'slot no longer available';
  end if;

  insert into public.bk_projects
    (client_name, client_email, client_phone, service, title, event_date, event_time,
     location, details, referral_source)
  values
    (trim(p_name), lower(trim(p_email)), p_phone, v_svc.legacy_service,
     trim(p_name) || ' — ' || v_svc.name,
     v_day, trim(to_char(p_starts_at at time zone v_tz, 'FMHH12:MI AM')),
     p_location, p_details, 'website-booking')
  returning id, access_token into v_project, v_token;

  insert into public.bk_bookings
    (project_id, service_id, starts_at, duration_min, status, expires_at, location)
  values
    (v_project, v_svc.id, p_starts_at, v_svc.duration_min, 'pending_payment',
     now() + interval '30 minutes', p_location)
  returning id into v_booking;

  insert into public.bk_invoices (project_id, title, line_items, amount_cents, kind, status, due_date)
  values
    (v_project,
     case when v_kind = 'full' then v_svc.name || ' — session' else v_svc.name || ' — booking deposit' end,
     jsonb_build_array(jsonb_build_object(
       'title', v_svc.name || ' · ' || to_char(p_starts_at at time zone v_tz, 'FMMon DD, YYYY FMHH12:MI AM'),
       'amount_cents', v_amount)),
     v_amount, v_kind, 'sent', v_day)
  returning id into v_invoice;

  update public.bk_bookings set invoice_id = v_invoice where id = v_booking;

  return jsonb_build_object(
    'project_id', v_project, 'token', v_token, 'booking_id', v_booking,
    'invoice_id', v_invoice, 'amount_cents', v_amount,
    'starts_at', p_starts_at, 'service_name', v_svc.name);
end $$;

-- ============ public: booking status for the success page ============
create or replace function public.bk_booking_status(p_project uuid, p_token uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  if not exists (select 1 from bk_projects where id = p_project and access_token = p_token) then
    raise exception 'not found';
  end if;
  select jsonb_build_object(
    'project', (select jsonb_build_object('id', id, 'title', title, 'client_name', client_name,
        'event_date', event_date, 'event_time', event_time, 'status', status)
      from bk_projects where id = p_project),
    'booking', (select jsonb_build_object('id', b.id, 'starts_at', b.starts_at,
        'duration_min', b.duration_min, 'status', b.status, 'location', b.location,
        'service_name', s.name)
      from bk_bookings b join bk_services s on s.id = b.service_id
      where b.project_id = p_project order by b.created_at desc limit 1),
    'invoice', (select jsonb_build_object('id', id, 'title', title, 'amount_cents', amount_cents,
        'status', status, 'paid_at', paid_at)
      from bk_invoices where project_id = p_project order by created_at desc limit 1)
  ) into v;
  return v;
end $$;

-- ============ inquiry lane: replace bk_submit_inquiry to add preferred time + auto emails ============
drop function if exists public.bk_submit_inquiry(text,text,text,text,text,date,text,text,text,text);
create or replace function public.bk_submit_inquiry(
  p_name text, p_email text, p_service text,
  p_phone text default null, p_company text default null,
  p_event_date date default null, p_location text default null,
  p_budget text default null, p_details text default null,
  p_source text default null, p_event_time text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_token uuid;
begin
  if p_name is null or length(trim(p_name)) < 1 then raise exception 'name required'; end if;
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'valid email required'; end if;
  if p_service not in ('music_video','brand_content','photography','event','other') then raise exception 'invalid service'; end if;
  insert into public.bk_projects (client_name, client_email, client_phone, company, service, event_date, event_time, location, budget_range, details, referral_source, title)
  values (trim(p_name), lower(trim(p_email)), p_phone, p_company, p_service, p_event_date, p_event_time, p_location, p_budget, p_details, p_source,
          trim(p_name) || ' — ' || replace(initcap(replace(p_service,'_',' ')),'Of','of'))
  returning id, access_token into v_id, v_token;

  insert into public.bk_email_queue (project_id, kind, payload)
  values
    (v_id, 'inquiry_ack', jsonb_build_object('service', p_service)),
    (v_id, 'nelson_alert', jsonb_build_object('type', 'inquiry', 'service', p_service));

  return jsonb_build_object('id', v_id, 'token', v_token);
end $$;

-- ============ triggers: paid invoice → confirmed booking → queued emails ============
create or replace function public.bk_on_invoice_paid() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.bk_bookings set status = 'confirmed'
    where invoice_id = new.id and status = 'pending_payment';
  insert into public.bk_email_queue (project_id, kind, payload)
  values (new.project_id, 'nelson_alert', jsonb_build_object(
    'type', 'payment', 'invoice_title', new.title, 'amount_cents', new.amount_cents));
  return new;
end $$;
create trigger bk_invoice_paid after update on public.bk_invoices
  for each row when (new.status = 'paid' and old.status is distinct from 'paid')
  execute function public.bk_on_invoice_paid();

create or replace function public.bk_on_booking_confirmed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- confirmation right away
  insert into public.bk_email_queue (project_id, booking_id, kind, send_at)
  values (new.project_id, new.id, 'confirmation', now());
  -- prep 3 days out (only if there is still meaningful lead time)
  if new.starts_at - interval '3 days' > now() + interval '6 hours' then
    insert into public.bk_email_queue (project_id, booking_id, kind, send_at)
    values (new.project_id, new.id, 'prep', new.starts_at - interval '3 days');
  elsif new.starts_at > now() + interval '12 hours' then
    insert into public.bk_email_queue (project_id, booking_id, kind, send_at)
    values (new.project_id, new.id, 'prep', now() + interval '10 minutes');
  end if;
  -- reminder the day before
  if new.starts_at - interval '1 day' > now() + interval '2 hours' then
    insert into public.bk_email_queue (project_id, booking_id, kind, send_at)
    values (new.project_id, new.id, 'reminder', new.starts_at - interval '1 day');
  end if;
  return new;
end $$;
create trigger bk_booking_confirmed_ins after insert on public.bk_bookings
  for each row when (new.status = 'confirmed')
  execute function public.bk_on_booking_confirmed();
create trigger bk_booking_confirmed_upd after update on public.bk_bookings
  for each row when (new.status = 'confirmed' and old.status is distinct from 'confirmed')
  execute function public.bk_on_booking_confirmed();

-- cancelled booking → drop unsent client emails
create or replace function public.bk_on_booking_cancelled() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.bk_email_queue
    where booking_id = new.id and sent_at is null
      and kind in ('confirmation','prep','reminder');
  return new;
end $$;
create trigger bk_booking_cancelled after update on public.bk_bookings
  for each row when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.bk_on_booking_cancelled();

-- ============ seeds ============
-- Default availability: Tue–Sat, 10:00–18:00 Central. NELSON: adjust in the admin Schedule tab.
insert into public.bk_availability_rules (dow, start_min, end_min) values
  (2, 600, 1080), (3, 600, 1080), (4, 600, 1080), (5, 600, 1080), (6, 600, 1080);

-- Services. Only documented pricing is seeded with a price; everything else is the
-- inquiry lane until Nelson sets pricing in admin (flip kind to 'session' + set deposit).
insert into public.bk_services (slug, name, tagline, kind, legacy_service, duration_min, price_cents, deposit_cents, prep_notes, sort) values
  ('digitals', 'Digitals Session', 'Rapid-fire digitals for actors, models & creators — $100 flat.', 'session', 'photography', 30, 10000, null,
   'Bring 2–3 simple outfit options (solid colors photograph best), arrive with hair and light makeup done, and get a full night''s rest — the camera sees everything. We shoot fast and natural; you''ll leave with the exact looks casting wants.', 10),
  ('headshots', 'Headshots', 'Professional headshots that open doors — DFW studio or on location.', 'project', 'photography', 60, null, null,
   'Bring 2–3 tops with different necklines and colors, avoid busy patterns, and bring a brush/touch-up kit. We''ll talk through how you want to be seen before the first frame.', 20),
  ('branding-photoshoot', 'Branding Photoshoot', 'A full visual identity shoot for your brand or personal brand.', 'project', 'photography', 120, null, null,
   'Make a short list of the shots your brand needs (website hero, socials, team). Bring wardrobe that matches your brand palette and any products or props you want featured.', 30),
  ('product-photography', 'Product Photography', 'E-commerce and campaign product imagery that sells.', 'project', 'photography', 120, null, null,
   'Ship or bring clean, retail-ready product units (2 of each if possible). Send your brand guide or reference imagery ahead of the shoot so lighting and styling match your line.', 40),
  ('music-video', 'Music Video', 'Cinematic music videos — concept, direction, shoot, edit.', 'project', 'music_video', 480, null, null,
   'Have your final mix ready and locked. We''ll build the concept, locations, and shot list together in pre-production.', 50),
  ('brand-content', 'Brand Content & Commercial', 'Short-form films and commercials built for conversion.', 'project', 'brand_content', 240, null, null,
   'Gather your brand assets (logo, colors, past content you love or hate). We''ll lock the creative direction and shot list before shoot day.', 60),
  ('event-coverage', 'Event Coverage', 'Photo + video coverage that makes your event live forever.', 'project', 'event', 240, null, null,
   'Send the run-of-show and a list of must-capture moments and VIPs at least 3 days before the event.', 70),
  ('ai-creative', 'AI Content & Automation', 'AI-powered content systems, avatars, and creative automation.', 'project', 'other', 60, null, null, null, 80),
  ('web-design', 'Web Design', 'Custom websites from $1,200 — designed, built, and launched.', 'project', 'other', 60, null, null, null, 90),
  ('social-media', 'Social Media Content', 'Monthly content engines — reels, carousels, and strategy.', 'project', 'other', 60, null, null, null, 100),
  ('workshops', 'Live Workshops & Training', 'Hands-on AI + creative workshops for teams and organizations.', 'project', 'other', 120, null, null, null, 110);

-- ============ grants ============
grant execute on function public.bk_public_services() to anon;
grant execute on function public.bk_open_slots(text, date, date) to anon;
grant execute on function public.bk_create_booking(text, timestamptz, text, text, text, text, text) to anon;
grant execute on function public.bk_booking_status(uuid, uuid) to anon;
grant execute on function public.bk_submit_inquiry(text,text,text,text,text,date,text,text,text,text,text) to anon;
