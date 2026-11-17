import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const directory = fileURLToPath(new URL("..", import.meta.url));
const port = 18759, base = `http://localhost:${port}`;
const server = spawn("python3", ["-m", "http.server", String(port)], {
  cwd: directory,
  stdio: "ignore",
});
let browser, checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks++;
}
function fixture() {
  const staff = [{
    id: "11111111-1111-4111-8111-111111111111",
    full_name: "Synthetic Editor",
  }];
  const project = {
    id: "33333333-3333-4333-8333-333333333333",
    contact_id: "44444444-4444-4444-8444-444444444444",
    title: "November Campaign",
    client_name: "Synthetic Customer",
  };
  const totals = {
    quote_cents: 150000,
    invoiced_cents: 120000,
    received_cents: 80000,
    expenses_cents: 20000,
    labor_cents: 9000,
    contribution_cents: 51000,
  };
  const current = new Date();
  const monthParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
    }).formatToParts(current).map((p) => [p.type, p.value]),
  );
  const periodStart = `${monthParts.year}-${monthParts.month}-01`;
  const periodEnd = new Date(
    Date.UTC(Number(monthParts.year), Number(monthParts.month), 0),
  ).toISOString().slice(0, 10);
  const allowance = {
    key: "reels",
    label: "Reels",
    included: 4,
    used: 2,
    remaining: 2,
  };
  const period = {
    id: "period-one",
    project_id: project.id,
    retainer_id: "retainer-one",
    starts_on: periodStart,
    ends_on: periodEnd,
    period_month: periodStart,
    status: "open",
    monthly_amount_cents: 120000,
    billing_provider: "honeybook",
    allowances: [allowance],
    usage: [{
      id: "usage-one",
      item_key: "reels",
      quantity_delta: 2,
      reversible_quantity: 2,
      note: "Two approved reels",
      created_at: "2026-11-16",
    }],
  };
  const retainer = {
    id: "retainer-one",
    contact_id: project.contact_id,
    client_name: project.client_name,
    name: "Monthly Content",
    status: "active",
    billing_provider: "honeybook",
    monthly_amount_cents: 120000,
    start_on: periodStart,
    owner_id: staff[0].id,
    allowances: [{ key: "reels", label: "Reels", quantity: 4 }],
    period_count: 1,
    periods: [period],
  };
  const db = {
    expenses: [{
      id: "expense-one",
      title: "<img src=x onerror=alert(1)>",
      category: "contractor",
      amount_cents: 20000,
      incurred_on: "2026-11-16",
    }],
    time_entries: [],
    allocations: [],
    rates: [{ staff_id: staff[0].id, hourly_cost_cents: 6000 }],
    periods: [period],
    retainers: { rows: [retainer], total: 1 },
    profit: {
      rows: [{ ...totals, project_id: project.id, ...project }],
      totals,
      total: 1,
    },
  };
  window.calls = [];
  window.failNext = false;
  window.failReads = false;
  window.portalEmpty = false;
  window.periodState = "open";
  window.dirty = false;
  window.globalSubmits = 0;
  document.addEventListener("submit", () => window.globalSubmits++);
  window.testOptions = {
    project,
    staff,
    toast: (m) => window.lastToast = m,
    onDirty: (v) => window.dirty = v,
    openProject: (id) => window.openedProject = id,
    rpc: async (name, args = {}) => {
      window.calls.push({ name, args });
      if (window.failReads && name !== "bk_ops_save") {
        throw Error(
          "Synthetic unavailable",
        );
      }
      if (name === "bk_ops_project") {
        const result = structuredClone(db);
        result.periods.forEach((p) => {
          p.period_state = window.periodState;
          p.allowances.forEach((a) =>
            a.available_now = window.periodState === "open" ? a.remaining : 0
          );
        });
        return result;
      }
      if (name === "bk_ops_profit") return structuredClone(db.profit);
      if (name === "bk_crm_contacts") {
        return {
          rows: [{
            id: project.contact_id,
            name: project.client_name,
            email: "customer@example.test",
          }],
          total: 1,
        };
      }
      if (name === "bk_crm_projects") return { rows: [project], total: 1 };
      if (name === "bk_ops_capacity") {
        return {
          week: "2026-11-16",
          staff: [{
            ...staff[0],
            weekly_minutes: 600,
            assigned_minutes: 700,
            working_days: [1, 2, 3, 4, 5],
            hourly_cost_cents: 6000,
          }],
          allocations: db.allocations,
          tasks: [{
            project_id: project.id,
            title: "First cut due",
            due_at: "2026-11-18",
          }],
          bookings: [{
            project_id: project.id,
            project_title: project.title,
            starts_at: "2026-11-18T02:00:00Z",
            status: "confirmed",
          }],
        };
      }
      if (name === "bk_ops_retainers") return structuredClone(db.retainers);
      if (name === "bk_ops_portal_retainers") {
        return {
          rows: window.portalEmpty ? [] : [{
            ...period,
            name: retainer.name,
            period_state: window.periodState,
            package_status: retainer.status,
          }],
        };
      }
      if (name !== "bk_ops_save") throw Error(`Unexpected RPC ${name}`);
      if (window.failNext) {
        window.failNext = false;
        throw Error("Synthetic save failure. Try again.");
      }
      const d = args.p_data;
      if (args.p_action === "expense") {
        db.expenses.push({
          ...d,
          id: "expense-new",
        });
      }
      if (args.p_action === "time") {
        db.time_entries.push({
          ...d,
          id: "time-new",
          staff_name: staff[0].full_name,
        });
      }
      if (args.p_action === "allocation") {
        db.allocations.push({
          ...d,
          id: "allocation-new",
          task_id: "task-new",
        });
      }
      if (args.p_action === "retainer") {
        db.retainers.rows.push({
          ...d,
          id: "retainer-new",
          client_name: project.client_name,
          period_count: 0,
          periods: [],
        });
      }
      if (args.p_action === "prepare_invoice") {
        period.invoice_id = "invoice-draft";
        period.invoice_status = "draft";
      }
      if (args.p_action === "usage") {
        const delta = d.reverses_id ? -d.quantity : d.quantity;
        if (allowance.used + delta > allowance.included) {
          throw Error(
            "Not enough included deliverables remain.",
          );
        }
        allowance.used += delta;
        allowance.remaining -= delta;
      }
      return {
        ...d,
        id: d.id || "saved",
        status: args.p_action === "prepare_invoice" ? "draft" : d.status,
      };
    },
  };
}
async function click(page, action) {
  await page.locator(`[data-ops-action="${action}"]`).first().click();
}
async function saved(page) {
  await page.waitForFunction(() => !document.querySelector("[data-ops-form]"));
}
try {
  for (let n = 0; n < 30; n++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
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
    });
    await context.route(`${base}/operations-test`, (r) =>
      r.fulfill({
        contentType: "text/html",
        body:
          `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/crm-workspace.css"><link rel="stylesheet" href="/css/crm-operations.css"><style>body{background:#f5f2eb;padding:20px}#test{max-width:1350px;margin:auto}</style></head><body><main id="test"></main><script>(${fixture.toString()})()</script><script type="module">import * as ops from '/js/crm-operations.js';window.ops=ops;await ops.mountOperations(document.querySelector('#test'),window.testOptions);window.ready=true;</script></body></html>`,
      }));
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto(`${base}/operations-test`);
    await page.waitForFunction(() => window.ready);
    check(
      await page.getByText("$510.00", { exact: true }).count() === 1,
      "contribution shows recorded receipts minus costs",
    );
    check(
      await page.locator("#test img").count() === 0,
      "expense titles are text, not executable HTML",
    );
    check(
      await page.locator("body").evaluate((e) => e.scrollWidth <= innerWidth),
      "project operations fit viewport",
    );
    await click(page, "new-expense");
    check(
      await page.locator("[name=title]").getAttribute("maxlength") === "180",
      "expense title matches DB maximum",
    );
    check(
      await page.locator("[name=notes]").getAttribute("maxlength") === "2000",
      "expense notes match DB maximum",
    );
    await page.locator("[name=title]").fill("Card processing fee");
    await page.locator("[name=category]").selectOption("payment_fees");
    await page.locator("[name=amount]").fill("12.50");
    check(
      await page.evaluate(() => window.dirty),
      "module propagates dirty state",
    );
    await page.evaluate(() => window.failNext = true);
    await page.locator("[data-ops-form] [type=submit]").click();
    await page.getByRole("alert").filter({ hasText: "Synthetic save failure" })
      .waitFor();
    const before = await page.evaluate(() =>
      window.calls.filter((c) => c.name === "bk_ops_save").at(-1).args
    );
    await page.locator("[data-ops-form] [type=submit]").click();
    await saved(page);
    const after = await page.evaluate(() =>
      window.calls.filter((c) => c.name === "bk_ops_save").at(-1).args
    );
    check(
      before.p_request_id === after.p_request_id,
      "failed save retry retains idempotency key",
    );
    check(
      after.p_data.amount_cents === 1250 &&
        after.p_data.category === "payment_fees",
      "expense saves exact cents and fee category",
    );
    check(
      !await page.evaluate(() => window.dirty),
      "successful save clears dirty state",
    );
    check(
      await page.evaluate(() => window.globalSubmits) === 0,
      "operation submit never reaches global CRM handler",
    );
    await click(page, "new-time");
    await page.locator("[name=title]").fill("Final edit");
    await page.locator("[name=minutes]").fill("75");
    await page.locator("[name=hourly_cost]").fill("60");
    await page.locator("[data-ops-form] [type=submit]").click();
    await saved(page);
    check(
      (await page.evaluate(() =>
        window.calls.filter((c) => c.name === "bk_ops_save").at(-1).args.p_data
      )).hourly_cost_cents === 6000,
      "time preserves explicit internal rate assumption",
    );
    await click(page, "use");
    await page.locator("[name=quantity]").fill("3");
    await page.locator("[name=note]").fill("Three additional completed reels");
    await page.locator("[data-ops-form] [type=submit]").click();
    await page.getByRole("alert").filter({ hasText: "Not enough" }).waitFor();
    check(
      await page.locator("[data-ops-form]").count() === 1,
      "allowance overspend stays visible and editable",
    );
    await click(page, "cancel");
    await click(page, "invoice");
    await page.locator("[data-ops-form] [type=submit]").click();
    await saved(page);
    check(
      await page.getByText("Draft prepared. Review and send in Studio.")
            .count() === 0 &&
        await page.evaluate(() => window.lastToast) ===
          "Draft prepared. Review and send in Studio.",
      "invoice creation is an explicit draft action",
    );
    check(
      await page.locator('a[href*="admin.html"]').count() > 0,
      "prepared invoice links existing provider workflow",
    );
    await page.evaluate(async () => {
      window.testOptions.project = undefined;
      await window.ops.mountOperationsView(document.querySelector("#test"), {
        ...window.testOptions,
        view: "capacity",
      });
    });
    check(
      await page.getByText("1.7h over capacity", { exact: true }).count() === 1,
      "capacity makes overload visible",
    );
    check(
      await page.locator(".ops-calendar-context").textContent().then((s) =>
        s.includes("2026-11-17 · Shoot")
      ),
      "booking timestamp displays Chicago calendar date rather than UTC date",
    );
    await click(page, "new-allocation");
    await page.locator("[name=title]").fill("Tuesday editing");
    await page.locator("[name=project_query]").fill("November");
    await click(page, "projects");
    await click(page, "choose-project");
    check(
      await page.locator("[name=title]").inputValue() === "Tuesday editing",
      "project search preserves pending work details",
    );
    await page.locator("[name=work_on]").fill("2026-11-17");
    await page.locator("[data-ops-form] [type=submit]").click();
    await saved(page);
    check(
      (await page.evaluate(() =>
        window.calls.filter((c) => c.name === "bk_ops_save").at(-1).args.p_data
      )).project_id === "33333333-3333-4333-8333-333333333333",
      "editing links searched project without editing promises",
    );
    await click(page, "staff-capacity");
    check(
      await page.locator("[name=weekly_hours]").getAttribute("max") === "168",
      "weekly availability bound matches DB",
    );
    await click(page, "cancel");
    check(
      await page.locator("body").evaluate((e) => e.scrollWidth <= innerWidth),
      "capacity fits viewport",
    );
    await page.evaluate(async () => {
      await window.ops.mountOperationsView(document.querySelector("#test"), {
        ...window.testOptions,
        view: "retainers",
      });
    });
    await click(page, "new-retainer");
    await page.locator("[name=name]").fill("Social content plan");
    await page.locator("[name=monthly_amount]").fill("900");
    await page.locator("[name=allowances]").fill("Reels | 4\nPhotos | 20");
    await page.locator("[name=contact_query]").fill("Synthetic");
    await click(page, "contacts");
    await click(page, "choose-contact");
    check(
      await page.locator("[name=name]").inputValue() === "Social content plan",
      "client selection preserves package draft",
    );
    await page.locator("[name=status]").selectOption("active");
    await page.locator("[data-ops-form] [type=submit]").click();
    await saved(page);
    const packageData = await page.evaluate(() =>
      window.calls.filter((c) => c.name === "bk_ops_save").at(-1).args.p_data
    );
    check(
      packageData.monthly_amount_cents === 90000 &&
        packageData.allowances.length === 2 && packageData.contact_id,
      "package saves client, monthly price and deliverables",
    );
    await click(page, "open");
    await page.locator("[name=month]").fill("2026-12");
    await page.locator("[data-ops-form] [type=submit]").click();
    await saved(page);
    const openData = await page.evaluate(() =>
      window.calls.filter((c) => c.name === "bk_ops_save").at(-1).args.p_data
    );
    check(
      openData.period_month === "2026-12-01" && !openData.project_id,
      "monthly package can open a new linked work project directly",
    );
    await click(page, "edit-retainer");
    check(
      await page.locator("[name=billing_provider]").isDisabled(),
      "existing period locks package provider",
    );
    await click(page, "cancel");
    check(
      await page.locator("body").evaluate((e) => e.scrollWidth <= innerWidth),
      "package view fits viewport",
    );
    await page.evaluate(async () => {
      await window.ops.mountPortalRetainers(document.querySelector("#test"), {
        rpc: window.testOptions.rpc,
        projectId: "project",
        token: "token",
      });
    });
    check(
      await page.getByText("Your monthly deliverables", { exact: true })
        .count() === 1,
      "client portal shows monthly included and remaining allowances",
    );
    check(
      await page.locator("[data-ops-action]").count() === 0,
      "client allowances expose no staff controls",
    );
    for (const state of ["expired", "upcoming", "closed"]) {
      await page.evaluate(async (state) => {
        window.periodState = state;
        await window.ops.mountPortalRetainers(document.querySelector("#test"), {
          rpc: window.testOptions.rpc,
          projectId: "project",
          token: "token",
        });
      }, state);
      check(
        await page.locator(`[data-period-state="${state}"]`).count() === 1,
        `client portal labels ${state} period`,
      );
      check(
        await page.locator(".ops-table tbody tr td:last-child").first()
          .textContent().then((s) => s.trim() === "0"),
        `${state} client allowance shows zero available now`,
      );
    }
    await page.evaluate(async () => {
      window.testOptions.project = {
        id: "33333333-3333-4333-8333-333333333333",
        contact_id: "44444444-4444-4444-8444-444444444444",
        title: "November Campaign",
        client_name: "Synthetic Customer",
      };
      window.periodState = "expired";
      await window.ops.mountOperations(
        document.querySelector("#test"),
        window.testOptions,
      );
    });
    check(
      await page.locator('[data-ops-action="use"]').count() === 0 &&
        await page.locator('[data-ops-action="return"]').count() > 0,
      "expired staff period hides new fulfillment and keeps historical corrections",
    );
    check(
      await page.getByText(/This month has expired/).count() > 0,
      "expired staff period explains current-month action",
    );
    await page.evaluate(() => {
      window.testOptions.project = undefined;
      window.periodState = "open";
    });
    await page.evaluate(async () => {
      window.portalEmpty = true;
      await window.ops.mountPortalRetainers(document.querySelector("#test"), {
        rpc: window.testOptions.rpc,
        projectId: "project",
        token: "token",
      });
    });
    check(
      await page.locator("#test").isHidden(),
      "portal hides empty retainer section",
    );
    await page.evaluate(async () => {
      window.failReads = true;
      await window.ops.mountPortalRetainers(document.querySelector("#test"), {
        rpc: window.testOptions.rpc,
        projectId: "project",
        token: "token",
      });
    });
    check(
      await page.getByText(/Monthly allowances are unavailable/).isVisible(),
      "portal read failure is honest, never false zero",
    );
    await page.evaluate(async () => {
      window.failReads = false;
      await window.ops.mountOperationsView(document.querySelector("#test"), {
        ...window.testOptions,
        view: "profit",
      });
    });
    check(
      await page.getByText(/Totals cover all 1 matching projects/).isVisible(),
      "profit labels all filtered project totals",
    );
    check(
      await page.locator("body").evaluate((e) => e.scrollWidth <= innerWidth),
      "profit table scrolls within panel on phone",
    );
    await page.evaluate(async () => {
      window.failReads = true;
      await window.ops.mountOperationsView(document.querySelector("#test"), {
        ...window.testOptions,
        view: "capacity",
      });
    });
    check(
      await page.getByRole("alert").filter({ hasText: "Synthetic unavailable" })
        .isVisible(),
      "staff read failure does not show false healthy data",
    );
    await page.evaluate(() => window.failReads = false);
    await click(page, "retry");
    await page.getByText("This week’s editing workload", { exact: true })
      .waitFor();
    mkdirSync("output/playwright", { recursive: true });
    await page.screenshot({
      path: `output/playwright/operations-${width}.png`,
      fullPage: true,
    });
    check(errors.length === 0, `no browser errors: ${errors.join("; ")}`);
    await context.close();
  }
  console.log(
    `operations.e2e: ${checks} checks passed at 1512/390 (synthetic RPC only)`,
  );
} finally {
  await browser?.close();
  server.kill();
}
