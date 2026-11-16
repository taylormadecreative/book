-- Retry-safe public intake. A random submission capability belongs to one exact
-- request; replaying it never creates another project, invoice, task or email.
create table if not exists public.bk_intake_receipts (
  submission_id uuid primary key,
  fingerprint text not null,
  project_id uuid not null references public.bk_projects(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.bk_intake_receipts enable row level security;
revoke all on public.bk_intake_receipts from public, anon, authenticated;

create or replace function public.bk_submit_inquiry_once(
  p_submission_id uuid, p_name text, p_email text, p_service text,
  p_phone text default null, p_company text default null,
  p_event_date date default null, p_location text default null,
  p_budget text default null, p_details text default null,
  p_source text default null, p_event_time text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_fingerprint text; v_receipt public.bk_intake_receipts;
  v_id uuid; v_token uuid;
begin
  if p_submission_id is null then raise exception 'submission_id_required'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 120 then raise exception 'name_required'; end if;
  if p_email is null or length(p_email)>200 or trim(p_email) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'valid_email_required'; end if;
  if p_service is null or p_service not in ('music_video','brand_content','photography','event','other','digitals') then raise exception 'invalid_service'; end if;
  if length(coalesce(p_phone,''))>40 or length(coalesce(p_company,''))>160
    or length(coalesce(p_location,''))>240 or length(coalesce(p_budget,''))>200
    or length(coalesce(p_details,''))>4000 or length(coalesce(p_source,''))>240
    or length(coalesce(p_event_time,''))>80 then raise exception 'input_too_long'; end if;
  v_fingerprint := md5(jsonb_build_array(trim(p_name),lower(trim(p_email)),p_service,p_phone,p_company,p_event_date,p_location,p_budget,p_details,p_source,p_event_time)::text);
  perform pg_advisory_xact_lock(hashtextextended('bk-intake:'||p_submission_id::text,0));
  select * into v_receipt from public.bk_intake_receipts where submission_id=p_submission_id;
  if found then
    if v_receipt.fingerprint<>v_fingerprint then raise exception 'submission_changed'; end if;
    select id,access_token into v_id,v_token from public.bk_projects where id=v_receipt.project_id;
    return jsonb_build_object('id',v_id,'token',v_token);
  end if;

  insert into public.bk_projects(client_name,client_email,client_phone,company,service,event_date,event_time,location,budget_range,details,referral_source,title)
  values(trim(p_name),lower(trim(p_email)),nullif(trim(p_phone),''),nullif(trim(p_company),''),p_service,p_event_date,p_event_time,p_location,p_budget,p_details,
    coalesce(nullif(trim(p_source),''),'Website'),trim(p_name)||' — '||initcap(replace(p_service,'_',' ')))
  returning id,access_token into v_id,v_token;
  insert into public.bk_intake_receipts(submission_id,fingerprint,project_id) values(p_submission_id,v_fingerprint,v_id);
  if p_service='digitals' then
    insert into public.bk_invoices(project_id,title,amount_cents,kind,status,source,line_items)
    values(v_id,'Digitals session',10000,'full','sent','digitals','[{"label":"Digitals session, flat rate","amount_cents":10000}]'::jsonb);
  else
    insert into public.bk_email_queue(project_id,kind,payload) values
      (v_id,'inquiry_ack',jsonb_build_object('service',p_service)),
      (v_id,'nelson_alert',jsonb_build_object('type','inquiry','service',p_service));
  end if;
  return jsonb_build_object('id',v_id,'token',v_token);
end $$;
revoke all on function public.bk_submit_inquiry_once(uuid,text,text,text,text,text,date,text,text,text,text,text) from public;
grant execute on function public.bk_submit_inquiry_once(uuid,text,text,text,text,text,date,text,text,text,text,text) to anon,authenticated;

create or replace function public.bk_book_digitals_once(
  p_submission_id uuid,p_name text,p_email text,p_phone text default null,
  p_event_date date default null,p_location text default null,p_notes text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;
begin
  if p_submission_id is null then raise exception 'submission_id_required'; end if;
  v_result:=public.bk_submit_inquiry_once(p_submission_id,p_name,p_email,'digitals',p_phone,null,p_event_date,p_location,null,p_notes,'Website digitals',null);
  return v_result;
end $$;
revoke all on function public.bk_book_digitals_once(uuid,text,text,text,date,text,text) from public;
grant execute on function public.bk_book_digitals_once(uuid,text,text,text,date,text,text) to anon,authenticated;
