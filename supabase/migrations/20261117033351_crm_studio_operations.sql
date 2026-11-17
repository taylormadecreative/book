-- Staff studio operations. No emails, invoices are drafts only, and no charges.
begin;

create schema if not exists bk_ops_private;
revoke all on schema bk_ops_private from public, anon, authenticated;

create table bk_ops_private.requests (actor_id uuid not null, request_id uuid not null,
action text not null, payload jsonb not null, result jsonb not null, created_at timestamptz not null default now (),
primary key (actor_id, request_id));
alter table bk_ops_private.requests enable row level security;
revoke all on bk_ops_private.requests from public, anon, authenticated;

create table public.bk_project_expenses (id uuid primary key default gen_random_uuid (),
project_id uuid not null references public.bk_projects (id), title text not null check (length (trim (title)) between 1
and 180), category text not null check (category in ('contractor', 'rental', 'travel',
'location', 'materials', 'payment_fees', 'other')), amount_cents int not null check (amount_cents between 0
and 999999999), incurred_on date not null, notes text not null default '' check (length (notes) <= 2000),
voided_at timestamptz, created_at timestamptz not null default now (), updated_at timestamptz not null default now ());

create table public.bk_staff_capacity (staff_id uuid primary key references public.profiles (id),
weekly_minutes int not null check (weekly_minutes between 0 and 10080), working_days int [] not null default array [1,
2, 3, 4, 5] check (cardinality (working_days) between 1 and 7 and working_days <@ array [0,
1, 2, 3, 4, 5, 6]), hourly_cost_cents int not null check (hourly_cost_cents between 0 and 99999999),
updated_at timestamptz not null default now ());

create table public.bk_time_entries (id uuid primary key default gen_random_uuid (), project_id uuid not null references public.bk_projects (id),
staff_id uuid not null references public.profiles (id), title text not null check (length (trim (title)) between 1
and 180), worked_on date not null, minutes int not null check (minutes between 1 and 1440),
hourly_cost_cents int not null check (hourly_cost_cents between 0 and 99999999), notes text not null default '' check (length (notes) <= 2000),
voided_at timestamptz, created_at timestamptz not null default now (), updated_at timestamptz not null default now ());

create table public.bk_edit_allocations (id uuid primary key default gen_random_uuid (),
project_id uuid not null references public.bk_projects (id), staff_id uuid not null references public.profiles (id),
title text not null check (length (trim (title)) between 1 and 180), work_on date not null,
minutes int not null check (minutes between 1 and 1440), status text not null default 'planned' check (status in ('planned',
'done', 'cancelled')), task_id uuid references public.bk_tasks (id), notes text not null default '' check (length (notes) <= 2000),
created_at timestamptz not null default now (), updated_at timestamptz not null default now ());

create table public.bk_retainers (id uuid primary key default gen_random_uuid (), contact_id uuid not null references public.bk_contacts (id),
name text not null check (length (trim (name)) between 1 and 180), status text not null default 'draft' check (status in ('draft',
'active', 'paused', 'cancelled')), billing_provider text not null check (billing_provider in ('stripe',
'honeybook')), monthly_amount_cents int not null check (monthly_amount_cents between 0 and 999999999),
start_on date not null, allowances jsonb not null check (jsonb_typeof (allowances) = 'array'),
owner_id uuid references public.profiles (id), notes text not null default '' check (length (notes) <= 4000),
created_at timestamptz not null default now (), updated_at timestamptz not null default now ());

create table public.bk_retainer_periods (id uuid primary key default gen_random_uuid (),
retainer_id uuid not null references public.bk_retainers (id), period_month date not null check (extract (day
from period_month) = 1), project_id uuid not null references public.bk_projects (id), starts_on date not null,
ends_on date not null, status text not null default 'open' check (status in ('open', 'closed')),
monthly_amount_cents int not null check (monthly_amount_cents >= 0), billing_provider text not null check (billing_provider in ('stripe',
'honeybook')), invoice_id uuid references public.bk_invoices (id), created_at timestamptz not null default now (),
unique (retainer_id, period_month));

create table public.bk_retainer_allowances (period_id uuid not null references public.bk_retainer_periods (id),
item_key text not null check (item_key ~ '^[a-z0-9_]{1,40}$'), label text not null check (length (trim (label)) between 1
and 120), included int not null check (included between 0 and 100000), primary key (period_id,
item_key));

create table public.bk_retainer_usage (id uuid primary key default gen_random_uuid (),
period_id uuid not null, item_key text not null, quantity_delta int not null check (quantity_delta <> 0),
note text not null check (length (trim (note)) between 3 and 500), reverses_id uuid references public.bk_retainer_usage (id),
actor_id uuid not null, created_at timestamptz not null default now (), foreign key (period_id,
item_key) references public.bk_retainer_allowances (period_id, item_key));

create index bk_expenses_project on public.bk_project_expenses (project_id, incurred_on);

create index bk_time_project on public.bk_time_entries (project_id, worked_on);

create index bk_edit_week on public.bk_edit_allocations (work_on, staff_id);

create index bk_retainer_project on public.bk_retainer_periods (project_id);

