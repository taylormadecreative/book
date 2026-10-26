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
