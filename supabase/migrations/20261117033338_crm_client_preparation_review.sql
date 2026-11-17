-- Versioned client preparation and timestamped video review. No email, message,
-- invoice, payment or booking side effects. Existing bk-media owns media URLs.
begin;
create table public.bk_client_preparations (
  id uuid primary key default gen_random_uuid (),
  project_id uuid not null references public.bk_projects (id),
  revision int not null,
  version uuid not null default gen_random_uuid (),
  service text not null,
  status text not null default 'draft' check (status in ('draft', 'published',
    'submitted', 'reviewed')),
  title text not null check (length(trim(title)) between 1 and 180),
  instructions text not null default '' check (length(instructions) <= 4000),
  questions jsonb not null check (jsonb_typeof(questions) = 'array'),
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  answer_revision int not null default 0,
  feedback text not null default '' check (length(feedback) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  created_by uuid,
  request_id uuid not null default gen_random_uuid (),
  request_fingerprint text not null,
  unique (project_id, revision),
  unique (project_id, request_id)
);
create index bk_preparation_project_idx on public.bk_client_preparations (project_id, revision desc);
alter table public.bk_gallery_items
  add column media_revision uuid not null default gen_random_uuid ();
create table public.bk_video_reviews (
  id uuid primary key default gen_random_uuid (),
  project_id uuid not null references public.bk_projects (id),
  gallery_id uuid not null references public.bk_galleries (id),
  item_id uuid not null references public.bk_gallery_items (id),
  thread_id uuid not null,
  revision int not null,
  version uuid not null default gen_random_uuid (),
  media_revision uuid not null,
  media_scope text not null check (media_scope in ('preview', 'clean')),
  asset_signature text not null,
  title text not null check (length(trim(title)) between 1 and 180),
  status text not null default 'published' check (status in ('published', 'changes', 'approved')),
  notes_revision int not null default 0,
  request_id uuid not null,
  request_fingerprint text not null,
  published_at timestamptz not null default now(),
  decided_at timestamptz,
  approved_by text,
  unique (thread_id, revision),
  unique (project_id, request_id)
);
create index bk_video_reviews_project_idx on public.bk_video_reviews (project_id, published_at desc);
create index bk_video_reviews_item_idx on public.bk_video_reviews (item_id);
create table public.bk_video_notes (
  id uuid primary key default gen_random_uuid (),
  review_id uuid not null references public.bk_video_reviews (id),
  project_id uuid not null references public.bk_projects (id),
  at_seconds numeric(12, 3) not null check (at_seconds between 0 and 21600),
  body text not null check (length(trim(body)) between 1 and 2000),
  revision int not null default 1,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  unique (review_id, request_id)
);
create index bk_video_notes_review_idx on public.bk_video_notes (review_id, at_seconds, id);
create index bk_video_notes_project_idx on public.bk_video_notes (project_id);
do $rls$
declare
  t text;
begin
  foreach t in array array['bk_client_preparations', 'bk_video_reviews', 'bk_video_notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public,anon,authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.bk_is_staff()))', t || '_staff_read', t);
  end loop;
end
$rls$;
create function bk_crm_private.prep_immutable ()
  returns trigger
  language plpgsql
  set search_path = ''
  as $$
begin
  if old.status <> 'draft' and row (new.project_id,
    new.revision,
    new.version,
    new.title,
    new.instructions,
    new.questions) is distinct from row (old.project_id,
  old.revision,
  old.version,
  old.title,
  old.instructions,
  old.questions) then
    raise exception 'Published preparation is immutable';
  end if;
  if old.status in ('submitted', 'reviewed') and new.answers is distinct from old.answers then
    raise exception 'Submitted answers are read-only';
  end if;
  if old.status = 'reviewed' and new.status is distinct from old.status then
    raise exception 'Reviewed preparation is read-only';
  end if;
  return new;
end
$$;
create trigger bk_prep_immutable
  before update on public.bk_client_preparations
  for each row
  execute function bk_crm_private.prep_immutable ();
create function bk_crm_private.video_immutable ()
  returns trigger
  language plpgsql
  set search_path = ''
  as $$
begin
  if row (new.project_id,
    new.gallery_id,
    new.item_id,
    new.thread_id,
    new.revision,
    new.version,
    new.media_revision,
    new.media_scope,
    new.asset_signature,
    new.title) is distinct from row (old.project_id,
  old.gallery_id,
  old.item_id,
  old.thread_id,
  old.revision,
  old.version,
  old.media_revision,
  old.media_scope,
  old.asset_signature,
  old.title) then
    raise exception 'Published review content is immutable';
  end if;
  if old.status <> 'published' and row (new.status,
    new.decided_at,
    new.approved_by) is distinct from row (old.status,
  old.decided_at,
  old.approved_by) then
    raise exception 'Submitted review decision is immutable';
  end if;
  return new;
end
$$;
create trigger bk_video_immutable
  before update on public.bk_video_reviews
  for each row
  execute function bk_crm_private.video_immutable ();
create function bk_crm_private.client_project (p_project uuid, p_token uuid)
  returns public.bk_projects
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
declare
  p public.bk_projects;
begin
  select
    *
  into
    p
  from
    public.bk_projects
  where
    id = p_project
    and access_token = p_token;
  if not found then
    raise exception 'not_found'
      using errcode = '42501';
  end if;
  return p;
end
$$;
create function bk_crm_private.prep_defaults (p_service text)
  returns jsonb
  language plpgsql
  immutable
  set search_path = ''
  as $$
declare
  q jsonb;
begin
  q := jsonb_build_array(
    jsonb_build_object(
      'id', 'goal',
      'label', 'What should this project achieve?',
      'type', 'long',
      'required', true
    ),
    jsonb_build_object(
      'id', 'contact',
      'label', 'Who is the main contact on the day? Include a phone number.',
      'type', 'short',
      'required', true
    )
  );
  if p_service = 'music_video' then
    q := q || '[
  {
    "id": "track",
    "label": "Link to the final track and any lyrics",
    "type": "long",
    "required": true
  },
  {
    "id": "visuals",
    "label": "Visual references, locations and performers",
    "type": "long",
    "required": true
  },
  {
    "id": "permissions",
    "label": "I will confirm access and any required location or performer permissions before the shoot.",
    "type": "check",
    "required": true
  }
]'::jsonb;
  elsif p_service = 'brand_content' then
    q := q || '[
  {
    "id": "audience",
    "label": "Who is the audience, and what should they remember?",
    "type": "long",
    "required": true
  },
  {
    "id": "brand",
    "label": "Brand guidelines, product details or reference links",
    "type": "long",
    "required": false
  },
  {
    "id": "approver",
    "label": "Who will give the final approval?",
    "type": "short",
    "required": true
  }
]'::jsonb;
  elsif p_service in ('photography', 'digitals') then
    q := q || '[
  {
    "id": "use",
    "label": "What will you use the photos for?",
    "type": "choice",
    "required": true,
    "options": [
      "Headshots",
      "Branding",
      "Portfolio",
      "Other"
    ]
  },
  {
    "id": "looks",
    "label": "Looks, outfits and reference images or links",
    "type": "long",
    "required": true
  },
  {
    "id": "wardrobe",
    "label": "I will have the agreed outfits and any needed accessories ready.",
    "type": "check",
    "required": true
  }
]'::jsonb;
  elsif p_service = 'event' then
    q := q || '[
  {
    "id": "schedule",
    "label": "Run of show and key times",
    "type": "long",
    "required": true
  },
  {
    "id": "moments",
    "label": "People and moments we must capture",
    "type": "long",
    "required": true
  },
  {
    "id": "access",
    "label": "Venue access, parking and any filming restrictions",
    "type": "long",
    "required": true
  }
]'::jsonb;
  else
    q := q || '[
  {
    "id": "priorities",
    "label": "Deliverables and priorities",
    "type": "long",
    "required": true
  },
  {
    "id": "logistics",
    "label": "Locations, people, timing and reference links",
    "type": "long",
    "required": false
  }
]'::jsonb;
  end if;
  return jsonb_build_object(
    'title', 'Prepare for your project',
    'instructions', 'Add the details Nelson needs before production. Save your answers as you go, then submit when everything is ready.',
    'questions', q
  );
