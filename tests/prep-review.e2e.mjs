// Synthetic, intercepted browser tests. No live client records, messages or payments.
import { chromium, webkit } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const directory = fileURLToPath(new URL("..", import.meta.url));
const base = "http://127.0.0.1:18760";
const server = spawn(
  "python3",
  ["-m", "http.server", "18760", "--bind", "127.0.0.1"],
  { cwd: directory, stdio: "ignore" },
);
const shots = new URL("../output/prep-review/", import.meta.url);
mkdirSync(shots, { recursive: true });
let browser,
  checks = 0;
const check = (value, message) => {
  assert.ok(value, message);
  checks++;
};
const copy = (value) => structuredClone(value);
const questions = [
  {
    id: "goal",
    label: "What should this campaign achieve?",
    type: "long",
    required: true,
  },
  {
    id: "rights",
    label: "I have permission to use the supplied assets.",
    type: "check",
    required: true,
  },
];
const prep = () => ({
  id: "prep-one",
  version: "prep-version-one",
  revision: 1,
  title: "Brand content preparation",
  instructions: "Share the details before our shoot.",
  status: "published",
  questions,
  answers: {},
  answer_revision: 0,
  total_required: 2,
  completed_required: 0,
  current: true,
  feedback: "",
});
const review = () => ({
  id: "review-one",
  version: "review-version-one",
  revision: 1,
  item_id: "video-one",
  gallery_id: "gallery-one",
  media_revision: "media-one",
  asset_key: "opaque-preview-one",
  media_scope: "preview",
  title: "Campaign film · first cut",
  status: "published",
  current: true,
  notes_revision: 0,
  notes: [],
});
async function noOverflow(page) {
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "content stays within viewport",
  );
}

