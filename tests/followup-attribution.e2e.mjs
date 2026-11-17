import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 18758;
const origin = `http://localhost:${port}`;
const server = spawn("python3", ["-m", "http.server", String(port)], {
  cwd: root,
  stdio: "ignore",
});
let browser;
let checks = 0;
function ok(value, message) {
  checks++;
  if (!value) throw Error(message);
}
const project = "10000000-0000-4000-8000-000000000001";
const task = "00000000-0000-4000-8000-000000000002";

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
  for (const width of [1512, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      serviceWorkers: "block",
    });
    await context.route("**/__growth_test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/crm-workspace.css"><link rel="stylesheet" href="/css/crm-growth-tools.css"><main class="workspace"><div id="morning"></div><div id="report"></div><div id="settings"></div></main>',
      }));
    await context.route(
      /fonts\.(googleapis|gstatic)\.com/,
      (route) => route.fulfill({ body: "" }),
    );
    await context.route("**/*.supabase.co/**", () => {
      throw Error("Unexpected live request");
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/__growth_test");
    await page.evaluate(async ({ project, task }) => {
      const growth = await import("/js/crm-growth-tools.js");
      window.calls = [];
      window.dirty = [];
      window.actionFails = true;
      window.settingsFails = true;
      window.plan = {
        project_id: project,
        enabled: true,
        state: "active",
        lead_days: [1, 3, 7],
        quote_days: [3, 7, 14],
        next_due_at: "2026-11-17T15:00:00Z",
      };
      const row = {
        id: task,
        project_id: project,
        client_name: '<img src=x onerror="window.pwned=true">',
        project_title: "Synthetic inquiry",
        title: "Reply to new inquiry",
        due_at: "2026-11-17T15:00:00Z",
        phone: "+1 (555) 010-0100",
        source: "Instagram",
        conversation_url: "/inbox/?p=" + project,
        template_url: "/inbox/?p=" + project + "&template=call",
        cadence_step: 1,
        cadence_total: 3,
      };
      window.morningRows = [row];
      const rpc = async (name, args) => {
        window.calls.push({ name, args });
        if (name === "bk_crm_morning") {
          return {
            rows: window.morningRows,
            total: window.morningRows.length,
            counts: { overdue: 1, today: 0, unassigned: 1 },
          };
        }
        if (name === "bk_crm_followup_action") {
          if (window.actionFails) {
            window.actionFails = false;
            throw Error("Connection interrupted. Try again.");
          }
          window.morningRows = [];
          return {};
        }
        if (name === "bk_crm_followup_settings") return window.plan;
        if (name === "bk_crm_set_followup") {
          if (window.settingsFails) {
            window.settingsFails = false;
            throw Error("Settings did not save. Try again.");
          }
          Object.assign(window.plan, args.p_settings);
          return window.plan;
        }
        if (name === "bk_crm_source_report") {
          const source = {
            source: "Instagram",
            leads: 2,
            booked: 0,
            receipts_cents: 8000,
            responded: 1,
            median_response_hours: 2,
            conversion_pct: 0,
          };
          return {
            totals: source,
            rows: [source],
            campaigns: [{
              ...source,
              campaign: "<script>window.pwned=true</script>",
            }],
            campaign_total: 1,
          };
        }
        throw Error("Unexpected RPC " + name);
      };
      const onDirty = (value) => window.dirty.push(value);
      growth.mountMorningList(document.querySelector("#morning"), {
        rpc,
        openProject: (id) => window.openedProject = id,
      });
      growth.mountSourceReport(document.querySelector("#report"), {
        rpc,
        onDirty,
      });
      growth.mountFollowupSettings(document.querySelector("#settings"), {
        rpc,
        project,
        onDirty,
      });
    }, { project, task });
    await page.waitForSelector("[data-growth-done]");
    await page.waitForSelector("#report .growth-table");
    await page.waitForSelector("#settings details");
    ok(
      !await page.evaluate(() => window.pwned),
      "all client and campaign text is escaped",
    );
    ok(
      await page.locator('#morning a:has-text("Conversation")').getAttribute(
        "href",
      ) === `/inbox/?p=${project}`,
      "morning opens exact project conversation",
    );
    ok(
      await page.locator('#morning a:has-text("Open reply template")')
        .getAttribute("href") === `/inbox/?p=${project}&template=call`,
      "template link carries exact conversation and template",
    );
    await page.locator("[data-growth-project]").click();
    ok(
      await page.evaluate(() => window.openedProject) === project,
      "project action delegates exact selected record",
    );
    await page.locator("[data-growth-done]").click();
    await page.locator("[data-growth-error]").filter({
      hasText: "Connection interrupted",
    }).waitFor();
    ok(
      await page.locator("[data-growth-done]").isEnabled(),
      "failed action remains retryable",
    );
    await page.locator("[data-growth-done]").click();
    await page.getByText("No follow-ups are due through today.", {
      exact: false,
    }).waitFor();
    const actionCalls = await page.evaluate(() =>
      window.calls.filter((call) => call.name === "bk_crm_followup_action")
    );
    ok(
      actionCalls.length === 2 &&
        actionCalls[0].args.p_request_id === actionCalls[1].args.p_request_id,
      "action retry retains idempotency key",
    );
    ok(
      await page.locator("#report").textContent().then((text) =>
        text.includes("$80.00") && text.includes("0 booked")
      ),
      "report separates actual receipts from confirmed booking count",
    );
    await page.locator('#report [name="campaign"]').fill("Summer launch");
    await page.locator('#report [name="source"]').selectOption("Instagram");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForFunction(() =>
      window.calls.filter((call) => call.name === "bk_crm_source_report")
        .length === 2
    );
    const filters = await page.evaluate(() =>
      window.calls.filter((call) => call.name === "bk_crm_source_report").at(-1)
        .args
    );
    ok(
      filters.p_source === "Instagram" &&
        filters.p_campaign === "Summer launch",
      "source and campaign filters pass exact values",
    );
    ok(
      !await page.locator("#settings details").evaluate((el) => el.open),
      "project cadence starts collapsed",
    );
    ok(
      await page.locator("#settings summary").textContent().then((text) =>
        text.includes("Enabled") && text.includes("Nov 17")
      ),
      "collapsed summary shows state and next action date",
    );
    await page.locator("#settings summary").click();
    await page.locator('#settings [name="lead_days"]').fill("3, 2");
    await page.getByRole("button", { name: "Save cadence" }).click();
    await page.locator("#settings [role=alert]").filter({
      hasText: "increasing",
    }).waitFor();
    ok(
      await page.evaluate(() =>
        window.calls.filter((call) => call.name === "bk_crm_set_followup")
          .length
      ) === 0,
      "invalid offsets do not submit",
    );
    await page.locator('#settings [name="lead_days"]').fill("2, 4, 8");
    await page.getByRole("button", { name: "Save cadence" }).click();
    await page.locator("#settings [role=alert]").filter({
      hasText: "did not save",
    }).waitFor();
    ok(
      await page.locator('#settings [name="lead_days"]').inputValue() ===
        "2, 4, 8",
      "failed settings preserve edited values",
    );
    await page.getByRole("button", { name: "Save cadence" }).click();
    await page.waitForFunction(() =>
      window.calls.filter((call) => call.name === "bk_crm_set_followup")
        .length === 2
    );
    const saves = await page.evaluate(() =>
      window.calls.filter((call) => call.name === "bk_crm_set_followup")
    );
    ok(
      saves[0].args.p_request_id === saves[1].args.p_request_id,
      "settings retry retains idempotency key",
    );
    ok(
      await page.evaluate(() =>
        window.dirty.includes(true) && window.dirty.includes(false)
      ),
      "edits and successful save update dirty state",
    );
    ok(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
      "responsive layout has no page overflow " + width,
    );
    ok(
      errors.length === 0,
      "module browser has no runtime errors: " + errors.join("; "),
    );
    await context.close();
  }

  // Exercise the real public entrypoint and both real form handlers. Every
  // network mutation is intercepted with synthetic responses before it leaves.
  const context = await browser.newContext({
    serviceWorkers: "block",
    reducedMotion: "reduce",
  });
  const inquiries = [];
  const digitals = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname.endsWith("supabase.co")) {
      const body = route.request().postDataJSON();
      if (url.pathname.endsWith("/bk_submit_inquiry_attributed")) {
        inquiries.push(body);
        return route.fulfill({
          status: inquiries.length === 1 ? 503 : 200,
          contentType: "application/json",
          body: inquiries.length === 1
            ? '{"message":"retry"}'
            : JSON.stringify({ id: project, token: task }),
        });
      }
      if (url.pathname.endsWith("/bk_book_digitals_attributed")) {
        digitals.push(body);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: project, token: task }),
        });
      }
      throw Error("Unexpected public RPC " + url.pathname);
    }
    if (url.origin !== origin) return route.fulfill({ body: "" });
    if (url.pathname === "/portal.html") {
      return route.fulfill({
        contentType: "text/html",
        body: "<h1>Synthetic portal</h1>",
      });
    }
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    origin +
      "/?utm_source=Instagram&utm_medium=paid_social&utm_campaign=Summer+launch&token=PRIVATE",
  );
  await page.locator('#svcPick [data-v="brand_content"]').click();
  await page.locator("#next1").click();
  await page.locator("#next2").click();
  await page.locator("#fName").fill("Synthetic Browser Lead");
  await page.locator("#fEmail").fill("synthetic@example.test");
  await page.locator("#fSource").selectOption("Referral");
  await page.locator("#submitBtn").click();
  await page.locator("#bookErr").filter({ hasText: "Something glitched" })
    .waitFor();
  await page.locator("#submitBtn").click();
  await page.locator("#bookDone").waitFor({ state: "visible" });
  ok(
    inquiries.length === 2,
    "real inquiry handler uses attributed wrapper and retries",
  );
  ok(
    inquiries[0].p_submission_id === inquiries[1].p_submission_id,
    "inquiry retry preserves submission id",
  );
  ok(
    inquiries[1].p_attribution.utm_source === "instagram" &&
      inquiries[1].p_attribution.utm_campaign === "Summer launch",
    "real inquiry captures first-touch campaign",
  );
  ok(
    inquiries[1].p_source === "Referral",
    "declared source preserved separately from campaign",
  );
  ok(
    inquiries[1].p_attribution.landing_path === "/" &&
      !JSON.stringify(inquiries[1].p_attribution).includes("PRIVATE"),
    "public attribution excludes private query values",
  );
  await page.locator("#dgName").fill("Synthetic Digitals Lead");
  await page.locator("#dgEmail").fill("digitals@example.test");
  await page.locator("#dgBtn").click();
  await page.getByRole("heading", { name: "Synthetic portal" }).waitFor();
  ok(
    digitals.length === 1 &&
      digitals[0].p_attribution.utm_source === "instagram",
    "real digitals handler attaches same first-touch attribution",
  );
  ok(
    !("p_amount_cents" in digitals[0]),
    "digitals wrapper leaves payment amount server owned",
  );
  ok(
    errors.length === 0,
    "classic public entrypoint has no runtime errors: " + errors.join("; "),
  );
  await context.close();
  console.log(
    `followup-attribution.e2e: ${checks} checks passed on desktop/phone and public forms; no live writes`,
  );
} finally {
  await browser?.close();
  server.kill();
}