create index bk_retainer_usage_period on public.bk_retainer_usage (period_id, item_key);

create unique index bk_ops_renewal_task_unique on public.bk_tasks (automation_key) where automation_key like 'ops_retainer_%';
do
$$
declare
  t text;
begin
  foreach t in array array ['bk_project_expenses', 'bk_staff_capacity', 'bk_time_entries',
  'bk_edit_allocations', 'bk_retainers', 'bk_retainer_periods', 'bk_retainer_allowances',
  'bk_retainer_usage'] loop execute format ('alter table public.%I enable row level security',
  t);
  execute format ('revoke all on public.%I from public,anon,authenticated', t);
  execute format ('grant select on public.%I to authenticated', t);
  execute format ('create policy %I on public.%I for select to authenticated using ((select public.bk_is_staff()))',
  t || '_staff', t);
  end loop;
end
$$;

create function bk_ops_private.audit (p_project uuid, p_contact uuid, p_kind text, p_summary text) returns void language sql security definer
set search_path = '' as
$$
insert into public.bk_activities (project_id, contact_id, actor_id, kind, summary) values (p_project,
p_contact, auth.uid (), p_kind, left (p_summary, 500))
$$
;

create function bk_ops_private.renewal (p_retainer uuid, p_month date) returns void language plpgsql security definer
set search_path = '' as
$$
declare
  r public.bk_retainers;
begin
  select * into r from public.bk_retainers where id = p_retainer;
  if r.status <> 'active' or p_month < date_trunc ('month', r.start_on) :: date or exists (select 1 from public.bk_retainer_periods
  where retainer_id = r.id and period_month = p_month) then
    return;
  end if;
  insert into public.bk_tasks (contact_id, title, kind, due_at, owner_id, automation_key,
  notes) values (r.contact_id, 'Review monthly retainer: ' || left (r.name, 130), 'rebook',
  (greatest (p_month, r.start_on) :: timestamp + interval '9 hours') at time zone 'America/Chicago',
  r.owner_id, 'ops_retainer_' || r.id || '_' || p_month, 'Open the work period, review its allowances and prepare the invoice in the existing billing provider. No charge is automatic.')
  on conflict (automation_key) where automation_key like 'ops_retainer_%' do update set status = case
  when public.bk_tasks.status = 'cancelled' then
    'open'
  else public.bk_tasks.status
end;
end
$$;

create function public.bk_ops_queue_renewals () returns int language plpgsql security definer set search_path = '' as
$$
declare
  r record;
  n int := 0;
begin
  for r in select id from public.bk_retainers where status = 'active' loop perform bk_ops_private.renewal (r.id,
  date_trunc ('month', now () at time zone 'America/Chicago') :: date);
  n := n + 1;
  end loop;
  return n;
end
$$;
revoke all on function public.bk_ops_queue_renewals () from public, anon, authenticated;
grant execute on function public.bk_ops_queue_renewals () to service_role;

-- One idempotent, staff-authorized command surface. Row locks serialize allowance use.

create function public.bk_ops_save (p_action text, p_data jsonb, p_request_id uuid) returns jsonb language plpgsql security definer
set search_path = '' as
$$
declare
  uid uuid := auth.uid ();
  prior bk_ops_private.requests;
  result jsonb;
  v_id uuid;
  pid uuid;
  cid uuid;
  staff uuid;
  expense public.bk_project_expenses;
  entry public.bk_time_entries;
  block public.bk_edit_allocations;
  ret public.bk_retainers;
  period public.bk_retainer_periods;
  allowance public.bk_retainer_allowances;
  usage public.bk_retainer_usage;
  item jsonb;
  clean jsonb := '[]';
  k text;
  qty int;
  used int;
  reversed int;
  month date;
  inv public.bk_invoices;
  project public.bk_projects;
  rate int;
  changed boolean;
