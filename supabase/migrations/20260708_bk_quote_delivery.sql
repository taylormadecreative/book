-- BK QUOTE DELIVERY — when Nelson sends a custom invoice (quote) or a portal
-- message from the admin dashboard, the client gets an email automatically.
-- Instant-book checkout invoices are excluded: they are inserted in the SAME
-- transaction as their project (identical created_at), and the client is
-- already on the Stripe page at that moment.

alter table public.bk_email_queue drop constraint bk_email_queue_kind_check;
alter table public.bk_email_queue add constraint bk_email_queue_kind_check
  check (kind in ('confirmation','prep','reminder','nelson_alert','inquiry_ack',
                  'invoice_sent','new_message'));

-- Nelson creates an invoice as 'sent' from admin (insert) …
create or replace function public.bk_on_invoice_sent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- same-transaction-as-project = auto-created by bk_create_booking; skip
  if exists (select 1 from public.bk_projects p
             where p.id = new.project_id and p.created_at = new.created_at) then
    return new;
  end if;
  insert into public.bk_email_queue (project_id, kind, payload)
  values (new.project_id, 'invoice_sent',
          jsonb_build_object('invoice_id', new.id));
  return new;
end $$;
create trigger bk_invoice_sent_ins after insert on public.bk_invoices
  for each row when (new.status = 'sent')
  execute function public.bk_on_invoice_sent();
-- … or promotes a draft to 'sent'
create trigger bk_invoice_sent_upd after update on public.bk_invoices
  for each row when (new.status = 'sent' and old.status = 'draft')
  execute function public.bk_on_invoice_sent();

-- studio portal message -> one pending "you have a new message" email per project
create or replace function public.bk_on_studio_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.bk_email_queue q
                 where q.project_id = new.project_id
                   and q.kind = 'new_message' and q.sent_at is null) then
    insert into public.bk_email_queue (project_id, kind, payload)
    values (new.project_id, 'new_message',
            jsonb_build_object('snippet', left(new.body, 200)));
  end if;
  return new;
end $$;
create trigger bk_studio_message after insert on public.bk_messages
  for each row when (new.sender = 'studio')
  execute function public.bk_on_studio_message();
