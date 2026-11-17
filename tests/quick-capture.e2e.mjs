import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { stubCRM } from "./fixtures/crm-workspace-fixture.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 18757;
const base = `http://localhost:${port}/crm/`;
const server = spawn("python3", ["-m", "http.server", String(port)], {
  cwd: root,
  stdio: "ignore",
});
await new Promise((resolve) => setTimeout(resolve, 600));
let browser;
let checks = 0;
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
      (route) => route.fulfill({ body: "" }),
    );
    await context.route(
      "**/supabase.min.js",
      (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: `
      (${stubCRM.toString()})();
      const originalCreate = window.supabase.createClient;
      window.supabase.createClient = (...values) => {
        const client = originalCreate(...values), originalRPC = client.rpc.bind(client);
        client.rpc = async (name, args) => {
          if (name !== 'bk_crm_capture_lead') return originalRPC(name, args);
          window.__captures = window.__captures || [];
          window.__captures.push(args.p_data);
          if (window.__failCapture !== false) return { data: null, error: { message: 'Synthetic connection failure' } };
          return originalRPC('bk_crm_create_project', args);
        };
        return client;
      };`,
        }),
    );
    await context.route("**/*.supabase.co/**", (route) => {
      throw Error("Unexpected live request " + route.request().url());
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    const message =
      "Please call +1 (214) 555-0100 or email studio@example.test. Instagram @example_studio";
    await page.goto(
      base + "?capture=1&share_text=" + encodeURIComponent(message),
    );
    await page.locator("#quickCaptureForm").waitFor();
    assert.ok(!page.url().includes("share_text"));
    checks++;
    assert.equal(await page.locator("[name=details]").inputValue(), message);
    checks++;
    assert.equal(
      await page.locator("[name=client_email]").inputValue(),
      "studio@example.test",
    );
    checks++;
    assert.equal(
      await page.locator("[name=instagram]").inputValue(),
      "example_studio",
    );
    checks++;
    await page.locator("[name=client_name]").fill("Synthetic Shared Lead");
    await page.getByRole("button", { name: "Save lead & next action" }).click();
    await page.locator("#quickCaptureForm .form-error").filter({
      hasText: "Synthetic connection failure",
    }).waitFor();
    assert.equal(await page.locator("[name=details]").inputValue(), message);
    checks++;
    const requestId = await page.evaluate(() =>
      window.__captures[0].request_id
    );
    await page.reload();
    await page.locator("#quickCaptureForm").waitFor();
    assert.equal(
      await page.locator("[name=client_name]").inputValue(),
      "Synthetic Shared Lead",
    );
    checks++;
    await page.evaluate(() => window.__failCapture = false);
    await page.getByRole("button", { name: "Save lead & next action" }).click();
    await page.waitForURL(/p=10000000/);
    assert.equal(
      await page.evaluate(() => window.__captures[0].request_id),
      requestId,
    );
    checks++;
    assert.equal(await page.evaluate(() => window.__crm.projects.length), 2);
    checks++;
    await page.locator("[data-view=capture]").click();
    await page.locator("#quickCaptureForm").waitFor();
    assert.equal(await page.locator("[name=details]").inputValue(), "");
    checks++;
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.scrollWidth > innerWidth
      ),
      false,
    );
    checks++;
    await page.locator("[name=client_name]").fill("Earlier Synthetic Lead");
    await page.locator("[name=client_email]").fill("earlier@example.test");
    await page.locator("[name=details]").fill("Keep this earlier conversation");
    await page.evaluate(() => window.__failCapture = true);
    await page.getByRole("button", { name: "Save lead & next action" }).click();
    await page.locator("#quickCaptureForm .form-error").filter({
      hasText: "Synthetic connection failure",
    }).waitFor();
    const earlierRequest = await page.evaluate(() =>
      window.__captures.at(-1).request_id
    );
    const incoming =
      "A separate request from @new_studio <img src=x onerror=window.pwned=1>";
    await page.goto(
      base + "?capture=1&share_text=" + encodeURIComponent(incoming),
    );
    await page.locator("[data-capture-existing]").waitFor();
    await page.locator("[data-capture-existing]").click();
    assert.equal(
      await page.locator("[name=client_name]").inputValue(),
      "Earlier Synthetic Lead",
    );
    assert.equal(
      await page.locator("[name=details]").inputValue(),
      "Keep this earlier conversation",
    );
    checks += 2;
    await page.goto(base + "?capture=1");
    await page.locator("[data-capture-incoming]").click();
    assert.equal(await page.locator("[name=client_name]").inputValue(), "");
    assert.equal(await page.locator("[name=client_email]").inputValue(), "");
    assert.equal(await page.locator("[name=details]").inputValue(), incoming);
    assert.equal(
      await page.locator("[name=instagram]").inputValue(),
      "new_studio",
    );
    checks += 4;
    await page.locator("[name=client_name]").fill("New Synthetic Lead");
    await page.evaluate(() => window.__failCapture = false);
    await page.getByRole("button", { name: "Save lead & next action" }).click();
    await page.waitForURL(/p=10000000/);
    await page.locator("[data-view=capture]").click();
    await page.locator("#quickCaptureForm").waitFor();
    await page.locator("[data-capture-restore]").click();
    assert.equal(
      await page.locator("[name=client_name]").inputValue(),
      "Earlier Synthetic Lead",
    );
    assert.equal(
      await page.locator("[name=client_email]").inputValue(),
      "earlier@example.test",
    );
    assert.equal(await page.evaluate(() => Boolean(window.pwned)), false);
    checks += 3;
    await page.getByRole("button", { name: "Save lead & next action" }).click();
    await page.waitForURL(/p=10000000/);
    assert.equal(
      await page.evaluate(() => window.__captures.at(-1).request_id),
      earlierRequest,
    );
    checks++;
    assert.deepEqual(errors, []);
    checks++;
    await context.close();
  }
  console.log(`quick-capture.e2e: ${checks} checks passed`);
} finally {
  await browser?.close();
  server.kill();
}