begin
  perform bk_crm_private.require_staff ();
  if p_request_id is null then
    raise exception 'A request ID is required';
  end if;
  perform pg_advisory_xact_lock (hashtextextended (uid :: text || p_request_id :: text,
  0));
  select * into prior from bk_ops_private.requests where actor_id = uid and request_id = p_request_id;
  if found then
    if prior.action <> p_action or prior.payload is distinct from p_data then
      raise exception 'This saved request changed. Reload its records before submitting a new change.';
    end if;
    return prior.result;
  end if;
  v_id := nullif (p_data ->> 'id', '') :: uuid;
  pid := nullif (p_data ->> 'project_id', '') :: uuid;
  staff := coalesce (nullif (p_data ->> 'staff_id', '') :: uuid, uid);
  if p_action in ('expense', 'time', 'allocation') then
    select * into project from public.bk_projects where public.bk_projects.id = pid for update;
    if not found then
      raise exception 'Project not found';
    end if;
    cid := project.contact_id;
  end if;
  if p_action in ('time', 'allocation', 'staff_capacity') and not exists (select 1 from public.profiles where public.profiles.id = staff
  and role in ('admin', 'employee')) then
    raise exception 'Choose a staff member';
  end if;
  case p_action
    when 'expense' then
      if v_id is null then
        insert into public.bk_project_expenses (project_id, title, category, amount_cents, incurred_on,
        notes) values (pid, trim (p_data ->> 'title'), p_data ->> 'category', (p_data ->> 'amount_cents') :: int,
        (p_data ->> 'incurred_on') :: date, coalesce (p_data ->> 'notes', '')) returning * into expense;
      else
        update public.bk_project_expenses set title = trim (p_data ->> 'title'), category = p_data ->> 'category',
        amount_cents = (p_data ->> 'amount_cents') :: int, incurred_on = (p_data ->> 'incurred_on') :: date,
        notes = coalesce (p_data ->> 'notes', ''), updated_at = now () where public.bk_project_expenses.id = v_id
        and project_id = pid and voided_at is null returning * into expense;
        if not found then
          raise exception 'Expense not found or voided';
        end if;
      end if;
      result := to_jsonb (expense);
      perform bk_ops_private.audit (pid, cid, 'expense_saved', 'Recorded expense: ' || expense.title);
    when 'void_expense' then
      update public.bk_project_expenses set voided_at = now (), updated_at = now () where public.bk_project_expenses.id = v_id
      and voided_at is null returning * into expense;
      if not found then
        raise exception 'Expense not found or already voided';
      end if;
      result := to_jsonb (expense);
      perform bk_ops_private.audit (expense.project_id, null, 'expense_voided', 'Voided expense: ' || expense.title);
    when 'staff_capacity' then
      if cardinality (array (select distinct x from jsonb_array_elements_text (p_data -> 'working_days') x)) <> jsonb_array_length (p_data -> 'working_days') then
        raise exception 'Working days must be unique';
      end if;
      insert into public.bk_staff_capacity (staff_id, weekly_minutes, working_days, hourly_cost_cents) values (staff,
      (p_data ->> 'weekly_minutes') :: int, array (select x :: int from jsonb_array_elements_text (p_data -> 'working_days') x),
      (p_data ->> 'hourly_cost_cents') :: int) on conflict (staff_id) do update set weekly_minutes = excluded.weekly_minutes,
      working_days = excluded.working_days, hourly_cost_cents = excluded.hourly_cost_cents, updated_at = now ();
      result := jsonb_build_object ('staff_id', staff);
      perform bk_ops_private.audit (null, null, 'capacity_saved', 'Updated staff capacity and internal cost assumption');
    when 'time' then
      rate := coalesce (nullif (p_data ->> 'hourly_cost_cents', '') :: int, (select hourly_cost_cents from public.bk_staff_capacity
      where staff_id = staff));
      if rate is null then
        raise exception 'Set an internal hourly cost assumption before logging time';
      end if;
      if v_id is null then
        insert into public.bk_time_entries (project_id, staff_id, title, worked_on, minutes, hourly_cost_cents,
        notes) values (pid, staff, trim (p_data ->> 'title'), (p_data ->> 'worked_on') :: date,
        (p_data ->> 'minutes') :: int, rate, coalesce (p_data ->> 'notes', '')) returning * into entry;
      else
        update public.bk_time_entries set staff_id = staff, title = trim (p_data ->> 'title'),
        worked_on = (p_data ->> 'worked_on') :: date, minutes = (p_data ->> 'minutes') :: int,
        hourly_cost_cents = rate, notes = coalesce (p_data ->> 'notes', ''), updated_at = now () where public.bk_time_entries.id = v_id
        and project_id = pid and voided_at is null returning * into entry;
        if not found then
          raise exception 'Time entry not found or voided';
        end if;
      end if;
      result := to_jsonb (entry);
      perform bk_ops_private.audit (pid, cid, 'time_saved', 'Recorded time: ' || entry.minutes || ' minutes, ' || entry.title);
    when 'void_time' then
      update public.bk_time_entries set voided_at = now (), updated_at = now () where public.bk_time_entries.id = v_id
      and voided_at is null returning * into entry;
      if not found then
        raise exception 'Time entry not found or already voided';
      end if;
      result := to_jsonb (entry);
      perform bk_ops_private.audit (entry.project_id, null, 'time_voided', 'Voided time entry: ' || entry.title);
    when 'allocation' then
      if v_id is null then
        insert into public.bk_edit_allocations (project_id, staff_id, title, work_on, minutes,
        status, notes) values (pid, staff, trim (p_data ->> 'title'), (p_data ->> 'work_on') :: date,
        (p_data ->> 'minutes') :: int, coalesce (p_data ->> 'status', 'planned'), coalesce (p_data ->> 'notes',
        '')) returning * into block;
      else
        update public.bk_edit_allocations set staff_id = staff, title = trim (p_data ->> 'title'),
        work_on = (p_data ->> 'work_on') :: date, minutes = (p_data ->> 'minutes') :: int,
        status = coalesce (p_data ->> 'status', 'planned'), notes = coalesce (p_data ->> 'notes',
        ''), updated_at = now () where public.bk_edit_allocations.id = v_id and project_id = pid returning * into block;
        if not found then
          raise exception 'Editing block not found';
        end if;
      end if;
      if block.task_id is null then
        insert into public.bk_tasks (project_id, contact_id, title, kind, due_at, owner_id, notes,
        automation_key) values (pid, cid, 'Editing: ' || left (block.title, 160), 'production',
        (block.work_on :: timestamp + interval '17 hours') at time zone 'America/Chicago', staff,
        'Planned editing block. Project delivery and shoot dates remain separately recorded.',
        'ops_edit_' || block.id) returning public.bk_tasks.id into block.task_id;
        update public.bk_edit_allocations set task_id = block.task_id where public.bk_edit_allocations.id = block.id;
      end if;
      update public.bk_tasks set title = 'Editing: ' || left (block.title, 160), due_at = (block.work_on :: timestamp + interval '17 hours') at time zone 'America/Chicago',
      owner_id = staff, status = case block.status
    when 'done' then
      'done'
    when 'cancelled' then
      'cancelled'
    else 'open'
  end where public.bk_tasks.id = block.task_id;
  result := to_jsonb (block);
  perform bk_ops_private.audit (pid, cid, 'editing_planned', 'Editing block: ' || block.title || ' on ' || block.work_on);
  when 'retainer' then
    if jsonb_typeof (p_data -> 'allowances') is distinct from 'array' or jsonb_array_length (p_data -> 'allowances') not between 1
    and 20 then
      raise exception 'Add 1–20 included deliverables';
    end if;
    for item in select value from jsonb_array_elements (p_data -> 'allowances') loop k := item ->> 'key';
    qty := (item ->> 'quantity') :: int;
    if k is null or k !~ '^[a-z0-9_]{1,40}$' or nullif (trim (item ->> 'label'), '') is null or length (item ->> 'label') > 120
    or qty is null or qty not between 1 and 100000 or exists (select 1 from jsonb_array_elements (clean) x where x ->> 'key' = k) then
      raise exception 'Invalid or duplicate allowance';
    end if;
    clean := clean || jsonb_build_array (jsonb_build_object ('key', k, 'label', trim (item ->> 'label'),
    'quantity', qty));
  end loop;
  if v_id is not null then
    select * into ret from public.bk_retainers where public.bk_retainers.id = v_id for update;
    if not found then
      raise exception 'Retainer not found';
    end if;
    if ret.contact_id <> (p_data ->> 'contact_id') :: uuid then
      raise exception 'A retainer cannot change client';
    end if;
    if ret.billing_provider <> p_data ->> 'billing_provider' and exists (select 1 from public.bk_retainer_periods
    where retainer_id = ret.id) then
      raise exception 'Provider is locked after opening a work period';
    end if;
    update public.bk_retainers set name = trim (p_data ->> 'name'), status = p_data ->> 'status',
    billing_provider = p_data ->> 'billing_provider', monthly_amount_cents = (p_data ->> 'monthly_amount_cents') :: int,
    start_on = (p_data ->> 'start_on') :: date, allowances = clean, owner_id = coalesce (nullif (p_data ->> 'owner_id',
    '') :: uuid, uid), notes = coalesce (p_data ->> 'notes', ''), updated_at = now () where public.bk_retainers.id = v_id
    returning * into ret;
  else
    insert into public.bk_retainers (contact_id, name, status, billing_provider, monthly_amount_cents,
    start_on, allowances, owner_id, notes) values ((p_data ->> 'contact_id') :: uuid, trim (p_data ->> 'name'),
    coalesce (p_data ->> 'status', 'draft'), p_data ->> 'billing_provider', (p_data ->> 'monthly_amount_cents') :: int,
    (p_data ->> 'start_on') :: date, clean, coalesce (nullif (p_data ->> 'owner_id', '') :: uuid,
    uid), coalesce (p_data ->> 'notes', '')) returning * into ret;
  end if;
  if not exists (select 1 from public.profiles where public.profiles.id = ret.owner_id and role in ('admin',
  'employee')) then
    raise exception 'Choose a staff owner';
  end if;
  if ret.status = 'active' then
    perform bk_ops_private.renewal (ret.id, date_trunc ('month', greatest (ret.start_on, current_date)) :: date);
  else
    update public.bk_tasks set status = 'cancelled' where automation_key like 'ops_retainer_' || ret.id || '_%'
    and status = 'open';
  end if;
  result := to_jsonb (ret);
  perform bk_ops_private.audit (null, ret.contact_id, 'retainer_saved', 'Retainer ' || ret.status || ': ' || ret.name);
  when 'open_period' then
    select * into ret from public.bk_retainers where public.bk_retainers.id = (p_data ->> 'retainer_id') :: uuid for update;
    if not found or ret.status <> 'active' then
      raise exception 'Activate the retainer before opening a work period';
    end if;
    month := (p_data ->> 'period_month') :: date;
    if extract (day from month) <> 1 or month < date_trunc ('month', ret.start_on) :: date then
      raise exception 'Choose a calendar month on or after the retainer start';
    end if;
    select * into period from public.bk_retainer_periods where retainer_id = ret.id and period_month = month;
    if found then
      if pid is not null and pid <> period.project_id then
        raise exception 'This month is already linked to another project';
      end if;
      result := to_jsonb (period);
    else if pid is null then
      result := public.bk_crm_create_project (jsonb_build_object ('contact_id', ret.contact_id,
      'client_name', (select name from public.bk_contacts where public.bk_contacts.id = ret.contact_id),
      'service', 'other', 'referral_source', 'Repeat client / retainer', 'title', ret.name || ' · ' || to_char (month,
      'Mon YYYY'), 'owner_id', ret.owner_id));
      pid := (result ->> 'id') :: uuid;
      update public.bk_projects set status = 'booked' where public.bk_projects.id = pid;
      update public.bk_tasks set status = 'cancelled' where project_id = pid and automation_key in ('initial_followup',
      'production_prep') and status = 'open';
    end if;
    select * into project from public.bk_projects where public.bk_projects.id = pid for update;
    if project.contact_id is distinct from ret.contact_id then
      raise exception 'The project belongs to a different client';
    end if;
    if project.billing_provider not in ('unassigned', ret.billing_provider) then
      raise exception 'The project uses a different payment provider';
    end if;
    perform public.bk_set_project_billing (pid, ret.billing_provider, project.external_billing_url,
    project.external_billing_ref);
    insert into public.bk_retainer_periods (retainer_id, period_month, project_id, starts_on,
    ends_on, monthly_amount_cents, billing_provider) values (ret.id, month, pid, greatest (month,
    ret.start_on), (month + interval '1 month' - interval '1 day') :: date, ret.monthly_amount_cents,
    ret.billing_provider) returning * into period;
    insert into public.bk_retainer_allowances (period_id, item_key, label, included) select period.id,
    x ->> 'key', x ->> 'label', (x ->> 'quantity') :: int from jsonb_array_elements (ret.allowances) x;
    insert into public.bk_tasks (project_id, contact_id, title, kind, due_at, owner_id, automation_key) values (pid,
    ret.contact_id, 'Plan monthly deliverables: ' || left (ret.name, 140), 'production', (greatest (period.starts_on,
    current_date) :: timestamp + interval '10 hours') at time zone 'America/Chicago', ret.owner_id,
    'ops_period_' || period.id);
    result := to_jsonb (period);
    perform bk_ops_private.audit (pid, ret.contact_id, 'retainer_period_opened', 'Opened retainer month: ' || to_char (month,
    'Mon YYYY'));
  end if;
  update public.bk_tasks set status = 'done' where automation_key = 'ops_retainer_' || ret.id || '_' || month;
  perform bk_ops_private.renewal (ret.id, (month + interval '1 month') :: date);
  when 'usage' then
    select * into period from public.bk_retainer_periods where public.bk_retainer_periods.id = (p_data ->> 'period_id') :: uuid for update;
    if not found then
      raise exception 'Work period not found';
    end if;
    select * into ret from public.bk_retainers where public.bk_retainers.id = period.retainer_id;
    select * into allowance from public.bk_retainer_allowances where period_id = period.id and item_key = p_data ->> 'item_key' for update;
    if not found then
      raise exception 'Included deliverable not found';
    end if;
    qty := (p_data ->> 'quantity') :: int;
    if qty is null or qty < 1 then
      raise exception 'Enter a positive whole quantity';
    end if;
    select coalesce (sum (quantity_delta), 0) :: int into used from public.bk_retainer_usage where period_id = period.id
    and item_key = allowance.item_key;
    if nullif (p_data ->> 'reverses_id', '') is not null then
      select * into usage from public.bk_retainer_usage where public.bk_retainer_usage.id = (p_data ->> 'reverses_id') :: uuid
      and period_id = period.id and item_key = allowance.item_key and quantity_delta > 0;
      if not found then
        raise exception 'Original fulfilled entry not found';
      end if;
      select - coalesce (sum (quantity_delta), 0) :: int into reversed from public.bk_retainer_usage where reverses_id = usage.id;
      if qty > usage.quantity_delta - reversed then
        raise exception 'This would return more than the original usage';
      end if;
      qty := - qty;
    elsif period.status <> 'open' or ret.status not in ('active', 'paused') then
      raise exception 'This work period is closed';
    elsif (now() at time zone 'America/Chicago')::date < period.starts_on then
    raise exception 'This work period has not started. Record fulfillment in the current month, or wait until its start date.';
  elsif (now() at time zone 'America/Chicago')::date > period.ends_on then
    raise exception 'This work period has expired. Open the current month to record new fulfillment. Use Correct usage to reverse a mistaken historical entry.';
  elsif used + qty > allowance.included then
      raise exception 'Not enough included deliverables remain. Agree and record an allowance adjustment first.';
    end if;
    insert into public.bk_retainer_usage (period_id, item_key, quantity_delta, note, reverses_id,
    actor_id) values (period.id, allowance.item_key, qty, trim (p_data ->> 'note'), nullif (p_data ->> 'reverses_id',
    '') :: uuid, uid) returning * into usage;
    result := to_jsonb (usage);
    perform bk_ops_private.audit (period.project_id, ret.contact_id, 'retainer_usage', case
  when qty < 0 then
    'Returned allowance: '
  else 'Recorded fulfilled deliverables: '
end || abs (qty) || ' ' || allowance.label);
  when 'adjust_allowance' then
    select * into allowance from public.bk_retainer_allowances where period_id = (p_data ->> 'period_id') :: uuid
    and item_key = p_data ->> 'item_key' for update;
    if not found then
      raise exception 'Allowance not found';
    end if;
    if length (trim (coalesce (p_data ->> 'note', ''))) < 10 then
      raise exception 'Explain the allowance adjustment in at least 10 characters';
    end if;
    qty := (p_data ->> 'included') :: int;
    select coalesce (sum (quantity_delta), 0) :: int into used from public.bk_retainer_usage where period_id = allowance.period_id
    and item_key = allowance.item_key;
    if qty < used then
      raise exception 'The allowance cannot be reduced below fulfilled usage';
    end if;
    update public.bk_retainer_allowances set included = qty where period_id = allowance.period_id and item_key = allowance.item_key;
    select * into period from public.bk_retainer_periods where public.bk_retainer_periods.id = allowance.period_id;
    result := jsonb_build_object ('included', qty);
    perform bk_ops_private.audit (period.project_id, null, 'retainer_allowance_adjusted', 'Allowance adjusted: ' || allowance.label || ' to ' || qty || '. ' || left (p_data ->> 'note',
    250));
  when 'close_period' then
    update public.bk_retainer_periods set status = 'closed' where public.bk_retainer_periods.id = v_id returning *
    into period;
    if not found then
      raise exception 'Work period not found';
    end if;
    result := to_jsonb (period);
    perform bk_ops_private.audit (period.project_id, null, 'retainer_period_closed', 'Closed monthly allowance period');
  when 'prepare_invoice' then
    select * into period from public.bk_retainer_periods where public.bk_retainer_periods.id = (p_data ->> 'period_id') :: uuid for update;
    if not found then
      raise exception 'Work period not found';
    end if;
    select * into ret from public.bk_retainers where public.bk_retainers.id = period.retainer_id;
    select * into project from public.bk_projects where public.bk_projects.id = period.project_id for update;
    if project.billing_provider <> period.billing_provider or project.billing_requires_reconciliation then
      raise exception 'Confirm the existing project billing provider first';
    end if;
    if period.invoice_id is null then
      if period.monthly_amount_cents <= 0 then
        raise exception 'This is a zero-fee period; no payment invoice is needed';
      end if;
      insert into public.bk_invoices (project_id, title, line_items, amount_cents, kind, status,
      source, due_date) values (period.project_id, ret.name || ' · ' || to_char (period.period_month,
      'Mon YYYY'), jsonb_build_array (jsonb_build_object ('label', ret.name, 'amount_cents',
      period.monthly_amount_cents)), period.monthly_amount_cents, 'balance', 'draft', 'retainer',
      period.starts_on) returning * into inv;
      update public.bk_retainer_periods set invoice_id = inv.id where public.bk_retainer_periods.id = period.id;
      perform bk_ops_private.audit (period.project_id, ret.contact_id, 'retainer_invoice_prepared',
      'Prepared draft monthly invoice in ' || period.billing_provider);
    else
      select * into inv from public.bk_invoices where public.bk_invoices.id = period.invoice_id;
    end if;
    result := to_jsonb (inv);
  else
    raise exception 'Unknown studio operation';
  end case;
  insert into bk_ops_private.requests (actor_id, request_id, action, payload, result) values (uid,
  p_request_id, p_action, p_data, result);
  return result;
