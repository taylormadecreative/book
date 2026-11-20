import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The proposal view reporter on a fake https proposal page. Supabase is
// routed to a recorder; nothing reaches the live project.
const root = fileURLToPath(new URL("..", import.meta.url));
const port = 18762;
const local = `http://localhost:${port}`;
const site = "https://proposal.example.test";
const server = spawn("python3", ["-m", "http.server", String(port)], {
  cwd: root,
  stdio: "ignore",
});
const KEY = "k".repeat(32);
const PUBLIC_KEY = "sb_publishable_fyYqa9QkEeA5LD_0hYLTTA_F8Gxw1oz";
let browser;
let checks = 0;
function ok(value, message) {
  checks++;
  if (!value) throw Error(message);
}
const page = (src, key) =>
  `<!doctype html><meta charset="utf-8"><title>Synthetic proposal</title><h1>Synthetic proposal</h1>` +
  `<script async src="${src}" data-key="${key}"></script>`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

async function newContext({ webdriver = false, abort = false } = {}) {
  const context = await browser.newContext({ serviceWorkers: "block" });
  const sent = [];
  await context.addInitScript(() =>
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: () => window.__webdriver ?? false,
    })
  );
  if (webdriver) await context.addInitScript(() => window.__webdriver = true);
  await context.route(`${site}/js/proposal-beacon.js`, async (route) => {
    const response = await route.fetch({ url: `${local}/js/proposal-beacon.js` });
    await route.fulfill({ response });
  });
  await context.route(`${site}/proposal*`, (route) => {
    const key = new URL(route.request().url()).pathname.endsWith("short")
      ? "short"
      : KEY;
    return route.fulfill({
      contentType: "text/html",
      body: page(`${site}/js/proposal-beacon.js`, key),
    });
  });
  await context.route(`${local}/__beacon_local`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: page("/js/proposal-beacon.js", KEY),
    }));
  await context.route("**/*.supabase.co/**", (route) => {
    const request = route.request();
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "apikey, authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: cors });
    }
    sent.push({
      url: request.url(),
      method: request.method(),
      headers: request.headers(),
      body: request.postData(),
    });
    return abort ? route.abort() : route.fulfill({ status: 204, headers: cors });
  });
  const errors = [];
  context.on("weberror", (error) => errors.push(error.error().message));
  context.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return { context, sent, errors };
}

async function visit(context, url) {
  const tab = await context.newPage();
  await tab.goto(url);
  await settle();
  return tab;
}

try {
  await new Promise((resolve) => setTimeout(resolve, 500));
  browser = await chromium.launch(
    process.env.PW_CHROME
      ? {
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }
      : {},
  );

  // 1-4: a real visitor, a reload, opting out and back in
  {
    const { context, sent, errors } = await newContext();
    const tab = await visit(context, `${site}/proposal`);
    ok(sent.length === 1, "a normal visit reports once, got " + sent.length);
    const [hit] = sent;
    ok(
      hit.method === "POST" &&
        hit.url ===
          "https://pgqdmnmessbbzyszjfvr.supabase.co/rest/v1/rpc/bk_money_view" &&
        hit.body === JSON.stringify({ p_key: KEY }),
      "posts the key to the view counter",
    );
    ok(
      hit.headers.apikey === PUBLIC_KEY &&
        hit.headers.authorization === "Bearer " + PUBLIC_KEY,
      "sends the public key headers",
    );
    await tab.reload();
    await settle();
    ok(sent.length === 1, "a reload in the same tab does not count again");

    const optOut = await visit(context, `${site}/proposal?notrack=1&ref=synthetic`);
    ok(sent.length === 1, "?notrack=1 sends nothing");
    ok(
      await optOut.evaluate(() => location.search) === "?ref=synthetic",
      "the opt-out parameter is removed from the address",
    );
    ok(
      await optOut.getByText("This browser won't be counted as a proposal view.")
        .isVisible(),
      "the opt-out shows a note",
    );
    await visit(context, `${site}/proposal`);
    ok(sent.length === 1, "an opted-out browser stays uncounted in a new tab");

    const optIn = await visit(context, `${site}/proposal?notrack=0`);
    ok(
      await optIn.evaluate(() => location.search) === "",
      "?notrack=0 is removed from the address",
    );
    const counted = sent.length;
    await visit(context, `${site}/proposal`);
    ok(sent.length === counted + 1, "after ?notrack=0 a new visit counts");
    ok(errors.length === 0, "no page errors: " + errors.join("; "));
    await context.close();
  }

  // 5: automated test browsers are skipped
  {
    const { context, sent } = await newContext({ webdriver: true });
    await visit(context, `${site}/proposal`);
    ok(sent.length === 0, "a test browser sends nothing");
    await context.close();
  }

  // 6: a short key is ignored
  {
    const { context, sent } = await newContext();
    await visit(context, `${site}/proposal-short`);
    ok(sent.length === 0, "a short key sends nothing");
    await context.close();
  }

  // 7: plain http and localhost are skipped
  {
    const { context, sent, errors } = await newContext();
    const tab = await visit(context, `${local}/__beacon_local`);
    ok(
      await tab.evaluate(() => document.querySelector("h1").textContent) ===
        "Synthetic proposal",
      "the local page loaded",
    );
    ok(sent.length === 0, "localhost over http sends nothing");
    ok(errors.length === 0, "no errors on localhost: " + errors.join("; "));
    await context.close();
  }

  // 8: a failing network never surfaces to the visitor
  {
    const { context, sent, errors } = await newContext({ abort: true });
    await visit(context, `${site}/proposal`);
    ok(sent.length === 1, "the aborted request was attempted");
    const own = errors.filter((text) => !/^Failed to load resource/.test(text));
    ok(own.length === 0, "a failed report raises no script error: " + own.join("; "));
    await context.close();
  }

  console.log(
    `proposal-beacon.e2e: ${checks} checks passed; fake https page, Supabase routed, no live requests`,
  );
} finally {
  await browser?.close();
  server.kill();
}
