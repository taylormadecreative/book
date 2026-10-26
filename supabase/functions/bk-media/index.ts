// bk-media — client gateway to project galleries (proofing, finals, video).
// Access is granted three ways, all validated here with the service role:
//   1. project token  : body { project_id, token } matches bk_projects.access_token
//   2. client login    : Authorization bearer JWT whose email matches client_email
//   3. staff           : Authorization bearer JWT whose profile.role is admin/employee
// verify_jwt is OFF so the token path works for clients who never logged in.
// Deployed to Supabase project pgqdmnmessbbzyszjfvr.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const BUCKET = "project-media";
const SIGN_TTL = 60 * 60 * 2; // 2h

const svc = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function resolveAccess(req: Request, body: any, db: ReturnType<typeof svc>) {
  if (body.project_id && body.token) {
    const { data } = await db
      .from("bk_projects").select("id")
      .eq("id", body.project_id).eq("access_token", body.token).maybeSingle();
    if (data) return { staff: false, projectIds: new Set<string>([data.id]) };
  }
  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Only treat the bearer as a user session if it is shaped like a JWT (header.payload.sig).
  // The publishable key (sb_publishable_…) and legacy anon key are NOT user sessions and
  // must never be run through getUser as if they were.
  const looksLikeJwt = jwt.split(".").length === 3;
  if (looksLikeJwt) {
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: u } = await anon.auth.getUser(jwt);
    const user = u?.user;
    if (user) {
      const { data: prof } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (prof && (prof.role === "admin" || prof.role === "employee")) {
        return { staff: true, projectIds: null as Set<string> | null };
      }
      const email = (user.email || "").toLowerCase();
      if (email) {
        const { data: projs } = await db.from("bk_projects").select("id").eq("client_email", email);
        return { staff: false, projectIds: new Set<string>((projs || []).map((p: any) => p.id)) };
      }
    }
  }
  return { staff: false, projectIds: new Set<string>() };
}

// Grid thumbnails live next to the original under a thumbs/ folder (same file name).
// Older uploads have none; the client falls back to the full image.
const thumbPath = (p: string) => p.replace(/([^/]+)$/, "thumbs/$1");