end
$$;
revoke all on function public.bk_ops_save (text, jsonb, uuid) from public, anon;
grant execute on function public.bk_ops_save (text, jsonb, uuid) to authenticated;

-- Stored closure and calendar availability are separate: an unclosed past
-- month is expired, and future work is not an available current entitlement.
create function bk_ops_private.period_state(p public.bk_retainer_periods)
returns text language sql stable set search_path = '' as $$
  select case
    when p.status = 'closed' then 'closed'
    when (now() at time zone 'America/Chicago')::date < p.starts_on then 'upcoming'
    when (now() at time zone 'America/Chicago')::date > p.ends_on then 'expired'
    else 'open'
  end
$$;

create function bk_ops_private.period_json(p public.bk_retainer_periods)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(p) || jsonb_build_object(
    'period_state', bk_ops_private.period_state(p),
    'package_status', (select status from public.bk_retainers where id = p.retainer_id),
    'invoice_status', (select status from public.bk_invoices where id = p.invoice_id),
    'allowances', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', a.item_key,
        'label', a.label,
        'included', a.included,
        'used', coalesce(u.used, 0),
        'remaining', a.included - coalesce(u.used, 0),
        'available_now', case
          when bk_ops_private.period_state(p) = 'open'
            and exists(select 1 from public.bk_retainers where id = p.retainer_id and status in ('active', 'paused'))
          then a.included - coalesce(u.used, 0)
          else 0
        end
      ) order by a.item_key)
      from public.bk_retainer_allowances a
      left join lateral (
        select sum(quantity_delta)::int used
        from public.bk_retainer_usage
        where period_id = a.period_id and item_key = a.item_key
      ) u on true
      where a.period_id = p.id
    ), '[]'::jsonb),
    'usage', coalesce((
      select jsonb_agg(to_jsonb(u) || jsonb_build_object(
        'reversible_quantity', case when u.quantity_delta > 0
          then u.quantity_delta + coalesce((
            select sum(r.quantity_delta)::int from public.bk_retainer_usage r where r.reverses_id = u.id
          ), 0)
          else 0
        end
      ) order by u.created_at desc, u.id)
      from public.bk_retainer_usage u where u.period_id = p.id
    ), '[]'::jsonb)
  )
