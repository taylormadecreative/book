/* Taylormade — BOOK · client login (Supabase email OTP / magic link) */

const sb = window.supabase.createClient(window.BK.SUPABASE_URL, window.BK.SUPABASE_KEY);
const $ = (s) => document.querySelector(s);

const GALLERY_URL =
  `${location.origin}${location.pathname.replace(/login\.html$/, "")}gallery.html`;

// already signed in? go straight to the gallery
sb.auth.getSession().then(({ data }) => {
  if (data.session) location.replace("gallery.html");
});

let pendingEmail = "";

function show(stepId) {
  document.querySelectorAll(".step").forEach((s) => s.classList.toggle("on", s.id === stepId));
}

$("#emailStep").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#err1");
  err.textContent = "";
  const email = $("#email").value.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "That email doesn't look right."; return; }
  const btn = $("#sendBtn");
  btn.disabled = true; btn.textContent = "Sending…";
  // shouldCreateUser:true so first-time clients (who only ever booked) can log in
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: GALLERY_URL, shouldCreateUser: true },
  });
  btn.disabled = false; btn.textContent = "Send my login link";
  if (error) { err.textContent = error.message || "Could not send the link. Try again."; return; }
  pendingEmail = email;
  $("#sentMsg").innerHTML = `Check <strong>${email}</strong> for a login link from Taylormade Creative. Tap it on this device and you're in. The link is good for one hour.`;
  show("sentStep");
});

$("#showCode").addEventListener("click", (e) => { e.preventDefault(); show("codeStep"); });

$("#codeStep").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#err2");
  err.textContent = "";
  const token = $("#code").value.trim();
  if (!/^\d{6}$/.test(token)) { err.textContent = "Enter the 6-digit code from your email."; return; }
  if (!pendingEmail) { err.textContent = "Start by sending yourself a link first."; show("emailStep"); return; }
  const btn = $("#verifyBtn");
  btn.disabled = true; btn.textContent = "Verifying…";
  const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token, type: "email" });
  btn.disabled = false; btn.textContent = "Verify & log in";
  if (error) { err.textContent = "That code didn't work. Check it or resend the link."; return; }
  location.replace("gallery.html");
});
