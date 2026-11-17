import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const db = new PGlite(),
  read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const q = async (s, p = []) => (await db.query(s, p)).rows,
  one = async (s, p = []) => (await q(s, p))[0],
  rpc = async (n, a = []) =>
    (await one(`select ${n}(${a.map((_, i) => "$" + (i + 1)).join(",")}) r`, a))
      .r;
let checks = 0;
const ok = (v, m) => {
    assert.ok(v, m);
    checks++;
  },
  denies = async (fn, m) => {
    await assert.rejects(fn, m);
    checks++;
  };
const STAFF = "11111111-1111-4111-8111-111111111111";
async function as(role, uid, fn) {
  await db.exec(`set role ${role}`);
  await q(`select set_config('request.jwt.claim.sub',$1,false)`, [uid || ""]);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}
const staff = (fn) => as("authenticated", STAFF, fn),
  client = (fn) => as("anon", null, fn);
try {
  await db.exec(read("./fixtures/crm-schema.sql"));
  await db.exec(
    read("../supabase/migrations/20261116192939_crm_foundation.sql"),
  );
  await db.exec(`alter table bk_galleries add title text default 'Synthetic gallery',add locked bool default false,add unlock_invoice_id uuid,add preview_closed_at timestamptz;alter table bk_gallery_items add created_at timestamptz default now(),add storage_path text,add filename text,add content_type text,add size_bytes bigint;
 create schema storage;create table storage.objects(bucket_id text,name text,updated_at timestamptz not null default now(),primary key(bucket_id,name));`);
  await db.exec(
    read(
      "../supabase/migrations/20261117033338_crm_client_preparation_review.sql",
    ),
  );
  await q(`insert into profiles values($1,'employee','Synthetic Staff')`, [
    STAFF,
  ]);
  const p = await staff(() =>
    rpc("bk_crm_create_project", [
      {
        client_name: "Synthetic Client",
        client_email: "client@example.test",
        service: "brand_content",
        referral_source: "Test",
      },
    ]),
  );
  const other = await staff(() =>
    rpc("bk_crm_create_project", [
      {
        client_name: "Other Client",
        client_email: "other@example.test",
        service: "photography",
        referral_source: "Test",
      },
    ]),
  );
  for (const table of [
    "bk_client_preparations",
    "bk_video_reviews",
    "bk_video_notes",
  ]) {
    await denies(
      () => client(() => q(`select * from ${table}`)),
      "anonymous direct data denied",
    );
    await denies(
      () => staff(() => q(`delete from ${table}`)),
      "staff bypass of versioned RPC denied",
    );
  }
  await denies(
    () => client(() => rpc("bk_crm_client_experience", [p.id])),
    "anonymous cannot read staff project data",
  );
  await denies(
    () =>
      client(() => rpc("bk_portal_preparation", [p.id, other.access_token])),
    "wrong project token denied",
  );
  let experience = await staff(() => rpc("bk_crm_client_experience", [p.id]));
  ok(
    experience.prep_defaults.questions.some((q) => q.id === "audience"),
    "service-specific brand questions supplied",
  );
  const data = {
    ...experience.prep_defaults,
    request_id: "aaaaaaaa-1111-4111-8111-111111111111",
  };
  let prep = await staff(() => rpc("bk_crm_prep_save", [p.id, data]));
  ok(prep.status === "draft", "checklist starts private draft");
  ok(
    (await staff(() => rpc("bk_crm_prep_save", [p.id, data]))).id === prep.id,
    "draft creation retry is idempotent",
  );
  ok(
    (await client(() => rpc("bk_portal_preparation", [p.id, p.access_token])))
      .current === null,
    "draft checklist invisible to client",
  );
  await denies(
    () =>
      staff(() =>
        rpc("bk_crm_prep_save", [
          p.id,
          {
            questions: [
              { id: "bad", label: "Invalid", type: "unknown", required: true },
            ],
          },
          prep.id,
          prep.version,
        ]),
      ),
    "invalid question type refused",
  );
  const originalVersion = prep.version;
  prep = await staff(() =>
    rpc("bk_crm_prep_save", [
      p.id,
      { ...data, title: "Before production" },
      prep.id,
      prep.version,
    ]),
  );
  await denies(
    () => staff(() => rpc("bk_crm_prep_publish", [prep.id, originalVersion])),
    "stale staff draft cannot publish",
  );
  prep = await staff(() => rpc("bk_crm_prep_publish", [prep.id, prep.version]));
  ok(prep.status === "published", "staff publishes checklist");
  await denies(
    () =>
      q("update bk_client_preparations set questions = '[]' where id=$1", [
        prep.id,
      ]),
    "published preparation remains immutable even through a privileged table update",
  );
  ok(
    (await client(() => rpc("bk_portal_preparation", [p.id, p.access_token])))
      .current.id === prep.id,
    "client sees published checklist",
  );
  await denies(
    () =>
      staff(() => rpc("bk_crm_prep_save", [p.id, data, prep.id, prep.version])),
    "published definition cannot be edited",
  );
  let saved = await client(() =>
    rpc("bk_portal_prep_save", [
      p.id,
      p.access_token,
      prep.id,
      prep.version,
      0,
      { goal: "Launch story" },
      false,
    ]),
  );
  ok(
    saved.answer_revision === 1 && saved.completed_required === 1,
    "partial draft saves required progress",
  );
  ok(
    (
      await client(() =>
        rpc("bk_portal_prep_save", [
          p.id,
          p.access_token,
          prep.id,
          prep.version,
          0,
          { goal: "Launch story" },
          false,
        ]),
      )
    ).answer_revision === 1,
    "exact answer retry does not increment",
  );
  await denies(
    () =>
      client(() =>
        rpc("bk_portal_prep_save", [
          p.id,
          p.access_token,
          prep.id,
          prep.version,
          0,
          { goal: "Different concurrent answer" },
          false,
        ]),
      ),
    "stale answer edit cannot overwrite",
  );
  await denies(
    () =>
      client(() =>
        rpc("bk_portal_prep_save", [
          p.id,
          p.access_token,
          prep.id,
          prep.version,
          1,
          { goal: "Only one answer" },
          true,
        ]),
      ),
    "required questions block submit",
  );
  ok(
    (await client(() => rpc("bk_portal_preparation", [p.id, p.access_token])))
      .current.answers.goal === "Launch story",
    "failed required submit preserves saved draft",
  );
  const answers = Object.fromEntries(
    prep.questions.map((x) => [
      x.id,
      x.type === "check"
        ? true
        : x.type === "choice"
          ? x.options[0]
          : "Synthetic answer",
    ]),
  );
  saved = await client(() =>
    rpc("bk_portal_prep_save", [
      p.id,
      p.access_token,
      prep.id,
      prep.version,
      1,
      answers,
      true,
    ]),
  );
  ok(saved.status === "submitted", "complete preparation submits");
  ok(
    (
      await one(
        `select count(*)::int n from bk_tasks where automation_key=$1 and status='open'`,
        ["prep_review_" + prep.id],
      )
    ).n === 1,
    "staff gets review action",
  );
  const activityCount = (
    await one(
      `select count(*)::int n from bk_activities where kind='prep_submitted'`,
    )
  ).n;
  await client(() =>
    rpc("bk_portal_prep_save", [
      p.id,
      p.access_token,
      prep.id,
      prep.version,
      1,
      answers,
      true,
    ]),
  );
  ok(
    (
      await one(
        `select count(*)::int n from bk_activities where kind='prep_submitted'`,
      )
    ).n === activityCount,
    "submit retry posts no duplicate activity",
  );
  prep = await staff(() =>
    rpc("bk_crm_prep_review", [
      prep.id,
      prep.version,
      "Ready for the session.",
    ]),
  );
  ok(
    prep.status === "reviewed" && prep.feedback.includes("Ready"),
    "staff review feedback persisted",
  );
  const revised = await staff(() =>
    rpc("bk_crm_prep_save", [
      p.id,
      {
        ...data,
        request_id: "aaaaaaaa-1111-4111-8111-111111111112",
        title: "Updated preparation",
      },
    ]),
  );
  await staff(() => rpc("bk_crm_prep_publish", [revised.id, revised.version]));
  await denies(
    () =>
      client(() =>
        rpc("bk_portal_prep_save", [
          p.id,
          p.access_token,
          prep.id,
          prep.version,
          2,
          answers,
          false,
        ]),
      ),
    "prior preparation version is read-only",
  );
  ok(
    (await client(() => rpc("bk_portal_preparation", [p.id, p.access_token])))
      .history[0].status === "reviewed",
    "previous completed preparation remains visible",
  );
  const inv = (
    await one(
      `insert into bk_invoices(project_id,amount_cents,status) values($1,10000,'sent') returning id`,
      [p.id],
    )
  ).id;
  const gallery = (
    await one(
      `insert into bk_galleries(project_id,kind,title,unlock_invoice_id) values($1,'video','Synthetic film',$2) returning id`,
      [p.id, inv],
    )
  ).id;
  const item = (
    await one(
      `insert into bk_gallery_items(project_id,gallery_id,storage_path,filename,content_type,size_bytes) values($1,$2,'synthetic/film.mp4','Synthetic film.mp4','video/mp4',1000) returning *`,
      [p.id, gallery],
    )
  ).id;
  await q(
    `insert into storage.objects(bucket_id,name) values('project-media','synthetic/film.mp4')`,
  );
  const videoData = {
    gallery_id: gallery,
    item_id: item,
    title: "First cut",
    request_id: "bbbbbbbb-2222-4222-8222-222222222222",
  };
  await denies(
    () => staff(() => rpc("bk_crm_video_publish", [p.id, videoData])),
    "unpaid clean file without preview cannot be reviewed",
  );
  await q(
    `insert into storage.objects(bucket_id,name) values('project-media','synthetic/preview/film.mp4')`,
  );
  let review = await staff(() =>
    rpc("bk_crm_video_publish", [p.id, videoData]),
  );
  ok(
    review.media_scope === "preview",
    "unpaid project publishes preview-specific review",
  );
  ok(
    (await staff(() => rpc("bk_crm_video_publish", [p.id, videoData]))).id ===
      review.id,
    "video publish retry is idempotent",
  );
  const visible = await client(() =>
    rpc("bk_portal_video_reviews", [p.id, p.access_token]),
  );
  await denies(
    () => client(() => rpc("bk_crm_media_bindings", [[p.id]])),
    "anonymous cannot enumerate media bindings",
  );
  await denies(
    () => staff(() => rpc("bk_crm_media_bindings", [[p.id]])),
    "staff cannot bypass service media gateway binding scope",
  );
  const bindings = await as("service_role", null, () =>
    rpc("bk_crm_media_bindings", [[p.id]]),
  );
  const playerBinding = bindings.rows.find((row) => row.id === review.item_id);
  ok(
    playerBinding.preview_key === visible.rows[0].asset_key &&
      playerBinding.media_revision === visible.rows[0].media_revision,
    "gateway and portal bind the exact same preview revision",
  );
  ok(
    playerBinding.clean_key !== playerBinding.preview_key,
    "preview and clean asset keys remain distinct",
  );
  ok(
    visible.rows.length === 1 &&
      !JSON.stringify(visible).includes("synthetic/film.mp4") &&
      !JSON.stringify(visible).includes("asset_signature"),
    "review payload exposes no clean paths or private asset fingerprint",
  );
  await denies(
    () =>
      client(() => rpc("bk_portal_video_reviews", [p.id, other.access_token])),
    "wrong token cannot read notes",
  );
  let note = await client(() =>
    rpc("bk_portal_video_note", [
      p.id,
      p.access_token,
      review.id,
      review.version,
      "cccccccc-3333-4333-8333-333333333333",
      12.25,
      "Tighten this pause",
    ]),
  );
  ok(
    Number(note.at_seconds) === 12.25,
    "timestamped note persists against exact version",
  );
  await client(() =>
    rpc("bk_portal_video_note", [
      p.id,
      p.access_token,
      review.id,
      review.version,
      "cccccccc-3333-4333-8333-333333333333",
      12.25,
      "Tighten this pause",
    ]),
  );
  ok(
    (await one(`select count(*)::int n from bk_video_notes`)).n === 1,
    "lost note response retry creates no duplicate",
  );
  await denies(
    () =>
      client(() =>
        rpc("bk_portal_video_decide", [
          p.id,
          p.access_token,
          review.id,
          review.version,
          0,
          "approved",
          "Signer",
        ]),
      ),
    "stale visible note revision cannot approve",
  );
  await denies(
    () =>
      client(() =>
        rpc("bk_portal_video_decide", [
          p.id,
          p.access_token,
          review.id,
          review.version,
          1,
          "approved",
          "Signer",
        ]),
      ),
    "unresolved notes prevent approval",
  );
  await client(() =>
    rpc("bk_portal_video_decide", [
      p.id,
      p.access_token,
      review.id,
      review.version,
      1,
      "changes",
      "",
    ]),
  );
  note = await staff(() =>
    rpc("bk_crm_video_resolve", [note.id, note.revision, true]),
  );
  ok(note.resolved_at, "staff resolves exact note revision");
  await denies(
    () =>
      client(() =>
        rpc("bk_portal_video_note", [
          p.id,
          p.access_token,
          review.id,
          review.version,
          "cccccccc-3333-4333-8333-333333333334",
          15,
          "Late edit",
        ]),
      ),
    "submitted review is read-only",
  );
  const next = await staff(() =>
    rpc("bk_crm_video_publish", [
      p.id,
      {
        ...videoData,
        request_id: "bbbbbbbb-2222-4222-8222-222222222223",
        title: "Second cut",
        supersedes_id: review.id,
        expected_version: review.version,
      },
    ]),
  );
  await denies(
    () =>
      client(() =>
        rpc("bk_portal_video_decide", [
          p.id,
          p.access_token,
          review.id,
          review.version,
          2,
          "approved",
          "Signer",
        ]),
      ),
    "superseded version cannot be approved",
  );
  await client(() =>
    rpc("bk_portal_video_decide", [
      p.id,
      p.access_token,
      next.id,
      next.version,
      0,
      "approved",
      "Synthetic Signer",
    ]),
  );
  ok(
    (
      await one(`select approved_by from bk_video_reviews where id=$1`, [
        next.id,
      ])
    ).approved_by === "Synthetic Signer",
    "approval evidence belongs to exact current version",
  );
  await q(`update bk_galleries set preview_closed_at=now() where id=$1`, [
    gallery,
  ]);
  ok(
    (await client(() => rpc("bk_portal_video_reviews", [p.id, p.access_token])))
      .rows.length === 0,
    "closed unpaid preview exposes no review payload",
  );
  await q(`update bk_galleries set preview_closed_at=null where id=$1`, [
    gallery,
  ]);
  await q(
    `update storage.objects set updated_at=updated_at+interval '1 second' where name='synthetic/preview/film.mp4'`,
  );
  ok(
    (await client(() => rpc("bk_portal_video_reviews", [p.id, p.access_token])))
      .rows.length === 0,
    "storage object replacement invalidates old review binding",
  );
  await q(`update bk_invoices set status='paid' where id=$1`, [inv]);
  ok(
    (await client(() => rpc("bk_portal_video_reviews", [p.id, p.access_token])))
      .rows.length === 0,
    "paying does not attach preview approval to clean media",
  );
  const clean = await staff(() =>
    rpc("bk_crm_video_publish", [
      p.id,
      {
        ...videoData,
        request_id: "bbbbbbbb-2222-4222-8222-222222222224",
        title: "Clean delivery",
        supersedes_id: next.id,
        expected_version: next.version,
      },
    ]),
  );
  ok(
    clean.media_scope === "clean",
    "clean asset receives its own review version",
  );
  await q(
    `update bk_gallery_items set storage_path='synthetic/replaced.mp4' where id=$1`,
    [item],
  );
  ok(
    (await client(() => rpc("bk_portal_video_reviews", [p.id, p.access_token])))
      .rows.length === 0,
    "item replacement invalidates client review access",
  );
  ok(
    (await one(`select count(*)::int n from bk_messages`)).n === 0 &&
      (await one(`select count(*)::int n from bk_email_queue`)).n === 0,
    "preparation and review send no real-client messages or email",
  );
  console.log(
    `prep-review.pglite: ${checks} checks passed (synthetic records only)`,
  );
} catch (e) {
  console.error(e.message, e.where || "");
  process.exitCode = 1;
} finally {
  await db.close();
}