$$;

create function public.bk_ops_profit (p_project uuid default null, p_offset int default 0,
p_limit int default 50, p_query text default '') returns jsonb language plpgsql stable security definer set search_path = '' as
$$
declare
  result jsonb;
begin
  perform bk_crm_private.require_staff ();
  with rows as (select p.id project_id, p.title, p.client_name, p.status, coalesce (q.total_cents,
  0) quote_cents, q.status quote_status, coalesce (i.invoiced, 0) invoiced_cents, coalesce (i.received,
  0) received_cents, coalesce (e.cost, 0) expenses_cents, coalesce (t.cost, 0) labor_cents,
  coalesce (t.minutes, 0) minutes, coalesce (i.received, 0) - coalesce (e.cost, 0) - coalesce (t.cost,
  0) contribution_cents from public.bk_projects p left join lateral (select total_cents,
  status from public.bk_quotes where project_id = p.id and status in ('draft', 'sent', 'accepted') order by created_at desc,
  id desc limit 1) q on true left join lateral (select sum (amount_cents) filter (where status in ('sent',
  'paid')) invoiced, sum (coalesce (paid_amount_cents, amount_cents)) filter (where status = 'paid') received
  from public.bk_invoices where project_id = p.id) i on true left join lateral (select sum (amount_cents) cost
  from public.bk_project_expenses where project_id = p.id and voided_at is null) e on true left join lateral (select sum (round (minutes :: numeric * hourly_cost_cents / 60)) cost,
  sum (minutes) minutes from public.bk_time_entries where project_id = p.id and voided_at is null) t on true
  where (p_project is null or p.id = p_project) and lower (concat_ws (' ', p.title, p.client_name)) like '%' || lower (coalesce (p_query,
  '')) || '%') select jsonb_build_object ('total', (select count (*) from rows), 'rows',
  coalesce ((select jsonb_agg (to_jsonb (r)) from (select * from rows order by title, project_id limit least (greatest (p_limit,
  1), 100) offset greatest (p_offset, 0)) r), '[]' :: jsonb), 'totals', (select jsonb_build_object ('quote_cents',
  coalesce (sum (quote_cents), 0), 'invoiced_cents', coalesce (sum (invoiced_cents), 0),
  'received_cents', coalesce (sum (received_cents), 0), 'expenses_cents', coalesce (sum (expenses_cents),
  0), 'labor_cents', coalesce (sum (labor_cents), 0), 'contribution_cents', coalesce (sum (contribution_cents),
  0), 'minutes', coalesce (sum (minutes), 0)) from rows)) into result;
  return result;
