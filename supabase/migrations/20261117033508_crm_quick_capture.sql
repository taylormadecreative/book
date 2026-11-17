-- Mobile and shared-message capture is one staff-only, retry-safe transaction.
create table bk_crm_private.capture_requests (
  user_id uuid not null,
  request_id uuid not null,
  fingerprint text not null,
  project_id uuid not null references public.bk_projects(id),
  primary key (user_id, request_id)
);
alter table bk_crm_private.capture_requests enable row level security;
revoke all on bk_crm_private.capture_requests from public, anon, authenticated;

create function public.bk_crm_capture_lead(p_data jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_request uuid := nullif(p_data->>'request_id','')::uuid;
  v_fingerprint text := md5((p_data-'request_id')::text);
  v_receipt bk_crm_private.capture_requests;
  v_project jsonb;
  v_due timestamptz := nullif(p_data->>'next_due_at','')::timestamptz;
  v_action text := coalesce(nullif(trim(p_data->>'next_action'),''),'Reply to new inquiry');
begin
  perform bk_crm_private.require_staff();
  if v_request is null then raise exception 'A capture request ID is required'; end if;
  if jsonb_typeof(p_data) <> 'object' or length(coalesce(p_data->>'client_name','')) > 120
    or length(coalesce(p_data->>'details','')) > 4000
    or length(coalesce(p_data->>'title','')) > 240
    or length(v_action) > 180 then
    raise exception 'Check the name, message and next action lengths';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('crm-capture:'||auth.uid()::text||':'||v_request::text,0));
  select * into v_receipt from bk_crm_private.capture_requests
    where user_id=auth.uid() and request_id=v_request;
  if found then
    if v_receipt.fingerprint <> v_fingerprint then raise exception 'request_changed'; end if;
    select bk_crm_private.project_json(p) into v_project from public.bk_projects p where id=v_receipt.project_id;
    return v_project;
  end if;
  v_project := public.bk_crm_create_project(p_data);
  update public.bk_tasks set title=v_action, due_at=coalesce(v_due,due_at)
    where project_id=(v_project->>'id')::uuid and automation_key='initial_followup' and status='open';
  insert into bk_crm_private.capture_requests values(auth.uid(),v_request,v_fingerprint,(v_project->>'id')::uuid);
  return v_project;
end $$;
revoke all on function public.bk_crm_capture_lead(jsonb) from public,anon,authenticated;
grant execute on function public.bk_crm_capture_lead(jsonb) to authenticated;
