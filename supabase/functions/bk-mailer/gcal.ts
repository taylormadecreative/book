// gcal — mirrors confirmed bookings onto Nelson's Google Calendar.
// Runs at the end of every bk-mailer drain (pg_cron, every 10 min), so a failed
// insert simply retries next run. bk_bookings.gcal_event_id records the mirror:
//   NULL      → not on the calendar yet (confirmed + upcoming ones get inserted)
//   'manual'  → Nelson added it by hand, leave alone
//   <id>      → ours; deleted again if the booking gets cancelled
// Auth: service account JSON in secret GCAL_SA_KEY; Nelson's calendar is shared
// with that service account ("Make changes to events"). GCAL_CALENDAR_ID
// defaults to taylormademd@gmail.com. No key set → sync is a no-op.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";

const CAL_API = "https://www.googleapis.com/calendar/v3/calendars/";
const ADMIN_URL = "https://book.taylormadecreative.net/admin.html";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function accessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: "RS256", typ: "JWT" }) + "." + enc({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/calendar.events",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  });
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: unsigned + "." + b64url(sig),
    }),
  });
  if (!r.ok) throw new Error(`google token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).access_token;
}

type Row = {
  id: string; starts_at: string; duration_min: number; travel_min: number | null; status: string;
  location: string | null; gcal_event_id: string | null;
  bk_services: { name: string } | null;
  bk_projects: { client_name: string; client_email: string; client_phone: string | null } | null;
};

export async function syncCalendar(db: SupabaseClient): Promise<{ added: number; removed: number; errors: string[] }> {
  const out = { added: 0, removed: 0, errors: [] as string[] };
  const raw = Deno.env.get("GCAL_SA_KEY");
  if (!raw) return out;
  const calId = encodeURIComponent(Deno.env.get("GCAL_CALENDAR_ID") ?? "taylormademd@gmail.com");
  const cols = "id, starts_at, duration_min, travel_min, status, location, gcal_event_id, bk_services(name), bk_projects(client_name, client_email, client_phone)";

  const { data: toAdd } = await db.from("bk_bookings").select(cols)
    .eq("status", "confirmed").is("gcal_event_id", null)
    .gt("starts_at", new Date().toISOString()).limit(20);
  const { data: toRemove } = await db.from("bk_bookings").select(cols)
    .eq("status", "cancelled").not("gcal_event_id", "is", null).neq("gcal_event_id", "manual").limit(20);
  if (!toAdd?.length && !toRemove?.length) return out;

  const token = await accessToken(JSON.parse(raw));
  const auth = { authorization: "Bearer " + token, "content-type": "application/json" };

  for (const b of (toAdd ?? []) as unknown as Row[]) {
    // deterministic id (base32hex-safe) → a retry after a lost response gets 409, not a duplicate
    const eventId = "tmbk" + b.id.replace(/-/g, "");
    const pj = b.bk_projects;
    const svc = b.bk_services?.name ?? "Session";
    // on-location shoots: the event also covers the drive the booking engine
    // keeps clear on each side (bk_bookings.travel_min), so the calendar shows
    // when to leave, not just when the shoot starts
    const travel = b.travel_min ?? 0;
    const shootStart = new Date(b.starts_at);
    const shootEnd = new Date(shootStart.getTime() + b.duration_min * 60000);
    const start = new Date(shootStart.getTime() - travel * 60000).toISOString();
    const end = new Date(shootEnd.getTime() + travel * 60000).toISOString();
    const ct = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });
    const r = await fetch(CAL_API + calId + "/events", {
      method: "POST", headers: auth,
      body: JSON.stringify({
        id: eventId,
        summary: `${travel ? "ON LOCATION · " : ""}${svc} — ${pj?.client_name ?? "Client"}`,
        location: b.location ?? undefined,
        description: [
          ...(travel ? [`Shoot ${ct(shootStart)}–${ct(shootEnd)} CT on location. This block includes ${travel} min of drive time each way.`] : []),
          `${svc} (${b.duration_min} min) · booked + paid on book.taylormadecreative.net`,
          [pj?.client_name, pj?.client_email, pj?.client_phone].filter(Boolean).join(" · "),
          `Admin: ${ADMIN_URL}`,
        ].join("\n"),
        start: { dateTime: start, timeZone: "America/Chicago" },
        end: { dateTime: end, timeZone: "America/Chicago" },
        visibility: "private",
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 1440 }, { method: "popup", minutes: 60 }] },
      }),
    });
    if (r.ok || r.status === 409) {
      await db.from("bk_bookings").update({ gcal_event_id: eventId }).eq("id", b.id);
      out.added++;
    } else {
      out.errors.push(`add ${b.id}: ${r.status} ${(await r.text()).slice(0, 160)}`);
    }
  }

  for (const b of (toRemove ?? []) as unknown as Row[]) {
    const r = await fetch(CAL_API + calId + "/events/" + b.gcal_event_id, { method: "DELETE", headers: auth });
    if (r.ok || r.status === 404 || r.status === 410) {
      await db.from("bk_bookings").update({ gcal_event_id: null }).eq("id", b.id);
      out.removed++;
    } else {
      out.errors.push(`remove ${b.id}: ${r.status} ${(await r.text()).slice(0, 160)}`);
    }
  }
  return out;
}

