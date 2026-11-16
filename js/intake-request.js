// Keep one retry capability per exact form request, including across reloads.
// Session storage holds a digest and random ID, never the submitted contact data.
const pending = new Map();
export function completeSubmission(lane, storage) {
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch (_) { /* private browsing */ } }
  const key = `bk-intake:${lane}`;
  pending.delete(key);
  try { storage?.removeItem(key); } catch (_) { /* optional */ }
}
export async function submissionFor(lane, payload, storage) {
  if (storage === undefined) { try { storage = globalThis.sessionStorage; } catch (_) { /* private browsing */ } }
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const signature = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const key = `bk-intake:${lane}`;
  let saved = pending.get(key);
  try { saved = JSON.parse(storage?.getItem(key) || 'null') || saved; } catch (_) { /* storage is optional */ }
  if (saved?.signature === signature && /^[0-9a-f-]{36}$/i.test(saved.id || '')) return saved.id;
  const next = {signature, id: crypto.randomUUID()};
  pending.set(key, next);
  try { storage?.setItem(key, JSON.stringify(next)); } catch (_) { /* still protects in-tab retries */ }
  return next.id;
}