// Batch-sign: one storage call for every inline URL and one for every thumb,
// instead of one call per item (a 400-photo proofing gallery would be 800+ calls).
async function signItems(db: ReturnType<typeof svc>, items: any[], kindByGallery: Record<string, string>) {
  if (!items.length) return [];
  const bucket = db.storage.from(BUCKET);
  const paths = items.map((it) => it.storage_path);
  const [inline, thumbs] = await Promise.all([
    bucket.createSignedUrls(paths, SIGN_TTL),
    bucket.createSignedUrls(paths.map(thumbPath), SIGN_TTL),
  ]);
  // match results by path (missing thumbs come back as per-path errors, not a failed batch)
  const byPath = (r: any) => new Map<string, string | null>((r.data || []).map((d: any) => [d.path, d.signedUrl || null]));
  const inlineBy = byPath(inline), thumbBy = byPath(thumbs);
  return Promise.all(items.map(async (it) => {
    // proofs are for picking and storyboards are for reviewing (the frames are Nelson's); finals + video keep a named download link
    let download_url: string | null = null;
    const kind = kindByGallery[it.gallery_id];
    if (kind === "final" || kind === "video") {
      const dl = await bucket.createSignedUrl(it.storage_path, SIGN_TTL, { download: it.filename || "download" });
      download_url = dl.data?.signedUrl || null;
    }
    return {
      id: it.id, gallery_id: it.gallery_id, filename: it.filename, content_type: it.content_type,
      size_bytes: it.size_bytes, sort: it.sort, selected: it.selected,
      meta: it.meta || {}, client_note: it.client_note ?? null,
      url: inlineBy.get(it.storage_path) ?? null, thumb_url: thumbBy.get(thumbPath(it.storage_path)) ?? null, download_url,
    };
  }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }

  const db = svc();
  const access = await resolveAccess(req, body, db);
  const allow = (pid: string) => access.staff || (access.projectIds?.has(pid) ?? false);
  // the storyboard functions refuse with a code; anything else is a real failure
  const rpcError = (error: { message?: string }) => {
    const code = /\b(not_found|locked|superseded|already_submitted|outcome_changed|empty)\b/.exec(error.message || "")?.[1];
    if (!code) throw new Error(error.message || "rpc_failed");
    return json({ error: code }, code === "not_found" ? 404 : 409);
  };

  try {
    if (body.action === "list") {
      let pids: string[];
      if (body.project_id) {
        if (!allow(body.project_id)) return json({ error: "not_found" }, 404);
        pids = [body.project_id];
      } else if (access.staff) {
        return json({ error: "project_required" }, 400);
      } else {
        pids = [...(access.projectIds || [])];
      }
      if (!pids.length) return json({ projects: [] });

      const { data: projects } = await db.from("bk_projects")
        .select("id, title, client_name, service, status").in("id", pids);
      const { data: galleries } = await db.from("bk_galleries").select("*").in("project_id", pids).order("created_at");
      const { data: items } = await db.from("bk_gallery_items").select("*")
        .in("project_id", pids).order("sort").order("created_at");
      const kindByGallery: Record<string, string> = {};
      for (const g of galleries || []) kindByGallery[g.id] = g.kind;
      const signed = await signItems(db, items || [], kindByGallery);
      const byGallery: Record<string, any[]> = {};
      for (const s of signed) (byGallery[s.gallery_id] ||= []).push(s);

      // a storyboard Nelson is still building (a draft: locked, never reviewed) or one with no frames
      // yet stays out of the client's view, including portal pages cached from before storyboards
      const hidden = (g: any) => !access.staff && g.kind === "storyboard" &&
        ((g.locked && !g.review_outcome) || !(byGallery[g.id] || []).length);
      const out = (projects || []).map((p: any) => ({
        ...p,
        galleries: (galleries || []).filter((g: any) => g.project_id === p.id && !hidden(g)).map((g: any) => ({
          id: g.id, kind: g.kind, title: g.title, selection_limit: g.selection_limit, locked: g.locked,
          review_outcome: g.review_outcome ?? null, reviewed_at: g.reviewed_at ?? null, pay_url: g.pay_url ?? null,
          items: byGallery[g.id] || [],
        })),
      }));
      return json({ projects: out, staff: access.staff });
    }

    if (body.action === "toggle_select") {
      const { data: item } = await db.from("bk_gallery_items")
        .select("id, project_id, gallery_id, selected").eq("id", body.item_id).maybeSingle();
      if (!item || !allow(item.project_id)) return json({ error: "not_found" }, 404);
      const { data: gal } = await db.from("bk_galleries")
        .select("kind, locked, selection_limit").eq("id", item.gallery_id).maybeSingle();
      if (!gal) return json({ error: "not_found" }, 404);
      if (gal.kind !== "proof") return json({ error: "not_selectable" }, 409);
      if (gal.locked) return json({ error: "locked" }, 409);
      const want = body.selected === true;
      if (want && gal.selection_limit != null) {
        const { count } = await db.from("bk_gallery_items")
          .select("id", { count: "exact", head: true })
          .eq("gallery_id", item.gallery_id).eq("selected", true);
        if ((count || 0) >= gal.selection_limit && !item.selected) {
          return json({ error: "limit_reached", limit: gal.selection_limit }, 409);
        }
      }
      await db.from("bk_gallery_items")
        .update({ selected: want, selected_at: want ? new Date().toISOString() : null }).eq("id", item.id);
      return json({ ok: true, selected: want });
    }

    if (body.action === "submit_selections") {
      const { data: gal } = await db.from("bk_galleries")
        .select("id, project_id, kind, locked, title").eq("id", body.gallery_id).maybeSingle();
      if (!gal || !allow(gal.project_id)) return json({ error: "not_found" }, 404);
      if (gal.kind !== "proof") return json({ error: "not_selectable" }, 409);
      // idempotent: once submitted it stays locked — never re-message (blocks thread spam)
      if (gal.locked) return json({ error: "already_submitted" }, 409);
      const { data: picks } = await db.from("bk_gallery_items").select("filename, sort")
        .eq("gallery_id", gal.id).eq("selected", true).order("sort");
      const n = (picks || []).length;
      if (n === 0) return json({ error: "no_selection" }, 409);
      // lock only if still open (guards a concurrent double-submit race)
      const { data: locked } = await db.from("bk_galleries")
        .update({ locked: true }).eq("id", gal.id).eq("locked", false).select("id");
      if (!locked || !locked.length) return json({ error: "already_submitted" }, 409);
      await db.from("bk_messages").insert({
        project_id: gal.project_id, sender: "client",
        // list the picks by file name so the originals are easy to find for editing
        body: `Selected ${n} image${n === 1 ? "" : "s"} for editing from "${gal.title}". Ready when you are.\n\n` +
          (picks || []).map((p: any) => p.filename || "(unnamed)").join("\n"),
      });
      return json({ ok: true, count: n });
    }

    // storyboard: the client's change note on one frame (empty clears it). The lock check and the
    // write happen in one database call (bk_storyboard_note), so a note can't land after a review.
    if (body.action === "storyboard_note") {
      const { data: item } = await db.from("bk_gallery_items")
        .select("id, project_id").eq("id", body.item_id).maybeSingle();
      if (!item || !allow(item.project_id)) return json({ error: "not_found" }, 404);
      const note = typeof body.note === "string" ? body.note.slice(0, 4000) : "";
      const { data, error } = await db.rpc("bk_storyboard_note", { p_item: item.id, p_note: note });
      if (error) return rpcError(error);
      return json(data);
    }

    // storyboard: send the review. Notes on any frame = changes; none = approved, decided in the
    // database from what's saved (never trusted from the browser). The lock and Nelson's message are
    // one transaction (bk_storyboard_submit).
    if (body.action === "storyboard_submit") {
      const { data: gal } = await db.from("bk_galleries")
        .select("id, project_id, kind").eq("id", body.gallery_id).maybeSingle();
      if (!gal || !allow(gal.project_id) || gal.kind !== "storyboard") return json({ error: "not_found" }, 404);
      const expect = body.expect === "approved" || body.expect === "changes" ? body.expect : null;
      const expectNotes = Number.isInteger(body.expect_notes) ? body.expect_notes : null;
      const { data, error } = await db.rpc("bk_storyboard_submit", { p_gallery: gal.id, p_expect: expect, p_expect_notes: expectNotes });
      if (error) return rpcError(error);
      return json(data);
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