end
$$;

create function public.bk_ops_capacity (p_week date default current_date) returns jsonb language plpgsql stable security definer
set search_path = '' as
$$
declare
  week date := date_trunc ('week', p_week) :: date;
begin
  perform bk_crm_private.require_staff ();
  return jsonb_build_object ('week', week, 'staff', coalesce ((select jsonb_agg (jsonb_build_object ('id',
  p.id, 'full_name', p.full_name, 'weekly_minutes', c.weekly_minutes, 'working_days', c.working_days,
  'hourly_cost_cents', c.hourly_cost_cents, 'assigned_minutes', coalesce (a.n, 0)) order by p.full_name) from public.profiles p left
  join public.bk_staff_capacity c on c.staff_id = p.id left join lateral (select sum (minutes) n from public.bk_edit_allocations
  where staff_id = p.id and status <> 'cancelled' and work_on between week and week + 6) a on true where p.role in ('admin',
  'employee')), '[]' :: jsonb), 'allocations', coalesce ((select jsonb_agg (to_jsonb (a) || jsonb_build_object ('project_title',
  p.title, 'client_name', p.client_name, 'delivery_target', p.delivery_target) order by a.work_on,
  a.created_at) from public.bk_edit_allocations a join public.bk_projects p on p.id = a.project_id where a.work_on between week
  and week + 6), '[]' :: jsonb), 'tasks', coalesce ((select jsonb_agg (jsonb_build_object ('id',
  t.id, 'project_id', t.project_id, 'title', t.title, 'due_at', t.due_at, 'owner_id', t.owner_id)) from public.bk_tasks t
  where status = 'open' and (due_at at time zone 'America/Chicago') :: date between week and week + 6),
  '[]' :: jsonb), 'bookings', coalesce ((select jsonb_agg (jsonb_build_object ('id', b.id,
  'project_id', b.project_id, 'starts_at', b.starts_at, 'status', b.status, 'project_title',
  p.title)) from public.bk_bookings b join public.bk_projects p on p.id = b.project_id where (starts_at at time zone 'America/Chicago') :: date between week
  and week + 6 and b.status not in ('cancelled', 'completed')), '[]' :: jsonb));
