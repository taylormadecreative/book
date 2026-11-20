-- Open money: manual deal reminders and proposal view counts. No outbound messages, no payment records.
begin;

-- One row is one thing a client still has to decide, sign or pay. Staff keep
-- these by hand: nothing here is imported from HoneyBook, email or a bank.
create table public.bk_money_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  project_id uuid references public.bk_projects(id),
  client_name text not null check (char_length(btrim(client_name)) between 1 and 120),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  amount_cents bigint check (amount_cents between 0 and 1000000000),
  step text not null default 'decision' check (step in ('decision','signature','payment')),
  ball text not null default 'client' check (ball in ('client','me')),
  provider text not null default 'other' check (provider in ('honeybook','stripe','zelle','ach','other')),
  link_url text check (char_length(link_url)<=500 and link_url ~ '^https://[^[:space:]]+$'),
  next_move text check (char_length(next_move)<=240),
  next_move_on date,
  staged_note text check (char_length(staged_note)<=240),
  hold_reason text check (char_length(hold_reason)<=240),
  sent_on date,
  due_on date,
  notes text check (char_length(notes)<=2000),
  view_key text not null unique default replace(gen_random_uuid()::text,'-',''),
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  view_count int not null default 0,
  closed_at timestamptz,
  outcome text check (outcome in ('paid','lost','dropped')),
  check ((closed_at is null) = (outcome is null))
);
create index bk_money_items_open on public.bk_money_items(closed_at);
alter table public.bk_money_items enable row level security;
revoke all on public.bk_money_items from public,anon,authenticated;

-- Only human edits move updated_at. A counted proposal view writes the view
-- columns alone, which this column list leaves out.
create trigger bk_money_items_touch before update of
  project_id,client_name,title,amount_cents,step,ball,provider,link_url,
  next_move,next_move_on,staged_note,hold_reason,sent_on,due_on,notes,
  closed_at,outcome
  on public.bk_money_items for each row execute function public.bk_touch();

