import { captureLeadAttribution } from "../js/lead-attribution.js";

function assert(condition, message) {
  if (!condition) throw Error(message);
}
function storage() {
  const rows = new Map();
  return {
    rows,
    getItem: (key) => rows.get(key) || null,
    setItem: (key, value) => rows.set(key, value),
  };
}

Deno.test("first-touch capture stores UTM labels and host/path, never full private URLs", () => {
  const cache = storage();
  const result = captureLeadAttribution({
    href:
      "https://capture-one.example.test/book?utm_source=InStaGram&utm_medium=Paid_Social&utm_campaign=Summer+launch&token=PRIVATE#gclid",
    referrer:
      "https://user:password@instagram.com/private/conversation?private=do-not-store",
    storage: cache,
  });
  assert(result.utm_source === "instagram", "source normalized for capture");
  assert(result.utm_medium === "paid_social", "medium normalized");
  assert(result.utm_campaign === "Summer launch", "campaign label preserved");
  assert(
    result.referrer_host === "instagram.com",
    "only external hostname captured",
  );
  assert(result.landing_path === "/book", "only landing pathname captured");
  const saved = [...cache.rows.values()].join("");
  assert(
    !/PRIVATE|password|conversation|do-not-store|gclid/.test(saved),
    "private URL pieces excluded",
  );
});

Deno.test("same-session first external touch survives direct navigation and later campaign URLs", () => {
  const cache = storage();
  const first = captureLeadAttribution({
    href:
      "https://capture-two.example.test/?utm_source=google&utm_campaign=First",
    storage: cache,
  });
  const later = captureLeadAttribution({
    href:
      "https://capture-two.example.test/book?utm_source=instagram&utm_campaign=Later",
    storage: cache,
  });
  assert(
    JSON.stringify(first) === JSON.stringify(later),
    "first attributed touch remains stable",
  );
});

Deno.test("direct entry can be enriched by first later attributed touch without retaining same-site referrer", () => {
  const cache = storage();
  const direct = captureLeadAttribution({
    href: "https://capture-three.example.test/",
    referrer: "https://capture-three.example.test/private?token=hidden",
    storage: cache,
  });
  assert(!direct.referrer_host, "same-site referrer excluded");
  const attributed = captureLeadAttribution({
    href: "https://capture-three.example.test/book?utm_source=referral",
    storage: cache,
  });
  assert(
    attributed.utm_source === "referral",
    "first meaningful campaign enriches direct session",
  );
});

Deno.test("blocked storage and malformed storage do not break public intake attribution", () => {
  const blocked = {
    getItem() {
      throw Error("disabled");
    },
    setItem() {
      throw Error("disabled");
    },
  };
  const first = captureLeadAttribution({
    href: "https://capture-four.example.test/?utm_source=instagram",
    storage: blocked,
  });
  const again = captureLeadAttribution({
    href: "https://capture-four.example.test/other",
    storage: blocked,
  });
  assert(
    JSON.stringify(first) === JSON.stringify(again),
    "in-memory fallback stable",
  );
  const malformed = captureLeadAttribution({
    href: "https://capture-five.example.test/book",
    storage: { getItem: () => "{bad", setItem() {} },
  });
  assert(malformed.landing_path === "/book", "invalid saved state ignored");
});

Deno.test("throwing sessionStorage getter and malformed locations fail safely", () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw Error("SecurityError");
    },
  });
  try {
    assert(
      captureLeadAttribution({ href: "https://capture-six.example.test/" })
        .landing_path === "/",
      "getter refusal caught",
    );
    assert(
      Object.keys(captureLeadAttribution({ href: "javascript:alert(1)" }))
        .length === 0,
      "unsupported location ignored",
    );
  } finally {
    if (old) Object.defineProperty(globalThis, "sessionStorage", old);
    else delete globalThis.sessionStorage;
  }
});