end
$$;

create function public.bk_ops_retainers (p_contact uuid default null, p_offset int default 0,
p_limit int default 20, p_query text default '') returns jsonb language plpgsql stable security definer set search_path = '' as
$$
declare
  result jsonb;
begin
  perform bk_crm_private.require_staff ();
  with rows as (select r.*, c.name client_name, c.email client_email, (select count (*) from public.bk_retainer_periods
  where retainer_id = r.id) period_count, coalesce ((select jsonb_agg (bk_ops_private.period_json (p) order by p.period_month desc)
  from public.bk_retainer_periods p where p.retainer_id = r.id), '[]' :: jsonb) periods from public.bk_retainers r
  join public.bk_contacts c on c.id = r.contact_id where (p_contact is null or r.contact_id = p_contact) and lower (concat_ws (' ',
  r.name, c.name)) like '%' || lower (coalesce (p_query, '')) || '%') select jsonb_build_object ('total',
  (select count (*) from rows), 'rows', coalesce ((select jsonb_agg (to_jsonb (r)) from (select * from rows order by updated_at desc,
  id limit least (greatest (p_limit, 1), 50) offset greatest (p_offset, 0)) r), '[]' :: jsonb)) into result;
  return result;
end
$$;

create function public.bk_ops_project (p_project uuid) returns jsonb language plpgsql stable security definer
set search_path = '' as
$$
declare
  p public.bk_projects;
