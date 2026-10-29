-- Video held until the balance is paid (2026-10-29, first used for Delilah Amaro's Hide & Haunt commercial).
-- A video gallery with unlock_invoice_id set streams the client a watermarked copy stored next to each
-- original under preview/ (same file name) until that invoice is paid. bk-media never signs the original
-- for the client before then, and there is no download link. Paid (Stripe in the portal, or "Mark paid"
-- in admin) = the original and its Download come back on the next load.

-- restrict, not set null: deleting the invoice must never quietly unlock the video
alter table public.bk_galleries
  add column if not exists unlock_invoice_id uuid references public.bk_invoices(id) on delete restrict;

-- the balance that unlocks a video goes out with Nelson's own portal message, not the "quote is ready" email
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
  -- the balance on a held video: Nelson tells her about it himself
  if new.source = 'video_unlock' then
    return new;
  end if;
  insert into public.bk_email_queue (project_id, kind, payload)
  values (new.project_id, 'invoice_sent',
          jsonb_build_object('invoice_id', new.id));
  return new;
end $function$;