end
$$;
create function bk_crm_private.prep_questions (p_questions jsonb)
  returns jsonb
  language plpgsql
  immutable
  set search_path = ''
  as $$
declare
  q jsonb;
  clean jsonb := '[]';
  ids text[] := '{}';
  kind text;
  label text;
  opts jsonb;
begin
  if jsonb_typeof(p_questions) is distinct from 'array' or jsonb_array_length(p_questions)
    not between 1 and 30 then
    raise exception 'Add between 1 and 30 questions';
  end if;
  for q in
  select
    value
  from
    jsonb_array_elements(p_questions)
  loop
    kind := q ->> 'type';
    label := trim(q ->> 'label');
    if q ->> 'id' is null or q ->> 'id' !~ '^[a-zA-Z0-9_-]{1,70}$' or q ->> 'id' =
      any (ids) or label is null or length(label)
    not between 1 and 240 or kind not in ('short', 'long', 'date', 'choice',
      'check') or kind is null or jsonb_typeof(q -> 'required') is distinct from 'boolean'
      then
      raise exception 'Each question needs a unique ID, label, type and required setting';
    end if;
    ids := array_append(ids, q ->> 'id');
    opts := null;
    if kind = 'choice' then
      opts := q -> 'options';
      if jsonb_typeof(opts) is distinct from 'array' or jsonb_array_length(opts)
        not between 1 and 20 or exists (
        select
          1
        from
          jsonb_array_elements(opts) o
        where
          jsonb_typeof(o) <> 'string'
          or length(trim(o #>> '{}'))
          not between 1 and 160) then
        raise exception 'Choice questions need 1 to 20 readable options';
      end if;
    end if;
    clean := clean || jsonb_build_array(
      jsonb_strip_nulls (
        jsonb_build_object(
          'id', q ->> 'id',
          'label', label,
          'type', kind,
          'required', (q ->> 'required')::boolean,
          'options', opts
        )
      )
    );
  end loop;
  return clean;
end
$$;
create function bk_crm_private.prep_answers (p_questions jsonb, p_answers jsonb)
  returns jsonb
  language plpgsql
  immutable
  set search_path = ''
  as $$
declare
  q jsonb;
  v jsonb;
  txt text;
  clean jsonb := '{}';
begin
  if jsonb_typeof(p_answers) is distinct from 'object' or octet_length(p_answers::text) > 100000 then
    raise exception 'Invalid preparation answers';
  end if;
  if exists (
    select
      1
    from
      jsonb_object_keys(p_answers) as keys (answer_key)
  where
    not exists (
    select
      1
    from
      jsonb_array_elements(p_questions) as fields (question)
  where
    question ->> 'id' = answer_key)) then
    raise exception 'The checklist changed. Reload the current questions.';
  end if;
  for q in
  select
    value
  from
    jsonb_array_elements(p_questions)
  loop
    v := p_answers -> (q ->> 'id');
    if v is null or v = 'null'::jsonb then
      continue;
    end if;
    if q ->> 'type' = 'check' then
      if jsonb_typeof(v) <> 'boolean' then
        raise exception 'Invalid checkbox answer';
      end if;
      clean := clean || jsonb_build_object(
        q ->> 'id', v
      );
    else
      if jsonb_typeof(v) <> 'string' then
        raise exception 'Invalid text answer';
      end if;
      txt := trim(v #>> '{}');
      if length(txt) > 4000 then
        raise exception 'Keep each answer under 4000 characters';
      end if;
      if q ->> 'type' = 'date' and txt <> '' then
        perform
          txt::date;
      end if;
      if q ->> 'type' = 'choice' and txt <> '' and not ((q -> 'options') @>
  jsonb_build_array(txt)) then
        raise exception 'Choose an option from the checklist';
      end if;
      clean := clean || jsonb_build_object(
        q ->> 'id', txt
      );
    end if;
  end loop;
  return clean;
end
$$;
create function bk_crm_private.prep_public (p public.bk_client_preparations)
  returns jsonb
  language sql
  stable
  set search_path = ''
  as $$
  select
    (to_jsonb (p) - 'created_by' - 'request_id' - 'request_fingerprint') || jsonb_build_object(
      'total_required', (
        select
          count(*)
        from jsonb_array_elements(p.questions) q
        where (q ->> 'required')::boolean),
      'completed_required', (
        select
          count(*)
        from jsonb_array_elements(p.questions) q
        where (q ->> 'required')::boolean
        and case when q ->> 'type' = 'check' then
          p.answers -> (q ->> 'id') = 'true'::jsonb
        else
          length(trim(coalesce(p.answers ->> (q ->> 'id'), ''))) > 0
        end),
      'current', p.status <> 'draft'
      and p.revision = (
        select
          max(revision)
        from public.bk_client_preparations
        where
          project_id = p.project_id
          and status <> 'draft')
    )
$$;
create function public.bk_crm_prep_save (p_project uuid, p_data jsonb, p_prep uuid default null, p_version
  uuid default null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  p public.bk_projects;
  f public.bk_client_preparations;
  defaults jsonb;
  clean_questions jsonb;
  request uuid := coalesce(nullif (p_data ->> 'request_id', '')::uuid, gen_random_uuid ());
  fingerprint text := md5((p_data - 'request_id')::text);
begin
  perform
    bk_crm_private.require_staff ();
  select
    *
  into
    p
  from
    public.bk_projects
  where
    id = p_project
  for update;
  if not found then
    raise exception 'not_found';
  end if;
  defaults := bk_crm_private.prep_defaults (p.service);
  clean_questions := bk_crm_private.prep_questions (coalesce(p_data -> 'questions', defaults -> 'questions'));
  if p_prep is null then
    select
      *
    into
      f
    from
      public.bk_client_preparations
    where
      project_id = p.id
      and request_id = request;
    if found then
      if f.request_fingerprint <> fingerprint then
        raise exception 'request_changed';
      end if;
      return bk_crm_private.prep_public (f);
    end if;
    insert into public.bk_client_preparations (project_id, revision, service, title, instructions, questions,
      created_by, request_id, request_fingerprint)
      values (p.id, coalesce((
          select
            max(revision)
          from public.bk_client_preparations
          where
      project_id = p.id), 0) + 1, p.service, coalesce(nullif (trim(p_data ->> 'title'),
        ''), defaults ->> 'title'), coalesce(p_data ->> 'instructions', defaults ->>
        'instructions'), clean_questions, auth.uid (), request, fingerprint)
  returning
    *
  into
    f;
  else
    select
      *
    into
      f
    from
      public.bk_client_preparations
    where
      id = p_prep
      and project_id = p.id
    for update;
    if not found or f.status <> 'draft' then
      raise exception 'Only a draft checklist can be edited';
    end if;
    if f.version is distinct from p_version then
      raise exception 'version_changed';
    end if;
    update
      public.bk_client_preparations
    set
      title = coalesce(nullif (trim(p_data ->> 'title'), ''),defaults->>'title'),instructions=coalesce(p_data->>'instructions',''), questions = clean_questions,
  version = gen_random_uuid (), updated_at = now()
    where
      id = f.id
    returning
      *
    into
      f;
  end if;
  insert into public.bk_activities (project_id, contact_id, actor_id, kind, summary)
    values (p.id, p.contact_id, auth.uid (), 'prep_draft', 'Client preparation draft saved');
  return bk_crm_private.prep_public (f);
end
$$;
create function public.bk_crm_prep_publish (p_prep uuid, p_version uuid)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  f public.bk_client_preparations;
  p public.bk_projects;
begin
  perform
    bk_crm_private.require_staff ();
  select
    p0.*
  into
    p
  from
    public.bk_projects p0
    join public.bk_client_preparations f0 on f0.project_id = p0.id
  where
    f0.id = p_prep
  for update
    of p0;
  if not found then
    raise exception 'not_found';
  end if;
  select
    *
  into
    f
  from
    public.bk_client_preparations
  where
    id = p_prep
  for update;
  if f.version is distinct from p_version then
    raise exception 'version_changed';
  end if;
  if f.status <> 'draft' then
    return bk_crm_private.prep_public (f);
  end if;
  if exists (
    select
      1
    from
      public.bk_client_preparations
    where
      project_id = p.id
      and status <> 'draft'
      and revision > f.revision) then
    raise exception 'superseded';
  end if;
  update
    public.bk_client_preparations
  set
    status = 'published',
    published_at = now(),
    updated_at = now()
  where
    id = f.id
  returning
    *
  into
    f;
  insert into public.bk_tasks (project_id, contact_id, title, kind, due_at, owner_id, automation_key)
    values (p.id, p.contact_id, 'Confirm client preparation is complete', 'production', coalesce(p.event_date::timestamp at time
      zone 'America/Chicago', now() + interval '3 days'), p.owner_id, 'prep_client_' || f.id)
  on conflict (project_id, automation_key)
    do nothing;
  insert into public.bk_activities (project_id, contact_id, actor_id, kind, summary)
    values (p.id, p.contact_id, auth.uid (), 'prep_published', 'Client preparation published to portal');
  return bk_crm_private.prep_public (f);
end
$$;
create function public.bk_portal_preparation (p_project uuid, p_token uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
declare
  p public.bk_projects;
  latest int;
begin
  p := bk_crm_private.client_project (p_project, p_token);
  select
    max(revision)
  into
    latest
  from
    public.bk_client_preparations
  where
    project_id = p.id
    and status <> 'draft';
  return jsonb_build_object(
    'current', (
      select
        bk_crm_private.prep_public (f)
      from public.bk_client_preparations f
      where
        project_id = p.id
        and revision = latest),
    'history', coalesce((
      select
        jsonb_agg(bk_crm_private.prep_public (f)
      order by revision desc)
      from public.bk_client_preparations f
      where
        project_id = p.id
        and status <> 'draft'
        and revision < latest), '[]'::jsonb)
  );
end
$$;
create function public.bk_portal_prep_save (p_project uuid, p_token uuid, p_prep uuid, p_version uuid,
  p_answer_revision int, p_answers jsonb, p_submit boolean default false)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  p public.bk_projects;
  f public.bk_client_preparations;
  clean_answers jsonb;
  v jsonb;
begin
  p := bk_crm_private.client_project (p_project, p_token);
  perform
    1
  from
    public.bk_projects
  where
    id = p.id
  for update;
  if p.status in ('lost', 'archived') then
    raise exception 'Project is closed';
  end if;
  select
    *
  into
    f
  from
    public.bk_client_preparations
  where
    id = p_prep
    and project_id = p.id
    and status <> 'draft'
  for update;
  if not found then
    raise exception 'not_found';
  end if;
  if f.version is distinct from p_version then
    raise exception 'version_changed';
  end if;
  if exists (
    select
      1
    from
      public.bk_client_preparations
    where
      project_id = p.id
      and status <> 'draft'
      and revision > f.revision) then
    raise exception 'superseded';
  end if;
  clean_answers := bk_crm_private.prep_answers (f.questions, p_answers);
  if clean_answers = f.answers and ((p_submit and f.status in ('submitted', 'reviewed')) or (not
    p_submit and f.status = 'published')) then
    return bk_crm_private.prep_public (f);
  end if;
  if f.status <> 'published' then
    raise exception 'Preparation already submitted';
  end if;
  if f.answer_revision is distinct from p_answer_revision then
    raise exception 'answers_changed';
  end if;
  update
    public.bk_client_preparations
  set
    answers = clean_answers,
    answer_revision = answer_revision + 1,
    updated_at = now()
  where
    id = f.id
  returning
    *
  into
    f;
  v := bk_crm_private.prep_public (f);
  if p_submit then
    if (v ->> 'completed_required')::int < (v ->> 'total_required')::int then
      raise exception 'required_answers_missing';
    end if;
    update
      public.bk_client_preparations
    set
      status = 'submitted',
      submitted_at = now()
    where
      id = f.id
    returning
      *
    into
      f;
    update
      public.bk_tasks
    set
      status = 'done'
    where
      project_id = p.id
      and automation_key = 'prep_client_' || f.id
      and status = 'open';
    insert into public.bk_tasks (project_id, contact_id, title, kind, due_at, owner_id, automation_key)
      values (p.id, p.contact_id, 'Review submitted client preparation', 'production', now(), p.owner_id, 'prep_review_' || f.id)
    on conflict (project_id, automation_key)
      do nothing;
    insert into public.bk_activities (project_id, contact_id, kind, summary)
      values (p.id, p.contact_id, 'prep_submitted', 'Client preparation submitted');
  else
    insert into public.bk_activities (project_id, contact_id, kind, summary)
      values (p.id, p.contact_id, 'prep_answers_saved', 'Client preparation answers saved');
  end if;
  return bk_crm_private.prep_public (f);
end
$$;
create function public.bk_crm_prep_review (p_prep uuid, p_version uuid, p_feedback text default '') returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  f public.bk_client_preparations;
  p public.bk_projects;
begin
  perform
    bk_crm_private.require_staff ();
  select
    p0.*
  into
    p
  from
    public.bk_projects p0
    join public.bk_client_preparations f0 on f0.project_id = p0.id
  where
    f0.id = p_prep
  for update
    of p0;
  select
    *
  into
    f
  from
    public.bk_client_preparations
  where
    id = p_prep
  for update;
  if not found then
    raise exception 'not_found';
  end if;
  if f.version is distinct from p_version then
    raise exception 'version_changed';
  end if;
  if f.status = 'reviewed' and f.feedback = coalesce(p_feedback, '') then
    return bk_crm_private.prep_public (f);
  end if;
  if f.status <> 'submitted' or exists (
    select
      1
    from
      public.bk_client_preparations
    where
      project_id = f.project_id
      and status <> 'draft'
      and revision > f.revision) then
    raise exception 'Preparation is not the current submitted version';
  end if;
  update
    public.bk_client_preparations
  set
    status = 'reviewed',
    reviewed_at = now(),
    feedback = coalesce(p_feedback, ''),
    updated_at = now()
  where
    id = f.id
  returning
    *
  into
    f;
  select
    *
  into
    p
  from
    public.bk_projects
  where
    id = f.project_id;
  update
    public.bk_tasks
  set
    status = 'done'
  where
    project_id = p.id
    and automation_key = 'prep_review_' || f.id
    and status = 'open';
  insert into public.bk_activities (project_id, contact_id, actor_id, kind, summary)
    values (p.id, p.contact_id, auth.uid (), 'prep_reviewed', 'Client preparation reviewed');
  return bk_crm_private.prep_public (f);
end
$$;
-- Review state never grants media access. These checks mirror the existing
-- bk-media preview/clean selection and return neither URLs nor storage paths.
create function bk_crm_private.video_scope (p_project uuid, p_gallery uuid, p_item uuid)
  returns text
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
declare
  g public.bk_galleries;
  i public.bk_gallery_items;
  paid boolean;
  scope text;
  path text;
begin
  select
    *
  into
    g
  from
    public.bk_galleries
  where
    id = p_gallery
    and project_id = p_project
    and kind = 'video';
  select
    *
  into
    i
  from
    public.bk_gallery_items
  where
    id = p_item
    and gallery_id = p_gallery
    and project_id = p_project;
  if g.id is null or i.id is null then
    return null;
  end if;
  if g.unlock_invoice_id is null then
    scope := 'clean';
  else
    select
      status = 'paid'
    into
      paid
    from
      public.bk_invoices
    where
      id = g.unlock_invoice_id
      and project_id = p_project;
    if coalesce(paid, false) then
      scope := 'clean';
    elsif g.preview_closed_at is not null then
      return null;
    else
      scope := 'preview';
    end if;
  end if;
  path := case when scope = 'preview' then
    regexp_replace(i.storage_path, '([^/]+)$', 'preview/\1')
  else
    i.storage_path
  end;
  if not exists (
    select
      1
    from
      storage.objects
    where
      bucket_id = 'project-media'
      and name = path) then
    return null;
  end if;
  return scope;
end
$$;
create function bk_crm_private.video_asset_signature (p_item uuid, p_scope text)
  returns text
  language sql
  stable
  security definer
  set search_path = ''
  as $$
  select
    md5(i.storage_path || ':' || o.updated_at::text || ':' || p_scope)
  from
    public.bk_gallery_items i
    join storage.objects o on o.bucket_id = 'project-media'
      and o.name = case when p_scope = 'preview' then
        regexp_replace(i.storage_path, '([^/]+)$', 'preview/\1')
      else
        i.storage_path
      end
  where
    i.id = p_item
$$;
-- Only the authenticated media gateway may request these opaque player bindings.
-- No storage path or signature is returned to a portal caller.
create function public.bk_crm_media_bindings (p_projects uuid[])
  returns jsonb
  language sql
  stable
  security definer
  set search_path = ''
  as $$
  select
    jsonb_build_object(
      'rows', coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', i.id,
            'media_revision', i.media_revision,
      'preview_key', md5('client-review:' || bk_crm_private.video_asset_signature (i.id,
        'preview') || ':' || i.media_revision::text),
      'clean_key', md5('client-review:' || bk_crm_private.video_asset_signature (i.id,
        'clean') || ':' || i.media_revision::text)
          )
        ),
        '[]'::jsonb
      )
    )
  from
    public.bk_gallery_items i
    join public.bk_galleries g on g.id = i.gallery_id
      and g.project_id = i.project_id
  where
    i.project_id = any (p_projects)
    and g.kind = 'video';
$$;
revoke all on function public.bk_crm_media_bindings (uuid[]) from public, anon, authenticated;
grant execute on function public.bk_crm_media_bindings (uuid[]) to service_role;
create function bk_crm_private.video_asset_touch ()
  returns trigger
  language plpgsql
  set search_path = ''
  as $$
begin
  if row (new.storage_path,
    new.filename,
    new.content_type,
    new.size_bytes) is distinct from row (old.storage_path,
  old.filename,
  old.content_type,
  old.size_bytes) then
    new.media_revision := gen_random_uuid ();
  end if;
  return new;
end
$$;
create trigger bk_video_asset_touch
  before update on public.bk_gallery_items
  for each row
  execute function bk_crm_private.video_asset_touch ();
create function bk_crm_private.video_public (r public.bk_video_reviews)
  returns jsonb
  language sql
  stable
  set search_path = ''
  as $$
  select
    (to_jsonb (r) - 'request_fingerprint' - 'request_id' - 'asset_signature') || jsonb_build_object(
      'asset_key', md5('client-review:' || r.asset_signature || ':' || r.media_revision::text),
      'current', r.revision = (
        select
          max(revision)
        from public.bk_video_reviews
        where
          thread_id = r.thread_id),
      'notes', coalesce((
        select
          jsonb_agg((to_jsonb (n) - 'resolved_by' - 'request_id')
      order by at_seconds, id)
        from public.bk_video_notes n
        where
          review_id = r.id), '[]'::jsonb)
    )
$$;
create function public.bk_crm_video_publish (p_project uuid, p_data jsonb)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  p public.bk_projects;
  i public.bk_gallery_items;
  r public.bk_video_reviews;
  prior public.bk_video_reviews;
  scope text;
  request uuid;
  fingerprint text;
  thread uuid;
  rev int;
begin
  perform
    bk_crm_private.require_staff ();
  select
    *
  into
    p
  from
    public.bk_projects
  where
    id = p_project
  for update;
  if not found then
    raise exception 'not_found';
  end if;
  request := (p_data ->> 'request_id')::uuid;
  if request is null then
    raise exception 'request_id_required';
  end if;
  fingerprint := md5((p_data - 'request_id')::text);
  select
    *
  into
    r
  from
    public.bk_video_reviews
  where
    project_id = p.id
    and request_id = request;
  if found then
    if r.request_fingerprint <> fingerprint then
      raise exception 'request_changed';
    end if;
    return bk_crm_private.video_public (r);
  end if;
  scope := bk_crm_private.video_scope (p.id, (p_data ->> 'gallery_id')::uuid, (p_data ->> 'item_id')::uuid);
  if scope is null then
    raise exception 'No video is currently visible to this client';
  end if;
  select
    *
  into
    i
  from
    public.bk_gallery_items
  where
    id = (p_data ->> 'item_id')::uuid;
  if nullif (p_data ->> 'supersedes_id', '') is not null then
    select
      *
    into
      prior
    from
      public.bk_video_reviews
    where
      id = (p_data ->> 'supersedes_id')::uuid
      and project_id = p.id
      and gallery_id = i.gallery_id
    for update;
    if not found or prior.version is distinct from (p_data ->> 'expected_version')::uuid or exists (
    select
      1
    from
      public.bk_video_reviews
    where
      thread_id = prior.thread_id
        and revision > prior.revision) then
      raise exception 'version_changed';
    end if;
    thread := prior.thread_id;
    rev := prior.revision + 1;
  else
    if exists (
      select
        1
      from
        public.bk_video_reviews
      where
        item_id = i.id
        and project_id = p.id) then
      raise exception 'Choose the existing review to publish a new version';
    end if;
    thread := gen_random_uuid ();
    rev := 1;
  end if;
  insert into public.bk_video_reviews (project_id, gallery_id, item_id, thread_id, revision, media_revision,
    media_scope, asset_signature, title, request_id, request_fingerprint)
    values (p.id, i.gallery_id, i.id, thread, rev, i.media_revision, scope,
      bk_crm_private.video_asset_signature (i.id, scope), coalesce(nullif (trim(p_data ->> 'title'),
      ''),
      left (coalesce(i.filename, 'Video review'), 180)), request, fingerprint)
  returning
    *
  into
    r;
  insert into public.bk_activities (project_id, contact_id, actor_id, kind, summary)
    values (p.id, p.contact_id, auth.uid (), 'video_review_published', 'Video review version ' || rev || ' published');
  return bk_crm_private.video_public (r);
end
$$;
create function public.bk_portal_video_reviews (p_project uuid, p_token uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
declare
  p public.bk_projects;
begin
  p := bk_crm_private.client_project (p_project, p_token);
  return jsonb_build_object(
    'rows', coalesce((
      select
        jsonb_agg(bk_crm_private.video_public (r)
      order by r.published_at, r.id)
      from public.bk_video_reviews r
      join public.bk_gallery_items i on i.id = r.item_id
      where
        r.project_id = p.id
        and i.media_revision = r.media_revision
        and bk_crm_private.video_scope (p.id, r.gallery_id, r.item_id) = r.media_scope
        and bk_crm_private.video_asset_signature (i.id, r.media_scope) = r.asset_signature), '[]'::jsonb)
  );
end
$$;
create function bk_crm_private.video_open (p_project uuid, p_token uuid, p_review uuid, p_version uuid)
  returns public.bk_video_reviews
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  p public.bk_projects;
  r public.bk_video_reviews;
begin
  p := bk_crm_private.client_project (p_project, p_token);
  perform
    1
  from
    public.bk_projects
  where
    id = p.id
  for update;
  select
    *
  into
    r
  from
    public.bk_video_reviews
  where
    id = p_review
    and project_id = p.id
  for update;
  if not found or r.version is distinct from p_version then
    raise exception 'not_found';
  end if;
  if not exists (
    select
      1
    from
      public.bk_gallery_items
    where
      id = r.item_id
      and media_revision = r.media_revision) or bk_crm_private.video_scope (p.id, r.gallery_id, r.item_id) is
  distinct from r.media_scope or bk_crm_private.video_asset_signature (r.item_id, r.media_scope) is
  distinct from r.asset_signature then
    raise exception 'media_changed';
  end if;
  if exists (
    select
      1
    from
      public.bk_video_reviews
    where
      thread_id = r.thread_id
      and revision > r.revision) then
    raise exception 'superseded';
  end if;
  if p.status in ('lost', 'archived') then
    raise exception 'Project is closed';
  end if;
  return r;
end
$$;
create function public.bk_portal_video_note (p_project uuid, p_token uuid, p_review uuid, p_version uuid,
  p_request_id uuid, p_at_seconds numeric, p_body text, p_note uuid default null, p_note_revision int default
  null)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  r public.bk_video_reviews;
  n public.bk_video_notes;
begin
  r := bk_crm_private.video_open (p_project, p_token, p_review, p_version);
  if r.status <> 'published' then
    raise exception 'Review is already submitted';
  end if;
  if p_request_id is null or p_body is null or length(trim(p_body))
    not between 1 and 2000 or p_at_seconds is null or p_at_seconds not between 0 and 21600 then
    raise exception 'Invalid timestamp note';
  end if;
  if p_note is null then
    select
      *
    into
      n
    from
      public.bk_video_notes
    where
      review_id = r.id
      and request_id = p_request_id;
    if found then
      if n.body <> trim(p_body) or n.at_seconds <> p_at_seconds then
        raise exception 'request_changed';
      end if;
      return to_jsonb (n) - 'resolved_by' - 'request_id';
    end if;
    insert into public.bk_video_notes (review_id, project_id, at_seconds, body, request_id)
      values (r.id, r.project_id, p_at_seconds, trim(p_body), p_request_id)
    returning
      *
    into
      n;
  else
    select
      *
    into
      n
    from
      public.bk_video_notes
    where
      id = p_note
      and review_id = r.id
    for update;
    if not found then
      raise exception 'not_found';
    end if;
    if n.body = trim(p_body) and n.at_seconds = p_at_seconds then
      return to_jsonb (n) - 'resolved_by' - 'request_id';
    end if;
    if n.revision is distinct from p_note_revision then
      raise exception 'note_changed';
    end if;
    update
      public.bk_video_notes
    set
      body = trim(p_body),
      at_seconds = p_at_seconds,
      revision = revision + 1,
      resolved_at = null,
      resolved_by = null,
      updated_at = now()
    where
      id = n.id
    returning
      *
    into
      n;
  end if;
  update
    public.bk_video_reviews
  set
    notes_revision = notes_revision + 1
  where
    id = r.id;
  insert into public.bk_activities (project_id, contact_id, kind, summary)
  select
    p.id,
    p.contact_id,
    case when p_note is null then
      'video_note_added'
    else
      'video_note_updated'
    end,
    'Client saved a timestamped video note'
  from
    public.bk_projects p
  where
    p.id = r.project_id;
  return (to_jsonb (n) - 'resolved_by' - 'request_id') || jsonb_build_object(
    'notes_revision', r.notes_revision + 1
  );
end
$$;
create function public.bk_portal_video_decide (p_project uuid, p_token uuid, p_review uuid, p_version uuid,
  p_notes_revision int, p_decision text, p_signer text default '') returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  r public.bk_video_reviews;
  p public.bk_projects;
  n int;
begin
  r := bk_crm_private.video_open (p_project, p_token, p_review, p_version);
  if p_decision not in ('approved', 'changes') or p_decision is null then
    raise exception 'Invalid review decision';
  end if;
  if r.status = p_decision then
    return bk_crm_private.video_public (r);
  end if;
  if r.status <> 'published' then
    raise exception 'Review is already submitted';
  end if;
  if r.notes_revision is distinct from p_notes_revision then
    raise exception 'notes_changed';
  end if;
  select
    count(*)
  into
    n
  from
    public.bk_video_notes
  where
    review_id = r.id
    and resolved_at is null;
  if p_decision = 'approved' and n > 0 then
    raise exception 'unresolved_notes';
  end if;
  if p_decision = 'changes' and n = 0 then
    raise exception 'Add a note before requesting changes';
  end if;
  if p_decision = 'approved' and length(trim(coalesce(p_signer, '')))
    not between 1 and 120 then
    raise exception 'Your name is required';
  end if;
  update
    public.bk_video_reviews
  set
    status = p_decision,
    decided_at = now(),
    approved_by = case when p_decision = 'approved' then
      trim(p_signer)
    end
  where
    id = r.id
  returning
    *
  into
    r;
  select
    *
  into
    p
  from
    public.bk_projects
  where
    id = r.project_id;
  if p_decision = 'changes' then
    insert into public.bk_tasks (project_id, contact_id, title, kind, due_at, owner_id, automation_key)
      values (p.id, p.contact_id, 'Review timestamped video feedback', 'production', now(), p.owner_id, 'video_feedback_' || r.id)
    on conflict (project_id, automation_key)
      do nothing;
  end if;
  insert into public.bk_activities (project_id, contact_id, kind, summary)
    values (p.id, p.contact_id, 'video_' || p_decision, 'Client ' || p_decision ||
      ' video version ' || r.revision);
  return bk_crm_private.video_public (r);
end
$$;
create function public.bk_crm_video_resolve (p_note uuid, p_note_revision int, p_resolved boolean)
  returns jsonb
  language plpgsql
  security definer
  set search_path = ''
  as $$
declare
  n public.bk_video_notes;
  r public.bk_video_reviews;
begin
  perform
    bk_crm_private.require_staff ();
  select
    *
  into
    n
  from
    public.bk_video_notes
  where
    id = p_note;
  if not found then
    raise exception 'not_found';
  end if;
  perform
    1
  from
    public.bk_projects
  where
    id = n.project_id
  for update;
  select
    *
  into
    r
  from
    public.bk_video_reviews
  where
    id = n.review_id
  for update;
  select
    *
  into
    n
  from
    public.bk_video_notes
  where
    id = p_note
  for update;
  if exists (
    select
      1
    from
      public.bk_video_reviews
    where
      thread_id = r.thread_id
      and revision > r.revision) then
    raise exception 'superseded';
  end if;
  if r.status = 'approved' then
    raise exception 'An approved review is read-only';
  end if;
  if bk_crm_private.video_asset_signature (r.item_id, r.media_scope) is distinct from r.asset_signature then
    raise exception 'media_changed';
  end if;
  if n.revision is distinct from p_note_revision then
    raise exception 'note_changed';
  end if;
  if (n.resolved_at is not null) = p_resolved then
    return to_jsonb (n);
  end if;
  update
    public.bk_video_notes
  set
    resolved_at = case when p_resolved then
      now()
    end,
    resolved_by = case when p_resolved then
      auth.uid ()
    end,
    revision = revision + 1,
    updated_at = now()
  where
    id = n.id
  returning
    *
  into
    n;
  update
    public.bk_video_reviews
  set
    notes_revision = notes_revision + 1
  where
    id = r.id;
  if p_resolved and not exists (
    select
      1
    from
      public.bk_video_notes
    where
      review_id = r.id
      and resolved_at is null) then
    update
      public.bk_tasks
    set
      status = 'done'
    where
      project_id = r.project_id
      and automation_key = 'video_feedback_' || r.id
      and status = 'open';
  end if;
  if not p_resolved then
    update
      public.bk_tasks
    set
      status = 'open'
    where
      project_id = r.project_id
      and automation_key = 'video_feedback_' || r.id
      and status = 'done';
  end if;
  insert into public.bk_activities (project_id, contact_id, actor_id, kind, summary)
  select
    p.id,
    p.contact_id,
    auth.uid (),
    'video_note_resolved',
    case when p_resolved then
      'Video note resolved'
    else
      'Video note reopened'
    end
  from
    public.bk_projects p
  where
    p.id = r.project_id;
  return to_jsonb (n);
end
$$;
create function public.bk_crm_client_experience (p_project uuid)
  returns jsonb
  language plpgsql
  stable
  security definer
  set search_path = ''
  as $$
declare
  p public.bk_projects;
begin
  perform
    bk_crm_private.require_staff ();
  select
    *
  into
    p
  from
    public.bk_projects
  where
    id = p_project;
  if not found then
    raise exception 'not_found';
  end if;
  return jsonb_build_object(
    'prep_defaults', bk_crm_private.prep_defaults (p.service),
    'preparations', coalesce((
      select
        jsonb_agg(bk_crm_private.prep_public (f)
      order by revision desc)
      from public.bk_client_preparations f
      where
        project_id = p.id), '[]'::jsonb),
    'video_items', coalesce((
      select
        jsonb_agg(
          jsonb_build_object(
            'id', i.id,
            'gallery_id', g.id,
            'gallery_title', g.title,
            'filename', i.filename,
            'media_revision', i.media_revision,
            'client_scope', bk_crm_private.video_scope (p.id, g.id, i.id)
          )
          order by g.created_at,
          i.created_at,
          i.id
        )
      from public.bk_gallery_items i
      join public.bk_galleries g on g.id = i.gallery_id
      where
        i.project_id = p.id
        and g.project_id = p.id
        and g.kind = 'video'), '[]'::jsonb),
    'reviews', coalesce((
      select
        jsonb_agg(bk_crm_private.video_public (r)
        order by published_at desc, id)
      from public.bk_video_reviews r
      where
        project_id = p.id), '[]'::jsonb)
  );
end
$$;
-- Explicit ACLs also remove legacy Supabase default function grants.
do $acl$
declare
  f record;
begin
  for f in
  select
    p.oid::regprocedure sig,
    p.proname,
    n.nspname
  from
    pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public'
    and p.proname in ('bk_crm_client_experience', 'bk_crm_prep_save', 'bk_crm_prep_publish', 'bk_crm_prep_review',
      'bk_portal_preparation', 'bk_portal_prep_save', 'bk_crm_video_publish', 'bk_portal_video_reviews', 'bk_portal_video_note',
      'bk_portal_video_decide', 'bk_crm_video_resolve'))
    or (n.nspname = 'bk_crm_private'
      and p.proname in ('client_project', 'prep_defaults', 'prep_questions', 'prep_answers',
  'prep_public', 'prep_immutable', 'video_scope', 'video_asset_signature', 'video_asset_touch',
  'video_public', 'video_open', 'video_immutable'))
  loop
    execute format('revoke all on function %s from public,anon,authenticated', f.sig);
    if f.nspname = 'public' then
      execute format('grant execute on function %s to authenticated%s', f.sig, case when f.proname like 'bk_portal_%' then
          ',anon'
        else
          ''
        end);
    end if;
  end loop;
end
$acl$;
commit;
