import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { stubCRM } from "./fixtures/crm-workspace-fixture.mjs";
const root = fileURLToPath(new URL("..", import.meta.url)),
  port = 18743,
  base = `http://localhost:${port}/crm/`;
const server = spawn("python3", ["-m", "http.server", String(port)], {
  cwd: root,
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 600));
let browser, checks = 0;
function ok(v, msg) {
  checks++;
  if (!v) throw Error(msg);
}
try {
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
    await context.route(
      /fonts\.(googleapis|gstatic)\.com/,
      (r) => r.fulfill({ body: "" }),
    );
    await context.route(
      "**/supabase.min.js",
      (r) =>
        r.fulfill({
          contentType: "text/javascript",
          body: `(${stubCRM.toString()})();`,
        }),
    );
    await context.route("**/*.supabase.co/**", (r) => {
      throw Error("Unexpected live Supabase request: " + r.request().url());
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto(base);
    await page.waitForSelector(".task-title");
    ok(
      (await page.locator("#workspace h1").textContent()) === "Today",
      "today heading",
    );
    ok(
      await page.locator(".task-due.red").count() === 1,
      "overdue task visible",
    );
    ok(!await page.evaluate(() => window.pwned), "client text must be escaped");
    await page.waitForSelector('[data-health-status="ready"]');
    ok(
      await page.locator("#operationalHealth").textContent().then((t) =>
        t.includes("Queue clear")
      ),
      "healthy queue is explicitly checked",
    );
    await page.evaluate(() => {
      const p = window.__crm.projects[0];
      Object.assign(window.__crm.health, {
        email_failed: 1,
        email_waiting: 2,
        email_stalled: 1,
        billing_unassigned: 1,
        billing_issues: [{
          id: p.id,
          client_name: p.client_name,
          title: p.title,
        }],
        email_issues: [{
          id: "failed-example",
          project_id: p.id,
          project_title: p.title,
          kind: "studio_message",
          attempts: 3,
          last_error: "401 invalid API key in internal_fn()",
          created_at: new Date().toISOString(),
        }],
      });
    });
    await page.locator("[data-health-refresh]").click();
    await page.waitForSelector(
      '#operationalHealth.has-issues[data-health-status="ready"]',
    );
    ok(
      await page.locator("#operationalHealth").textContent().then((t) =>
        t.includes("provider connection needs attention")
      ),
      "failed message has actionable plain-language reason",
    );
    ok(
      !await page.locator("#operationalHealth").textContent().then((t) =>
        t.includes("internal_fn")
      ),
      "health does not expose raw internal errors",
    );
    ok(
      await page.locator("#operationalHealth [data-project]").count() === 2,
      "health links to failed-message and unknown-billing projects",
    );
    await page.evaluate(() => window.__crm.failHealth = true);
    await page.locator("[data-health-refresh]").click();
    await page.waitForSelector('[data-health-status="unavailable"]');
    ok(
      await page.locator("#operationalHealth").textContent().then((t) =>
        t.includes("Counts remain unknown")
      ),
      "failed health checks do not show false zeroes",
    );
    ok(
      await page.locator(".task-title").count() === 1,
      "health failure leaves CRM tasks working",
    );
    await page.evaluate(() => {
      window.__crm.failHealth = false;
      Object.assign(window.__crm.health, {
        email_failed: 0,
        email_waiting: 0,
        email_stalled: 0,
        billing_unassigned: 0,
        billing_issues: [],
        email_issues: [],
      });
    });
    await page.locator("[data-health-refresh]").click();
    await page.waitForSelector('[data-health-status="ready"]');
    if (process.env.SHOTS) {
      await page.evaluate(() => {
        window.__crm.projects[0].client_name = "Avery Test";
        window.__crm.contacts[0].name = "Avery Test";
        window.__crm.tasks[0].client_name = "Avery Test";
      });
      await page.locator("[data-refresh]").click();
      await page.waitForSelector(".task-title");
    }
    ok(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
      "today overflow " + width,
    );
    if (process.env.SHOTS) {
      mkdirSync(process.env.SHOTS, { recursive: true });
      await page.screenshot({
        path: `${process.env.SHOTS}/crm-today-${width}.png`,
        fullPage: true,
      });
    }
    const moneyLine = page.locator("#openMoneyLine a");
    await moneyLine.waitFor();
    ok(
      (await moneyLine.textContent()).trim() ===
        "Open money: $2,500.00 across 1 item · 1 your move · 0 overdue",
      "today shows the open money line",
    );
    await page.locator("#mainNav [data-view=money]").click();
    await page.locator("#openMoney .money-row").filter({
      hasText: "Synthetic Money Client",
    }).waitFor();
    ok(
      new URL(page.url()).searchParams.get("view") === "money" &&
        await page.locator("#mainNav [data-view=money]").getAttribute(
            "aria-current",
          ) === "page" &&
        (await page.locator("#workspace h1").textContent()) === "Open money",
      "nav opens the Open money screen",
    );
    await page.goto(base + "?view=money");
    await page.locator("#openMoney .money-row").filter({
      hasText: "Synthetic Money Client",
    }).waitFor();
    ok(
      (await page.locator("#workspace h1").textContent()) === "Open money",
      "a direct link lands on the Open money screen",
    );
    await page.locator("#mainNav [data-view=today]").click();
    await page.waitForSelector(".task-title");
    await page.locator("[data-task-toggle]").click();
    await page.waitForFunction(() => window.__crm.tasks[0].status === "done");
    await page.getByRole("heading", {
      name: "Needs a next action",
      exact: true,
    }).waitFor();
    ok(
      await page.getByRole("link", { name: "Set action", exact: true })
        .count() === 1,
      "unfinished lead remains visible after sole task completes",
    );
    await page.locator("#mainNav [data-view=pipeline]").click();
    await page.waitForSelector(".row-title");
    await page.locator(".row-title").click();
    await page.waitForSelector("#projectForm", { state: "attached" });
    ok(
      await page.locator("#billingForm [name=provider]").isDisabled(),
      "issued HoneyBook provider locked",
    );
    ok(
      await page.locator("#projectForm [name=client_name]").inputValue().then(
        (v) => v.includes("Avery Test"),
      ),
      "project client fields",
    );
    await page.getByText("Edit project details", { exact: true }).click();
    await page.locator("#projectForm [name=client_phone]").fill("555-0202");
    await page.locator("#projectForm button").click();
    await page.waitForFunction(() =>
      window.__crm.projects[0].client_phone === "555-0202"
    );
    ok(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <= innerWidth
      ),
      "detail overflow " + width,
    );
    if (process.env.SHOTS) {
      await page.screenshot({
        path: `${process.env.SHOTS}/crm-project-${width}.png`,
        fullPage: true,
      });
    }
    await page.evaluate(() => window.__crm.failWrite = true);
    await page.locator("#notesForm [name=notes]").fill(
      "Unsaved note survives rejected row",
    );
    await page.locator("#notesForm button").click();
    await page.waitForFunction(() =>
      document.querySelector("#notesForm .form-error").textContent.includes(
        "Nothing was saved",
      )
    );
    ok(
      await page.locator("#notesForm textarea").inputValue() ===
        "Unsaved note survives rejected row",
      "rejected writes preserve draft",
    );
    await page.evaluate(() => window.__crm.failWrite = false);
    await page.locator("#notesForm button").click();
    await page.waitForFunction(() =>
      window.__crm.projects[0].notes_internal ===
        "Unsaved note survives rejected row"
    );
    await page.locator("#quoteEditor summary").click();
    await page.locator("#quoteForm [data-line=description]").fill(
      "Half-day shoot",
    );
    await page.locator("#quoteForm [data-line=unit]").fill("500");
    ok(
      await page.locator("#quoteTotal").textContent() === "$500.00",
      "quote total updates",
    );
    await page.locator(
      "#quoteForm button[type=submit], #quoteForm button:not([type])",
    ).click();
    await page.waitForSelector("[data-quote-status=sent]");
    await page.locator("[data-quote-status=sent]").click();
    await page.waitForSelector(".quote .pill.sent");
    ok(
      await page.locator("[data-quote-edit]").count() === 0,
      "sent quote immutable in editor",
    );
    await page.locator("[data-quote-copy]").click();
    await page.locator("#quoteForm [name=title]").fill("Revised test quote");
    await page.locator("#quoteForm button:not([type])").click();
    await page.waitForFunction(() => window.__crm.quotes.length === 2);
    ok(
      await page.evaluate(() =>
        window.__crm.quotes[0].status === "sent" &&
        window.__crm.quotes[1].status === "draft"
      ),
      "revision keeps published quote immutable",
    );
    await page.locator("#newLeadBtn").click();
    ok(
      await page.locator("#leadForm [name=instagram]").inputValue() === "",
      "new lead has no accidental handle",
    );
    ok(
      await page.locator("#leadForm [name=owner_id]").inputValue() ===
        "10000000-0000-4000-8000-000000000009",
      "new lead defaults to signed-in owner",
    );
    await page.locator("#leadForm [name=client_name]").fill(
      "Instagram Test Lead",
    );
    await page.locator("#leadForm [name=instagram]").fill("@synthetic_lead");
    await page.locator("#leadForm [name=referral_source]").fill("Instagram DM");
    await page.locator("#leadForm button:not([type])").click();
    await page.waitForFunction(() =>
      document.querySelector("#projectForm [name=client_name]")?.value ===
        "Instagram Test Lead"
    );
    ok(
      await page.locator(".note").first().textContent().then((v) =>
        v.includes("no email address")
      ),
      "manual no-email warning",
    );
    ok(
      await page.locator(".task-title").textContent() === "Respond to inquiry",
      "first followup created",
    );
    ok(
      await page.evaluate(() =>
        Boolean(
          window.__crm.logs.find((l) => l.rpc === "bk_crm_create_project")?.args
            .p_data.request_id,
        )
      ),
      "manual creation has retry key",
    );
    await page.locator("details summary").filter({ hasText: "Add next action" })
      .click();
    await page.locator("#taskForm [name=title]").fill("Send edited previews");
    await page.locator("#taskForm [name=due_at]").fill("2027-02-03T10:00");
    await page.locator("#taskForm [name=kind]").selectOption("delivery");
    await page.locator("#taskForm button").click();
    await page.waitForFunction(() =>
      window.__crm.tasks.some((t) => t.title === "Send edited previews")
    );
    await page.locator("#mainNav [data-view=clients]").click();
    await page.waitForSelector("[data-contact-open]");
    await page.locator("[data-contact-open]").first().click();
    await page.waitForSelector("[data-contact-form]");
    ok(
      await page.locator(".contact-projects a").count() > 0,
      "contact project history",
    );
    await page.locator("#mainNav [data-view=reports]").click();
    await page.waitForSelector(".report-row");
    ok(
      await page.locator("#workspace h1").textContent() === "Reports",
      "reports load",
    );
    await page.waitForSelector('[data-health-status="ready"]');
    ok(
      await page.locator("#operationalHealth").count() === 1,
      "reports include operational health",
    );
    ok(errors.length === 0, "browser errors: " + errors.join("; "));
    await context.close();
  }
  const context = await browser.newContext();
  await context.route(
    /fonts\.(googleapis|gstatic)\.com/,
    (r) => r.fulfill({ body: "" }),
  );
  await context.route(
    "**/supabase.min.js",
    (r) =>
      r.fulfill({
        contentType: "text/javascript",
        body: `(${stubCRM.toString()})();window.__crm.missing=true;`,
      }),
  );
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector("#statusBanner:not([hidden])");
  ok(
    await page.locator("#statusBanner").textContent().then((t) =>
      t.includes("foundation is not installed")
    ),
    "missing migration actionable error",
  );
  ok(
    await page.locator(".tool-links a").count() === 5,
    "legacy tools available when setup missing",
  );
  await context.close();
  const reviewContext = await browser.newContext();
  await reviewContext.route(
    /fonts\.(googleapis|gstatic)\.com/,
    (r) => r.fulfill({ body: "" }),
  );
  await reviewContext.route("**/supabase.min.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body:
        `(${stubCRM.toString()})();window.__crm.bookings=[{id:"review-test",project_id:window.__crm.projects[0].id,payment_review_required:true,payment_review_reason:"The date hold expired before payment arrived."}];window.__crm.projects[0].status="booked";window.__crm.projects[0].billing_requires_reconciliation=true;`,
    }));
  const reviewPage = await reviewContext.newPage();
  reviewPage.on("dialog", (d) => d.accept());
  await reviewPage.goto(
    base + "?view=pipeline&p=10000000-0000-4000-8000-000000000001",
  );
  await reviewPage.waitForSelector(".critical-note");
  ok(
    await reviewPage.locator(".heading .pill").textContent() ===
      "Booking needs review",
    "reviewed payment never presents as automatically booked",
  );
  ok(
    await reviewPage.locator('.critical-note[role="alert"]').textContent().then(
      (t) => t.includes("hold expired"),
    ),
    "payment review reason visible",
  );
  ok(
    await reviewPage.locator("#billingForm").count() === 0,
    "conflicted billing cannot use normal assignment",
  );
  await reviewPage.getByText("Review billing assignment", { exact: true })
    .click();
  ok(
    await reviewPage.locator("#billingReconcileForm [name=provider]")
      .inputValue() === "",
    "billing reconciliation requires an explicit provider",
  );
  await reviewPage.locator("#billingReconcileForm [name=provider]")
    .selectOption("honeybook");
  await reviewPage.locator("#billingReconcileForm [name=note]").fill(
    "Reviewed original invoices and reconciled all outstanding sessions.",
  );
  await reviewPage.locator("#billingReconcileForm button").click();
  await reviewPage.waitForSelector("#billingForm");
  ok(
    await reviewPage.evaluate(() =>
      window.__crm.projects[0].billing_requires_reconciliation === false &&
      window.__crm.logs.some((l) =>
        l.rpc === "bk_reconcile_project_billing" && l.args.p_note.length >= 20
      )
    ),
    "admin reconciliation records explicit choice and note",
  );
  await reviewContext.close();
  console.log(
    `PASS CRM workspace: ${checks} checks, desktop + phone, no live writes`,
  );
} finally {
  await browser?.close();
  server.kill();
}
