// Real-Postgres test (PGlite, no Docker) for the storyboard migration: the note and review functions,
// their locking and message rules, and that only the service role can call them.
// Run: node tests/storyboard-rpc.pglite.mjs
import { PGlite } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/@electric-sql/pglite/dist/index.js";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
let failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.error("FAIL:", msg); } };
const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const err = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };

// the tables as prod has them before this migration (from 20260612 + 20260615), with Supabase's default grants
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create table public.bk_projects (id uuid primary key default gen_random_uuid(), title text);
  create table public.bk_messages (
    id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
    project_id uuid not null references public.bk_projects(id) on delete cascade,
    sender text not null check (sender in ('studio','client')),
    body text not null check (length(body) between 1 and 4000), read_at timestamptz);
  create table public.bk_galleries (
    id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
    project_id uuid not null references public.bk_projects(id) on delete cascade,
    kind text not null constraint bk_galleries_kind_check check (kind in ('proof','final','video')),
    title text not null default 'Gallery', selection_limit integer, locked boolean not null default false);
  create table public.bk_gallery_items (
    id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(),
    gallery_id uuid not null references public.bk_galleries(id) on delete cascade,
    project_id uuid not null references public.bk_projects(id) on delete cascade,
    storage_path text not null, filename text, content_type text, size_bytes bigint,
    sort integer not null default 0, selected boolean not null default false, selected_at timestamptz);
