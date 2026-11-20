import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Stubbed Open money screen: synthetic rows only, every Supabase request throws.
// SHOTS=<dir> saves stills. HOLD=1 opens a headed window to click through.
const root = fileURLToPath(new URL("..", import.meta.url));
const port = 18761;
const origin = `http://localhost:${port}`;
const server = spawn("python3", ["-m", "http.server", String(port)], {
  cwd: root,
  stdio: "ignore",
});
const hold = Boolean(process.env.HOLD);
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
let browser;
let checks = 0;
function ok(value, message) {
  checks++;
  if (!value) throw Error(message);
}

const PAGE =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open money test</title>' +
  '<link rel="stylesheet" href="/css/crm-workspace.css"><link rel="stylesheet" href="/css/crm-open-money.css">' +
  '<style>body{background:var(--paper);color:var(--paper-ink)}.workspace{padding:24px 16px;max-width:1180px;margin:0 auto}</style>' +
  '<main class="workspace"><div id="money"></div><div id="line"></div></main><div id="toast" class="toast" role="status"></div>';

async function mount(page) {
  await page.evaluate(async () => {
    const money = await import("/js/crm-open-money.js");
    window.calls = [];
    window.toasts = [];
    window.dirty = [];
    window.saveFails = false;
    const base = {
      project_id: null,
      amount_cents: null,
      step: "decision",
      ball: "client",
      provider: "other",
      link_url: null,
      next_move: null,
      next_move_on: null,
      staged_note: null,
      hold_reason: null,
      sent_on: null,
      due_on: null,
      notes: null,
      first_viewed_at: null,
      last_viewed_at: null,
      view_count: 0,
      closed_at: null,
      outcome: null,
      created_at: "2026-11-10T15:00:00Z",
    };
    let serial = 0;
    const make = (fields) => ({
      ...base,
      id: "00000000-0000-4000-8000-00000000000" + (++serial).toString(16),
      view_key: "k".repeat(28) + String(serial).padStart(4, "0"),
      ...fields,
    });
    window.items = [
      make({
        client_name: "Synthetic Studio Co",
        title: "Brand film proposal",
        amount_cents: 450000,
        ball: "me",
        staged_note: "Follow-up written in a Gmail draft",
        next_move: "Send the follow-up",
        next_move_on: "2026-11-17",
        sent_on: "2026-11-12",
        provider: "honeybook",
        link_url: "https://example.test/proposal",
        project_id: "10000000-0000-4000-8000-000000000001",
      }),
      make({
        client_name: '<img src=x onerror="window.pwned=true">',
        title: "Deposit invoice <b>bold</b>",
        amount_cents: 125050,
        step: "payment",
        due_on: "2026-11-10",
        sent_on: "2026-11-03",
        provider: "ach",
        link_url: "javascript:alert(1)",
      }),
      make({
        client_name: "Synthetic Gallery",
        title: "Website proposal",
        step: "signature",
        view_count: 3,
        last_viewed_at: "2026-11-13T03:30:00Z",
        sent_on: "2026-11-11",
        link_url: "https://example.test/site",
        next_move: "Check in if not signed",
        next_move_on: "2026-11-20",
      }),
      make({
        client_name: "Synthetic Bakery",
        title: "Menu shoot",
        amount_cents: 55000,
        hold_reason: "Owner traveling until December",
        provider: "zelle",
      }),
    ];
    const groupOf = (row) =>
      row.hold_reason
        ? "hold"
        : row.ball === "me" || row.staged_note
        ? "me"
        : row.step === "payment" && row.due_on && row.due_on < "2026-11-17"
        ? "overdue"
        : "client";
    const shape = (row) => ({
      ...row,
      group: groupOf(row),
      overdue: !row.closed_at && row.step === "payment" && Boolean(row.due_on) &&
        row.due_on < "2026-11-17",
      due: Boolean(row.next_move_on) && row.next_move_on <= "2026-11-17",
      days_waiting: row.sent_on
        ? Math.round((Date.parse("2026-11-17") - Date.parse(row.sent_on)) / 864e5)
        : null,
    });
    const order = ["me", "overdue", "client", "hold"];
    window.board = (show) => {
      const open = window.items.filter((row) => !row.closed_at).map(shape);
      const rows = show === "closed"
        ? window.items.filter((row) => row.closed_at).map(shape)
          .sort((a, b) => b.closed_at.localeCompare(a.closed_at))
        : open.slice().sort((a, b) =>
          order.indexOf(a.group) - order.indexOf(b.group)
        );
      const count = (fn) => open.filter(fn).length;
      return {
        day: "2026-11-17",
        show,
        totals: {
          open_cents: open.reduce((sum, row) => sum + (row.amount_cents || 0), 0),
          items: open.length,
          unpriced: count((row) => row.amount_cents === null),
          me: count((row) => row.group === "me"),
          overdue: count((row) => row.group === "overdue"),
          hold: count((row) => row.group === "hold"),
          viewed_waiting: count((row) =>
            row.group === "client" && row.step !== "payment" && row.view_count > 0
          ),
        },
        rows,
      };
    };
    let clock = 0;
    window.rpc = async (name, args) => {
      window.calls.push({ name, args: structuredClone(args) });
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (name === "bk_money_board") return window.board(args.p_show);
      if (name === "bk_money_save") {
        if (window.saveFails) {
          window.saveFails = false;
          throw Error("Connection interrupted");
        }
        const item = args.p_item;
        if (item.id) {
          const row = window.items.find((r) => r.id === item.id);
          Object.assign(row, item);
          return row;
        }
        const row = make(item);
        window.items.push(row);
        return row;
      }
      if (name === "bk_money_close") {
        const row = window.items.find((r) => r.id === args.p_id);
        row.closed_at = "2026-11-17T16:00:0" + (++clock) + "Z";
        row.outcome = args.p_outcome;
        return row;
      }
      if (name === "bk_money_reopen") {
        const row = window.items.find((r) => r.id === args.p_id);
        row.closed_at = null;
        row.outcome = null;
        return row;
      }
      throw Error("Unexpected RPC " + name);
    };
    const toastEl = document.querySelector("#toast");
    const context = {
      rpc: (name, args) => window.rpc(name, args),
      toast: (message) => {
        window.toasts.push(message);
        toastEl.textContent = message;
        toastEl.classList.add("show");
      },
      onDirty: (value) => window.dirty.push(value),
      openProject: (id) => window.openedProject = id,
    };
    window.context = context;
    window.money = money;
    money.mountOpenMoney(document.querySelector("#money"), context);
    money.mountOpenMoneyLine(document.querySelector("#line"), context);
  });
  await page.locator("#money .money-group").first().waitFor();
  await page.locator("#line a").waitFor();
}

