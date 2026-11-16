-- Minimal production-shaped schema for isolated payment tests. Synthetic data only.
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
create function bk_is_staff() returns boolean language sql stable as $$select coalesce(current_setting('test.staff',true),'false')='true'$$;
create function bk_is_admin() returns boolean language sql stable as $$select coalesce(current_setting('test.admin',true),'false')='true'$$;
create table bk_projects (
 id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),updated_at timestamptz default now(),
 access_token uuid not null default gen_random_uuid(),client_name text default 'Test Client',client_email text default 'test@example.test',
 client_phone text,company text,service text default 'other',title text,status text not null default 'new',
 event_date date,event_time text,location text,details text,referral_source text,contact_id uuid
);
create table bk_invoices (
 id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),project_id uuid references bk_projects,
 title text default 'Test invoice',amount_cents int not null,kind text default 'full',status text default 'draft',
 line_items jsonb default '[]',due_date date,stripe_session_id text,paid_at timestamptz,payment_note text,source text
);
create table bk_services(
 id uuid primary key default gen_random_uuid(),slug text unique,name text,active bool default true,kind text default 'session',
 duration_min int default 60,legacy_service text default 'photography',price_cents int default 10000,
 weekend_price_cents int,deposit_cents int,location_ok bool default false,auto_balance bool default false
);
create table bk_bookings(
 id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),project_id uuid references bk_projects,
 service_id uuid references bk_services,invoice_id uuid references bk_invoices,starts_at timestamptz,
 duration_min int default 60,status text default 'pending_payment',expires_at timestamptz,location text,
 travel_min int not null default 0,balance_cents int,balance_status text,balance_invoice_id uuid
);
create table bk_galleries(id uuid primary key default gen_random_uuid(),created_at timestamptz default now(),project_id uuid references bk_projects,pay_url text);
create table bk_activities(id uuid primary key default gen_random_uuid(),project_id uuid,contact_id uuid,actor_id uuid,kind text,summary text);
create table bk_email_queue(id uuid primary key default gen_random_uuid(),project_id uuid,booking_id uuid,kind text,payload jsonb,send_at timestamptz default now());
create table bk_config(key text primary key,value text);
insert into bk_config values('timezone','America/Chicago'),('min_notice_hours','0'),('buffer_min','30');
create function bk_cfg_int(p_key text,p_default int) returns int language sql stable as $$
 select coalesce((select value::int from bk_config where key=p_key),p_default)
$$;
create table bk_addons(slug text,active bool default true,services text[],sort int,name text,price_cents int);
create table bk_service_hours(service_id uuid,dow int,start_min int,end_min int,active bool default true);
create table bk_availability_rules(dow int,start_min int,end_min int,active bool default true);
create table bk_blackouts(starts_on date,ends_on date);
insert into bk_availability_rules select n,600,1080,true from generate_series(0,6) n;


CREATE OR REPLACE FUNCTION public.bk_open_slots_where(p_service text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_on_location boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_svc bk_services%rowtype;
  v_tz text; v_step int; v_buffer int; v_notice int; v_advance int; v_travel int;
  v_today date; v_from date; v_to date;
  v_custom boolean;
  v_slots jsonb;
begin
  select * into v_svc from bk_services where slug = p_service and active;
  if not found then raise exception 'service not found'; end if;
  if coalesce(p_on_location, false) and not v_svc.location_ok then
    raise exception 'on-location not offered for this service';
  end if;

  v_tz := coalesce((select value from bk_config where key = 'timezone'), 'America/Chicago');
  v_step := bk_cfg_int('slot_step_min', 30);
  v_buffer := bk_cfg_int('buffer_min', 30);
  v_notice := bk_cfg_int('min_notice_hours', 24);
  v_advance := bk_cfg_int('max_advance_days', 60);
  v_travel := case when coalesce(p_on_location, false) then least(greatest(bk_cfg_int('travel_min', 60), 0), 240) else 0 end;

  v_custom := exists (
    select 1 from bk_service_hours h where h.service_id = v_svc.id and h.active);

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
    join (
      select h.dow, h.start_min, h.end_min
        from bk_service_hours h
       where v_custom and h.service_id = v_svc.id and h.active
      union all
      select r.dow, r.start_min, r.end_min
        from bk_availability_rules r
       where (not v_custom) and r.active
    ) r on r.dow = extract(dow from d.d)::int
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
        and tstzrange(bk.starts_at - make_interval(mins => greatest(v_buffer, bk.travel_min, v_travel)),
                      bk.starts_at + make_interval(mins => bk.duration_min + greatest(v_buffer, bk.travel_min, v_travel)))
            && tstzrange(s.slot_start, s.slot_start + make_interval(mins => v_svc.duration_min))
    );

  return jsonb_build_object(
    'service', jsonb_build_object('slug', v_svc.slug, 'name', v_svc.name, 'kind', v_svc.kind,
      'duration_min', v_svc.duration_min, 'price_cents', v_svc.price_cents,
      'deposit_cents', v_svc.deposit_cents),
    'timezone', v_tz, 'from', v_from, 'to', v_to, 'on_location', coalesce(p_on_location, false),
    'slots', v_slots);
end $function$
