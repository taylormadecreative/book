-- A held video's preview can be closed once the client has seen it: bk-media then sends no video at
-- all (only a still), so nothing plays until the balance is paid. Reopen = back to null.
alter table public.bk_galleries add column if not exists preview_closed_at timestamptz;
