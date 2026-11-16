-- Staff-only operational visibility. No sends or queue retries are triggered.
alter table public.bk_email_queue add column if not exists delivery_request jsonb;
alter table public.bk_email_queue add column if not exists delivery_started_at timestamptz;
alter table public.bk_email_queue add column if not exists delivery_legacy_review boolean not null default false;
-- Previous workers did not use an idempotency key. An attempted unsent row
-- might already have reached its recipient, so never retry it automatically.
update public.bk_email_queue set delivery_legacy_review=true,attempts=greatest(attempts,5),
  last_error='delivery_review_required: previous worker delivery result needs review. '||coalesce(last_error,'')
where sent_at is null and attempts>0 and delivery_request is null and not delivery_legacy_review;

create or replace function public.bk_crm_mail_request(p_queue uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q public.bk_email_queue;
begin
  select * into q from public.bk_email_queue where id=p_queue for update;
  if not found or q.sent_at is not null then raise exception 'queue_item_not_pending'; end if;
  -- Resend retains idempotency keys for 24 hours. Ambiguous old attempts need review.
  if q.delivery_legacy_review or (q.delivery_started_at is not null and q.delivery_started_at<now()-interval '23 hours') then
    raise exception 'delivery_review_required: verify the original delivery in Resend';
  end if;
  if q.delivery_request is null then
    if p_request is null or jsonb_typeof(p_request)<>'object' or not(p_request ?& array['from','to','reply_to','subject','html']) then raise exception 'invalid_delivery_request'; end if;
    update public.bk_email_queue set delivery_request=p_request,delivery_started_at=now() where id=p_queue;
    return p_request;
  end if;
  return q.delivery_request;
end $$;
revoke all on function public.bk_crm_mail_request(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.bk_crm_mail_request(uuid,jsonb) to service_role;

create or replace function public.bk_crm_health() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.bk_is_staff() then raise exception 'Staff access required' using errcode='42501'; end if;
  select jsonb_build_object(
    'email_failed',(select count(*) from public.bk_email_queue where sent_at is null and send_at<=now() and last_error is not null),
    'email_waiting',(select count(*) from public.bk_email_queue where sent_at is null and send_at<=now()),
    'email_stalled',(select count(*) from public.bk_email_queue where sent_at is null and send_at<now()-interval '10 minutes'),
    'email_review',(select count(*) from public.bk_email_receipts where status='review' and reviewed_at is null),
    'email_review_issues',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select e.email_id,e.project_id,p.title project_title,p.client_name,e.reason,e.created_at
      from public.bk_email_receipts e join public.bk_projects p on p.id=e.project_id
      where e.status='review' and e.reviewed_at is null order by e.created_at desc limit 10)r),'[]'::jsonb),
    'email_issues',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select q.id,q.project_id,p.title project_title,q.kind,q.attempts,left(q.last_error,400) last_error,q.created_at
      from public.bk_email_queue q left join public.bk_projects p on p.id=q.project_id
      where q.sent_at is null and q.send_at<=now() and q.last_error is not null
      order by q.created_at desc,q.id limit 10)r),'[]'::jsonb),
    'billing_unassigned',(select count(*) from public.bk_projects p where p.billing_provider='unassigned' and exists(select 1 from public.bk_invoices i where i.project_id=p.id and i.status in ('sent','paid'))),
    'billing_issues',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select p.id,p.client_name,p.title from public.bk_projects p where p.billing_provider='unassigned'
        and exists(select 1 from public.bk_invoices i where i.project_id=p.id and i.status in ('sent','paid'))
      order by p.updated_at desc,p.id limit 10)r),'[]'::jsonb),
    'content_ready',to_regclass('public.bk_content_posts') is not null,
    'checked_at',now()
  ) into result;
  return result;
end $$;
revoke all on function public.bk_crm_health() from public,anon;
grant execute on function public.bk_crm_health() to authenticated;

-- Invoice edits and manual payment recording belong in the same immutable
-- project history as quotes, stage changes and provider decisions.
create or replace function bk_crm_private.invoice_activity() returns trigger
language plpgsql security definer set search_path='' as $$
declare label text;
begin
  if tg_op='INSERT' then label:='Invoice created';
  elsif row(new.status,new.amount_cents,new.paid_amount_cents,new.due_date,new.title,new.payment_note)
    is distinct from row(old.status,old.amount_cents,old.paid_amount_cents,old.due_date,old.title,old.payment_note)
    then label:='Invoice updated: '||old.status||' → '||new.status;
  else return new; end if;
  insert into public.bk_activities(project_id,contact_id,actor_id,kind,summary)
  select new.project_id,p.contact_id,auth.uid(),'invoice_updated',label from public.bk_projects p where p.id=new.project_id;
  return new;
end $$;
revoke all on function bk_crm_private.invoice_activity() from public,anon,authenticated;
create trigger bk_crm_invoice_activity after insert or update on public.bk_invoices
for each row execute function bk_crm_private.invoice_activity();
