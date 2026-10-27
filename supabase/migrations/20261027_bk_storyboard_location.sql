-- 2026-10-27 · storyboard review, location mode (first use: Delilah's Hide & Haunt building).
-- A review gallery can be a storyboard (frames of the commercial) or a location (reference images
-- of the place every shot is built in). Same review: a note per image, then approve or send notes.
-- A location never replaces a storyboard (or the other way round); each has its own rounds.
alter table public.bk_galleries add column if not exists purpose text
  check (purpose is null or purpose in ('storyboard', 'location'));

-- an earlier round = a newer review OF THE SAME KIND that the client can see
create or replace function public.bk_storyboard_superseded(p_gallery uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.bk_galleries g
      join public.bk_galleries o on o.project_id = g.project_id and o.kind = 'storyboard' and o.id <> g.id
     where g.id = p_gallery
       and coalesce(o.purpose, 'storyboard') = coalesce(g.purpose, 'storyboard')
       and o.created_at > g.created_at
       and not (o.locked and o.review_outcome is null));
$$;

-- same review as before; only Nelson's message names what was reviewed
create or replace function public.bk_storyboard_submit(p_gallery uuid, p_expect text, p_expect_notes integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gal public.bk_galleries;
  v_n integer;
  v_k integer;
  v_outcome text;
  v_now timestamptz := now();
  v_body text;
  v_more integer := 0;
  v_loc boolean;
  r record;
begin
  select * into v_gal from public.bk_galleries where id = p_gallery for update;
  if not found or v_gal.kind <> 'storyboard' then raise exception 'not_found'; end if;
  if v_gal.locked then raise exception 'already_submitted'; end if;
  if public.bk_storyboard_superseded(p_gallery) then raise exception 'superseded'; end if;
  select count(*), count(client_note) into v_n, v_k from public.bk_gallery_items where gallery_id = p_gallery;
  if v_n = 0 then raise exception 'empty'; end if;
  v_outcome := case when v_k > 0 then 'changes' else 'approved' end;
  if (p_expect is not null and p_expect <> v_outcome) or (p_expect_notes is not null and p_expect_notes <> v_k) then
    raise exception 'outcome_changed';
  end if;
  v_loc := coalesce(v_gal.purpose = 'location', false);  -- no purpose = a storyboard

  update public.bk_galleries set locked = true, review_outcome = v_outcome, reviewed_at = v_now where id = p_gallery;

  -- sent as the client (it shows as "You" in her thread); Nelson's phone buzzes
  if v_outcome = 'approved' then
    v_body := case when v_loc
      then format('I approved the location "%s" (%s images).', v_gal.title, v_n)
      else format('I approved the storyboard "%s" (%s frames).', v_gal.title, v_n) end;
  else
    v_body := format('My notes on %s %s%s of "%s":', v_k, case when v_loc then 'image' else 'frame' end,
      case when v_k = 1 then '' else 's' end, v_gal.title);
    for r in
      select coalesce(meta->>'code', '#' || sort) as code, meta->>'tc' as tc, client_note
        from public.bk_gallery_items
       where gallery_id = p_gallery and client_note is not null
       order by sort, created_at
    loop
      if v_more > 0 or length(v_body) + length(r.client_note) + 60 > 3900 then v_more := v_more + 1; continue; end if;
      v_body := v_body || E'\n\n' || concat_ws(' · ', r.code, r.tc) || E'\n' || r.client_note;
    end loop;
    if v_more > 0 then
      v_body := v_body || format(E'\n\n+%s more note%s on the %s.', v_more, case when v_more = 1 then '' else 's' end,
        case when v_loc then 'images' else 'frames' end);
    end if;
  end if;
  insert into public.bk_messages (project_id, sender, body) values (v_gal.project_id, 'client', left(v_body, 4000));

  -- a location has no deposit step: only an approved storyboard leads to the invoice
  return jsonb_build_object('ok', true, 'outcome', v_outcome, 'notes', v_k, 'reviewed_at', v_now,
    'pay_url', case when v_outcome = 'approved' and not v_loc then v_gal.pay_url end);
end $$;

revoke all on function public.bk_storyboard_superseded(uuid) from public, anon, authenticated;
revoke all on function public.bk_storyboard_submit(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.bk_storyboard_superseded(uuid) to service_role;
grant execute on function public.bk_storyboard_submit(uuid, text, integer) to service_role;