-- Keeps only the editable keys and turns blank strings into null.
create function bk_crm_private.money_clean(p_item jsonb) returns jsonb
language sql immutable set search_path='' as $$
  select coalesce(jsonb_object_agg(
    e.key,
    case
      when jsonb_typeof(e.value)='string' and btrim(e.value#>>'{}')='' then 'null'::jsonb
      when jsonb_typeof(e.value)='string' then to_jsonb(btrim(e.value#>>'{}'))
      else e.value
    end
  ),'{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(p_item)='object' then p_item else '{}'::jsonb end) e
  where e.key in (
    'id','project_id','client_name','title','amount_cents','step','ball','provider','link_url',
    'next_move','next_move_on','staged_note','hold_reason','sent_on','due_on','notes'
  )
$$;

create function public.bk_money_save(p_item jsonb,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  payload jsonb:=jsonb_build_object('item',p_item);
  v jsonb:=bk_crm_private.money_clean(p_item);
  it public.bk_money_items;
  amount jsonb;
  r jsonb;
begin
  perform bk_crm_private.require_staff();
  r:=bk_crm_private.growth_request(p_request_id,'money_save',payload);
  if r is not null then
    return r;
  end if;

  if v->>'id' is null then
    it.step:='decision';
    it.ball:='client';
    it.provider:='other';
  else
    select * into it from public.bk_money_items where id=(v->>'id')::uuid for update;
    if not found then
      raise exception 'money_item_not_found';
    end if;
    if it.closed_at is not null then
      raise exception 'item_closed';
    end if;
  end if;

  if v ? 'project_id' then it.project_id:=(v->>'project_id')::uuid; end if;
  if v ? 'client_name' then it.client_name:=v->>'client_name'; end if;
  if v ? 'title' then it.title:=v->>'title'; end if;
  if v ? 'amount_cents' then
    amount:=v->'amount_cents';
    if jsonb_typeof(amount)='null' then
      it.amount_cents:=null;
    elsif jsonb_typeof(amount)<>'number' or (amount#>>'{}')::numeric<>trunc((amount#>>'{}')::numeric)
      or (amount#>>'{}')::numeric not between 0 and 1000000000 then
      raise exception 'invalid_amount';
    else
      it.amount_cents:=(amount#>>'{}')::bigint;
    end if;
  end if;
  if v ? 'step' then it.step:=v->>'step'; end if;
  if v ? 'ball' then it.ball:=v->>'ball'; end if;
  if v ? 'provider' then it.provider:=v->>'provider'; end if;
  if v ? 'link_url' then it.link_url:=v->>'link_url'; end if;
  if v ? 'next_move' then it.next_move:=v->>'next_move'; end if;
  if v ? 'next_move_on' then it.next_move_on:=(v->>'next_move_on')::date; end if;
  if v ? 'staged_note' then it.staged_note:=v->>'staged_note'; end if;
  if v ? 'hold_reason' then it.hold_reason:=v->>'hold_reason'; end if;
  if v ? 'sent_on' then it.sent_on:=(v->>'sent_on')::date; end if;
  if v ? 'due_on' then it.due_on:=(v->>'due_on')::date; end if;
  if v ? 'notes' then it.notes:=v->>'notes'; end if;

  if coalesce(it.client_name,'')='' then
    raise exception 'client_name_required';
  end if;
  if coalesce(it.title,'')='' then
    raise exception 'title_required';
  end if;
  if it.step is null or it.step not in ('decision','signature','payment') then
    raise exception 'invalid_step';
  end if;
  if it.ball is null or it.ball not in ('client','me') then
    raise exception 'invalid_ball';
  end if;
  if it.provider is null or it.provider not in ('honeybook','stripe','zelle','ach','other') then
    raise exception 'invalid_provider';
  end if;
  if it.link_url is not null and (it.link_url !~ '^https://[^[:space:]]+$' or char_length(it.link_url)>500) then
    raise exception 'invalid_link';
  end if;

  if it.id is null then
    insert into public.bk_money_items(
      project_id,client_name,title,amount_cents,step,ball,provider,link_url,
      next_move,next_move_on,staged_note,hold_reason,sent_on,due_on,notes
    ) values (
      it.project_id,it.client_name,it.title,it.amount_cents,it.step,it.ball,it.provider,it.link_url,
      it.next_move,it.next_move_on,it.staged_note,it.hold_reason,it.sent_on,it.due_on,it.notes
    ) returning * into it;
  else
    update public.bk_money_items set
      project_id=it.project_id,client_name=it.client_name,title=it.title,amount_cents=it.amount_cents,
      step=it.step,ball=it.ball,provider=it.provider,link_url=it.link_url,
      next_move=it.next_move,next_move_on=it.next_move_on,staged_note=it.staged_note,
      hold_reason=it.hold_reason,sent_on=it.sent_on,due_on=it.due_on,notes=it.notes
    where id=it.id
    returning * into it;
  end if;

  r:=to_jsonb(it);
  perform bk_crm_private.growth_remember(p_request_id,'money_save',payload,r);
  return r;
end $$;

create function public.bk_money_close(p_id uuid,p_outcome text,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  payload jsonb:=jsonb_build_object('id',p_id,'outcome',p_outcome);
  it public.bk_money_items;
  r jsonb;
begin
  perform bk_crm_private.require_staff();
  r:=bk_crm_private.growth_request(p_request_id,'money_close',payload);
  if r is not null then
    return r;
  end if;
  if p_outcome is null or p_outcome not in ('paid','lost','dropped') then
    raise exception 'invalid_outcome';
  end if;
  select * into it from public.bk_money_items where id=p_id for update;
  if not found then
    raise exception 'money_item_not_found';
  end if;
  -- Closing only ends the reminder. It records no payment anywhere.
  if it.closed_at is null then
    update public.bk_money_items set closed_at=now(),outcome=p_outcome
    where id=p_id returning * into it;
  end if;
  r:=to_jsonb(it);
  perform bk_crm_private.growth_remember(p_request_id,'money_close',payload,r);
  return r;
end $$;

create function public.bk_money_reopen(p_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  payload jsonb:=jsonb_build_object('id',p_id);
  it public.bk_money_items;
  r jsonb;
begin
  perform bk_crm_private.require_staff();
  r:=bk_crm_private.growth_request(p_request_id,'money_reopen',payload);
  if r is not null then
    return r;
  end if;
  select * into it from public.bk_money_items where id=p_id for update;
  if not found then
    raise exception 'money_item_not_found';
  end if;
  if it.closed_at is not null then
    update public.bk_money_items set closed_at=null,outcome=null
    where id=p_id returning * into it;
  end if;
  r:=to_jsonb(it);
  perform bk_crm_private.growth_remember(p_request_id,'money_reopen',payload,r);
  return r;
end $$;

create function public.bk_money_board(p_show text default 'open',p_day date default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  d date:=coalesce(p_day,(now() at time zone 'America/Chicago')::date);
  r jsonb;
begin
  perform bk_crm_private.require_staff();
  if p_show is null or p_show not in ('open','closed') then
    raise exception 'invalid_show';
  end if;
  with marked as (
    select i,
      coalesce(i.closed_at is null and i.step='payment' and i.due_on<d,false) overdue,
      coalesce(i.closed_at is null and i.next_move_on<=d,false) due,
      d-i.sent_on days_waiting
    from public.bk_money_items i
  ),
  grouped as (
    select m.*,
      case
        when (m.i).hold_reason is not null then 'hold'
        when (m.i).ball='me' or (m.i).staged_note is not null then 'me'
        when m.overdue then 'overdue'
        else 'client'
      end grp
    from marked m
  ),
  shaped as (
    select g.*,
      array_position(array['me','overdue','client','hold'],g.grp) pos,
      to_jsonb(g.i)||jsonb_build_object(
        'overdue',g.overdue,'due',g.due,'days_waiting',g.days_waiting,'group',g.grp
      ) j
    from grouped g
  ),
  open_rows as (
    select * from shaped s where (s.i).closed_at is null
  ),
  picked as (
    select s.j,
      row_number() over (
        order by s.pos,(s.i).next_move_on nulls last,(s.i).created_at,(s.i).id
      ) n
    from open_rows s
    where p_show='open'
    union all
    select s.j,
      row_number() over (order by (s.i).closed_at desc,(s.i).id) n
    from shaped s
    where p_show='closed' and (s.i).closed_at is not null
  )
  select jsonb_build_object(
    'day',d,
    'show',p_show,
    'totals',(
      select jsonb_build_object(
        'open_cents',coalesce(sum((o.i).amount_cents),0),
        'items',count(*),
        'unpriced',count(*) filter (where (o.i).amount_cents is null),
        'me',count(*) filter (where o.grp='me'),
        'overdue',count(*) filter (where o.grp='overdue'),
        'hold',count(*) filter (where o.grp='hold'),
        'viewed_waiting',count(*) filter (
          where o.grp='client' and (o.i).step in ('decision','signature') and (o.i).view_count>0
        )
      ) from open_rows o
    ),
    'rows',coalesce((
      select jsonb_agg(p.j order by p.n)
      from picked p
      where p.n<=case when p_show='open' then 200 else 50 end
    ),'[]'::jsonb)
  ) into r;
  return r;
end $$;

-- The only public entry point. It answers nothing, ignores unknown or closed
-- items, stores no visitor details, and counts at most one view per item per
-- 30 minutes. The row lock makes concurrent calls serialize on that window.
create function public.bk_money_view(p_key text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_key is null or char_length(p_key)<16 or char_length(p_key)>64 then
    return;
  end if;
  update public.bk_money_items set
    first_viewed_at=coalesce(first_viewed_at,now()),
    last_viewed_at=now(),
    view_count=view_count+1
  where view_key=p_key
    and closed_at is null
    and (last_viewed_at is null or last_viewed_at<now()-interval '30 minutes');
end $$;

-- Staff functions for signed-in staff, the view counter for everyone, and
-- the private helper for no one.
do $$
declare
  f record;
begin
  for f in select p.oid::regprocedure sig,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='bk_crm_private' and p.proname='money_clean') or
    (n.nspname='public' and p.proname in (
      'bk_money_board','bk_money_save','bk_money_close','bk_money_reopen','bk_money_view'
    )) loop
    execute format('revoke all on function %s from public,anon,authenticated',f.sig);
    if f.nspname='public' then
      execute format('grant execute on function %s to authenticated',f.sig);
      if f.proname='bk_money_view' then
        execute format('grant execute on function %s to anon',f.sig);
      end if;
    end if;
  end loop;
end $$;
commit;
