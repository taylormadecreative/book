-- 2026-10-21 · client portal: extra edits at a per-photo price (Nelson: $35/image).
-- Once picks are sent, the client can add more photos from the same proof set. Each one
-- becomes a pick marked `extra`, one "Extra edits" invoice is created for them to pay in
-- the portal, and a message lists the files so Nelson sees the request in his inbox.
-- The price lives in bk_config.extra_edit_cents; the client never sends an amount.

alter table public.bk_gallery_items add column if not exists extra boolean not null default false;
-- who raised the invoice: null = Nelson (dashboard / booking flow), 'portal_extras' = the client
alter table public.bk_invoices add column if not exists source text;

insert into public.bk_config (key, value) values ('extra_edit_cents', '3500')
  on conflict (key) do nothing;

create or replace function public.bk_extra_edit_cents()
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((select value::integer from public.bk_config where key = 'extra_edit_cents'), 3500)
$$;
grant execute on function public.bk_extra_edit_cents() to anon, authenticated;

create or replace function public.bk_portal_request_extras(p_project uuid, p_token uuid, p_gallery uuid, p_items uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_price integer := public.bk_extra_edit_cents();
  v_gal record;
  v_n integer;
  v_names text;
  v_total integer;
  v_each text;
  v_sum text;
  v_inv uuid;
begin
  if not exists (select 1 from public.bk_projects where id = p_project and access_token = p_token) then
    raise exception 'not found';
  end if;
  select id, title, kind, locked into v_gal
    from public.bk_galleries where id = p_gallery and project_id = p_project;
  if v_gal.id is null or v_gal.kind <> 'proof' then
    raise exception 'not found';
  end if;
  -- the included picks go first; extras are added on top of a sent set
  if not v_gal.locked then
    raise exception 'send_picks_first';
  end if;
  if p_items is null or cardinality(p_items) < 1 or cardinality(p_items) > 100 then
    raise exception 'bad_items';
  end if;

  -- only photos from this set that aren't already picks; a double tap finds nothing new
  select count(*), string_agg(filename, E'\n' order by sort)
    into v_n, v_names
    from public.bk_gallery_items
   where gallery_id = p_gallery and id = any(p_items) and not selected;
  if v_n = 0 then
    raise exception 'nothing_to_add';
  end if;

  v_total := v_n * v_price;
  v_each := '$' || case when v_price % 100 = 0 then (v_price / 100)::text else to_char(v_price / 100.0, 'FM999990.00') end;
  v_sum := '$' || case when v_total % 100 = 0 then (v_total / 100)::text else to_char(v_total / 100.0, 'FM999990.00') end;

  update public.bk_gallery_items
     set selected = true, extra = true, selected_at = now()
   where gallery_id = p_gallery and id = any(p_items) and not selected;

  insert into public.bk_invoices (project_id, title, kind, status, amount_cents, due_date, source, line_items)
  values (p_project, 'Extra edits', 'custom', 'sent', v_total, current_date, 'portal_extras',
          jsonb_build_array(jsonb_build_object(
            'title', format('Extra edits · %s photo%s × %s', v_n, case when v_n = 1 then '' else 's' end, v_each),
            'amount_cents', v_total)))
  returning id into v_inv;

  insert into public.bk_messages (project_id, sender, body)
  values (p_project, 'client', left(format(
    'Added %s extra edit%s from "%s" (%s each, %s total). Paying in the portal.%s%s',
    v_n, case when v_n = 1 then '' else 's' end, v_gal.title, v_each, v_sum, E'\n\n', v_names), 4000));

  return jsonb_build_object('ok', true, 'invoice_id', v_inv, 'count', v_n, 'amount_cents', v_total);
end $$;
grant execute on function public.bk_portal_request_extras(uuid, uuid, uuid, uuid[]) to anon, authenticated;

-- the "Your quote is ready" email is for invoices Nelson sends; a client's own extras request
-- is paid on the spot in the portal, so it skips that email (Nelson still gets the payment alert)
create or replace function public.bk_on_invoice_sent()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- same-transaction-as-project = auto-created by bk_create_booking; skip
  if exists (select 1 from public.bk_projects p
             where p.id = new.project_id and p.created_at = new.created_at) then
    return new;
  end if;
  -- auto-balance invoice: bk-charge-balances handles the client email
  if new.kind = 'balance' and exists (select 1 from public.bk_bookings b
                                      where b.balance_invoice_id = new.id) then
    return new;
  end if;
  -- the client raised it themselves (extra edits) and is paying in the portal right now
  if new.source = 'portal_extras' then
    return new;
  end if;
  insert into public.bk_email_queue (project_id, kind, payload)
  values (new.project_id, 'invoice_sent',
          jsonb_build_object('invoice_id', new.id));
  return new;
end $function$;
