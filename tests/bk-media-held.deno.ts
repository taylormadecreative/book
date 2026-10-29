// bk-media held-video gate, run against an in-memory stand-in for Supabase (never touches prod).
// Run: deno run --allow-env --import-map=tests/fixtures/bk-media-importmap.json tests/bk-media-held.deno.ts
// The import map swaps npm:@supabase/supabase-js for tests/fixtures/fake-supabase.ts.
import { fake } from "./fixtures/fake-supabase.ts";

let failures = 0, checks = 0;
const ok = (cond: unknown, msg: string) => { checks++; if (!cond) { failures++; console.error("FAIL:", msg); } };

Deno.env.set("SUPABASE_URL", "https://fake.supabase.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service");
Deno.env.set("SUPABASE_ANON_KEY", "anon");
let handler: (req: Request) => Promise<Response>;
// bk-media registers its handler with Deno.serve on import
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
await import("../supabase/functions/bk-media/index.ts");

const P = "proj-1", G = "gal-video", INV = "inv-bal";
const ORIG = `${P}/${G}/abc-hide-and-haunt-commercial.mp4`;
const PREV = `${P}/${G}/preview/abc-hide-and-haunt-commercial.mp4`;
function seed(status: string, opts: { preview?: boolean; unlock?: string | null; invProject?: string } = {}) {
  fake.reset({
    bk_projects: [{ id: P, access_token: "tok", title: "Delilah Amaro — Hide & Haunt Commercial", client_name: "Delilah Amaro", service: "other", status: "booked", client_email: "d@x.test" }],
    bk_galleries: [{ id: G, project_id: P, kind: "video", title: "Hide & Haunt commercial", locked: false, created_at: "2026-10-29",
      unlock_invoice_id: opts.unlock === undefined ? INV : opts.unlock }],
    bk_gallery_items: [{ id: "it-1", gallery_id: G, project_id: P, storage_path: ORIG, filename: "Hide & Haunt Commercial.mp4", sort: 1, created_at: "2026-10-29" }],
    bk_invoices: [{ id: INV, project_id: opts.invProject ?? P, title: "Final balance", amount_cents: 75000, status }],
    profiles: [{ id: "staff-uid", role: "admin" }],
  }, [ORIG, ...(opts.preview === false ? [] : [PREV])]);
}
const list = async (body: Record<string, unknown>, auth?: string) => {
  const res = await handler(new Request("https://fake/bk-media", {
    method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ action: "list", ...body }),
  }));
  return { status: res.status, json: await res.json() };
};
const gallery = (j: any) => j.projects?.[0]?.galleries?.[0];

// 1. unpaid, client token: preview only, no download, never the original
seed("sent");
let r = await list({ project_id: P, token: "tok" });
let g = gallery(r.json), it = g?.items?.[0];
ok(r.status === 200, "list ok");
ok(g.held === true, "gallery is held while the balance is unpaid");
ok(g.unlock && g.unlock.invoice_id === INV && g.unlock.amount_cents === 75000 && g.unlock.paid === false && g.unlock.payable === true, "unlock names the invoice and amount, payable");
ok(it.thumb_url === null && !fake.signed.includes(`${P}/${G}/thumbs/abc-hide-and-haunt-commercial.mp4`), "held thumbs are looked up next to the preview, not the original");
ok(it.url && it.url.includes("/preview/"), "client streams the preview: " + it.url);
ok(it.download_url === null, "no download link while held");
ok(!JSON.stringify(r.json).includes(`sign/${ORIG}`), "the original path is never signed for the client");
ok(!fake.signed.includes(ORIG), "storage was never asked to sign the original: " + fake.signed.join(", "));

// 2. preview missing: no link at all (fail closed), still never the original
seed("sent", { preview: false });
fake.signed.length = 0;
r = await list({ project_id: P, token: "tok" });
it = gallery(r.json).items[0];
ok(it.url === null && it.download_url === null, "missing preview gives no link, not the original");
ok(!fake.signed.includes(ORIG), "missing preview never falls back to signing the original");

// 3. void invoice stays held
seed("void");
r = await list({ project_id: P, token: "tok" });
ok(gallery(r.json).held === true && gallery(r.json).items[0].download_url === null, "a void invoice does not unlock the video");
ok(gallery(r.json).unlock.payable === false, "a void invoice is not offered for payment");

// 3b. a paid invoice from another project neither unlocks it nor shows up
seed("paid", { invProject: "someone-else" });
fake.signed.length = 0;
r = await list({ project_id: P, token: "tok" });
g = gallery(r.json);
ok(g.held === true && g.unlock === null && g.items[0].download_url === null && !fake.signed.includes(ORIG), "another project's paid invoice doesn't unlock it");

// 4. paid: the original and a named download come back
seed("paid");
fake.signed.length = 0;
r = await list({ project_id: P, token: "tok" });
g = gallery(r.json); it = g.items[0];
ok(g.held === false && g.unlock.paid === true, "paid = not held");
ok(it.url && !it.url.includes("/preview/") && it.url.includes(ORIG), "paid streams the original");
ok(it.download_url && it.download_url.includes("download="), "paid has a named download link");

// 5. staff always see the original, even unpaid
seed("sent");
r = await list({ project_id: P }, "aaa.staff.jwt");
g = gallery(r.json); it = g.items[0];
ok(g.held === false && it.url.includes(ORIG) && it.download_url, "staff get the original while the client is held");

// 6. a video with no balance attached behaves as before
seed("sent", { unlock: null });
r = await list({ project_id: P, token: "tok" });
g = gallery(r.json); it = g.items[0];
ok(g.held === false && g.unlock === null && it.download_url, "no unlock invoice = normal delivery");

// 7. wrong token sees nothing
seed("sent");
r = await list({ project_id: P, token: "nope" });
ok(r.status === 404, "wrong token refused");

// 8. invoice lookup failing fails closed (no list, never an unlocked video)
seed("sent");
fake.failTable = "bk_invoices";
r = await list({ project_id: P, token: "tok" });
ok(r.status === 500 && !JSON.stringify(r.json).includes(ORIG), "invoice lookup error returns an error, not the original");
fake.failTable = null;

console.log(`${checks - failures}/${checks} checks passed`);
if (failures) Deno.exit(1);
