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
const save = (item) => staff(() => rpc("bk_money_save", [item, id()]));
const board = (show = "open", day = "2026-11-18") =>
  staff(() => rpc("bk_money_board", [show, day]));

try {
  await db.exec(read("./fixtures/crm-schema.sql"));
  for (
    const file of [
      "20261116192939_crm_foundation.sql",
      "20261116193012_crm_intake_retries.sql",
      "20261116193952_crm_inbound_email.sql",
    ]
  ) await db.exec(read("../supabase/migrations/" + file));
  await db.exec("alter table bk_invoices add column paid_amount_cents int");
  await query(
    "insert into profiles values($1,'employee','Synthetic Staff'),($2,'client','Synthetic Client')",
    [STAFF, CLIENT],
  );
  await db.exec(
    read("../supabase/migrations/20261117033405_crm_followup_attribution.sql"),
  );
  await db.exec(
    read("../supabase/migrations/20261118090000_crm_open_money.sql"),
  );

  // staff-only
  await rejects(
    () => anonymous(() => rpc("bk_money_board")),
    /Staff access|permission denied/,
    "anon cannot read the board",
  );
  await rejects(
    () => as("authenticated", CLIENT, () => rpc("bk_money_board")),
    /Staff access/,
    "a signed-in client cannot read the board",
  );
  await rejects(
    () => as("authenticated", CLIENT, () => rpc("bk_money_save", [{ client_name: "x", title: "y" }, id()])),
    /Staff access/,
    "a signed-in client cannot write",
  );
  await rejects(
    () => anonymous(() => query("select * from bk_money_items")),
    /permission denied/,
    "no direct table read",
  );
  await rejects(
    () => as("authenticated", STAFF, () => query("select * from bk_money_items")),
    /permission denied/,
    "staff read through the functions only",
  );
  const empty = await board("open", "2026-11-17");
  check(
    empty.rows.length === 0 && empty.totals.items === 0 &&
      empty.totals.open_cents === 0 && empty.day === "2026-11-17",
    "empty board",
  );

  // minimal add, then retry with the same request id
  const req = id();
  const a = await staff(() =>
    rpc("bk_money_save", [{
      client_name: " Synthetic Client ",
      title: "Synthetic proposal",
    }, req])
  );
  const again = await staff(() =>
    rpc("bk_money_save", [{
      client_name: " Synthetic Client ",
      title: "Synthetic proposal",
    }, req])
  );
  check(
    a.id === again.id &&
      (await one("select count(*)::int n from bk_money_items")).n === 1,
    "a retried save creates one item",
  );
  check(
    a.client_name === "Synthetic Client" && a.step === "decision" &&
      a.ball === "client" && a.provider === "other" &&
      a.amount_cents === null && a.view_key.length >= 32 &&
      a.view_count === 0 && a.closed_at === null,
    "defaults",
  );
  await rejects(
    () => staff(() => rpc("bk_money_save", [{ client_name: "Changed", title: "x" }, req])),
    /request_changed/,
    "a reused id with different data is refused",
  );
  await rejects(
    () => staff(() => rpc("bk_money_save", [{ client_name: "x", title: "y" }, null])),
    /request_id_required/,
    "a write needs a request id",
  );

  // validation, one rejects() per message
  const invalid = [
    [{}, /client_name_required/],
    [{ client_name: "   ", title: "x" }, /client_name_required/],
    [{ client_name: "x" }, /title_required/],
    [{ client_name: "x", title: "" }, /title_required/],
    [{ client_name: "x", title: "y", amount_cents: -1 }, /invalid_amount/],
    [{ client_name: "x", title: "y", amount_cents: 1000000001 }, /invalid_amount/],
    [{ client_name: "x", title: "y", amount_cents: 12.5 }, /invalid_amount/],
    [{ client_name: "x", title: "y", amount_cents: "2500" }, /invalid_amount/],
    [{ client_name: "x", title: "y", step: "x" }, /invalid_step/],
    [{ client_name: "x", title: "y", ball: "x" }, /invalid_ball/],
    [{ client_name: "x", title: "y", provider: "x" }, /invalid_provider/],
    [{ client_name: "x", title: "y", link_url: "javascript:alert(1)" }, /invalid_link/],
    [{ client_name: "x", title: "y", link_url: "http://example.test" }, /invalid_link/],
    [{ client_name: "x", title: "y", link_url: "https://exa mple.test" }, /invalid_link/],
    [{ id: id(), title: "y" }, /money_item_not_found/],
  ];
  for (const [item, pattern] of invalid) {
    await rejects(() => save(item), pattern, JSON.stringify(item));
  }
  check(
    (await one("select count(*)::int n from bk_money_items")).n === 1,
    "refused saves store nothing",
  );
  const max = await save({ client_name: "Synthetic Max", title: "Big", amount_cents: 1000000000 });
  check(max.amount_cents === 1000000000, "ten million dollars is allowed");
  await staff(() => rpc("bk_money_close", [max.id, "dropped", id()]));

  // ignored keys are ignored
  const sneaky = await save({
    client_name: "Synthetic Sneaky",
    title: "x",
    view_key: "chosen-by-caller-0000000000000000",
    view_count: 99,
    outcome: "paid",
    closed_at: "2026-11-01T00:00:00Z",
  });
  check(
    sneaky.view_key !== "chosen-by-caller-0000000000000000" &&
      sneaky.view_count === 0 && sneaky.outcome === null &&
      sneaky.closed_at === null,
    "only editable keys are read",
  );
  await staff(() => rpc("bk_money_close", [sneaky.id, "dropped", id()]));

  // partial update keeps what it does not mention, and JSON null clears
  const before = await one("select updated_at from bk_money_items where id=$1", [a.id]);
  const u = await save({
    id: a.id,
    amount_cents: 250000,
    step: "payment",
    due_on: "2026-11-17",
    sent_on: "2026-11-12",
    link_url: "https://example.test/file",
    notes: "Synthetic note",
  });
  check(
    u.title === "Synthetic proposal" && u.amount_cents === 250000 &&
      u.view_key === a.view_key && u.link_url === "https://example.test/file" &&
      u.due_on === "2026-11-17",
    "partial update",
  );
  check(
    (await one("select updated_at from bk_money_items where id=$1", [a.id])).updated_at >= before.updated_at,
    "edits touch updated_at",
  );
  const cleared = await save({ id: a.id, notes: null });
  check(cleared.notes === null && cleared.amount_cents === 250000, "JSON null clears one key");
  const blanked = await save({ id: a.id, notes: "  " });
  check(blanked.notes === null, "a blank string is null");

  // day boundary (Review Focus 5)
  let b = await board("open", "2026-11-17");
  check(
    b.rows[0].overdue === false && b.rows[0].group === "client" &&
      b.rows[0].days_waiting === 5,
    "due today is not overdue",
  );
  b = await board("open", "2026-11-18");
  check(
    b.rows[0].overdue === true && b.rows[0].group === "overdue" &&
      b.totals.overdue === 1 && b.totals.open_cents === 250000,
    "overdue the next Central day",
  );
  check(
    (await staff(() => rpc("bk_money_board", []))).day ===
      (await one("select (now() at time zone 'America/Chicago')::date::text d")).d,
    "the default day is Central today",
  );

  // staged note means my move; hold beats everything
  await save({ id: a.id, staged_note: "Reply written, not sent" });
  check(
    (await board()).rows[0].group === "me",
    "a staged note is my move",
  );
  await save({ id: a.id, hold_reason: "Client asked for time" });
  b = await board();
  check(
    b.rows[0].group === "hold" && b.totals.me === 0 &&
      b.totals.overdue === 0 && b.totals.hold === 1,
    "on hold never counts as my move or overdue",
  );
  check(b.rows[0].overdue === true, "the overdue flag still reads true on hold");

  // ordering: one item per group comes back me, overdue, client, hold
  const client = await save({
    client_name: "Synthetic Waiting",
    title: "Signature",
    step: "signature",
    amount_cents: 100000,
  });
  const late = await save({
    client_name: "Synthetic Late",
    title: "Invoice",
    step: "payment",
    due_on: "2026-11-10",
  });
  const mine = await save({
    client_name: "Synthetic Mine",
    title: "Send invoice",
    ball: "me",
    next_move: "Send the invoice",
    next_move_on: "2026-11-18",
  });
  b = await board();
  check(
    b.rows.map((r) => r.id).join() ===
      [mine.id, late.id, client.id, a.id].join(),
    "rows come back me, overdue, client, hold",
  );
  check(
    b.rows[0].due === true && b.rows[2].due === false,
    "due means the next move day has come",
  );
  check(
    b.totals.items === 4 && b.totals.unpriced === 2 &&
      b.totals.open_cents === 350000 && b.totals.me === 1 &&
      b.totals.overdue === 1 && b.totals.hold === 1 &&
      b.totals.viewed_waiting === 0,
    "totals",
  );

  // view counter (Review Focus 3)
  check(
    [null, ""].includes(await anonymous(() => rpc("bk_money_view", ["nope"]))),
    "the counter returns nothing",
  );
  await anonymous(() => rpc("bk_money_view", ["0".repeat(32)]));
  await anonymous(() => rpc("bk_money_view", [null]));
  check(
    (await one("select sum(view_count)::int n from bk_money_items")).n === 0,
    "unknown keys count nothing",
  );
  const quiet = await one("select updated_at from bk_money_items where id=$1", [a.id]);
  await anonymous(() => rpc("bk_money_view", [a.view_key]));
  await anonymous(() => rpc("bk_money_view", [a.view_key]));
  let v = await one(
    "select view_count,first_viewed_at,last_viewed_at,updated_at from bk_money_items where id=$1",
    [a.id],
  );
  check(v.view_count === 1 && v.first_viewed_at, "two quick views count once");
  check(
    v.updated_at.getTime() === quiet.updated_at.getTime(),
    "a counted view does not touch updated_at",
  );
  await db.query(
    "update bk_money_items set last_viewed_at=now()-interval '31 minutes' where id=$1",
    [a.id],
  );
  await anonymous(() => rpc("bk_money_view", [a.view_key]));
  const v2 = await one(
    "select view_count,first_viewed_at from bk_money_items where id=$1",
    [a.id],
  );
  check(v2.view_count === 2, "counts again after 30 minutes");
  check(
    v2.first_viewed_at.getTime() === v.first_viewed_at.getTime(),
    "first view stays put",
  );
  await anonymous(() => rpc("bk_money_view", [client.view_key]));
  b = await board();
  check(
    b.totals.viewed_waiting === 1 &&
      b.rows.find((r) => r.id === client.id).view_count === 1,
    "a seen signature still waiting counts as viewed and waiting",
  );

  // close and reopen
  await rejects(
    () => staff(() => rpc("bk_money_close", [a.id, "won", id()])),
    /invalid_outcome/,
    "outcome list",
  );
  await rejects(
    () => staff(() => rpc("bk_money_close", [id(), "paid", id()])),
    /money_item_not_found/,
    "close needs a real item",
  );
  const closeReq = id();
  const c = await staff(() => rpc("bk_money_close", [a.id, "paid", closeReq]));
  check(c.closed_at && c.outcome === "paid", "closed");
  check(
    (await staff(() => rpc("bk_money_close", [a.id, "paid", closeReq]))).closed_at === c.closed_at,
    "a retried close returns the same row",
  );
  const twice = await staff(() => rpc("bk_money_close", [a.id, "lost", id()]));
  check(
    twice.outcome === "paid" && twice.closed_at === c.closed_at,
    "closing a closed item returns it unchanged",
  );
  await rejects(
    () => save({ id: a.id, title: "x" }),
    /item_closed/,
    "closed items are not edited",
  );
  await anonymous(() => rpc("bk_money_view", [a.view_key])); // no count on a closed item
  check(
    (await one("select view_count from bk_money_items where id=$1", [a.id])).view_count === 2,
    "a closed item counts no views",
  );
  b = await board();
  check(
    !b.rows.some((r) => r.id === a.id) && b.totals.items === 3 &&
      b.totals.hold === 0,
    "closed items leave the open list and totals",
  );
  const closed = await staff(() => rpc("bk_money_board", ["closed"]));
  check(
    closed.rows[0].id === a.id && closed.totals.items === 3,
    "closed list, newest first, totals still open",
  );
  const reopened = await staff(() => rpc("bk_money_reopen", [a.id, id()]));
  check(reopened.closed_at === null && reopened.outcome === null, "reopened");
  check(
    (await board()).rows.some((r) => r.id === a.id),
    "a reopened item is open again",
  );
  await rejects(
    () => staff(() => rpc("bk_money_board", ["all"])),
    /invalid_show/,
    "show list",
  );

  // only the counter is public
  for (
    const [name, args] of [
      ["bk_money_board", "text,date"],
      ["bk_money_save", "jsonb,uuid"],
      ["bk_money_close", "uuid,text,uuid"],
      ["bk_money_reopen", "uuid,uuid"],
      ["bk_money_view", "text"],
    ]
  ) {
    const p = await one(
      "select has_function_privilege('anon',$1,'execute') anon, has_function_privilege('authenticated',$1,'execute') auth, has_function_privilege('public',$1,'execute') pub",
      ["public." + name + "(" + args + ")"],
    );
    check(
      p.anon === (name === "bk_money_view") && p.auth === true,
      name + " grants",
    );
  }
  check(
    (await one(
      "select count(*)::int n from pg_policies where tablename='bk_money_items'",
    )).n === 0,
    "no table policies",
  );

  console.log(
    "open-money.pglite:",
    checks,
    "checks passed; synthetic data, no live sends",
  );
} finally {
  await db.close();
}