try {
  await new Promise((resolve) => setTimeout(resolve, 500));
  browser = await chromium.launch({
    ...(process.env.PW_CHROME
      ? {
        executablePath:
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      }
      : {}),
    headless: !hold,
  });
  for (const width of hold ? [1512] : [1512, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      serviceWorkers: "block",
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin,
    });
    await context.route("**/__money_test", (route) =>
      route.fulfill({ contentType: "text/html", body: PAGE }));
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
    await page.goto(origin + "/__money_test");
    await mount(page);
    ok(
      await page.evaluate(() => window.dirty[0] === false),
      "mounting clears a stale unsaved-changes flag",
    );

    if (hold) {
      console.log("open-money preview: stubbed screen open at 1512px. Close the browser to finish.");
      await new Promise((resolve) => browser.on("disconnected", resolve));
      break;
    }

    const money = page.locator("#money");
    // 1. group order
    const headings = await money.locator(".money-group h2").allTextContents();
    ok(
      headings.map((t) => t.replace(/^\d+/, "").replace(/\s*\d+$/, "").trim()).join("|") ===
        "Your move|Overdue|Waiting on the client|On hold",
      "groups in order: " + headings.join("|"),
    );
    // 2. hostile text stays text
    ok(!await page.evaluate(() => window.pwned), "client text is escaped");
    ok(
      await money.locator('a[href^="javascript"]').count() === 0,
      "no javascript: link",
    );
    ok(
      (await money.textContent()).includes('<img src=x onerror="window.pwned=true">'),
      "hostile name shows as plain text",
    );
    const hostile = money.locator(".money-row", { hasText: "Deposit invoice" });
    ok(
      await hostile.locator("text=Open link").count() === 0,
      "a non-https link gets no Open link button",
    );
    // 3. totals and the honest note
    const totals = await money.locator(".money-totals").textContent();
    ok(
      totals.includes("$6,300.50") && totals.includes("4 items") &&
        totals.includes("1 not priced yet") && /Your move\s*1/.test(totals) &&
        /Overdue\s*1/.test(totals) && /Viewed and waiting\s*1/.test(totals),
      "totals: " + totals,
    );
    ok(
      await money.getByText(
        "You keep this list by hand. Nothing here is pulled from HoneyBook, your email or your bank.",
      ).isVisible(),
      "honest note",
    );
    ok(
      await money.locator(".money-staged", { hasText: "Written, not sent" })
        .filter({ hasText: "Gmail draft" }).isVisible(),
      "staged note box",
    );
    ok(
      await money.locator(".money-hold", { hasText: "Owner traveling" }).isVisible(),
      "hold reason",
    );
    ok(
      (await money.locator(".money-row", { hasText: "Synthetic Gallery" }).textContent())
        .includes("Sent 6 days ago · Viewed 3 times, last Nov 12"),
      "facts line",
    );
    // Project button
    await money.locator(".money-row", { hasText: "Synthetic Studio Co" })
      .getByRole("button", { name: "Project" }).click();
    ok(
      await page.evaluate(() => window.openedProject) ===
        "10000000-0000-4000-8000-000000000001",
      "project button opens the linked project",
    );
    const link = money.locator(".money-row", { hasText: "Synthetic Studio Co" })
      .getByRole("link", { name: "Open link" });
    ok(
      await link.getAttribute("href") === "https://example.test/proposal" &&
        await link.getAttribute("target") === "_blank" &&
        (await link.getAttribute("rel")).includes("noopener"),
      "open link is safe",
    );

    if (shots) {
      await page.screenshot({ path: `${shots}/open-money-${width}.png`, fullPage: true });
    }

    // 4. add with only the two required fields; first save fails, retry succeeds
    await money.getByRole("button", { name: "+ Add" }).click();
    const form = money.locator("form.money-form");
    await form.waitFor();
    await form.locator('[name="client_name"]').fill("Synthetic New Client");
    await form.locator('[name="title"]').fill("Synthetic headshot quote");
    ok(
      await page.evaluate(() => window.dirty.includes(true)),
      "typing marks the screen dirty",
    );
    if (shots) {
      await form.screenshot({ path: `${shots}/open-money-form-${width}.png` });
    }
    await page.evaluate(() => window.saveFails = true);
    await form.getByRole("button", { name: "Save" }).click();
    await form.locator('[role="alert"]', {
      hasText: "That didn't save. Nothing was changed. Try again.",
    }).waitFor();
    ok(
      await form.locator('[name="client_name"]').inputValue() ===
        "Synthetic New Client" &&
        await form.getByRole("button", { name: "Save" }).isEnabled(),
      "failed save keeps what was typed and can be retried",
    );
    await form.getByRole("button", { name: "Save" }).click();
    await money.locator(".money-row", { hasText: "Synthetic headshot quote" }).waitFor();
    const saves = await page.evaluate(() =>
      window.calls.filter((call) => call.name === "bk_money_save")
    );
    ok(
      saves.length === 2 && saves[0].args.p_request_id === saves[1].args.p_request_id,
      "a retried save reuses its request id",
    );
    ok(
      saves[1].args.p_item.amount_cents === null && !("id" in saves[1].args.p_item),
      "blank amount is sent as not priced",
    );
    ok(
      await page.evaluate(() => window.toasts.at(-1) === "Saved." && window.dirty.at(-1) === false),
      "saved toast and clean state",
    );
    ok(await money.locator("form.money-form").count() === 0, "form closes after save");

    // 5. a bad amount never leaves the browser
    await money.getByRole("button", { name: "+ Add" }).click();
    await form.locator('[name="client_name"]').fill("Synthetic Typo");
    await form.locator('[name="title"]').fill("Typo quote");
    await form.locator('[name="amount"]').fill("abc");
    const before = await page.evaluate(() => window.calls.length);
    await form.getByRole("button", { name: "Save" }).click();
    await form.locator('[role="alert"]', {
      hasText: "That amount doesn't look right. Use numbers, like 2,500.",
    }).waitFor();
    ok(
      await page.evaluate(() => window.calls.length) === before,
      "an invalid amount makes no call",
    );
    await form.getByRole("button", { name: "Cancel" }).click();
    ok(
      await money.locator("form.money-form").count() === 0 &&
        await page.evaluate(() => window.dirty.at(-1) === false),
      "cancel closes the form",
    );

    // 6. edit
    const gallery = money.locator(".money-row", { hasText: "Synthetic Gallery" });
    await gallery.getByRole("button", { name: "Edit" }).click();
    ok(
      await form.locator('[name="title"]').inputValue() === "Website proposal" &&
        await form.locator('[name="step"]').inputValue() === "signature",
      "edit opens filled in",
    );
    await form.locator('[name="title"]').fill("Website proposal, revised");
    await form.locator('[name="amount"]').fill("$2,500");
    await form.getByRole("button", { name: "Save" }).click();
    await money.locator(".money-row", { hasText: "Website proposal, revised" }).waitFor();
    const edit = await page.evaluate(() =>
      window.calls.filter((call) => call.name === "bk_money_save").at(-1).args.p_item
    );
    ok(
      edit.id && edit.amount_cents === 250000 && edit.link_url === "https://example.test/site",
      "edit sends the id, parsed amount and kept fields",
    );

    // 7. close out, show closed, reopen
    const revised = money.locator(".money-row", { hasText: "Website proposal, revised" });
    await revised.getByRole("button", { name: "Close out" }).click();
    ok(
      await revised.getByText(
        "This closes the reminder. It does not record a payment on a project.",
      ).isVisible(),
      "close out explains itself",
    );
    await revised.getByRole("button", { name: "Paid" }).click();
    await money.locator(".money-row", { hasText: "Website proposal, revised" })
      .waitFor({ state: "detached" });
    ok(await page.evaluate(() => window.toasts.at(-1) === "Closed out."), "closed toast");
    await money.getByRole("button", { name: "Show closed" }).click();
    const closedRow = money.locator(".money-row", { hasText: "Website proposal, revised" });
    await closedRow.waitFor();
    ok((await closedRow.textContent()).includes("Paid"), "closed list shows the outcome");
    await closedRow.getByRole("button", { name: "Reopen" }).click();
    await page.waitForFunction(() => window.toasts.at(-1) === "Reopened.");
    await money.getByRole("button", { name: "Show open" }).click();
    await money.locator(".money-row", { hasText: "Website proposal, revised" }).waitFor();

    // 7b. an open form survives work on other rows
    await money.getByRole("button", { name: "+ Add" }).click();
    await form.locator('[name="client_name"]').fill("Synthetic Half Typed");
    const headshot = money.locator(".money-row", { hasText: "Synthetic headshot quote" });
    await headshot.getByRole("button", { name: "Close out" }).click();
    await headshot.getByRole("button", { name: "Dropped" }).click();
    await money.locator(".money-row", { hasText: "Synthetic headshot quote" })
      .waitFor({ state: "detached" });
    ok(
      await form.locator('[name="client_name"]').inputValue() ===
        "Synthetic Half Typed",
      "closing another row keeps the typed form",
    );
    await money.locator(".money-row", { hasText: "Synthetic Bakery" })
      .getByRole("button", { name: "Edit" }).click();
    await form.locator('[role="alert"]', {
      hasText: "Save or cancel this first.",
    }).waitFor();
    ok(
      await form.locator('[name="client_name"]').inputValue() ===
        "Synthetic Half Typed",
      "Edit on another row does not throw away typed text",
    );
    await money.getByRole("button", { name: "Show closed" }).click();
    ok(
      await form.locator('[name="client_name"]').inputValue() ===
        "Synthetic Half Typed" &&
        await money.getByRole("button", { name: "Show closed" }).count() === 1,
      "Show closed waits while a form has typed text",
    );
    await form.getByRole("button", { name: "Cancel" }).click();

    // 8. copy tracking code
    const key = await page.evaluate(() =>
      window.items.find((row) => row.client_name === "Synthetic Bakery").view_key
    );
    await money.locator(".money-row", { hasText: "Synthetic Bakery" })
      .getByRole("button", { name: "Copy tracking code" }).click();
    await page.waitForFunction(() =>
      window.toasts.at(-1) ===
        "Copied. Paste it just before </body> on the proposal page."
    );
    const expected = await page.evaluate(
      async (key) => (await import("/js/crm-open-money-view.js")).trackingTag(key),
      key,
    );
    ok(
      await page.evaluate(() => navigator.clipboard.readText()) === expected,
      "clipboard holds the exact tracking tag",
    );

    // 9. phone fit
    if (width === 390) {
      ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= 390),
        "no sideways scroll on a phone",
      );
      await money.getByRole("button", { name: "+ Add" }).click();
      await form.locator("details summary").click();
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("#money button, #money a.btn, #money summary")]
          .filter((el) => el.offsetParent !== null)
          .filter((el) => el.getBoundingClientRect().height < 44)
          .map((el) => el.textContent.trim())
      );
      ok(small.length === 0, "touch targets at least 44px: " + small.join(", "));
      ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= 390),
        "the open form fits a phone",
      );
      await form.getByRole("button", { name: "Cancel" }).click();
    }

    // 10. the Today line
    const line = page.locator("#line a");
    ok(
      (await line.textContent()).replace(/\s+/g, " ").trim() ===
        "Open money: $6,300.50 across 4 items · 1 your move · 1 overdue",
      "today line at mount: " + await line.textContent(),
    );
    await page.evaluate(() =>
      window.money.mountOpenMoneyLine(document.querySelector("#line"), window.context)
    );
    ok(
      (await line.getAttribute("href")).endsWith("?view=money") &&
        (await line.textContent()).replace(/\s+/g, " ").trim() ===
          "Open money: $8,800.50 across 4 items · 1 your move · 1 overdue",
      "today line: " + await line.textContent(),
    );
    await page.evaluate(async () => {
      for (const row of window.items) row.closed_at = "2026-11-17T17:00:00Z";
      const el = document.querySelector("#line");
      await window.money.mountOpenMoneyLine(el, window.context);
    });
    ok(await page.locator("#line").innerHTML() === "", "an empty board hides the line");
    await page.evaluate(async () => {
      const el = document.querySelector("#line");
      window.rpc = async () => {
        throw Error("offline");
      };
      await window.money.mountOpenMoneyLine(el, window.context);
    });
    ok(await page.locator("#line").innerHTML() === "", "a failed load hides the line");

    // 11. no runtime errors
    ok(errors.length === 0, "no page errors: " + errors.join("; "));
    await context.close();
  }
  if (!hold) {
    console.log(
      `open-money.e2e: ${checks} checks passed at 1512 and 390; synthetic data, no live requests`,
    );
  }
} finally {
  await browser?.close();
  server.kill();
}
