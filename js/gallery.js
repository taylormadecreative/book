/* Taylormade — BOOK · authenticated client gallery hub */

const sb = window.supabase.createClient(window.BK.SUPABASE_URL, window.BK.SUPABASE_KEY);
const $ = (s) => document.querySelector(s);

init();
async function init() {
  // detectSessionInUrl handles the magic-link hash; give it a tick
  const { data } = await sb.auth.getSession();
  const session = data.session;
  if (!session) {
    // not logged in — send them to the login page
    location.replace("login.html");
    return;
  }
  // the studio owner has no client gallery: send him to the CRM
  if (await isStudioAdmin()) {
    location.replace("crm/");
    return;
  }
  $("#who").textContent = (session.user.email || "").toUpperCase();
  $("#loading").hidden = true;
  $("#app").hidden = false;
  BKGallery.mount($("#galleryRoot"), { mode: "session", jwt: session.access_token });
}

// any failure counts as "client", so a client never gets bounced to the CRM login
async function isStudioAdmin() {
  try {
    const { data, error } = await sb.rpc("bk_is_admin");
    return !error && data === true;
  } catch (_) {
    return false;
  }
}

$("#signout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.replace("login.html");
});
