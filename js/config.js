// Taylormade Creative — booking system config
window.BK = {
  SUPABASE_URL: "https://pgqdmnmessbbzyszjfvr.supabase.co",
  SUPABASE_KEY: "sb_publishable_fyYqa9QkEeA5LD_0hYLTTA_F8Gxw1oz",
  FUNCTIONS_BASE: "https://pgqdmnmessbbzyszjfvr.supabase.co/functions/v1",
};

// Minimal PostgREST RPC helper (no SDK needed for public pages)
window.BK.rpc = async function rpc(fn, args) {
  const res = await fetch(`${window.BK.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: window.BK.SUPABASE_KEY,
      Authorization: `Bearer ${window.BK.SUPABASE_KEY}`,
    },
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) {
    let msg = "request_failed";
    try { msg = (await res.json()).message || msg; } catch (_) { /* keep default */ }
    throw new Error(msg);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
};