async function staffTest(engine, name) {
  const page = await engine.newPage({
    viewport: { width: 1512, height: 1080 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/__staff-prep", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><link rel="stylesheet" href="/css/crm-workspace.css"><link rel="stylesheet" href="/css/crm-client-experience.css"><main style="background:var(--paper);padding:32px;max-width:1100px;margin:auto"><h1 style="color:var(--paper-ink)">Synthetic campaign</h1><div id="feature"></div></main>',
    }),
  );
  await page.goto(base + "/__staff-prep");
  await page.evaluate(
    async ({ questions, prep, review }) => {
      window.calls = [];
      window.dirty = false;
      window.outerSubmits = 0;
      window.fail = true;
      document.addEventListener("submit", () => window.outerSubmits++);
      const state = (window.staffState = {
        prep_defaults: {
          title: "Brand content preparation",
          instructions: "Share the production details.",
          questions,
        },
        preparations: [],
        video_items: [
          {
            id: "video-one",
            gallery_id: "gallery-one",
            gallery_title: "Campaign film",
            filename: "First cut.mp4",
            client_scope: "preview",
          },
        ],
        reviews: [
          {
            ...review,
            status: "changes",
            notes: [
              {
                id: "note-one",
                revision: 1,
                at_seconds: 12.25,
                body: "Shorten this hold.",
                resolved_at: null,
              },
            ],
          },
        ],
      });
      const rpc = async (name, args) => {
        window.calls.push({ name, args: structuredClone(args) });
        if (name === "bk_crm_client_experience") {
          if (window.failRead) throw Error("offline");
          return structuredClone(state);
        }
        if (window.fail) {
          window.fail = false;
          throw Error("offline");
        }
        if (name === "bk_crm_prep_save") {
          const saved = {
            ...prep,
            ...args.p_data,
            id: "prep-one",
            status: "draft",
            current: false,
          };
          state.preparations = [saved];
          return structuredClone(saved);
        }
        if (name === "bk_crm_prep_publish") {
          Object.assign(state.preparations[0], {
            status: "published",
            current: true,
          });
          return structuredClone(state.preparations[0]);
        }
        if (name === "bk_crm_prep_review") {
          Object.assign(state.preparations[0], {
            status: "reviewed",
            feedback: args.p_feedback,
          });
          return structuredClone(state.preparations[0]);
        }
        if (name === "bk_crm_video_resolve") {
          const note = state.reviews[0].notes[0];
          note.resolved_at = args.p_resolved ? "2026-11-16T12:00:00Z" : null;
          note.revision++;
          return structuredClone(note);
        }
        if (name === "bk_crm_video_publish") return { ...review, revision: 2 };
        throw Error(name);
      };
      const module = await import("/js/crm-client-experience.js");
      window.feature = await module.mountClientExperience(
        document.querySelector("#feature"),
        {
          rpc,
          project: { id: "synthetic-project" },
          onDirty: (value) => (window.dirty = value),
        },
      );
    },
    { questions, prep: prep(), review: review() },
  );
  await page.getByRole("button", { name: "Use service checklist" }).click();
  const title = page.locator('[data-ce-form="prep"] input[name="title"]');
  await title.fill("Campaign preparation, revised");
  check(
    await page.evaluate(() => window.dirty),
    "staff preparation marks unsaved state",
  );
  await page.getByRole("button", { name: "Save and publish" }).click();
  await page.locator("#feature > .ce-error").waitFor();
  check(
    (await title.inputValue()) === "Campaign preparation, revised",
    "failed staff save preserves draft",
  );
  const firstNonce = await page.evaluate(
    () =>
      window.calls.find((c) => c.name === "bk_crm_prep_save").args.p_data
        .request_id,
  );
  await page.getByRole("button", { name: "Save and publish" }).click();
  await page.locator(".ce-current").waitFor();
  check(
    await page.evaluate(() =>
      window.calls
        .filter((c) => c.name === "bk_crm_prep_save")
        .every(
          (c) =>
            c.args.p_data.request_id ===
            window.calls.find((c) => c.name === "bk_crm_prep_save").args.p_data
              .request_id,
        ),
    ),
    "staff retry retains request identity",
  );
  check(
    Boolean(firstNonce) && !(await page.evaluate(() => window.dirty)),
    "successful publish clears staff dirty state",
  );
  check(
    (await page.evaluate(() => window.outerSubmits)) === 0,
    "scoped submit does not reach global CRM handler",
  );
  await page.evaluate(async () => {
    Object.assign(window.staffState.preparations[0], {
      status: "submitted",
      answers: { goal: "Launch our campaign.", rights: true },
      completed_required: 2,
    });
    await window.feature.reload();
  });
  await page
    .locator('[name="feedback"]')
    .fill("Bring the alternate product packaging.");
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await page.getByRole("button", { name: "Reopen", exact: true }).waitFor();
  check(
    (await page.locator('[name="feedback"]').inputValue()) ===
      "Bring the alternate product packaging.",
    "resolving a video note preserves unsaved preparation feedback",
  );
  await page.evaluate(async () => {
    window.failRead = true;
    await window.feature.reload();
  });
  check(
    (await page.locator('[name="feedback"]').inputValue()) ===
      "Bring the alternate product packaging.",
    "failed staff reload preserves feedback",
  );
  await page.evaluate(() => (window.failRead = false));
  await page.getByRole("button", { name: "Mark preparation reviewed" }).click();
  await page.getByText("Review feedback:", { exact: false }).waitFor();
  check(
    !(await page.evaluate(() => window.dirty)),
    "reviewed preparation clears feedback dirty state",
  );
  const colors = await page
    .locator(".ce-section")
    .first()
    .evaluate((el) => ({
      text: getComputedStyle(el).color,
      bg: getComputedStyle(el.closest("main")).backgroundColor,
    }));
  check(
    colors.text === "rgb(19, 19, 21)" && colors.bg === "rgb(245, 242, 235)",
    "staff content uses readable ink on paper",
  );
  await noOverflow(page);
  await page.screenshot({
    path: fileURLToPath(new URL(`staff-${name}.png`, shots)),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(page);
  check(
    errors.length === 0,
    "staff module has no runtime exceptions: " + errors.join(", "),
  );
  await page.close();
}

async function portalTest(engine, name, width) {
  const state = {
    prep: prep(),
    reviews: [review()],
    calls: [],
    failPrep: true,
    failNote: true,
    failDecision: true,
    failRead: false,
    hidden: false,
    playerRevision: "media-one",
    playerKey: "opaque-preview-one",
  };
  const page = await engine.newPage({ viewport: { width, height: 1080 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://fonts.googleapis.com/**", (route) =>
    route.fulfill({ body: "", contentType: "text/css" }),
  );
  await page.route("https://preview.example.test/**", (route) =>
    route.fulfill({ body: Buffer.alloc(0), contentType: "video/mp4" }),
  );
  await page.route("**/rest/v1/rpc/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    const args = route.request().postDataJSON() || {};
    state.calls.push({ name, args: copy(args) });
    const reply = (json) => route.fulfill({ json });
    const reject = (message) =>
      route.fulfill({ status: 409, json: { message } });
    if (name === "bk_extra_edit_cents") return reply(0);
    if (
      args.p_project !== "synthetic-project" ||
      args.p_token !== "synthetic-token"
    )
      return reject("not_found");
    if (name === "bk_portal")
      return reply({
        project: {
          id: args.p_project,
          title: "Synthetic Client — Campaign film",
          client_name: "Synthetic Client",
          service: "brand_content",
          status: "in_production",
          event_date: null,
        },
        invoices: [
          {
            id: "invoice-one",
            status: "sent",
            title: "Final balance",
            amount_cents: 75000,
            kind: "balance",
          },
        ],
        messages: [],
        contracts: [],
        files: [],
      });
    if (name === "bk_crm_portal_billing")
      return reply({ billing_provider: "stripe", paid_amounts: [] });
    if (["bk_crm_portal_quotes", "bk_ops_portal_retainers"].includes(name))
      return reply({ rows: [] });
    if (name === "bk_portal_preparation")
      return state.failRead
        ? reject("offline")
        : reply({ current: state.prep, history: [] });
    if (name === "bk_portal_prep_save") {
      if (state.failPrep) {
        state.failPrep = false;
        return reject("offline");
      }
      if (args.p_answer_revision !== state.prep.answer_revision)
        return reject("answers_changed");
      if (
        args.p_submit &&
        (!args.p_answers.goal?.trim() || args.p_answers.rights !== true)
      )
        return reject("required_answers_missing");
      Object.assign(state.prep, {
        answers: args.p_answers,
        answer_revision: state.prep.answer_revision + 1,
        status: args.p_submit ? "submitted" : "published",
      });
      return reply(state.prep);
    }
    if (name === "bk_portal_video_reviews")
      return reply({ rows: state.hidden ? [] : state.reviews });
    if (name === "bk_portal_video_note") {
      if (state.failNote) {
        state.failNote = false;
        return reject("offline");
      }
      const r = state.reviews.find((r) => r.id === args.p_review);
      if (r.version !== args.p_version || r.status !== "published")
        return reject("superseded");
      r.notes.push({
        id: "note-one",
        at_seconds: args.p_at_seconds,
        body: args.p_body,
        revision: 1,
        resolved_at: null,
      });
      r.notes_revision++;
      return reply(r.notes.at(-1));
    }
    if (name === "bk_portal_video_decide") {
      if (state.failDecision) {
        state.failDecision = false;
        return reject("offline");
      }
      const r = state.reviews.find((r) => r.id === args.p_review);
      if (
        args.p_notes_revision !== r.notes_revision ||
        args.p_version !== r.version
      )
        return reject("notes_changed");
      Object.assign(r, { status: args.p_decision, approved_by: args.p_signer });
      return reply(r);
    }
    return reject("unexpected_rpc_" + name);
  });
  await page.route("**/functions/v1/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    const args = route.request().postDataJSON() || {};
    state.calls.push({ name, args });
    assert.equal(name, "bk-media", "test must never invoke checkout or mail");
    return route.fulfill({
      json: {
        projects: [
          {
            id: "synthetic-project",
            title: "Campaign film",
            galleries: [
              {
                id: "gallery-one",
                kind: "video",
                title: "Campaign film",
                locked: false,
                held: true,
                preview_closed: state.hidden,
                unlock: {
                  invoice_id: "invoice-one",
                  amount_cents: 75000,
                  paid: false,
                  payable: true,
                },
                items: [
                  {
                    id: "video-one",
                    gallery_id: "gallery-one",
                    filename: "Campaign first cut.mp4",
                    url: state.hidden
                      ? null
                      : "https://preview.example.test/watermarked.mp4",
                    download_url: null,
                    media_revision: state.playerRevision,
                    asset_key: state.hidden ? null : state.playerKey,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });
  let navigation = 0;
  const open = async (tab = "details") => {
    await page.goto(
      `${base}/portal.html?p=synthetic-project&t=synthetic-token&load=${++navigation}#${tab}`,
    );
    await page.locator("#app:not([hidden])").waitFor();
    await page.locator("[data-client-prep]").waitFor({ state: "attached" });
  };
  await open();
  const goal = page.locator('[data-answer="goal"]');
  await goal.fill("A thoughtful campaign launch.");
  state.failRead = true;
  await page.evaluate(async () => clientExperience.preparation.reload());
  check(
    (await goal.inputValue()) === "A thoughtful campaign launch.",
    "failed preparation refresh leaves unsaved answers in place",
  );
  check(
    (await page
      .getByText("Preparation could not refresh.", { exact: false })
      .count()) === 1,
    "failed refresh is visible to the client",
  );
  state.failRead = false;
  check(
    (await page.locator(".ce-progress").innerText()).startsWith("1 of 2"),
    "required preparation progress updates",
  );
  await page.getByRole("button", { name: "Save answers", exact: true }).click();
  await page.locator("#clientPreparationRoot > .ce-error").waitFor();
  check(
    (await goal.inputValue()) === "A thoughtful campaign launch.",
    "failed client save retains answer draft",
  );
  state.prep.answer_revision = 1;
  state.prep.answers = { goal: "Saved from another tab.", rights: false };
  await open();
  check(
    (await goal.inputValue()) === "A thoughtful campaign launch.",
    "page reload restores unsaved local answers",
  );
  await page.getByRole("button", { name: "Save answers", exact: true }).click();
  await page
    .getByText("A newer version is available.", { exact: false })
    .waitFor();
  check(
    state.calls.filter((c) => c.name === "bk_portal_prep_save").at(-1).args
      .p_answer_revision === 0,
    "restored draft retains original concurrency revision",
  );
  await page.getByRole("button", { name: "Load latest saved answers" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-answer="goal"]').value ===
      "Saved from another tab.",
  );
  check(
    (await page
      .getByText("Your previous unsaved answers from this device")
      .count()) === 1,
    "loading server copy preserves earlier local draft for comparison",
  );
  await goal.fill("Merged campaign plan.");
  await page
    .getByRole("button", { name: "Submit preparation", exact: true })
    .click();
  await page
    .getByText("Complete every required question", { exact: false })
    .waitFor();
  check(
    (await goal.inputValue()) === "Merged campaign plan.",
    "incomplete submit retains typed answers",
  );
  await page.locator('[data-answer="rights"]').check();
  await page
    .getByRole("button", { name: "Submit preparation", exact: true })
    .click();
  await page
    .getByText("Preparation submitted. Nelson can review your answers.")
    .waitFor();
  check(await goal.isDisabled(), "submitted preparation is read-only");
  await page.screenshot({
    path: fileURLToPath(new URL(`portal-prep-${name}-${width}.png`, shots)),
    fullPage: true,
  });
  await noOverflow(page);
  await page.locator("#tab-photos").click();
  await page.locator("[data-video-note]").waitFor();
  check(
    (await page.locator(".g-video video").getAttribute("src")) ===
      "https://preview.example.test/watermarked.mp4",
    "review uses existing entitlement-filtered preview player",
  );
  check(
    (await page
      .locator(".g-video a[download], .g-video .g-save, .g-video .g-dl")
      .count()) === 0,
    "review does not add a held clean download",
  );
  await page.locator(".g-video video").evaluate((el) =>
    Object.defineProperty(el, "currentTime", {
      value: 12.25,
      configurable: true,
    }),
  );
  await page.getByRole("button", { name: "Use current playhead" }).click();
  check(
    (await page.locator('[name="at"]').inputValue()) === "0:12.25",
    "playhead capture preserves subsecond timestamp",
  );
  await page
    .locator('[name="body"]')
    .fill("Cut before the product turn. <img src=x onerror=window.pwned=1>");
  await page.getByRole("button", { name: "Save timestamp note" }).click();
  await page.locator(".ce-video-review > .ce-error").waitFor();
  const request = state.calls
    .filter((c) => c.name === "bk_portal_video_note")
    .at(-1).args.p_request_id;
  await open("photos");
  await page.locator("[data-video-note]").waitFor();
  check(
    (await page.locator('[name="body"]').inputValue()).startsWith("Cut before"),
    "note draft survives failed save and page reload",
  );
  await page.getByRole("button", { name: "Save timestamp note" }).click();
  await page.locator(".ce-notes li").waitFor();
  const saved = state.calls
    .filter((c) => c.name === "bk_portal_video_note")
    .at(-1).args;
  check(
    saved.p_request_id === request && saved.p_at_seconds === 12.25,
    "note retry uses same request and exact timestamp",
  );
  check(
    !(await page.evaluate(() => window.pwned)) &&
      (await page.locator(".ce-notes img").count()) === 0,
    "review notes render as escaped text",
  );
  await page
    .getByRole("button", { name: "Submit 1 change", exact: true })
    .click();
  check(
    !state.calls.some((c) => c.name === "bk_portal_video_decide"),
    "review decision requires explicit confirmation",
  );
  await page.locator('[data-video-decision] [name="confirm"]').check();
  await page
    .getByRole("button", { name: "Submit 1 change", exact: true })
    .click();
  await page.locator(".ce-video-review > .ce-error").waitFor();
  await page
    .getByRole("button", { name: "Submit 1 change", exact: true })
    .click();
  await page
    .getByText("Your changes are submitted for this version.")
    .waitFor();
  check(
    state.reviews[0].status === "changes",
    "normal portal submits timestamped change decision",
  );
  state.reviews[0].current = false;
  state.reviews.push({
    ...review(),
    id: "review-two",
    version: "review-version-two",
    revision: 2,
    title: "Campaign film · revised cut",
    media_revision: "media-two",
    asset_key: "opaque-preview-two",
  });
  // Simulate current review refresh while the same DOM player still holds asset one.
  await page.evaluate(async () => {
    const module = await import("/js/crm-client-experience.js?v=1");
    window.testReview = await module.mountPortalVideoReviews(
      document.querySelector("#galleryRoot"),
      {
        rpc: (n, a) => BK.rpc(n, a),
        projectId: "synthetic-project",
        token: "synthetic-token",
      },
    );
  });
  check(
    (await page.locator("[data-video-decision]").count()) === 0,
    "new review cannot attach approval to an older cached player",
  );
  state.playerRevision = "media-two";
  state.playerKey = "opaque-preview-two";
  await open("photos");
  await page.locator('[data-video-decision] [name="signer"]').waitFor();
  await page.locator('[name="signer"]').fill("Synthetic Approver");
  await page.locator('[data-video-decision] [name="confirm"]').check();
  await page.getByRole("button", { name: "Approve this version" }).click();
  await page.getByText("Approved by Synthetic Approver.").waitFor();
  check(
    state.calls.filter((c) => c.name === "bk_portal_video_decide").at(-1).args
      .p_version === "review-version-two",
    "approval is bound to the exact displayed version",
  );
  await page.screenshot({
    path: fileURLToPath(new URL(`portal-review-${name}-${width}.png`, shots)),
    fullPage: true,
  });
  await noOverflow(page);
  state.hidden = true;
  await open("photos");
  check(
    (await page.locator(".g-video video, .ce-video-review").count()) === 0,
    "closed held preview has no player or review controls",
  );
  check(
    !state.calls.some((c) =>
      ["bk_portal_send", "bk-create-checkout", "bk-mailer"].includes(c.name),
    ),
    "preparation and review never send messages or initiate payments",
  );
  check(
    errors.length === 0,
    "portal feature has no runtime exceptions: " + errors.join(", "),
  );
  await page.close();
}

try {
  await new Promise((resolve) => setTimeout(resolve, 800));
  browser = await chromium.launch(
    process.env.PW_CHROME
      ? {
          executablePath:
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        }
      : {},
  );
  await staffTest(browser, "chromium");
  await portalTest(browser, "chromium", 1512);
  await portalTest(browser, "chromium", 390);
  await browser.close();
  browser = null;
  if (process.env.CI || process.env.PW_WEBKIT) {
    browser = await webkit.launch();
    await portalTest(browser, "webkit", 390);
  }
  console.log(
    `prep-review.e2e: ${checks} checks passed (synthetic records only)`,
  );
} finally {
  await browser?.close();
  server.kill();
}
