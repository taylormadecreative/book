// Session first-touch metadata only. No contact data, full URLs or query tokens.
const STORAGE_KEY = "bk-lead-attribution-v1";
const memory = new Map();
const FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
];

function clean(value, limit = 180) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, limit)
    : "";
}

function safeSaved(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const field of FIELDS) {
    const entry = clean(value[field]);
    if (entry) result[field] = entry;
  }
  const host = clean(value.referrer_host, 253).toLowerCase();
  if (/^[a-z0-9.-]+$/.test(host) && !host.includes("..")) {
    result.referrer_host = host;
  }
  const path = clean(value.landing_path, 500).split(/[?#]/, 1)[0];
  if (path.startsWith("/") && !path.startsWith("//")) {
    result.landing_path = path;
  }
  return Object.keys(result).length ? result : null;
}

export function captureLeadAttribution(options = {}) {
  let storage = options.storage;
  if (storage === undefined) {
    try {
      storage = globalThis.sessionStorage;
    } catch {
      // Private browsing may reject even reading the storage property.
    }
  }
  const href = options.href ?? globalThis.location?.href;
  let current;
  try {
    current = new URL(href);
    if (!["https:", "http:"].includes(current.protocol)) return {};
  } catch {
    return {};
  }
  const key = STORAGE_KEY + ":" + current.origin;
  let saved = memory.get(key) || null;
  try {
    saved = safeSaved(JSON.parse(storage?.getItem(key) || "null")) || saved;
  } catch {
    // In-memory first touch remains available when storage is blocked or corrupt.
  }
  const captured = {};
  for (const field of FIELDS) {
    const value = clean(current.searchParams.get(field));
    if (value) {
      captured[field] = ["utm_source", "utm_medium"].includes(field)
        ? value.toLowerCase()
        : value;
    }
  }
  try {
    const referrer = new URL(options.referrer ?? globalThis.document?.referrer);
    if (
      ["https:", "http:"].includes(referrer.protocol) &&
      referrer.hostname !== current.hostname
    ) {
      captured.referrer_host = referrer.hostname.toLowerCase();
    }
  } catch {
    // A direct visit has no external referrer.
  }
  captured.landing_path = current.pathname.slice(0, 500);
  const savedHasTouch = saved && (saved.utm_source || saved.referrer_host);
  const newHasTouch = captured.utm_source || captured.referrer_host;
  const result = savedHasTouch || !newHasTouch && saved ? saved : captured;
  const safe = safeSaved(result) || {};
  memory.set(key, safe);
  try {
    storage?.setItem(key, JSON.stringify(safe));
  } catch {
    // Attribution cannot prevent a customer from submitting an inquiry.
  }
  return { ...safe };
}