`);
await db.exec(readFileSync(`${root}supabase/migrations/20261026_bk_storyboard_review.sql`, "utf8"));
// twice: a re-run must be harmless
await db.exec(readFileSync(`${root}supabase/migrations/20261026_bk_storyboard_review.sql`, "utf8"));

const [{ id: P }] = await q(`insert into bk_projects (title) values ('Delilah Amaro — Hide & Haunt Commercial') returning id`);
const board = async (title, { locked = false, outcome = null, frames = 3, at = "now()", pay = null } = {}) => {
  const [{ id }] = await q(`insert into bk_galleries (project_id, kind, title, locked, review_outcome, created_at, pay_url)
    values ($1, 'storyboard', $2, $3, $4, ${at}, $5) returning id`, [P, title, locked, outcome, pay]);
  for (let i = 1; i <= frames; i++) {
    await q(`insert into bk_gallery_items (gallery_id, project_id, storage_path, sort, meta) values ($1, $2, 'x', $3, $4)`,
      [id, P, i, JSON.stringify({ code: `${i}A`, tc: `0:0${i}–0:0${i + 1}` })]);
  }
  return id;
};
const items = (gid) => q(`select id, client_note, client_note_at from bk_gallery_items where gallery_id = $1 order by sort`, [gid]);
const note = (item, text) => q(`select bk_storyboard_note($1, $2) as r`, [item, text]).then((r) => r[0].r);
const submit = (gid, expect, n) => q(`select bk_storyboard_submit($1, $2, $3) as r`, [gid, expect, n]).then((r) => r[0].r);
const lastMsg = async () => (await q(`select sender, body from bk_messages order by created_at desc, body desc limit 1`))[0];

/* --- schema --- */
ok((await err(`insert into bk_galleries (project_id, kind) values ($1, 'storyboard')`, [P])) === null, "storyboard is an allowed gallery kind");
ok(/check/.test(await err(`insert into bk_galleries (project_id, kind) values ($1, 'brochure')`, [P])), "other kinds still refused");
ok(/check/.test(await err(`update bk_galleries set pay_url = 'javascript:alert(1)'`)), "deposit link must be https");
await q(`delete from bk_galleries where kind = 'storyboard'`);

/* --- notes --- */
const A = await board("Hide & Haunt storyboard v1", { pay: "https://taylormadecreative.hbportal.co/app/invoice/abc" });
let [f1, f2, f3] = await items(A);
let r = await note(f1.id, "  Make him look at the camera.\n ");
ok(r.ok && r.note === "Make him look at the camera.", "note saves, trimmed");
ok((await items(A))[0].client_note_at, "note time is set");
ok((await note(f1.id, "x".repeat(1500))).note.length === 1000, "a note is capped at 1000 characters");
await note(f1.id, "Make him look at the camera.");
r = await note(f2.id, "   ");
ok(r.note === null && (await items(A))[1].client_note === null, "a blank note clears");
ok(/not_found/.test(await err(`select bk_storyboard_note(gen_random_uuid(), 'hi')`)), "unknown frame refused");

/* --- review --- */
ok(/outcome_changed/.test(await err(`select bk_storyboard_submit($1, 'approved', 0)`, [A])), "page said approve but a note is saved: refused");
ok(/outcome_changed/.test(await err(`select bk_storyboard_submit($1, 'changes', 2)`, [A])), "page showed 2 notes, 1 saved: refused");
ok(!(await q(`select locked from bk_galleries where id = $1`, [A]))[0].locked, "a refused review leaves it open");
ok((await q(`select count(*)::int as n from bk_messages`))[0].n === 0, "and posts nothing");
r = await submit(A, "changes", 1);
ok(r.outcome === "changes" && r.notes === 1 && r.pay_url == null, "notes sent as changes (no deposit link)");
let m = await lastMsg();
ok(m.sender === "client" && m.body.startsWith('My notes on 1 frame of "Hide & Haunt storyboard v1":') && m.body.includes("1A · 0:01–0:02\nMake him look at the camera."), "Nelson gets each note with its frame: " + JSON.stringify(m.body));
const g = (await q(`select locked, review_outcome, reviewed_at from bk_galleries where id = $1`, [A]))[0];
ok(g.locked && g.review_outcome === "changes" && g.reviewed_at, "gallery locked with the outcome");
ok(/already_submitted/.test(await err(`select bk_storyboard_submit($1, 'changes', 1)`, [A])), "a second send is refused");
ok(/locked/.test(await err(`select bk_storyboard_note($1, 'late')`, [f3.id])), "no notes once sent");
ok((await q(`select count(*)::int as n from bk_messages`))[0].n === 1, "exactly one message");

/* --- round two: v2 is a draft, then goes live --- */
const B = await board("Hide & Haunt storyboard v2", { locked: true, at: "now() + interval '1 minute'", pay: "https://taylormadecreative.hbportal.co/app/invoice/abc" });
ok(!(await q(`select bk_storyboard_superseded($1) as s`, [A]))[0].s, "a draft v2 doesn't replace v1 yet");
ok(/locked/.test(await err(`select bk_storyboard_note($1, 'hi')`, [(await items(B))[0].id])), "a draft takes no notes");
await q(`update bk_galleries set locked = false where id = $1`, [B]);
ok((await q(`select bk_storyboard_superseded($1) as s`, [A]))[0].s, "once v2 is live, v1 is an earlier round");
await q(`update bk_galleries set locked = false, review_outcome = null where id = $1`, [A]);
ok(/superseded/.test(await err(`select bk_storyboard_note($1, 'hi')`, [f3.id])), "an earlier round reopened by mistake still takes no notes");
ok(/superseded/.test(await err(`select bk_storyboard_submit($1, null, null)`, [A])), "nor a review");
await q(`update bk_galleries set locked = true, review_outcome = 'changes' where id = $1`, [A]);

r = await submit(B, "approved", 0);
ok(r.outcome === "approved" && r.pay_url === "https://taylormadecreative.hbportal.co/app/invoice/abc", "approve returns the deposit link");
m = await lastMsg();
ok(m.body === 'I approved the storyboard "Hide & Haunt storyboard v2" (3 frames).', "approve message in her voice: " + m.body);

/* --- edges --- */
const E = await board("Empty", { frames: 0, at: "now() + interval '2 minutes'" });
ok(/empty/.test(await err(`select bk_storyboard_submit($1, null, null)`, [E])), "an empty storyboard can't be approved");
const L = await board("Long notes", { frames: 27, at: "now() + interval '3 minutes'" });
for (const it of await items(L)) await note(it.id, "Please change this. ".repeat(60));
await submit(L, "changes", 27);
m = await lastMsg();
ok(m.body.length <= 4000 && /\+\d+ more notes on the frames\.$/.test(m.body), `27 long notes fit one message with a count (${m.body.length} chars)`);
ok(!/Please change this\. Please change th$/.test(m.body.split("\n\n+")[0]), "no note is cut mid-way");
const K = await board("Proof", { frames: 1, at: "now() + interval '4 minutes'" });
await q(`update bk_galleries set kind = 'proof' where id = $1`, [K]);
ok(/not_found/.test(await err(`select bk_storyboard_note($1, 'hi')`, [(await items(K))[0].id])), "notes only on storyboards");
ok(/not_found/.test(await err(`select bk_storyboard_submit($1, null, null)`, [K])), "review only on storyboards");

/* --- who can call them --- */
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set role ${role}`);
  ok(/permission denied/.test(await err(`select bk_storyboard_note(gen_random_uuid(), 'x')`)), `${role} can't call the note function`);
  ok(/permission denied/.test(await err(`select bk_storyboard_submit(gen_random_uuid(), null, null)`)), `${role} can't call the review function`);
  ok(/permission denied/.test(await err(`select bk_storyboard_superseded(gen_random_uuid())`)), `${role} can't call the helper`);
  await db.exec(`reset role`);
}
await db.exec(`set role service_role`);
ok(/not_found/.test(await err(`select bk_storyboard_note(gen_random_uuid(), 'x')`)), "service role (bk-media) can");
await db.exec(`reset role`);

console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
