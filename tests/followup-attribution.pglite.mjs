import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const query = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await query(sql, args))[0];
const rpc = async (name, args = []) =>
  (await one(
    "select " + name + "(" + args.map((_, i) => "$" + (i + 1)).join(",") +
      ") result",
    args,
  )).result;
const STAFF = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
let checks = 0;
const check = (value, label) => {
  assert.ok(value, label);
  checks++;
};
const rejects = async (callback, pattern, label) => {
  await assert.rejects(callback, pattern, label);
  checks++;
};
async function as(role, uid, callback) {
  await db.exec("set role " + role);
  await query("select set_config('request.jwt.claim.sub',$1,false)", [
    uid || "",
  ]);
  try {
    return await callback();
  } finally {
    await db.exec("reset role");
  }
}
const staff = (callback) => as("authenticated", STAFF, callback);
const anonymous = (callback) => as("anon", null, callback);
const id = () => crypto.randomUUID();

try {
  await db.exec(read("./fixtures/crm-schema.sql"));
  await db.exec(
    read("../supabase/migrations/20261116192939_crm_foundation.sql"),
  );
  await db.exec(
    read("../supabase/migrations/20261116193012_crm_intake_retries.sql"),
  );
  await db.exec(
    read("../supabase/migrations/20261116193952_crm_inbound_email.sql"),
  );
  await db.exec("alter table bk_invoices add column paid_amount_cents int");
  await query(
    "insert into profiles values($1,'employee','Synthetic Staff'),($2,'client','Synthetic Client')",
    [STAFF, CLIENT],
  );
  const legacy = await staff(() =>
    rpc("bk_crm_create_project", [{
      client_name: "Synthetic Legacy",
      client_email: "legacy@example.test",
      referral_source: "IG",
    }])
  );
  const oldTasks = (await one("select count(*)::int n from bk_tasks")).n;
  await db.exec(
    read("../supabase/migrations/20261117033405_crm_followup_attribution.sql"),
  );
  check(
    (await one("select count(*)::int n from bk_tasks")).n === oldTasks,
    "migration adds no surprise legacy follow-up tasks",
  );
  check(
    !(await staff(() => rpc("bk_crm_followup_settings", [legacy.id]))).enabled,
    "old projects default cadence disabled",
  );
  await staff(() =>
    rpc("bk_crm_save_project", [legacy.id, { referral_source: "Referral" }])
  );
  check(
    (await one(
      "select source_normalized from bk_lead_attribution where project_id=$1",
      [legacy.id],
    ))
      .source_normalized === "Referral",
    "legacy declared-source corrections reach normalized reports",
  );

  for (
    const callback of [
      () => rpc("bk_crm_morning"),
      () => rpc("bk_crm_source_report"),
      () => rpc("bk_crm_followup_settings", [legacy.id]),
      () =>
        rpc("bk_crm_set_attribution", [legacy.id, { source: "Search" }, id()]),
      () => rpc("bk_crm_set_followup", [legacy.id, { enabled: true }, id()]),
      () => rpc("bk_crm_followup_action", [id(), "done", id()]),
    ]
  ) {
    await rejects(
      () => anonymous(callback),
      /permission denied/,
      "anonymous caller cannot use staff growth API",
    );
    await rejects(
      () => as("authenticated", CLIENT, callback),
      /Staff access required/,
      "client login cannot use staff growth API",
    );
  }
  check(
    (await anonymous(() =>
      query("select * from bk_lead_attribution").catch(() => [])
    )).length === 0,
    "public cannot read attribution",
  );
  check(
    (await as(
      "authenticated",
      CLIENT,
      () => query("select * from bk_followup_plans"),
    )).length === 0,
    "clients cannot read cadence settings",
  );
  await rejects(
    () => staff(() => query("update bk_followup_plans set enabled=true")),
    /permission denied/,
    "staff cannot bypass cadence RPC by direct write",
  );
  await rejects(
    () =>
      staff(() =>
        query("update bk_lead_attribution set source_normalized='Fabricated'")
      ),
    /permission denied/,
    "staff cannot bypass source normalization",
  );

  const create = (extra = {}) =>
    staff(() =>
      rpc("bk_crm_create_project", [{
        request_id: id(),
        client_name: "Synthetic Lead",
        client_email: id() + "@example.test",
        referral_source: "Instagram",
        ...extra,
      }])
    );
  const lead = await create();
  await staff(() =>
    rpc("bk_crm_save_project", [lead.id, { referral_source: "Referral" }])
  );
  check(
    (await one(
      "select source_normalized from bk_lead_attribution where project_id=$1",
      [lead.id],
    ))
      .source_normalized === "Referral",
    "manual lead source edits update normalized reporting attribution",
  );
  let settings = await staff(() => rpc("bk_crm_followup_settings", [lead.id]));
  check(
    settings.enabled && settings.state === "active" && settings.step === 0,
    "new lead starts staff-only cadence",
  );
  check(
    (await one(
      "select count(*)::int n from bk_tasks where project_id=$1 and status='open'",
      [lead.id],
    )).n === 1,
    "initial task reused without duplicate",
  );
  check(
    (await one("select automation_key from bk_tasks where id=$1", [
      settings.current_task_id,
    ])).automation_key === "initial_followup",
    "first real task is the existing initial followup",
  );
  const firstTask = settings.current_task_id;
  const delayed = new Date(Date.now() + 12 * 86400000).toISOString();
  await staff(() =>
    query("update bk_tasks set due_at=$2 where id=$1", [firstTask, delayed])
  );
  const saveId = id();
  const config = { enabled: true, lead_days: [1, 4, 9], quote_days: [3, 8] };
  settings = await staff(() =>
    rpc("bk_crm_set_followup", [lead.id, config, saveId])
  );
  check(
    Date.parse(settings.next_due_at) === Date.parse(delayed),
    "settings preserve manually scheduled first action",
  );
  assert.deepEqual(
    await staff(() => rpc("bk_crm_set_followup", [lead.id, config, saveId])),
    settings,
  );
  checks++;
  await rejects(
    () =>
      staff(() =>
        rpc("bk_crm_set_followup", [lead.id, { enabled: false }, saveId])
      ),
    /request_changed/,
    "request ID cannot change settings on retry",
  );
  await rejects(
    () =>
      staff(() =>
        rpc("bk_crm_set_followup", [lead.id, { lead_days: [3, 1] }, id()])
      ),
    /cadence_days/,
    "cadence offsets must increase",
  );
  await rejects(
    () =>
      staff(() =>
        rpc("bk_crm_set_followup", [lead.id, { lead_days: [0, 1] }, id()])
      ),
    /cadence_days/,
    "cadence minimum is one business day",
  );
  await rejects(
    () =>
      staff(() =>
        rpc("bk_crm_set_followup", [lead.id, { lead_days: [1, 1] }, id()])
      ),
    /cadence_days/,
    "duplicate offsets rejected",
  );
  await rejects(
    () => staff(() => rpc("bk_crm_set_followup", [lead.id, null, id()])),
    /invalid_followup_settings/,
    "null settings cannot start or change a cadence",
  );
  const completeId = id();
  await staff(() =>
    rpc("bk_crm_followup_action", [firstTask, "done", completeId])
  );
  settings = await staff(() => rpc("bk_crm_followup_settings", [lead.id]));
  check(
    settings.step === 1 && settings.current_task_id !== firstTask,
    "completing first task creates exactly next step",
  );
  const expectedAfterDelay =
    (await one("select bk_crm_private.growth_due($1,3) value", [delayed]))
      .value;
  check(
    Date.parse(settings.next_due_at) === Date.parse(expectedAfterDelay),
    "next touch respects manually delayed first action and configured gap even when completed early",
  );
  const nextTask = settings.current_task_id;
  await staff(() =>
    rpc("bk_crm_followup_action", [firstTask, "done", completeId])
  );
  await staff(() => rpc("bk_crm_followup_action", [firstTask, "done", id()]));
  check(
    (await staff(() => rpc("bk_crm_followup_settings", [lead.id]))).step === 1,
    "duplicate completion never skips a step",
  );
  check(
    (await one(
      "select count(*)::int n from bk_tasks where project_id=$1 and status='open'",
      [lead.id],
    )).n === 1,
    "only one active cadence task exists",
  );
  const snoozeId = id();
  const snoozed = new Date(Date.now() + 20 * 86400000).toISOString();
  await staff(() =>
    rpc("bk_crm_followup_action", [nextTask, "snooze", snoozeId, snoozed])
  );
  check(
    Date.parse(
      (await staff(() => rpc("bk_crm_followup_settings", [lead.id])))
        .next_due_at,
    ) === Date.parse(snoozed),
    "snooze changes actual current task only",
  );
  await rejects(
    () =>
      staff(() =>
        rpc("bk_crm_followup_action", [nextTask, "snooze", id(), "2000-01-01"])
      ),
    /invalid_snooze/,
    "past snooze refused",
  );

  await query(
    "insert into bk_messages(project_id,sender,body) values($1,'client','Synthetic reply')",
    [lead.id],
  );
  settings = await staff(() => rpc("bk_crm_followup_settings", [lead.id]));
  check(
    settings.state === "client_replied" && !settings.current_task_id,
    "authenticated portal/email reply stops cadence",
  );
  check(
    (await one("select status from bk_tasks where id=$1", [nextTask]))
      .status === "cancelled",
    "pending cadence touch cancelled on client reply",
  );
  await rejects(
    () => staff(() => rpc("bk_crm_followup_action", [nextTask, "done", id()])),
    /task_no_longer_open/,
    "a stale morning action cannot complete a canceled task",
  );
  check(
    (await one(
      "select count(*)::int n from bk_tasks where project_id=$1 and automation_key='client_reply' and status='open'",
      [lead.id],
    )).n === 1,
    "real client reply task stays actionable",
  );
  await query(
    "insert into bk_messages(project_id,sender,body) values($1,'studio','Synthetic staff reply')",
    [lead.id],
  );
  settings = await staff(() => rpc("bk_crm_followup_settings", [lead.id]));
  check(
    settings.state === "active" && settings.step === 0,
    "staff reply restarts waiting cadence once",
  );
  check(
    (await one(
      "select count(*)::int n from bk_tasks where project_id=$1 and status='open' and kind='followup'",
      [lead.id],
    )).n === 1,
    "staff reply closes client-reply task and leaves one next action",
  );

  await staff(() =>
    rpc("bk_crm_save_project", [lead.id, { status: "booked" }])
  );
  check(
    (await staff(() => rpc("bk_crm_followup_settings", [lead.id]))).state ===
      "stopped",
    "booking stops lead cadence",
  );
  check(
    (await one(
      "select count(*)::int n from bk_tasks where project_id=$1 and status='open' and kind='production'",
      [lead.id],
    )).n === 1,
    "booking preparation workflow remains",
  );
  const quoteLead = await create();
  const quote = await staff(() =>
    rpc("bk_crm_save_quote", [quoteLead.id, {
      lines: [{
        description: "Synthetic scope",
        quantity: 1,
        unit_cents: 5000,
      }],
    }])
  );
  await staff(() => rpc("bk_crm_quote_status", [quote.id, "sent"]));
  settings = await staff(() => rpc("bk_crm_followup_settings", [quoteLead.id]));
  check(
    settings.phase === "quote" && settings.step === 0 &&
      settings.state === "active",
    "sent quote coordinates quote cadence",
  );
  check(
    (await one(
      "select count(*)::int n from bk_tasks where project_id=$1 and status='open' and kind='followup'",
      [quoteLead.id],
    )).n === 1,
    "stage transition closes initial task before quote followup",
  );
  await anonymous(() =>
    rpc("bk_crm_accept_quote", [
      quoteLead.id,
      quoteLead.access_token,
      quote.id,
      quote.version,
      "Synthetic Signer",
    ])
  );
  check(
    (await staff(() => rpc("bk_crm_followup_settings", [quoteLead.id])))
      .state === "client_replied",
    "quote decision stops nudging accepted scope",
  );
  const closedLead = await create();
  await staff(() =>
    rpc("bk_crm_save_project", [closedLead.id, {
      status: "lost",
      lost_reason: "Synthetic test closure",
    }])
  );
  check(
    (await staff(() => rpc("bk_crm_followup_settings", [closedLead.id])))
      .state === "stopped",
    "lost opportunity stops cadence",
  );
  const finishLead = await create();
  for (let n = 0; n < 3; n++) {
    const f = await staff(() =>
      rpc("bk_crm_followup_settings", [finishLead.id])
    );
    await staff(() =>
      rpc("bk_crm_followup_action", [f.current_task_id, "done", id()])
    );
  }
  check(
    (await staff(() => rpc("bk_crm_followup_settings", [finishLead.id])))
      .state === "complete",
    "cadence exhausts rather than creating endless tasks",
  );
  const friday = (await one(
    "select bk_crm_private.growth_due('2026-11-20T18:00:00Z',1) value",
  )).value;
  check(
    new Date(friday).toISOString() === "2026-11-23T15:00:00.000Z",
    "Friday cadence lands Monday at nine Central",
  );
  const defaultSnoozeLead = await create();
  const defaultPlan = await staff(() =>
    rpc("bk_crm_followup_settings", [defaultSnoozeLead.id])
  );
  const defaultSnoozeId = id();
  const defaultSnooze = await staff(() =>
    rpc("bk_crm_followup_action", [
      defaultPlan.current_task_id,
      "snooze",
      defaultSnoozeId,
      null,
    ])
  );
  const nextMorning =
    (await one("select bk_crm_private.growth_due(now(),1) value")).value;
  check(
    Date.parse(defaultSnooze.due_at) === Date.parse(nextMorning),
    "default snooze uses next business morning in Central time",
  );
  assert.deepEqual(
    await staff(() =>
      rpc("bk_crm_followup_action", [
        defaultPlan.current_task_id,
        "snooze",
        defaultSnoozeId,
        null,
      ])
    ),
    defaultSnooze,
  );
  checks++;

  const morningLead = await create();
  await query(
    "update bk_tasks set due_at=now()-interval '1 day' where project_id=$1 and status='open'",
    [morningLead.id],
  );
  const morning = await staff(() => rpc("bk_crm_morning", [null, null, 0, 1]));
  check(
    morning.total >= 1 && morning.rows.length === 1,
    "morning list paginates real due tasks",
  );
  const page = await staff(() => rpc("bk_crm_morning", [null, null, 0, 100]));
  const listed = page.rows.find((t) => t.project_id === morningLead.id);
  check(
    listed.conversation_url === "/inbox/?p=" + morningLead.id,
    "morning row links exact conversation",
  );
  check(
    listed.template_url === listed.conversation_url + "&template=call",
    "morning row links deterministic existing template",
  );
  check(
    !(await staff(() => rpc("bk_crm_morning", [null, CLIENT, 0, 100]))).rows
      .length,
    "owner filter does not include other staff tasks",
  );

  const attributionId = id();
  const utm = {
    utm_source: "instagram",
    utm_medium: "paid_social",
    utm_campaign: "summer-launch",
    referrer_host: "instagram.com",
    landing_path: "/book?token=must-not-store#fragment",
  };
  const web = await anonymous(() =>
    rpc("bk_submit_inquiry_attributed", [
      attributionId,
      "Synthetic Website",
      "web@example.test",
      "brand_content",
      null,
      null,
      null,
      null,
      null,
      "Synthetic request",
      "Website",
      null,
      utm,
    ])
  );
  assert.deepEqual(
    await anonymous(() =>
      rpc("bk_submit_inquiry_attributed", [
        attributionId,
        "Synthetic Website",
        "web@example.test",
        "brand_content",
        null,
        null,
        null,
        null,
        null,
        "Synthetic request",
        "Website",
        null,
        { ...utm, utm_source: "google" },
      ])
    ),
    web,
  );
  checks++;
  let attr = await staff(() =>
    one("select * from bk_lead_attribution where project_id=$1", [web.id])
  );
  check(
    attr.source_normalized === "Instagram" &&
      attr.utm_campaign === "summer-launch",
    "website attribution captures normalized source and campaign",
  );
  check(
    attr.landing_path === "/book" && attr.capture_method === "website",
    "landing path never retains portal/query capabilities",
  );
  await staff(() =>
    rpc("bk_crm_save_project", [web.id, { referral_source: "Referral" }])
  );
  check(
    (await one(
      "select source_normalized from bk_lead_attribution where project_id=$1",
      [web.id],
    ))
      .source_normalized === "Instagram",
    "ordinary source edits preserve website first-touch attribution",
  );
  const attachRequest = id();
  const staffAttribution = {
    source: "Google search",
    utm_campaign: "search-test",
  };
  const updated = await staff(() =>
    rpc("bk_crm_set_attribution", [web.id, staffAttribution, attachRequest])
  );
  assert.deepEqual(
    await staff(() =>
      rpc("bk_crm_set_attribution", [web.id, staffAttribution, attachRequest])
    ),
    updated,
  );
  checks++;
  await staff(() =>
    rpc("bk_crm_save_project", [web.id, { referral_source: "Other" }])
  );
  check(
    (await one(
      "select source_normalized from bk_lead_attribution where project_id=$1",
      [web.id],
    ))
      .source_normalized === "Search",
    "ordinary source edits preserve staff-reviewed reporting attribution",
  );
  await anonymous(() =>
    rpc("bk_submit_inquiry_attributed", [
      attributionId,
      "Synthetic Website",
      "web@example.test",
      "brand_content",
      null,
      null,
      null,
      null,
      null,
      "Synthetic request",
      "Website",
      null,
      utm,
    ])
  );
  check(
    (await staff(() =>
      one(
        "select source_normalized from bk_lead_attribution where project_id=$1",
        [web.id],
      )
    )).source_normalized === "Search",
    "public retry cannot overwrite staff-reviewed source",
  );
  await rejects(
    () =>
      staff(() =>
        rpc("bk_crm_set_attribution", [
          web.id,
          { billing_provider: "stripe" },
          id(),
        ])
      ),
    /unsupported_attribution_field/,
    "attribution cannot write billing or client properties",
  );
  await rejects(
    () =>
      anonymous(() =>
        rpc("bk_submit_inquiry_attributed", [
          id(),
          "Bad attribution",
          "bad@example.test",
          "other",
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          { referrer_host: "user:password@example.com" },
        ])
      ),
    /invalid_referrer_host/,
    "unsafe referrer does not create a lead",
  );

  await query(
    "insert into bk_invoices(project_id,amount_cents,paid_amount_cents,status,paid_at) values($1,10000,8000,'paid',now())",
    [web.id],
  );
  await query(
    "insert into bk_messages(project_id,sender,body,created_at) values($1,'studio','Synthetic recorded reply',now()+interval '2 hours')",
    [web.id],
  );
  const held = await staff(() =>
    rpc("bk_crm_source_report", [
      "2020-01-01",
      "2030-01-01",
      "Search",
      "search-test",
    ])
  );
  check(
    held.totals.leads === 1 && held.totals.booked === 0 &&
      Number(held.totals.receipts_cents) === 8000,
    "paid invoice on an unbooked project records receipts without claiming a booking",
  );
  await staff(() => rpc("bk_crm_save_project", [web.id, { status: "booked" }]));
  const report = await staff(() =>
    rpc("bk_crm_source_report", [
      "2020-01-01",
      "2030-01-01",
      "Search",
      "search-test",
    ])
  );
  check(
    report.totals.leads === 1 && report.totals.booked === 1 &&
      Number(report.totals.receipts_cents) === 8000,
    "filtered source report uses actual receipts without invoice face inflation",
  );
  check(
    Number(report.totals.median_response_hours) > 1.9 &&
      Number(report.totals.median_response_hours) < 2.1,
    "response time uses first recorded studio reply",
  );
  check(
    report.rows.length === 1 && Number(report.rows[0].conversion_pct) === 100,
    "source conversion uses consistent lead cohort",
  );
  check(
    report.campaigns[0].campaign === "search-test",
    "campaign report is filterable",
  );
  check(
    report.basis === "lead_created_date",
    "report declares its cohort basis",
  );
  check(
    report.unit === "project_opportunity",
    "repeat jobs count as project opportunities, not distinct people",
  );
  for (
    const kind of [
      "prep_answers_saved",
      "prep_submitted",
      "video_note_added",
      "video_note_updated",
      "video_approved",
      "video_changes",
    ]
  ) {
    const clientAction = await create();
    await query(
      "insert into bk_activities(project_id,kind,summary) values($1,$2,'Synthetic client response')",
      [clientAction.id, kind],
    );
    check(
      (await staff(() => rpc("bk_crm_followup_settings", [clientAction.id])))
        .state === "client_replied",
      kind + " stops sales nudges without touching client preparation tasks",
    );
  }
  await query("delete from bk_lead_attribution where project_id=$1", [
    morningLead.id,
  ]);
  const fallback = await staff(() =>
    rpc("bk_crm_source_report", ["2020-01-01", "2030-01-01", "Instagram"])
  );
  check(
    fallback.totals.leads > 0,
    "projects without attribution still count from normalized declared source",
  );
  check(
    (await one("select count(*)::int n from bk_email_queue")).n === 2,
    "cadence and attribution never send or queue extra messages",
  );

  console.log(
    "followup-attribution.pglite:",
    checks,
    "checks passed; synthetic data, no live sends",
  );
} finally {
  await db.close();
}
