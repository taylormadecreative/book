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
  $("#who").textContent = (session.user.email || "").toUpperCase();
  $("#loading").hidden = true;
  $("#app").hidden = false;
  BKGallery.mount($("#galleryRoot"), { mode: "session", jwt: session.access_token });
}

$("#signout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.replace("login.html");
});
