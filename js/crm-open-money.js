// Open money: every proposal, contract and invoice a client still has to
// decide, sign or pay. Kept by hand. This screen never sends anything.
import { date, esc, money, safeUrl } from "./crm-workspace-view.js?v=1";
import {
  errorText,
  factsLine,
  groupRows,
  parseDollars,
  PROVIDERS,
  STEPS,
  trackingTag,
} from "./crm-open-money-view.js?v=1";

const HONEST =
  "You keep this list by hand. Nothing here is pulled from HoneyBook, your email or your bank.";
const CLOSE_NOTE =
  "This closes the reminder. It does not record a payment on a project.";
const COPIED = "Copied. Paste it just before </body> on the proposal page.";
const OUTCOMES = { paid: "Paid", lost: "Lost", dropped: "Dropped" };
const BALLS = { client: "The client's", me: "Mine" };
const WHERE = { ...PROVIDERS, other: "Somewhere else" };
const TEXT_FIELDS = [
  "client_name",
  "title",
  "step",
  "ball",
  "provider",
  "link_url",
  "next_move",
  "next_move_on",
  "staged_note",
  "hold_reason",
  "sent_on",
  "due_on",
  "notes",
];

function requestFor(pending, key, payload) {
  const fingerprint = JSON.stringify(payload);
  const previous = pending.get(key);
  if (previous?.fingerprint === fingerprint) return previous.id;
  const id = crypto.randomUUID();
  pending.set(key, { id, fingerprint });
  return id;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function dollarsInput(cents) {
  if (cents === null || cents === undefined) return "";
  return (Number(cents) / 100).toFixed(2).replace(/\.00$/, "");
}

function totalsHtml(t) {
  const items = Number(t.items) || 0;
  const unpriced = Number(t.unpriced) || 0;
  const cell = (label, value, extra = "") =>
    `<div class="money-total${extra}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
  return `<div class="money-totals">` +
    `<div class="money-total is-open"><span>Open</span><b>${esc(money(t.open_cents))}</b><small>${
      esc(plural(items, "item", "items"))
    }${unpriced ? ` · ${esc(unpriced)} not priced yet` : ""}</small></div>` +
    cell("Your move", Number(t.me) || 0) +
    cell("Overdue", Number(t.overdue) || 0, t.overdue ? " is-alert" : "") +
    cell("Viewed and waiting", Number(t.viewed_waiting) || 0) +
    `</div>` +
    (t.hold ? `<p class="money-held">${esc(plural(Number(t.hold), "item", "items"))} on hold</p>` : "");
}

function rowHtml(row, closed) {
  const link = safeUrl(row.link_url);
  const amount = row.amount_cents === null || row.amount_cents === undefined
    ? '<b class="money-amount is-unpriced">Not priced yet</b>'
    : `<b class="money-amount">${esc(money(row.amount_cents))}</b>`;
  const due = row.due_on
    ? `<p class="money-due${row.overdue ? " is-late" : ""}">${
      row.overdue ? "Was due" : "Due"
    } ${esc(date(row.due_on))}</p>`
    : "";
  const next = row.next_move || row.next_move_on
    ? `<p class="money-next"><span class="money-label">Next</span> ${esc(row.next_move || "Follow up")}${
      row.next_move_on
        ? ` <span class="money-when${row.due ? " is-due" : ""}">${esc(date(row.next_move_on))}</span>`
        : ""
    }</p>`
    : "";
  const staged = row.staged_note
    ? `<div class="money-staged"><span class="money-label">Written, not sent</span><p>${esc(row.staged_note)}</p></div>`
    : "";
  const held = row.hold_reason
    ? `<div class="money-hold"><span class="money-label">On hold</span><p>${esc(row.hold_reason)}</p></div>`
    : "";
  const notes = row.notes ? `<p class="money-notes">${esc(row.notes)}</p>` : "";
  const openLink = link
    ? `<a class="btn small" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Open link</a>`
    : "";
  const project = row.project_id
    ? `<button class="btn small" type="button" data-money-project="${esc(row.project_id)}">Project</button>`
    : "";
  const actions = closed
    ? `${openLink}<button class="btn small ink" type="button" data-money-reopen>Reopen</button>`
    : `${openLink}${project}<button class="btn small" type="button" data-money-edit>Edit</button>` +
      `<button class="btn small" type="button" data-money-copy>Copy tracking code</button>` +
      `<button class="btn small" type="button" data-money-close aria-expanded="false">Close out</button>`;
  const closeout = closed ? "" : `<div class="money-closeout" hidden>` +
    `<div class="money-outcomes">${
      Object.entries(OUTCOMES).map(([key, label]) =>
        `<button class="btn small${key === "paid" ? " primary" : ""}" type="button" data-money-outcome="${key}">${label}</button>`
      ).join("")
    }<button class="btn small" type="button" data-money-close-cancel>Keep open</button></div>` +
    `<p>${esc(CLOSE_NOTE)}</p></div>`;
  const outcome = closed && row.outcome
    ? `<p class="money-outcome is-${esc(row.outcome)}">${esc(OUTCOMES[row.outcome] || row.outcome)}${
      row.closed_at ? ` · ${esc(date(row.closed_at))}` : ""
    }</p>`
    : "";
  return `<article class="money-row${row.group === "hold" && !closed ? " is-hold" : ""}" data-id="${esc(row.id)}">` +
    `<div class="money-main">` +
    `<h3 class="money-client">${esc(row.client_name)}</h3>` +
    `<p class="money-title">${esc(row.title)}</p>` +
    `<p class="money-facts">${esc(factsLine(row))}</p>` +
    next + staged + held + notes +
    `</div>` +
    `<div class="money-side">${amount}<span class="money-step">${esc(STEPS[row.step] || row.step)}</span>${due}${outcome}</div>` +
    `<div class="money-actions">${actions}</div>` +
    closeout +
    `</article>`;
}

function groupsHtml(rows, closed) {
  if (closed) {
    return rows.length
      ? `<section class="money-group is-closed"><h2>Recently closed <span class="money-count">${rows.length}</span></h2>${
        rows.map((row) => rowHtml(row, true)).join("")
      }</section>`
      : `<div class="empty money-empty"><h3>Nothing closed yet.</h3><p>Items you close out show up here.</p></div>`;
  }
  const groups = groupRows(rows);
  if (!groups.length) {
    return `<div class="empty money-empty"><h3>Nothing open.</h3><p>Add the next proposal or invoice you send.</p></div>`;
  }
  return groups.map((group, index) =>
    `<section class="money-group is-${esc(group.key)}">` +
    `<h2><span class="number">${index + 1}</span>${esc(group.label)} <span class="money-count">${group.rows.length}</span></h2>` +
    group.rows.map((row) => rowHtml(row, false)).join("") +
    `</section>`
  ).join("");
}

function select(name, items, value) {
  return `<select name="${name}">${
    Object.entries(items).map(([key, label]) =>
      `<option value="${esc(key)}"${key === value ? " selected" : ""}>${esc(label)}</option>`
    ).join("")
  }</select>`;
}

function formHtml(row) {
  const v = (key) => esc(row?.[key] ?? "");
  const hasDetails = row && ["link_url", "next_move", "next_move_on", "staged_note", "hold_reason", "sent_on", "due_on", "notes"]
    .some((key) => row[key]);
  return `<form class="money-form" novalidate>` +
    `<h2>${row ? "Edit" : "Add something waiting on a client"}</h2>` +
    `<div class="money-form-grid">` +
    `<label>Client<input name="client_name" maxlength="120" autocomplete="off" required value="${v("client_name")}"></label>` +
    `<label>What it's for<input name="title" maxlength="160" autocomplete="off" required value="${v("title")}"></label>` +
    `<label>Amount<input name="amount" inputmode="decimal" autocomplete="off" placeholder="Leave blank if not priced yet" value="${
      esc(dollarsInput(row?.amount_cents))
    }"></label>` +
    `<label>What's needed next${select("step", STEPS, row?.step || "decision")}</label>` +
    `<label>Whose move${select("ball", BALLS, row?.ball || "client")}</label>` +
    `<label>Where it runs${select("provider", WHERE, row?.provider || "other")}</label>` +
    `</div>` +
    `<details class="money-more"${hasDetails ? " open" : ""}><summary>More details</summary><div class="money-form-grid">` +
    `<label class="full">Link<input name="link_url" type="url" inputmode="url" maxlength="500" placeholder="https://" value="${v("link_url")}"></label>` +
    `<label>Next move<input name="next_move" maxlength="240" value="${v("next_move")}"></label>` +
    `<label>Do it on<input name="next_move_on" type="date" value="${v("next_move_on")}"></label>` +
    `<label class="full">Written but not sent<input name="staged_note" maxlength="240" value="${v("staged_note")}"><small>Where is the draft? Example: Gmail draft.</small></label>` +
    `<label class="full">On hold because<input name="hold_reason" maxlength="240" value="${v("hold_reason")}"></label>` +
    `<label>Sent on<input name="sent_on" type="date" value="${v("sent_on")}"></label>` +
    `<label>Payment due<input name="due_on" type="date" value="${v("due_on")}"></label>` +
    `<label class="full">Notes<textarea name="notes" maxlength="2000" rows="3">${v("notes")}</textarea></label>` +
    `</div></details>` +
    `<p class="form-error" data-money-error role="alert"></p>` +
    `<div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-money-cancel>Cancel</button></div>` +
    `</form>`;
}

export function mountOpenMoney(root, { rpc, toast, onDirty, openProject } = {}) {
  let sequence = 0;
  let show = "open";
  let rows = [];
  let editing = null; // null: closed form, "new", or a row id
  let dirty = false;
  const pending = new Map();
  const notify = (message) => typeof toast === "function" && toast(message);
  const setDirty = (value) => {
    if (dirty === value) return;
    dirty = value;
    if (typeof onDirty === "function") onDirty(value);
  };

  // A remount (Refresh, coming back to the screen) starts clean, so the shell
  // never keeps asking about changes that are already gone.
  if (typeof onDirty === "function") onDirty(false);
  root.innerHTML = '<section class="money"><p class="muted" role="status">Loading…</p></section>';

  // The open form is a live node: re-rendering the list after a close out or
  // reopen moves it into the new slot instead of throwing away what was typed.
  const openForm_ = () => root.querySelector("[data-money-form-slot] form");
  function restoreForm(form) {
    const slot = root.querySelector("[data-money-form-slot]");
    if (form && slot) slot.append(form);
    else if (form) closeForm();
  }
  function busyWithForm() {
    const form = openForm_();
    if (!form || !dirty) return false;
    form.querySelector("[data-money-error]").textContent = "Save or cancel this first.";
    form.querySelector('[name="client_name"]')?.focus();
    return true;
  }

  function render(board) {
    rows = Array.isArray(board.rows) ? board.rows : [];
    const closed = show === "closed";
    const form = openForm_();
    root.innerHTML = `<section class="money" aria-live="polite">` +
      totalsHtml(board.totals || {}) +
      `<p class="money-honest">${esc(HONEST)}</p>` +
      `<div class="money-bar">` +
      (closed ? "" : `<button class="btn ink" type="button" data-money-add>+ Add</button>`) +
      `<button class="btn" type="button" data-money-show>${closed ? "Show open" : "Show closed"}</button>` +
      `</div>` +
      `<div data-money-form-slot></div>` +
      groupsHtml(rows, closed) +
      `</section>`;
    restoreForm(form);
  }

  async function load() {
    const current = ++sequence;
    try {
      const board = await rpc("bk_money_board", { p_show: show, p_day: null });
      if (!root.isConnected || current !== sequence) return;
      if (!board || !Array.isArray(board.rows)) throw Error("The list could not load.");
      render(board);
    } catch (error) {
      if (!root.isConnected || current !== sequence) return;
      const form = openForm_();
      root.innerHTML = `<section class="money"><div data-money-form-slot></div><p class="form-error" role="alert">${
        esc(error?.message || "The list could not load.")
      }</p><button class="btn" type="button" data-money-retry>Try again</button></section>`;
      restoreForm(form);
    }
  }

  function openForm(row) {
    const slot = root.querySelector("[data-money-form-slot]");
    if (!slot) return;
    editing = row ? row.id : "new";
    slot.innerHTML = formHtml(row);
    setDirty(false);
    slot.scrollIntoView({ block: "nearest", behavior: "smooth" });
    slot.querySelector('[name="client_name"]')?.focus({ preventScroll: true });
  }

  function closeForm() {
    const slot = root.querySelector("[data-money-form-slot]");
    if (slot) slot.innerHTML = "";
    editing = null;
    setDirty(false);
  }

  function readForm(form) {
    const item = {};
    for (const name of TEXT_FIELDS) {
      const value = String(form.elements[name]?.value ?? "").trim();
      item[name] = value === "" ? null : value;
    }
    const cents = parseDollars(form.elements.amount.value);
    if (Number.isNaN(cents)) throw Error("invalid_amount");
    item.amount_cents = cents;
    if (!item.client_name) throw Error("client_name_required");
    if (!item.title) throw Error("title_required");
    if (item.link_url && !/^https:\/\/\S+$/.test(item.link_url)) throw Error("invalid_link");
    if (editing && editing !== "new") item.id = editing;
    return item;
  }

  async function write(button, key, name, payload, done) {
    const request = requestFor(pending, key, payload);
    const buttons = [...(button.closest("form, article")?.querySelectorAll("button") || [button])];
    buttons.forEach((b) => b.disabled = true);
    try {
      await rpc(name, { ...payload, p_request_id: request });
      pending.delete(key);
      done();
      await load();
      return true;
    } catch (error) {
      if (root.isConnected) buttons.forEach((b) => b.disabled = false);
      throw error;
    }
  }

  root.addEventListener("input", (event) => {
    if (event.target.closest("form.money-form")) setDirty(true);
  });

  root.addEventListener("submit", async (event) => {
    const form = event.target.closest("form.money-form");
    if (!form) return;
    event.preventDefault();
    const message = form.querySelector("[data-money-error]");
    message.textContent = "";
    let item;
    try {
      item = readForm(form);
    } catch (error) {
      message.textContent = errorText(error);
      if (error.message === "invalid_link") form.querySelector("details").open = true;
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    try {
      await write(button, "save:" + (item.id || "new"), "bk_money_save", { p_item: item }, () => {
        closeForm();
        notify("Saved.");
      });
    } catch (error) {
      if (form.isConnected) message.textContent = errorText(error);
      else notify(errorText(error));
    }
  });

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    const article = button.closest(".money-row");
    const row = article ? rows.find((r) => r.id === article.dataset.id) : null;

    if (button.hasAttribute("data-money-retry")) return load();
    if (button.hasAttribute("data-money-add")) return busyWithForm() || openForm(null);
    if (button.hasAttribute("data-money-cancel")) return closeForm();
    if (button.hasAttribute("data-money-show")) {
      if (busyWithForm()) return;
      show = show === "open" ? "closed" : "open";
      closeForm();
      return load();
    }
    if (!row) return;
    if (button.hasAttribute("data-money-edit")) return busyWithForm() || openForm(row);
    if (button.dataset.moneyProject) {
      if (typeof openProject === "function") await openProject(button.dataset.moneyProject);
      return;
    }
    if (button.hasAttribute("data-money-close") || button.hasAttribute("data-money-close-cancel")) {
      const panel = article.querySelector(".money-closeout");
      const opening = button.hasAttribute("data-money-close") && panel.hidden;
      panel.hidden = !opening;
      article.querySelector("[data-money-close]").setAttribute("aria-expanded", String(opening));
      if (opening) panel.querySelector("[data-money-outcome]")?.focus();
      return;
    }
    if (button.dataset.moneyOutcome) {
      const outcome = button.dataset.moneyOutcome;
      try {
        await write(button, `close:${row.id}:${outcome}`, "bk_money_close", { p_id: row.id, p_outcome: outcome }, () =>
          notify("Closed out."));
      } catch (error) {
        notify(errorText(error));
      }
      return;
    }
    if (button.hasAttribute("data-money-reopen")) {
      try {
        await write(button, "reopen:" + row.id, "bk_money_reopen", { p_id: row.id }, () => notify("Reopened."));
      } catch (error) {
        notify(errorText(error));
      }
      return;
    }
    if (button.hasAttribute("data-money-copy")) {
      try {
        await navigator.clipboard.writeText(trackingTag(row.view_key));
        notify(COPIED);
      } catch {
        notify("This browser blocked copying. Try again from a computer.");
      }
    }
  });

  return load();
}

export async function mountOpenMoneyLine(root, { rpc } = {}) {
  const current = (root._moneyLine = (root._moneyLine || 0) + 1);
  root.innerHTML = "";
  try {
    const board = await rpc("bk_money_board", { p_show: "open", p_day: null });
    if (!root.isConnected || current !== root._moneyLine) return;
    const t = board?.totals || {};
    const items = Number(t.items) || 0;
    if (!items) return;
    root.innerHTML = `<p class="money-line"><a href="?view=money" data-view="money">Open money: ${
      esc(money(t.open_cents))
    } across ${esc(plural(items, "item", "items"))} · ${Number(t.me) || 0} your move · ${
      Number(t.overdue) || 0
    } overdue</a></p>`;
  } catch {
    if (root.isConnected && current === root._moneyLine) root.innerHTML = "";
  }
}