begin
  perform bk_crm_private.require_staff ();
  select * into p from public.bk_projects where id = p_project;
  if not found then
    raise exception 'Project not found';
  end if;
  return jsonb_build_object ('profit', public.bk_ops_profit (p.id), 'expenses', coalesce ((select jsonb_agg (to_jsonb (e) order by incurred_on desc,
  created_at desc) from public.bk_project_expenses e where project_id = p.id), '[]' :: jsonb),
  'time_entries', coalesce ((select jsonb_agg (to_jsonb (t) || jsonb_build_object ('staff_name',
  s.full_name) order by worked_on desc, t.created_at desc) from public.bk_time_entries t join public.profiles s
  on s.id = t.staff_id where project_id = p.id), '[]' :: jsonb), 'allocations', coalesce ((select jsonb_agg (to_jsonb (a) order by work_on)
  from public.bk_edit_allocations a where project_id = p.id), '[]' :: jsonb), 'rates', coalesce ((select jsonb_agg (to_jsonb (c))
  from public.bk_staff_capacity c), '[]' :: jsonb), 'retainers', public.bk_ops_retainers (p.contact_id),
  'periods', coalesce ((select jsonb_agg (bk_ops_private.period_json (t) || jsonb_build_object ('retainer_name',
  r.name, 'billing_provider', t.billing_provider) order by t.period_month desc) from public.bk_retainer_periods t
  join public.bk_retainers r on r.id = t.retainer_id where t.project_id = p.id), '[]' :: jsonb));
end
$$;

create function public.bk_ops_portal_retainers (p_project uuid, p_token uuid) returns jsonb language plpgsql stable security definer
set search_path = '' as
$$
declare
  p public.bk_projects;
begin
  select * into p from public.bk_projects where id = p_project and access_token = p_token;
  if not found then
    raise exception 'Project not found';
  end if;
  return jsonb_build_object ('rows', coalesce ((select jsonb_agg (jsonb_build_object ('id',
  r.id, 'name', r.name, 'status', t.status, 'package_status', r.status, 'period_state', bk_ops_private.period_state(t), 'period_id', t.id, 'starts_on', t.starts_on,
  'ends_on', t.ends_on, 'monthly_amount_cents', t.monthly_amount_cents, 'billing_provider',
  t.billing_provider, 'invoice_status', (select status from public.bk_invoices where id = t.invoice_id),
  'allowances', (bk_ops_private.period_json (t) -> 'allowances')) order by t.period_month desc) from public.bk_retainer_periods t
  join public.bk_retainers r on r.id = t.retainer_id where t.project_id = p.id), '[]' :: jsonb));
end
$$;
do
$$
declare
  f record;
begin
  for f in select p.oid :: regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  and p.proname in ('bk_ops_profit', 'bk_ops_capacity', 'bk_ops_retainers', 'bk_ops_project') loop execute format ('revoke all on function %s from public,anon',
  f.sig);
  execute format ('grant execute on function %s to authenticated', f.sig);
  end loop;
end
$$;
revoke all on function public.bk_ops_portal_retainers (uuid, uuid) from public;
grant execute on function public.bk_ops_portal_retainers (uuid, uuid) to anon, authenticated;
revoke all on all functions in schema bk_ops_private from public, anon, authenticated;

-- Existing cron extension, when installed, schedules internal tasks only.
do
$$
begin
  if to_regnamespace ('cron') is not null then
    execute
    $q$
    select cron.schedule ('bk-retainer-renewal-tasks', '15 8 * * *', 'select public.bk_ops_queue_renewals()')
    $q$
    ;
  end if;
end
$$;
commit;
