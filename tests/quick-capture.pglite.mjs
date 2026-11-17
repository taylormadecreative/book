import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const query = async (sql, args = []) => (await db.query(sql, args)).rows;
const staff = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
let checks = 0;
async function capture(payload) {
  const rows = await query(
    "select public.bk_crm_capture_lead($1::jsonb) result",
    [JSON.stringify(payload)],
  );
  return rows[0].result;
}
try {
  await db.exec(read("./fixtures/crm-schema.sql"));
  await db.exec(
    read("../supabase/migrations/20261116192939_crm_foundation.sql"),
  );
  await db.exec(
    read("../supabase/migrations/20261117033508_crm_quick_capture.sql"),
  );
  await query(
    `insert into public.profiles values ($1,'employee','Synthetic Staff'),($2,'client','Synthetic Client')`,
    [staff, stranger],
  );
  await db.exec("set role authenticated");
  await query(`select set_config('request.jwt.claim.sub',$1,false)`, [staff]);
  const payload = {
    client_name: "Synthetic Quick Lead",
    instagram: "synthetic_lead",
    service: "brand_content",
    details: "Synthetic shared conversation",
    referral_source: "Instagram",
    next_action: "Discuss shoot requirements",
    next_due_at: "2099-01-02T15:00:00Z",
    request_id: "aaaaaaaa-1111-4111-8111-111111111111",
  };
  const created = await capture(payload);
  assert.ok(created.id && !created.client_email);
  checks++;
  assert.equal(
    (await query("select title from public.bk_tasks where project_id=$1", [
      created.id,
    ]))[0].title,
    payload.next_action,
  );
  checks++;
  assert.equal(
    new Date(
      (await query("select due_at from public.bk_tasks where project_id=$1", [
        created.id,
      ]))[0].due_at,
    ).toISOString(),
    payload.next_due_at.replace("Z", ".000Z"),
  );
  checks++;
  assert.equal((await capture(payload)).id, created.id);
  checks++;
  assert.equal(
    (await query("select count(*)::int n from public.bk_projects"))[0].n,
    1,
  );
  checks++;
  assert.equal(
    (await query("select count(*)::int n from public.bk_tasks"))[0].n,
    1,
  );
  checks++;
  assert.equal(
    (await query("select count(*)::int n from public.bk_email_queue"))[0].n,
    0,
  );
  checks++;
  await assert.rejects(
    capture({ ...payload, next_action: "Changed request" }),
    /request_changed/,
  );
  checks++;
  await query(
    `update public.bk_tasks set title='Staff changed this later' where project_id=$1`,
    [created.id],
  );
  await capture(payload);
  assert.equal(
    (await query("select title from public.bk_tasks where project_id=$1", [
      created.id,
    ]))[0].title,
    "Staff changed this later",
  );
  checks++;
  await assert.rejects(capture({ ...payload, request_id: null }), /request ID/);
  checks++;
  await assert.rejects(
    capture({
      ...payload,
      request_id: "bbbbbbbb-2222-4222-8222-222222222222",
      details: "x".repeat(4001),
    }),
    /length/,
  );
  checks++;
  const boundary = await capture({
    ...payload,
    request_id: "cccccccc-3333-4333-8333-333333333333",
    next_action: "x".repeat(180),
  });
  assert.equal(
    (await query(
      "select length(title) n from public.bk_tasks where project_id=$1",
      [boundary.id],
    ))[0].n,
    180,
  );
  checks++;
  await assert.rejects(
    capture({
      ...payload,
      request_id: "dddddddd-4444-4444-8444-444444444444",
      next_action: "x".repeat(181),
    }),
    /length/,
  );
  checks++;
  assert.equal(
    (await query("select count(*)::int n from public.bk_projects"))[0].n,
    2,
  );
  checks++;
  await query(`select set_config('request.jwt.claim.sub',$1,false)`, [
    stranger,
  ]);
  await assert.rejects(capture(payload), /Staff access required/);
  checks++;
  await assert.rejects(
    query("select * from bk_crm_private.capture_requests"),
    /permission denied/,
  );
  checks++;
  await db.exec("reset role; set role anon");
  await assert.rejects(capture(payload), /permission denied/);
  checks++;
  console.log(`quick-capture.pglite: ${checks} checks passed`);
} finally {
  await db.close();
}
