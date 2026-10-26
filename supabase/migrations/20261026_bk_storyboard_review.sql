-- 2026-10-26 · client portal: storyboard review (first use: Delilah Amaro, Hide & Haunt).
-- A storyboard is a gallery of frames in story order. Each frame carries its caption
-- (frame code, timecode, scene, action, dialogue) in `meta`. The client can leave a change
-- note on any frame, then either approve the whole storyboard or send her notes to Nelson.
-- Both lock the gallery and post one message to the thread (so Nelson's phone buzzes).
-- Clients only reach this through the bk-media edge function, which checks the token.

alter table public.bk_galleries drop constraint if exists bk_galleries_kind_check;
alter table public.bk_galleries
  add constraint bk_galleries_kind_check check (kind = any (array['proof','final','video','storyboard']));

-- 'approved' or 'changes', set when the client sends the review; cleared when Nelson reopens it
alter table public.bk_galleries add column if not exists review_outcome text
  check (review_outcome is null or review_outcome in ('approved','changes'));
alter table public.bk_galleries add column if not exists reviewed_at timestamptz;

-- caption for a storyboard frame: { code, tc, scene_no, scene, action, line }
alter table public.bk_gallery_items add column if not exists meta jsonb not null default '{}'::jsonb;
-- the client's change request for this frame (null = no change asked)
alter table public.bk_gallery_items add column if not exists client_note text
  check (client_note is null or char_length(client_note) <= 1000);
alter table public.bk_gallery_items add column if not exists client_note_at timestamptz;

-- where approving takes the client next: her deposit invoice (HoneyBook), pasted in by Nelson in admin
alter table public.bk_galleries add column if not exists pay_url text
  check (pay_url is null or pay_url ~ '^https://[^\s"''<>]+$');

-- A storyboard Nelson is still building is a draft: locked with no review yet. Clients never see a
-- draft; "Send to client" in admin opens it. (No column: locked + review_outcome null = draft.)

-- Is there a newer storyboard on this project that the client can see? Then this one is an earlier round.
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
       and o.created_at > g.created_at
       and not (o.locked and o.review_outcome is null));
$$;

-- Saving a note and sending the review both hold the gallery row, so a note can't slip in while the
-- review is going out, and the lock and Nelson's message land together or not at all.
-- bk-media checks the client's token first, then calls these with the service role.
create or replace function public.bk_storyboard_note(p_item uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gallery uuid;
  v_gal public.bk_galleries;
  v_note text := left(nullif(regexp_replace(coalesce(p_note, ''), '^\s+|\s+$', '', 'g'), ''), 1000);
begin
  select gallery_id into v_gallery from public.bk_gallery_items where id = p_item;
  if not found then raise exception 'not_found'; end if;
  select * into v_gal from public.bk_galleries where id = v_gallery for update;
  if v_gal.kind <> 'storyboard' then raise exception 'not_found'; end if;
  if v_gal.locked then raise exception 'locked'; end if;
  if public.bk_storyboard_superseded(v_gallery) then raise exception 'superseded'; end if;
  update public.bk_gallery_items
     set client_note = v_note, client_note_at = case when v_note is null then null else now() end
   where id = p_item;
  return jsonb_build_object('ok', true, 'note', v_note);
end $$;

-- Notes on any frame = changes; none = approved. Decided here from what's saved. p_expect and
-- p_expect_notes are what the page showed; if they don't match (a note from another device, a note
-- that never saved) nothing is sent and the page reloads.
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

  update public.bk_galleries set locked = true, review_outcome = v_outcome, reviewed_at = v_now where id = p_gallery;

  -- sent as the client (it shows as "You" in her thread); Nelson's phone buzzes
  if v_outcome = 'approved' then
    v_body := format('I approved the storyboard "%s" (%s frames).', v_gal.title, v_n);
  else
    v_body := format('My notes on %s frame%s of "%s":', v_k, case when v_k = 1 then '' else 's' end, v_gal.title);
    for r in
      select coalesce(meta->>'code', '#' || sort) as code, meta->>'tc' as tc, client_note
        from public.bk_gallery_items
       where gallery_id = p_gallery and client_note is not null
       order by sort, created_at
    loop
      -- whole notes while they fit the message; the rest are counted (every note is on its frame in admin)
      if v_more > 0 or length(v_body) + length(r.client_note) + 60 > 3900 then v_more := v_more + 1; continue; end if;
      v_body := v_body || E'\n\n' || concat_ws(' · ', r.code, r.tc) || E'\n' || r.client_note;
    end loop;
    if v_more > 0 then
      v_body := v_body || format(E'\n\n+%s more note%s on the frames.', v_more, case when v_more = 1 then '' else 's' end);
    end if;
  end if;
  insert into public.bk_messages (project_id, sender, body) values (v_gal.project_id, 'client', left(v_body, 4000));

  return jsonb_build_object('ok', true, 'outcome', v_outcome, 'notes', v_k, 'reviewed_at', v_now,
    'pay_url', case when v_outcome = 'approved' then v_gal.pay_url end);
end $$;

-- service role only (bk-media); Supabase grants new functions to anon/authenticated by default
revoke all on function public.bk_storyboard_superseded(uuid) from public, anon, authenticated;
revoke all on function public.bk_storyboard_note(uuid, text) from public, anon, authenticated;
revoke all on function public.bk_storyboard_submit(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.bk_storyboard_superseded(uuid) to service_role;
grant execute on function public.bk_storyboard_note(uuid, text) to service_role;
grant execute on function public.bk_storyboard_submit(uuid, text, integer) to service_role;
