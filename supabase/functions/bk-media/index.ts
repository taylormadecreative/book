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
  if (jwt && jwt !== Deno.env.get("SUPABASE_ANON_KEY")) {
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

async function signItems(db: ReturnType<typeof svc>, items: any[]) {
  return Promise.all(items.map(async (it) => {
    const inline = await db.storage.from(BUCKET).createSignedUrl(it.storage_path, SIGN_TTL);
    const dl = await db.storage.from(BUCKET).createSignedUrl(it.storage_path, SIGN_TTL, { download: it.filename || "download" });
    return {
      id: it.id, gallery_id: it.gallery_id, filename: it.filename, content_type: it.content_type,
      size_bytes: it.size_bytes, sort: it.sort, selected: it.selected,
      url: inline.data?.signedUrl || null, download_url: dl.data?.signedUrl || null,
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
      const signed = await signItems(db, items || []);
      const byGallery: Record<string, any[]> = {};
      for (const s of signed) (byGallery[s.gallery_id] ||= []).push(s);

      const out = (projects || []).map((p: any) => ({
        ...p,
        galleries: (galleries || []).filter((g: any) => g.project_id === p.id).map((g: any) => ({
          id: g.id, kind: g.kind, title: g.title, selection_limit: g.selection_limit, locked: g.locked,
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
        .select("kind, locked, selection_limit").eq("id", item.gallery_id).single();
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
      const { data: picks } = await db.from("bk_gallery_items").select("filename").eq("gallery_id", gal.id).eq("selected", true);
      await db.from("bk_galleries").update({ locked: true }).eq("id", gal.id);
      const n = (picks || []).length;
      await db.from("bk_messages").insert({
        project_id: gal.project_id, sender: "client",
        body: `Selected ${n} image${n === 1 ? "" : "s"} for editing from "${gal.title}". Ready when you are.`,
      });
      return json({ ok: true, count: n });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error" }, 500);
  }
});
