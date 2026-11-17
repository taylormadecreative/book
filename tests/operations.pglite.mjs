import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const db = new PGlite(),
  read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const q = async (s, p = []) => (await db.query(s, p)).rows,
  one = async (s, p = []) => (await q(s, p))[0];
const rpc = async (name, args = []) =>
  (await one(
    `select ${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) r`,
    args,
  )).r;
const STAFF = "11111111-1111-4111-8111-111111111111",
  CLIENT = "22222222-2222-4222-8222-222222222222";
let checks = 0;
const check = (v, label) => {
  assert.ok(v, label);
  checks++;
};
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
  save = (action, data, id = crypto.randomUUID()) =>
    staff(() => rpc("bk_ops_save", [action, data, id]));
try {
  await db.exec(read("./fixtures/crm-schema.sql"));
  await db.exec(
    `alter table bk_bookings add column travel_min int default 0,add column balance_invoice_id uuid;create table bk_config(key text primary key,value text);create function bk_cfg_int(text,int) returns int language sql as $$select $2$$;`,
  );
  await db.exec(
    read("../supabase/migrations/20261116192939_crm_foundation.sql"),
  );
  await db.exec(
    read("../supabase/migrations/20261116193011_crm_payment_integrity.sql"),
  );
  await db.exec(
    read("../supabase/migrations/20261117033351_crm_studio_operations.sql"),
  );
  const calendar = await one(`select
    date_trunc('month', now() at time zone 'America/Chicago')::date::text current_month,
    (date_trunc('month', now() at time zone 'America/Chicago') - interval '1 month')::date::text previous_month,
    (date_trunc('month', now() at time zone 'America/Chicago') + interval '1 month')::date::text next_month,
    (date_trunc('month', now() at time zone 'America/Chicago') + interval '2 months')::date::text following_month`);
  await q(
    `insert into profiles values($1,'employee','Synthetic Editor'),($2,'client','Synthetic Client')`,
    [STAFF, CLIENT],
  );
  const project = await staff(() =>
    rpc("bk_crm_create_project", [{
      client_name: "Synthetic Studio Customer",
      client_email: "studio@example.test",
      service: "brand_content",
      referral_source: "Test",
      title: "Synthetic Campaign",
    }])
  );
  await staff(() =>
    rpc("bk_set_project_billing", [project.id, "honeybook", null, null])
  );
  await assert.rejects(
    as("anon", null, () => rpc("bk_ops_project", [project.id])),
  );
  checks++;
  await assert.rejects(
    as("authenticated", CLIENT, () => rpc("bk_ops_profit", [])),
  );
  checks++;
  const request = crypto.randomUUID(),
    expenseData = {
      project_id: project.id,
      title: "Crew cost",
      category: "contractor",
      amount_cents: 20000,
      incurred_on: "2026-11-16",
      notes: "",
    };
  const expense = await save("expense", expenseData, request);
  assert.deepEqual(await save("expense", expenseData, request), expense);
  checks++;
  await assert.rejects(
    save("expense", { ...expenseData, amount_cents: 30000 }, request),
    /request changed/,
  );
  checks++;
  check(
    (await one(`select count(*)::int n from bk_project_expenses`)).n === 1,
    "expense retry does not duplicate actual cost",
  );
  await save("staff_capacity", {
    staff_id: STAFF,
    weekly_minutes: 600,
    hourly_cost_cents: 6000,
    working_days: [1, 2, 3, 4, 5],
  });
  const entry = await save("time", {
    project_id: project.id,
    staff_id: STAFF,
    title: "Edit first cut",
    worked_on: "2026-11-16",
    minutes: 90,
    notes: "",
  });
  check(
    entry.hourly_cost_cents === 6000,
    "time saves the internal cost rate snapshot",
  );
  await save("staff_capacity", {
    staff_id: STAFF,
    weekly_minutes: 600,
    hourly_cost_cents: 10000,
    working_days: [1, 2, 3, 4, 5],
  });
  await q(
    `insert into bk_invoices(project_id,title,amount_cents,paid_amount_cents,kind,status,source,paid_at) values($1,'Synthetic received payment',100000,80000,'balance','paid','honeybook',now())`,
    [project.id],
  );
  let profit = await staff(() => rpc("bk_ops_profit", [project.id]));
  check(
    Number(profit.rows[0].received_cents) === 80000 &&
      Number(profit.rows[0].expenses_cents) === 20000 &&
      Number(profit.rows[0].labor_cents) === 9000 &&
      Number(profit.rows[0].contribution_cents) === 51000,
    "profit separates actual receipts from invoice amount and snapshots labor costs",
  );
  const block = await save("allocation", {
    project_id: project.id,
    staff_id: STAFF,
    title: "Campaign edit",
    work_on: "2026-11-17",
    minutes: 700,
    status: "planned",
    notes: "",
  });
  const capacity = await staff(() => rpc("bk_ops_capacity", ["2026-11-17"]));
  check(
    capacity.staff[0].assigned_minutes === 700 &&
      capacity.staff[0].weekly_minutes === 600,
    "capacity shows overload without changing dates",
  );
  check(
    (await one(`select title,status from bk_tasks where id=$1`, [
      block.task_id,
    ])).status === "open",
    "editing block links an actual next-action task",
  );
  await save("allocation", { ...block, status: "done" });
  check(
    (await one(`select status from bk_tasks where id=$1`, [block.task_id]))
      .status === "done",
    "completed editing block completes linked task",
  );
  check(
    (await one(`select delivery_target from bk_projects where id=$1`, [
      project.id,
    ])).delivery_target === null,
    "planning never silently changes the promised delivery date",
  );
  const retainer = await save("retainer", {
    contact_id: project.contact_id,
    name: "Monthly content",
    status: "active",
    billing_provider: "honeybook",
    monthly_amount_cents: 120000,
    start_on: calendar.previous_month,
    owner_id: STAFF,
    allowances: [{ key: "reels", label: "Reels", quantity: 4 }, {
      key: "photos",
      label: "Photos",
      quantity: 20,
    }],
    notes: "",
  });
  check(
    (await one(
      `select count(*)::int n from bk_tasks where automation_key like 'ops_retainer_%' and status='open'`,
    )).n === 1,
    "activation creates one due renewal task",
  );
  const beforeEmail =
    (await one(`select count(*)::int n from bk_email_queue`)).n;
  const period = await save("open_period", {
    retainer_id: retainer.id,
    period_month: calendar.current_month,
    project_id: project.id,
  });
  const same = await save("open_period", {
    retainer_id: retainer.id,
    period_month: calendar.current_month,
    project_id: project.id,
  });
  check(
    same.id === period.id,
    "different request cannot create a duplicate calendar period",
  );
  check(
    (await one(
      `select count(*)::int n from bk_tasks where automation_key like 'ops_retainer_%' and status='open'`,
    )).n === 1,
    "opening a month schedules the next renewal exactly once",
  );
  const useRequest = crypto.randomUUID(),
    useData = {
      period_id: period.id,
      item_key: "reels",
      quantity: 3,
      note: "Delivered three approved reels",
    };
  const usage = await save("usage", useData, useRequest);
  assert.deepEqual(await save("usage", useData, useRequest), usage);
  checks++;
  await assert.rejects(
    save("usage", { ...useData, quantity: 2 }),
    /Not enough/,
  );
  checks++;
  await save("usage", {
    period_id: period.id,
    item_key: "reels",
    quantity: 1,
    note: "Returned one mistaken entry",
    reverses_id: usage.id,
  });
  await assert.rejects(
    save("usage", {
      period_id: period.id,
      item_key: "reels",
      quantity: 3,
      note: "Invalid duplicate return",
      reverses_id: usage.id,
    }),
    /more than/,
  );
  checks++;
  const portal = await as(
    "anon",
    null,
    () => rpc("bk_ops_portal_retainers", [project.id, project.access_token]),
  );
  check(
    portal.rows[0].allowances.find((a) => a.key === "reels").remaining === 2,
    "client sees accurate fulfilled and remaining monthly allowances",
  );
  check(
    !JSON.stringify(portal).includes("Crew cost") &&
      !JSON.stringify(portal).includes("hourly_cost"),
    "client response excludes expenses and internal rate assumptions",
  );
  await assert.rejects(
    as(
      "anon",
      null,
      () => rpc("bk_ops_portal_retainers", [project.id, crypto.randomUUID()]),
    ),
  );
  checks++;
  const draft = await save("prepare_invoice", { period_id: period.id });
  check(
    draft.status === "draft" && draft.amount_cents === 120000 &&
      draft.source === "retainer",
    "monthly billing prepares a draft in existing provider",
  );
  check(
    (await save("prepare_invoice", { period_id: period.id })).id === draft.id,
    "invoice preparation cannot duplicate the monthly invoice",
  );
  check(
    (await one(`select count(*)::int n from bk_email_queue`)).n === beforeEmail,
    "operations never queue client messages or charges",
  );
  await assert.rejects(
    save("retainer", { ...retainer, billing_provider: "stripe" }),
    /Provider is locked/,
  );
  checks++;
  await save("adjust_allowance", {
    period_id: period.id,
    item_key: "photos",
    included: 1,
    note: "Client agreed a smaller current-month package",
  });
  const competing = await staff(() =>
    Promise.allSettled([
      rpc("bk_ops_save", ["usage", {
        period_id: period.id,
        item_key: "photos",
        quantity: 1,
        note: "First fulfilled reel",
      }, crypto.randomUUID()]),
      rpc("bk_ops_save", ["usage", {
        period_id: period.id,
        item_key: "photos",
        quantity: 1,
        note: "Second competing reel",
      }, crypto.randomUUID()]),
    ])
  );
  check(
    competing.filter((x) => x.status === "fulfilled").length === 1 &&
      competing.filter((x) => x.status === "rejected").length === 1,
    "distinct competing requests cannot overdraw a single remaining allowance",
  );
  await save("close_period", { id: period.id });
  await assert.rejects(save("usage", { ...useData, quantity: 1 }), /closed/);
  checks++;
  await save("void_expense", { id: expense.id });
  profit = await staff(() => rpc("bk_ops_profit", [project.id]));
  check(
    Number(profit.rows[0].expenses_cents) === 0,
    "voided expense remains in audit but leaves contribution calculation",
  );
  check(
    (await as(
      "authenticated",
      CLIENT,
      () => q("select * from bk_project_expenses"),
    )).length === 0,
    "RLS hides staff costs from clients",
  );
  await assert.rejects(staff(() => q("select * from bk_ops_private.requests")));
  checks++;
  await assert.rejects(staff(() => rpc("bk_ops_queue_renewals")));
  checks++;
  await assert.rejects(
    staff(() =>
      q(
        "insert into bk_project_expenses(project_id,title,category,amount_cents,incurred_on) values($1,'Direct browser cost','other',1,current_date)",
        [project.id],
      )
    ),
  );
  checks++;
  check(
    (await one(
      "select relrowsecurity from pg_class where oid='bk_ops_private.requests'::regclass",
    )).relrowsecurity,
    "private request ledger has RLS defense",
  );
  await save("void_time", { id: entry.id });
  check(
    Number(
      (await staff(() => rpc("bk_ops_profit", [project.id]))).rows[0]
        .labor_cents,
    ) === 0,
    "voided time remains in history without contributing cost",
  );
  await assert.rejects(
    save("expense", { ...expenseData, title: "x".repeat(181) }),
  );
  checks++;
  await assert.rejects(
    save("retainer", {
      ...retainer,
      allowances: [{ key: "fraction", label: "Fraction", quantity: 1.5 }],
    }),
  );
  checks++;
  await assert.rejects(
    save("retainer", {
      ...retainer,
      allowances: [{ key: "same", label: "A", quantity: 1 }, {
        key: "same",
        label: "B",
        quantity: 2,
      }],
    }),
    /duplicate/,
  );
  checks++;
  await assert.rejects(
    save("adjust_allowance", {
      period_id: period.id,
      item_key: "reels",
      included: 1,
      note: "Agreed incorrect reduction",
    }),
    /below/,
  );
  checks++;
  const revised = {
    ...retainer,
    monthly_amount_cents: 150000,
    allowances: [{ key: "reels", label: "Reels", quantity: 6 }],
  };
  await save("retainer", revised);
  const next = await save("open_period", {
    retainer_id: retainer.id,
    period_month: calendar.next_month,
  });
  const monthlyProject = await one("select * from bk_projects where id=$1", [
    next.project_id,
  ]);
  check(
    monthlyProject.contact_id === project.contact_id &&
      monthlyProject.billing_provider === "honeybook" &&
      monthlyProject.referral_source === "Repeat client / retainer",
    "monthly renewal creates its own linked repeat-client work project",
  );
  check(
    next.monthly_amount_cents === 150000 &&
      next.billing_provider === "honeybook",
    "new month snapshots revised package amount and confirmed provider",
  );
  const previousPeriod = await one(
    "select * from bk_retainer_periods where id=$1",
    [period.id],
  );
  check(
    previousPeriod.monthly_amount_cents === 120000 &&
      previousPeriod.billing_provider === "honeybook",
    "package revisions cannot rewrite a prior month's billing assumptions",
  );
  const nextPortal = await as(
    "anon",
    null,
    () =>
      rpc("bk_ops_portal_retainers", [
        next.project_id,
        monthlyProject.access_token,
      ]),
  );
  check(
    nextPortal.rows.length === 1 && nextPortal.rows[0].period_id === next.id &&
      nextPortal.rows[0].allowances[0].included === 6,
    "each portal sees only its own project's snapshotted allowances",
  );
  const priorPortal = await as(
    "anon",
    null,
    () => rpc("bk_ops_portal_retainers", [project.id, project.access_token]),
  );
  check(
    priorPortal.rows.length === 1 &&
      priorPortal.rows[0].allowances.find((a) => a.key === "reels").included ===
        4,
    "future allowance changes cannot rewrite old period allowances",
  );
  check(
    priorPortal.rows[0].status === "closed" &&
      priorPortal.rows[0].package_status === "active",
    "client period state is distinct from package lifecycle",
  );
  await assert.rejects(
    save("usage", {
      period_id: next.id,
      item_key: "reels",
      quantity: 1,
      note: "Cannot fulfill future work",
    }),
    /has not started/,
  );
  checks++;
  check(
    nextPortal.rows[0].period_state === "upcoming" &&
      nextPortal.rows[0].allowances[0].available_now === 0,
    "future open period reports zero currently available allowances",
  );
  check(
    priorPortal.rows[0].period_state === "closed" &&
      priorPortal.rows[0].allowances.every((a) => a.available_now === 0),
    "closed period preserves unused history without current availability",
  );
  const expired = await save("open_period", {
    retainer_id: retainer.id,
    period_month: calendar.previous_month,
  });
  await assert.rejects(
    save("usage", {
      period_id: expired.id,
      item_key: "reels",
      quantity: 1,
      note: "Cannot consume expired allowance",
    }),
    /has expired/,
  );
  checks++;
  const historic = (await q(
    `insert into bk_retainer_usage(period_id,item_key,quantity_delta,note,actor_id,created_at) values($1,'reels',2,'Historical fulfillment fixture',$2,$3::date) returning id`,
    [expired.id, STAFF, calendar.previous_month],
  ))[0];
  await save("usage", {
    period_id: expired.id,
    item_key: "reels",
    quantity: 1,
    note: "Correct a mistaken historical entry",
    reverses_id: historic.id,
  });
  const expiredProject = await one(
    "select access_token from bk_projects where id=$1",
    [expired.project_id],
  );
  const expiredPortal = await as(
    "anon",
    null,
    () =>
      rpc("bk_ops_portal_retainers", [
        expired.project_id,
        expiredProject.access_token,
      ]),
  );
  check(
    expiredPortal.rows[0].status === "open" &&
      expiredPortal.rows[0].period_state === "expired",
    "unclosed historical period is labeled expired",
  );
  check(
    expiredPortal.rows[0].allowances[0].used === 1 &&
      expiredPortal.rows[0].allowances[0].remaining === 5 &&
      expiredPortal.rows[0].allowances[0].available_now === 0,
    "historical reversal remains permitted without reviving expired entitlement",
  );
  const activeTaskCount = (await one(
    "select count(*)::int n from bk_tasks where automation_key like 'ops_retainer_%' and status='open'",
  )).n;
  await as("service_role", null, () => rpc("bk_ops_queue_renewals"));
  check(
    (await one(
      "select count(*)::int n from bk_tasks where automation_key like 'ops_retainer_%' and status='open'",
    )).n === activeTaskCount,
    "scheduled renewal queue is idempotent",
  );
  await save("retainer", { ...revised, status: "paused" });
  check(
    (await one(
      "select count(*)::int n from bk_tasks where automation_key like 'ops_retainer_%' and status='open'",
    )).n === 0,
    "paused package cancels future open renewal tasks",
  );
  await assert.rejects(
    save("open_period", {
      retainer_id: retainer.id,
      period_month: calendar.following_month,
    }),
    /Activate/,
  );
  checks++;
  check(
    (await one("select count(*)::int n from bk_email_queue")).n === beforeEmail,
    "full package renewal lifecycle queues no client message or charge",
  );
  console.log(
    `operations.pglite: ${checks} checks passed (synthetic costs, time, capacity and retainer lifecycle; no external calls)`,
  );
} finally {
  await db.close();
}
