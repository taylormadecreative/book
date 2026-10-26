// Real-Postgres test (PGlite, no Docker) for the content calendar migration: it re-runs cleanly,
// its checks hold, updated_at moves, and only the studio admin can read or change a post.
// Run: node tests/content-calendar.pglite.mjs
import { PGlite } from "/Users/nelsontaylor/.cache/pglite-rig/node_modules/@electric-sql/pglite/dist/index.js";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
let failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.error("FAIL:", msg); } };
const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const err = async (sql, params) => { try { await db.query(sql, params); return null; } catch (e) { return e.message; } };

// what prod has before this migration: Supabase's roles and default grants, auth.uid(), profiles, bk_touch, bk_is_admin
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated;
  create schema auth; grant usage on schema auth to anon, authenticated;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table public.profiles (id uuid primary key, role text);
  create or replace function public.bk_touch() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end $$;
  create or replace function public.bk_is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
    select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
  $$;
`);
const MIG = readFileSync(`${root}supabase/migrations/20261026_bk_content_calendar.sql`, "utf8");
await db.exec(MIG);
await db.exec(MIG); // a re-run must be harmless

const ADMIN = "11111111-1111-1111-1111-111111111111", OTHER = "22222222-2222-2222-2222-222222222222";
await q(`insert into profiles values ($1, 'admin'), ($2, 'client')`, [ADMIN, OTHER]);
const [{ id }] = await q(`insert into bk_content_posts (post_date, lane, format, title, script, captions, checks)
  values ('2026-10-27', 'apps', 'talking_head', 'Sample post', 'So beat one.\n\nBeat two.', '{"instagram":"cap"}', array['check it'])
  returning id`);

// defaults and checks
const [row] = await q(`select status, notes, sort from bk_content_posts where id = $1`, [id]);
ok(row.status === "planned" && row.notes === "" && row.sort === 0, "defaults");
ok(await err(`update bk_content_posts set status = 'skipped' where id = $1`, [id]), "status outside the ladder is refused");
ok(await err(`update bk_content_posts set lane = 'music' where id = $1`, [id]), "unknown lane is refused");
ok(await err(`insert into bk_content_posts (post_date, title) values ('2026-10-28', '')`), "empty title is refused");
ok(await err(`update bk_content_posts set notes = repeat('x', 4001) where id = $1`, [id]), "notes cap");

// updated_at moves on change
await q(`update bk_content_posts set updated_at = '2020-01-01' where id = $1`, [id]);
await q(`update bk_content_posts set status = 'filmed' where id = $1`, [id]);
const [{ updated_at }] = await q(`select updated_at from bk_content_posts where id = $1`, [id]);
ok(new Date(updated_at).getUTCFullYear() > 2020, "updated_at touched");

// access: run as each kind of caller
async function as(role, sub, fn) {
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub || ""]);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
ok((await as("authenticated", ADMIN, () => q(`select id from bk_content_posts`))).length === 1, "admin reads");
ok((await as("authenticated", ADMIN, () => q(`update bk_content_posts set status = 'posted', notes = 'done' where id = $1 returning id`, [id]))).length === 1, "admin writes");
ok((await as("authenticated", OTHER, () => q(`select id from bk_content_posts`))).length === 0, "another login reads nothing");
ok((await as("authenticated", OTHER, () => q(`update bk_content_posts set notes = 'x' where id = $1 returning id`, [id]))).length === 0, "another login changes nothing");
ok(await as("authenticated", OTHER, () => err(`insert into bk_content_posts (post_date, title) values ('2026-10-29', 'sneaky')`)), "another login can't add");
ok((await as("anon", null, () => q(`select id from bk_content_posts`))).length === 0, "signed-out reads nothing");
const [after] = await q(`select status, notes from bk_content_posts where id = $1`, [id]);
ok(after.status === "posted" && after.notes === "done", "only the admin's write landed");

console.log(failures ? `content-calendar.pglite: ${failures} of ${checks} FAILED` : `content-calendar.pglite: ${checks} checks passed`);
process.exit(failures ? 1 : 0);
