/* Taylormade studio CRM. Authenticated staff reads and verified writes only. */
import {
  centralDay,
  csvText,
  date,
  dueLabel,
  esc,
  KINDS,
  localInput,
  money,
  options,
  pill,
  safeUrl,
  SERVICES,
  STAGES,
  time,
  totalLines,
} from "./crm-workspace-view.js?v=1";
import { mountClientExperience } from "./crm-client-experience.js?v=1";
import { mountOperations, mountOperationsView } from "./crm-operations.js?v=1";
import {
  mountFollowupSettings,
  mountMorningList,
  mountSourceReport,
} from "./crm-growth-tools.js?v=1";
import {
  mountQuickCapture,
  receiveSharedCapture,
} from "./crm-quick-capture.js?v=1";
receiveSharedCapture();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
const extensionDirty = new Set();
const sb = window.supabase.createClient(
  window.BK.SUPABASE_URL,
  window.BK.SUPABASE_KEY,
);
const $ = (s, r = document) => r.querySelector(s),
  $$ = (s, r = document) => [...r.querySelectorAll(s)];
const state = {
  view: "today",
  project: null,
  detail: null,
  dashboard: null,
  health: null,
  healthStatus: "loading",
  healthSeq: 0,
  staff: [],
  userId: null,
  q: "",
  status: "all",
  offset: 0,
  limit: 30,
  total: 0,
  rows: [],
  seq: 0,
  taskFilter: "due",
  taskOffset: 0,
  taskSeq: 0,
  taskRows: [],
  taskTotal: 0,
  dirty: false,
  contact: null,
};
const searchIcon =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="m12 12 5 5"/></svg>';
const checkIcon =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>';
const workspace = $("#workspace");
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 3500);
}
function fail(el, error) {
  const msg = error?.message || String(error || "Could not save. Try again.");
  const target = $(".form-error", el) || $("#statusBanner");
  target.textContent = msg;
  target.hidden = false;
}
function clearError(el) {
  const target = $(".form-error", el);
  if (target) target.textContent = "";
}
function missing(error) {
  return /PGRST202|PGRST205|does not exist|schema cache|Could not find the function|Could not find the table/i
    .test(error?.message || "");
}
function showError(error) {
  workspace.setAttribute("aria-busy", "false");
  $("#statusBanner").hidden = false;
  $("#statusBanner").innerHTML = `<p>${
    missing(error)
      ? "The CRM foundation is not installed on this database yet. Your existing Inbox, Studio and client portals remain available. Install the CRM migrations before using this workspace."
      : esc(
        error?.message ||
          "Couldn't load the workspace. Your data has not been changed.",
      )
  }</p><button class="btn small" data-retry>Try again</button>`;
  workspace.innerHTML =
    '<div class="empty"><h2>Workspace unavailable</h2><p>Use the studio tools above while this connection is restored.</p></div>';
}
async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}
async function result(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
async function write(table, id, patch) {
  const data = await result(
    sb.from(table).update(patch).eq("id", id).select("id"),
  );
  if (!data?.length) {
    throw Error("Nothing was saved. Check your staff access and try again.");
  }
  return data;
}
async function insert(table, row) {
  const data = await result(sb.from(table).insert(row).select("id"));
  if (!data?.length) {
    throw Error("Nothing was created. Check your staff access and try again.");
  }
  return data[0];
}
async function saving(form, work) {
  const btns = $$("button", form);
  btns.forEach((b) => b.disabled = true);
  clearError(form);
  try {
    await work();
    state.dirty = false;
  } catch (e) {
    fail(form, e);
  } finally {
    btns.forEach((b) => b.disabled = false);
  }
}
function staffOptions(id) {
  return options(
    Object.fromEntries(
      state.staff.map((s) => [s.id, s.full_name || s.role || "Staff member"]),
    ),
    id,
    "Unassigned",
  );
}
function head(title, sub, actions = "", eyebrow = "Studio CRM") {
  return `<div class="heading"><div><p class="eyebrow">${esc(eyebrow)}</p><h1>${
    esc(title)
  }</h1>${
    sub ? `<p class="subline">${esc(sub)}</p>` : ""
  }</div><div class="heading-actions">${actions}</div></div>`;
}
function empty(title, copy, action = "") {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${
    esc(copy)
  }</p>${action}</div>`;
}
function summary(stats) {
  return `<div class="summary-strip"><div><b class="${
    stats.overdue ? "red" : ""
  }">${
    esc(stats.overdue ?? 0)
  }</b><span>Overdue next actions</span></div><div><b>${
    esc(stats.dueToday ?? 0)
  }</b><span>Due today</span></div><div><b>${
    esc(stats.waiting ?? 0)
  }</b><span>Waiting on you</span></div><div><b>${
    money(stats.unpaid)
  }</b><span>Outstanding invoices</span></div></div>`;
}
function healthReason(error) {
  const text = String(error || "");
  if (/delivery_review_required|ambiguous|idempotency/i.test(text)) {
    return "Review the original delivery with the email provider before sending again.";
  }
  if (/429|rate.?limit|too many/i.test(text)) {
    return "The email provider has limited delivery. Check the provider before sending again.";
  }
  if (/401|403|unauthori|api.?key|authentication/i.test(text)) {
    return "The email provider connection needs attention.";
  }
  if (/recipient|invalid.*email|address|bounce/i.test(text)) {
    return "Check the recipient's email address and delivery status.";
  }
  if (/timeout|network|fetch|connection/i.test(text)) {
    return "The email provider could not be reached.";
  }
  return "Delivery reported an error. Review this project's conversation and the email provider.";
}
function healthBody() {
  if (state.healthStatus === "loading") {
    return '<div class="health-heading"><h2 id="healthTitle">Operational health</h2><span class="muted">Checking…</span></div><p class="health-caption" role="status">Checking the message queue, billing assignments and calendar data.</p>';
  }
  if (state.healthStatus === "unavailable") {
    return '<div class="health-heading"><h2 id="healthTitle">Operational health unavailable</h2><button class="btn small" data-health-refresh>Check again</button></div><p class="health-caption">This check could not be completed. Project data is still available. Counts remain unknown until the connection is restored.</p>';
  }
  const h = state.health,
    failed = Number(h.email_failed),
    waiting = Number(h.email_waiting),
    stalled = Number(h.email_stalled),
    unassigned = Number(h.billing_unassigned),
    attention = failed || stalled || unassigned ||
      Number(h.email_review || 0) || !h.content_ready;
  const labels = {
    inquiry_ack: "Inquiry acknowledgment",
    nelson_alert: "Studio alert",
    studio_message: "Client message",
    client_message: "Message notification",
    booking_confirmed: "Booking confirmation",
    booking_confirmation: "Booking confirmation",
    invoice_sent: "Invoice notification",
    quote_ready: "Quote notification",
    contract_sent: "Contract notification",
    reminder_24h: "Booking reminder",
    reminder_2h: "Booking reminder",
  };
  return `<div class="health-heading"><h2 id="healthTitle">Operational health</h2><span class="health-state ${
    attention ? "red" : "green"
  }">${
    attention ? "Needs attention" : "Queue clear"
  }</span><button class="btn small" data-health-refresh>Check again</button></div><div class="health-counts"><span><strong class="${
    failed ? "red" : ""
  }">${failed}</strong> failed messages</span><span><strong>${waiting}</strong> waiting</span><span><strong class="${
    stalled ? "red" : ""
  }">${stalled}</strong> stalled over 10 min</span><span><strong class="${
    unassigned ? "gold" : ""
  }">${unassigned}</strong> billing assignments to confirm</span>${
    h.email_review != null
      ? `<span><strong class="${Number(h.email_review) ? "gold" : ""}">${
        Number(h.email_review)
      }</strong> incoming replies to review</span>`
      : ""
  }</div>${
    (h.email_issues || []).length
      ? `<ul class="health-issues plain-list" aria-label="Message delivery issues">${
        h.email_issues.map((issue) =>
          `<li><div><strong>${
            esc(labels[issue.kind] || "Queued message")
          }</strong>${
            issue.project_id
              ? ` · ${
                projectLink({
                  id: issue.project_id,
                  title: issue.project_title || "Open project",
                })
              }`
              : ""
          }</div><p>${esc(healthReason(issue.last_error))}</p><small>${
            Number(issue.attempts || 0)
          } delivery attempts · ${esc(time(issue.created_at))}</small></li>`
        ).join("")
      }</ul><p class="health-caption">${h.email_issues.length} latest issues shown. No messages are retried from this panel.</p>`
      : ""
  }${
    Number(h.email_review)
      ? `<div class="health-billing"><strong>Incoming replies need review</strong><p>These replies were held outside the conversation until their sender and project can be verified. Review them in the email provider.</p>${
        (h.email_review_issues || []).map((issue) =>
          `<div class="compact-row"><span>${
            issue.project_id
              ? projectLink({
                id: issue.project_id,
                title: issue.project_title || issue.client_name ||
                  "Open project",
              })
              : "Unmatched reply"
          }</span><small>${esc(time(issue.created_at))}</small></div>`
        ).join("")
      }</div>`
      : ""
  }${
    unassigned
      ? `<div class="health-billing"><p>Confirm Stripe or HoneyBook on ${
        unassigned === 1 ? "the existing project" : "each affected project"
      } before issuing another invoice. This check does not choose a provider.</p>${
        (h.billing_issues || []).length
          ? `<div class="contact-projects">${
            h.billing_issues.map((p) =>
              projectLink(p, p.client_name || p.title)
            ).join("")
          }</div>`
          : '<a class="text-link" href="?view=pipeline" data-view="pipeline">Review projects in the pipeline</a>'
      }</div>`
      : ""
  }<p class="health-caption ${h.content_ready ? "" : "gold"}">${
    h.content_ready
      ? "Content calendar data available."
      : "Content calendar setup is pending. A studio administrator needs to finish its setup."
  } Checked ${
    esc(time(h.checked_at))
  }. These checks inspect saved records; they do not verify an email provider connection.</p>`;
}
function healthPanel() {
  const h = state.health;
  const attention = state.healthStatus === "ready" &&
    (Number(h.email_failed) || Number(h.email_stalled) ||
      Number(h.billing_unassigned) || Number(h.email_review || 0) ||
      !h.content_ready);
  return `<section id="operationalHealth" class="health-panel ${
    attention ? "has-issues" : ""
  }" data-health-status="${state.healthStatus}" aria-labelledby="healthTitle">${healthBody()}</section>`;
}
async function loadHealth(viewSeq = state.seq, restoreFocus = false) {
  const seq = ++state.healthSeq;
  state.healthStatus = "loading";
  const current = $("#operationalHealth");
  if (current) {
    current.dataset.healthStatus = "loading";
    current.innerHTML = healthBody();
  }
  try {
    const h = await rpc("bk_crm_health");
    if (
      !h ||
      !["email_failed", "email_waiting", "email_stalled", "billing_unassigned"]
        .every((k) => h[k] != null && Number.isFinite(Number(h[k]))) ||
      typeof h.content_ready !== "boolean" || !h.checked_at
    ) throw Error("Incomplete health check");
    if (seq !== state.healthSeq || viewSeq !== state.seq) return;
    state.health = h;
    state.healthStatus = "ready";
  } catch {
    if (seq !== state.healthSeq || viewSeq !== state.seq) return;
    state.health = null;
    state.healthStatus = "unavailable";
  }
  const panel = $("#operationalHealth");
  if (panel) panel.outerHTML = healthPanel();
}

function projectLink(p, label) {
  return `<a href="?view=pipeline&p=${
    encodeURIComponent(p.id)
  }" data-project="${esc(p.id)}">${
    esc(label || p.title || p.client_name || "Untitled project")
  }</a>`;
}
function taskHtml(t, projectView = false) {
  const due = dueLabel(t);
  return `<div class="task" data-task-row="${
    esc(t.id)
  }"><button type="button" class="task-check ${
    t.status === "done" ? "done" : ""
  }" data-task-toggle="${esc(t.id)}" data-status="${
    esc(t.status)
  }" aria-label="${t.status !== "open" ? "Reopen" : "Complete"} ${
    esc(t.title)
  }">${
    t.status === "done" ? checkIcon : ""
  }</button><div><span class="task-title">${
    esc(t.title)
  }</span><div class="task-meta">${esc(KINDS[t.kind] || t.kind)}${
    !projectView && t.project_id
      ? ` · ${
        projectLink({
          id: t.project_id,
          title: t.project_title || t.client_name,
        }, t.client_name || t.project_title)
      }`
      : ""
  }${
    t.notes ? ` · ${esc(t.notes)}` : ""
  }</div></div><div class="task-tools"><span class="task-due ${due.tone}">${
    esc(due.label)
  }</span>${
    t.status === "open"
      ? `<button class="btn small" data-task-edit="${
        esc(t.id)
      }">Reschedule</button><button class="btn small" data-task-wait="${
        esc(t.id)
      }">Tomorrow</button>`
      : ""
  }</div></div>`;
}
function section(title, content, actions = "", n = "") {
  return `<section class="section"><div class="section-title"><h2>${
    n ? `<span class="number">${n}</span>` : ""
  }${esc(title)}</h2>${actions}</div>${content}</section>`;
}
function markNav() {
  $$("#mainNav a").forEach((a) => {
    if (a.dataset.view === state.view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}
function canLeave() {
  return (!state.dirty && !extensionDirty.size) ||
    confirm("Leave without saving your changes?");
}
function extensionContext(name) {
  return {
    rpc,
    toast,
    staff: state.staff,
    project: state.detail?.project,
    onDirty(dirty) {
      dirty ? extensionDirty.add(name) : extensionDirty.delete(name);
    },
    onChange: refreshContent,
    openProject(id) {
      return navigate("pipeline", id);
    },
  };
}
function mountTool(selector, mount, context = {}) {
  const root = $(selector);
  if (!root) return;
  root.dataset.crmExtension = "";
  root.innerHTML = '<p class="muted" role="status">Loading…</p>';
  Promise.resolve().then(() =>
    mount(root, { ...extensionContext(selector), ...context })
  ).catch((error) => {
    if (!root.isConnected) return;
    root.innerHTML = `<section class="section"><p role="alert">${
      esc(error?.message || "This tool could not load. Try again.")
    }</p><button class="btn small" data-extension-retry>Try again</button></section>`;
  });
}
async function navigate(view, project = null, { replace = false } = {}) {
  if (!canLeave()) return;
  state.dirty = false;
  extensionDirty.clear();
  state.view = view;
  state.project = project;
  state.offset = 0;
  state.q = "";
  state.status = "all";
  state.contact = null;
  state.detail = null;
  $("#newLead").hidden = true;
  history[replace ? "replaceState" : "pushState"](
    {},
    "",
    `?view=${encodeURIComponent(view)}${
      project ? `&p=${encodeURIComponent(project)}` : ""
    }`,
  );
  await load();
  $("#main").focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}
async function load() {
  const seq = ++state.seq;
  markNav();
  $("#statusBanner").hidden = true;
  workspace.setAttribute("aria-busy", "true");
  workspace.innerHTML =
    '<div class="skeleton" aria-label="Loading workspace"><i></i><i></i><i></i></div>';
  try {
    if (!state.staff.length) state.staff = await rpc("bk_crm_staff");
    if (state.project) {
      const d = await rpc("bk_crm_project", { p_project: state.project });
      if (seq !== state.seq) return;
      if (!d?.project) {
        throw Error("This project was not found or you do not have access.");
      }
      state.detail = d;
      renderDetail();
      mountTool("#clientExperience", mountClientExperience);
      mountTool("#projectOperations", mountOperations);
      mountTool("#followupSettings", mountFollowupSettings);
    } else if (["capacity", "retainers", "profit"].includes(state.view)) {
      const titles = {
        capacity: "Editing workload",
        retainers: "Monthly packages",
        profit: "Project earnings",
      };
      workspace.innerHTML = head(
        titles[state.view],
        "",
        '<button class="btn" data-refresh>Refresh</button>',
      ) + '<div id="operationsView"></div>';
      mountTool("#operationsView", mountOperationsView, { view: state.view });
    } else if (state.view === "capture") {
      workspace.innerHTML = '<div id="captureWorkspace"></div>';
      mountTool("#captureWorkspace", mountQuickCapture, {
        userId: state.userId,
        onCreated(id) {
          return navigate("pipeline", id);
        },
      });
    } else if (state.view === "today" || state.view === "reports") {
      const d = await rpc("bk_crm_dashboard");
      if (seq !== state.seq) return;
      state.dashboard = d;
      if (state.view === "today") await loadTasks();
      if (seq !== state.seq) return;
      const n = d.tasks_total ??
        ((d.stats?.overdue || 0) + (d.stats?.dueToday || 0));
      $("#dueBadge").textContent = n;
      $("#dueBadge").hidden = !n;
      state.health = null;
      state.healthStatus = "loading";
      state.view === "reports" ? renderReports() : renderToday();
      if (state.view === "today") mountTool("#morningList", mountMorningList);
      if (state.view === "reports") {
        mountTool("#sourceReport", mountSourceReport);
      }
      loadHealth(seq);
    } else if (state.view === "clients") {
      const d = await rpc("bk_crm_contacts", {
        p_query: state.q,
        p_offset: state.offset,
        p_limit: state.limit,
      });
      if (seq !== state.seq) return;
      state.rows = d.rows || [];
      state.total = d.total || 0;
      renderClients();
    } else {
      const d = await rpc("bk_crm_projects", {
        p_query: state.q,
        p_status: state.status,
        p_offset: state.offset,
        p_limit: state.limit,
      });
      if (seq !== state.seq) return;
      state.rows = d.rows || [];
      state.total = d.total || 0;
      renderPipeline();
    }
    workspace.setAttribute("aria-busy", "false");
  } catch (e) {
    if (seq === state.seq) showError(e);
  }
}
async function loadTasks() {
  const seq = ++state.taskSeq;
  const d = await rpc("bk_crm_tasks", {
    p_filter: state.taskFilter,
    p_offset: state.taskOffset,
    p_limit: 30,
  });
  if (seq !== state.taskSeq) return false;
  state.taskRows = d.rows || [];
  state.taskTotal = Number(d.total || 0);
  return true;
}
function taskPagination() {
  return `<div class="pagination"><span>${
    state.taskTotal ? state.taskOffset + 1 : 0
  }–${
    Math.min(state.taskOffset + 30, state.taskTotal)
  } of ${state.taskTotal} open tasks</span><div class="actions"><button class="btn small" data-task-page="prev" ${
    !state.taskOffset ? "disabled" : ""
  }>Previous</button><button class="btn small" data-task-page="next" ${
    state.taskOffset + 30 >= state.taskTotal ? "disabled" : ""
  }>Next</button></div></div>`;
}
function renderToday() {
  const d = state.dashboard, now = new Date();
  const list = state.taskRows;
  const upcoming = (d.upcoming_bookings || d.bookings || []).slice(0, 8);
  const counts = d.stage_counts || {};
  workspace.innerHTML = head(
    "Today",
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      weekday: "long",
      month: "long",
      day: "numeric",
    }).format(now),
    '<button class="btn" data-refresh>Refresh</button>',
  ) + summary(d.stats || {}) + '<div id="morningList"></div>' + healthPanel() +
    `<div class="sections"><div>${
      section(
        "Next actions",
        `<div class="toolbar" role="group" aria-label="Task filter"><button class="btn small ${
          state.taskFilter === "due" ? "ink" : ""
        }" data-task-filter="due">Due & overdue</button><button class="btn small ${
          state.taskFilter === "upcoming" ? "ink" : ""
        }" data-task-filter="upcoming">Upcoming</button><button class="btn small ${
          state.taskFilter === "all" ? "ink" : ""
        }" data-task-filter="all">All open</button></div><div class="task-list">${
          list.length ? list.map((t) => taskHtml(t)).join("") : empty(
            "A clear next move",
            "No tasks in this view. Open a project to add or schedule its next action.",
            '<a class="btn small" href="?view=pipeline" data-view="pipeline">Open pipeline</a>',
          )
        }</div>${taskPagination()}`,
        `<span class="count">${state.taskTotal} ${
          state.taskTotal === 1 ? "action" : "actions"
        }</span>`,
      )
    }${
      (d.no_next_action || []).length
        ? section(
          "Needs a next action",
          d.no_next_action.map((p) =>
            `<div class="compact-row"><div><strong>${
              projectLink(p, p.client_name || p.title)
            }</strong><small>${esc(p.title)} · ${
              esc(STAGES[p.status] || p.status)
            }</small></div><a class="btn small" href="?view=pipeline&p=${
              encodeURIComponent(p.id)
            }" data-project="${esc(p.id)}">Set action</a></div>`
          ).join("") +
            `<p class="report-caption">${d.no_next_action.length} shown of ${
              Number(d.stats?.noNextAction || d.no_next_action.length)
            } active projects without an open task.</p>`,
        )
        : ""
    }</div><div>${
      section(
        "Pipeline",
        Object.entries(STAGES).filter(([s]) =>
          !["archived", "lost"].includes(s)
        ).map(([s, label]) =>
          `<a class="compact-row" href="?view=pipeline" data-stage="${s}"><span>${
            esc(label)
          }</span><strong>${esc(counts[s] || 0)}</strong></a>`
        ).join(""),
      )
    }${
      section(
        "Upcoming shoots",
        upcoming.length
          ? upcoming.map((b) =>
            `<div class="compact-row"><div><strong>${
              projectLink({
                id: b.project_id,
                title: b.project_title || b.client_name || b.service_name,
              })
            }</strong><small>${esc(time(b.starts_at))}</small></div>${
              pill(b.status, b.status)
            }</div>`
          ).join("")
          : empty(
            "Keep the calendar connected",
            "Confirmed shoots appear here. Manage availability and bookings in Schedule.",
            '<a class="btn small" href="../schedule.html">Open schedule</a>',
          ),
      )
    }</div></div>`;
}
function pagination() {
  const start = state.total ? state.offset + 1 : 0,
    end = Math.min(state.offset + state.limit, state.total);
  return `<div class="pagination"><span>${start}–${end} of ${state.total}</span><div class="actions"><button class="btn small" data-page="prev" ${
    !state.offset ? "disabled" : ""
  }>Previous</button><button class="btn small" data-page="next" ${
    state.offset + state.limit >= state.total ? "disabled" : ""
  }>Next</button></div></div>`;
}
function toolbar(clients = false) {
  return `<form class="toolbar" id="searchForm"><label class="search"><span class="sr-only">Search ${
    clients ? "clients" : "projects"
  }</span>${searchIcon}<input type="search" name="q" value="${
    esc(state.q)
  }" placeholder="${
    clients ? "Name, email, company or phone" : "Search every project"
  }" autocomplete="off"></label>${
    !clients
      ? `<label><span class="sr-only">Project stage</span><select name="stage" id="stageFilter">${
        options(
          { all: "All stages", active: "Active projects", ...STAGES },
          state.status,
        )
      }</select></label>`
      : ""
  }<button class="btn ink">Search</button></form>`;
}
function invoiceTotals(p) {
  const inv = p.bk_invoices || [];
  return {
    paid: inv.filter((i) => i.status === "paid").reduce(
      (n, i) => n + (i.paid_amount_cents ?? i.amount_cents),
      0,
    ),
    due: inv.filter((i) => i.status === "sent").reduce(
      (n, i) => n + i.amount_cents,
      0,
    ),
  };
}
function renderPipeline() {
  workspace.innerHTML = head(
    "Pipeline",
    "A place for every inquiry, shoot and delivery.",
    '<button class="btn" data-export="projects">Export CSV</button>',
  ) + toolbar() +
    `<div class="table-wrap"><table><thead><tr><th>Client / project</th><th>Stage</th><th class="hide-mobile">Next action</th><th class="hide-mobile">Shoot date</th><th>Unpaid</th></tr></thead><tbody>${
      state.rows.map((p) => {
        const totals = invoiceTotals(p), next = p.next_task;
        return `<tr><td><a class="row-title" href="?view=pipeline&p=${
          encodeURIComponent(p.id)
        }" data-project="${esc(p.id)}">${esc(p.client_name)}</a><small>${
          esc(p.title || SERVICES[p.service] || p.service)
        }${
          p.referral_source ? ` · ${esc(p.referral_source)}` : ""
        }</small></td><td>${pill(p.status)}</td><td class="hide-mobile">${
          next
            ? `${esc(next.title)}<small class="${dueLabel(next).tone}">${
              esc(time(next.due_at))
            }</small>`
            : '<small class="red">No next action</small>'
        }</td><td class="hide-mobile">${
          esc(p.event_date ? date(p.event_date) : "Not set")
        }</td><td>${
          totals.due ? money(totals.due) : '<span class="muted">$0.00</span>'
        }</td></tr>`;
      }).join("")
    }</tbody></table></div>${
      !state.rows.length
        ? empty(
          "No projects found",
          state.q
            ? "Try a different search or stage."
            : "Add an inquiry from a call, text, Instagram conversation or referral.",
          '<button class="btn primary" data-new-lead>+ Add lead</button>',
        )
        : ""
    }` + pagination();
}
function renderClients() {
  workspace.innerHTML = head(
    "Clients",
    "One relationship, with every project connected.",
    '<button class="btn" data-export="contacts">Export CSV</button>',
  ) + toolbar(true) +
    state.rows.map((c) =>
      `<article class="contact-card" data-contact-card="${
        esc(c.id)
      }"><div class="contact-head"><div><h2>${
        esc(c.name)
      }</h2><div class="contact-facts">${
        c.company ? `<span>${esc(c.company)}</span>` : ""
      }${
        c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""
      }${c.phone ? `<span>${esc(c.phone)}</span>` : ""}${
        c.instagram ? `<span>${esc(c.instagram)}</span>` : ""
      }</div></div><div class="actions"><span class="pill">${
        Number(c.project_count || 0)
      } projects</span><button class="btn small" data-contact-open="${
        esc(c.id)
      }">View client</button></div></div><div data-contact-detail="${
        esc(c.id)
      }" hidden></div></article>`
    ).join("") + (!state.rows.length
      ? empty(
        "No matching clients",
        "Clients are created when you add a lead, and repeat jobs stay linked to the same relationship.",
      )
      : "") +
    pagination();
}
function projectForm(p = {}, create = false) {
  return `<form id="${
    create ? "leadForm" : "projectForm"
  }" class="form-grid"><label>Client name<input name="client_name" value="${
    esc(p.client_name)
  }" maxlength="120" required></label><label>Project title<input name="title" value="${
    esc(p.title)
  }" maxlength="240" placeholder="Brand shoot, fall campaign…"></label><label>Email<input name="client_email" type="email" value="${
    esc(p.client_email)
  }" maxlength="200"></label><label>Phone<input name="client_phone" type="tel" value="${
    esc(p.client_phone)
  }" maxlength="40"></label><label>Instagram<input name="instagram" value="${
    esc(p.instagram || (create ? "" : state.detail?.contact?.instagram))
  }" maxlength="31" pattern="@?[A-Za-z0-9._]{1,30}" placeholder="@handle"></label><label>Company<input name="company" value="${
    esc(p.company)
  }" maxlength="160"></label><label>Service<select name="service">${
    options(SERVICES, p.service || "photography")
  }</select></label><label>Lead source<input name="referral_source" value="${
    esc(p.referral_source)
  }" maxlength="120" required placeholder="Instagram, website, referral…"></label>${
    !create
      ? `<label>Stage<select name="status">${
        options(STAGES, p.status)
      }</select></label>`
      : ""
  }<label>Owner<select name="owner_id">${
    staffOptions(p.owner_id || (create ? state.userId : null))
  }</select></label><label>Requested / shoot date<input name="event_date" type="date" value="${
    esc(p.event_date)
  }"></label><label>Delivery target<input name="delivery_target" type="date" value="${
    esc(p.delivery_target)
  }"></label><label>Location<input name="location" value="${
    esc(p.location)
  }" maxlength="240"></label><label class="full">Project brief<textarea name="details" maxlength="4000" rows="3">${
    esc(p.details)
  }</textarea></label>${
    !create
      ? `<label class="full">Lost reason<input name="lost_reason" value="${
        esc(p.lost_reason)
      }" maxlength="500" placeholder="Required when marking a project lost"></label>`
      : ""
  }<div class="full"><p class="field-note">Add at least one contact channel: email, phone or Instagram. Saving a lead does not send a message.</p><div class="actions"><button class="btn ${
    create ? "primary" : "ink"
  }">${create ? "Create lead" : "Save project"}</button>${
    create
      ? '<button class="btn" type="button" data-close-lead>Cancel</button>'
      : ""
  }</div><p class="form-error" role="alert"></p></div></form>`;
}
function openLead() {
  if (!canLeave()) return;
  state.dirty = false;
  state.contact = null;
  const panel = $("#newLead");
  panel.hidden = false;
  panel.innerHTML = `<section class="form-panel"><h2>Add a lead</h2>${
    projectForm({}, true)
  }</section>`;
  $("#leadForm", panel).dataset.requestId = crypto.randomUUID();
  $("[name=client_name]", panel).focus();
  panel.scrollIntoView({ block: "start", behavior: "smooth" });
  return true;
}
function taskForm(projectId) {
  return `<form id="taskForm" class="form-grid"><label class="full">Next action<input name="title" maxlength="180" required placeholder="Follow up on quote, edit first cut…"></label><label>Kind<select name="kind">${
    options(KINDS, "followup")
  }</select></label><label>Due date & time (local)<input type="datetime-local" name="due_at" required></label><label>Owner<select name="owner_id">${
    staffOptions(state.detail?.project.owner_id || state.userId)
  }</select></label><label>Notes<input name="notes" maxlength="2000" placeholder="What needs to happen?"></label><div class="full"><div class="actions"><button class="btn ink">Add next action</button></div><p class="form-error" role="alert"></p></div></form>`;
}
function quoteForm() {
  return `<details id="quoteEditor"><summary class="btn small">+ New quote</summary><form id="quoteForm" class="form-panel"><label>Quote title<input name="title" value="Project quote" maxlength="180" required></label><div class="quote-lines" id="quoteLines"><label>Description</label><label>Qty</label><label>Unit $</label><span></span>${quoteLine()}</div><button class="btn small" type="button" data-add-line style="margin-top:12px">+ Line item</button><p class="quote-total">Total: <span id="quoteTotal">$0.00</span></p><div class="form-grid"><label>Valid until<input name="valid_until" type="date"></label><label>Scope / terms<textarea name="notes" rows="3" maxlength="12000"></textarea></label></div><div class="actions"><button class="btn ink">Save draft</button></div><p class="form-error" role="alert"></p></form></details>`;
}
function quoteLine(l = {}) {
  return `<div class="quote-line"><input aria-label="Line description" data-line="description" value="${
    esc(l.description)
  }" maxlength="500" required><input aria-label="Quantity" data-line="quantity" type="number" min="1" max="10000" step="1" value="${
    esc(l.quantity || 1)
  }" required><input aria-label="Unit price in dollars" data-line="unit" type="number" min="0" max="1000000" step="0.01" value="${
    l.unit_cents != null ? esc(l.unit_cents / 100) : ""
  }" required><button class="remove-line" type="button" data-remove-line aria-label="Remove line item">×</button></div>`;
}
function quotesHtml(quotes) {
  return quotes.map((q) =>
    `<article class="quote"><div class="quote-head"><div><h3>${
      esc(q.title)
    }</h3>${pill(q.status, q.status)}</div><span class="amount">${
      money(q.total_cents)
    }</span></div>${
      (q.lines || []).map((l) =>
        `<div class="compact-row"><span>${esc(l.description)} <small>× ${
          esc(l.quantity)
        }</small></span><strong>${
          money(l.quantity * l.unit_cents)
        }</strong></div>`
      ).join("")
    }${q.notes ? `<p>${esc(q.notes)}</p>` : ""}${
      q.valid_until
        ? `<p class="muted">Valid until ${esc(date(q.valid_until))}</p>`
        : ""
    }${
      q.accepted_at
        ? `<p class="green">Accepted ${esc(date(q.accepted_at))}${
          q.accepted_by ? ` by ${esc(q.accepted_by)}` : ""
        }</p>`
        : ""
    }<div class="actions">${
      q.status === "draft"
        ? `<button class="btn small primary" data-quote-status="sent" data-id="${
          esc(q.id)
        }">Publish to portal</button><button class="btn small" data-quote-edit="${
          esc(q.id)
        }">Edit draft</button>`
        : ""
    }<button class="btn small" data-quote-copy="${
      esc(q.id)
    }">Copy to new draft</button>${
      ["draft", "sent"].includes(q.status)
        ? `<button class="btn small" data-quote-status="void" data-id="${
          esc(q.id)
        }">Void</button>`
        : ""
    }</div></article>`
  ).join("");
}
function billingReconcileHtml(p) {
  const admin = state.staff.some((s) =>
    s.id === state.userId && s.role === "admin"
  );
  const intro =
    '<div class="note critical-note"><strong>Billing history needs reconciliation.</strong><p>This project has Stripe records and historical HoneyBook links. Review the actual payments. If the owner confirms the project is fully paid through Stripe, choosing Stripe archives the old HoneyBook links and removes their active payment buttons. Projects with an outstanding balance keep their confirmed billing route.</p></div>';
  if (!admin) {
    return intro +
      '<p class="muted">A studio administrator must review this billing history before payment settings can change.</p>';
  }
  return intro +
    `<details><summary class="btn small">Review billing assignment</summary><form id="billingReconcileForm" class="form-grid" style="padding-top:18px"><label class="full">Confirmed provider<select name="provider" required>${
      options(
        { honeybook: "HoneyBook", stripe: "Stripe" },
        "",
        "Choose after reviewing payment history",
      )
    }</select></label><label class="full">External invoice / project URL<input name="url" type="url" maxlength="1200" value="${
      esc(p.external_billing_url)
    }" placeholder="https://…"></label><label class="full">External reference<input name="ref" maxlength="200" value="${
      esc(p.external_billing_ref)
    }"></label><label class="full">Reconciliation note<textarea name="note" minlength="20" maxlength="400" required placeholder="Record the owner-confirmed payment history and why this provider is correct."></textarea><small>20–400 characters. The reason is saved privately and the decision is recorded in activity history.</small></label><div class="full"><p class="field-note">Past invoices and paid amounts remain unchanged. Stripe is available only when a Stripe invoice is paid and every nonvoid invoice is paid; old HoneyBook links are archived before their payment buttons are removed. Unpaid or draft invoices block this exception.</p><button class="btn small ink">Record reconciliation</button><p class="form-error" role="alert"></p></div></form></details>`;
}

function billingHtml(p, invoices) {
  const locked = Boolean(p.billing_locked) ||
    p.billing_provider !== "unassigned" &&
      invoices.some((i) =>
        ["sent", "paid"].includes(i.status) || i.stripe_session_id
      );
  const totals = {
    due: invoices.filter((i) => i.status === "sent").reduce(
      (n, i) => n + i.amount_cents,
      0,
    ),
    paid: invoices.filter((i) => i.status === "paid").reduce(
      (n, i) => n + (i.paid_amount_cents ?? i.amount_cents),
      0,
    ),
  };
  return `<div class="billing-state">${
    pill(
      p.billing_provider || "unassigned",
      p.billing_provider === "honeybook"
        ? "HoneyBook"
        : p.billing_provider === "stripe"
        ? "Stripe"
        : "Choose billing provider",
    )
  }${locked ? '<span class="muted">Provider locked</span>' : ""}</div>${
    p.billing_requires_reconciliation
      ? billingReconcileHtml(p)
      : `<form id="billingForm" class="form-grid"><label class="full">Payment provider<select name="provider" ${
        locked ? "disabled" : ""
      }>${
        options({
          unassigned: "Choose provider",
          stripe: "Stripe",
          honeybook: "HoneyBook",
        }, p.billing_provider || "unassigned")
      }</select></label><label class="full">External invoice / project URL<input name="url" type="url" maxlength="1200" value="${
        esc(p.external_billing_url)
      }" placeholder="https://… HoneyBook project or invoice"></label><label class="full">External reference<input name="ref" value="${
        esc(p.external_billing_ref)
      }" maxlength="200" placeholder="Invoice or project reference"></label><div class="full"><p class="field-note">All payments for a HoneyBook project stay in HoneyBook, including the final balance. External balances are recorded manually; this does not synchronize HoneyBook.</p><button class="btn small ink">Save billing</button><p class="form-error" role="alert"></p></div></form>`
  }<div class="summary-strip"><div><b>${
    money(totals.paid)
  }</b><span>Recorded paid</span></div><div><b>${
    money(totals.due)
  }</b><span>Recorded unpaid</span></div></div>${
    safeUrl(p.external_billing_url)
      ? `<p><a class="text-link" href="${
        esc(safeUrl(p.external_billing_url))
      }" target="_blank" rel="noopener noreferrer">Open external billing ↗</a></p>`
      : ""
  }<div class="invoice-list">${
    invoices.map((i) =>
      `<div class="compact-row"><div><strong>${esc(i.title)}</strong><small>${
        i.due_date ? "Due " + esc(date(i.due_date)) : esc(i.kind || "Invoice")
      }</small></div><div>${
        money(
          i.status === "paid"
            ? i.paid_amount_cents ?? i.amount_cents
            : i.amount_cents,
        )
      } ${pill(i.status, i.status)}</div></div>`
    ).join("")
  }</div><a class="btn small" href="../admin.html?p=${
    encodeURIComponent(p.id)
  }">Manage invoices in Studio ↗</a>`;
}
function renderDetail() {
  const d = state.detail,
    p = d.project,
    review = (d.bookings || []).filter((b) => b.payment_review_required);
  workspace.innerHTML =
    `<a class="back-link" href="?view=pipeline" data-view="pipeline">← Pipeline</a>` +
    head(
      p.title || p.client_name,
      p.client_name + (p.company ? " · " + p.company : ""),
      review.length ? pill("overdue", "Booking needs review") : pill(p.status),
      "Project / " + p.id.slice(0, 8),
    ) +
    `<div class="help-links"><a class="btn ink" href="../inbox/?p=${
      encodeURIComponent(p.id)
    }">Open conversation</a><a class="btn" href="../admin.html?p=${
      encodeURIComponent(p.id)
    }">Contracts & galleries ↗</a><a class="btn" href="../schedule.html">Schedule ↗</a>${
      p.access_token
        ? '<button class="btn" data-copy-portal>Copy portal link</button>'
        : ""
    }</div>${
      review.length
        ? `<div class="note critical-note" role="alert"><strong>Payment recorded, booking needs review.</strong><p>This date was not automatically confirmed. ${
          review.map((b) =>
            esc(
              b.payment_review_reason ||
                "Check availability before confirming the booking.",
            )
          ).join(" ")
        }</p><a class="text-link" href="../schedule.html">Review in Schedule ↗</a></div>`
        : ""
    }${
      !p.client_email
        ? '<p class="note">This lead has no email address yet. Call, text or use the saved Instagram handle, then add an email before emailing them.</p>'
        : ""
    }<div id="clientExperience"></div><div class="detail-grid"><div>${
      section(
        "Project details",
        `<div class="detail-facts"><span>${
          esc(p.client_email || "No email")
        }</span>${
          p.client_phone ? `<span>${esc(p.client_phone)}</span>` : ""
        }<span>${
          esc(p.referral_source || "Source not set")
        }</span><span>Delivery: ${esc(date(p.delivery_target))}</span></div>${
          p.details ? `<p>${esc(p.details)}</p>` : ""
        }<details><summary class="btn small">Edit project details</summary><div style="padding-top:20px">${
          projectForm(p)
        }</div></details>`,
        "",
        "01",
      )
    }${
      section(
        "Tasks & follow-up",
        `<div class="task-list">${
          (d.tasks || []).length
            ? d.tasks.map((t) => taskHtml(t, true)).join("")
            : empty(
              "Set the next action",
              "Add a follow-up, production milestone or delivery deadline.",
            )
        }</div><details style="margin-top:18px"><summary class="btn small">+ Add next action</summary><div class="form-panel">${
          taskForm(p.id)
        }</div></details>`,
        "",
        "02",
      )
    }<div id="followupSettings"></div>${
      section(
        "Quotes",
        (d.quotes?.length ? quotesHtml(d.quotes) : empty(
          "Build a clear scope",
          "Save a quote draft, review it, then publish it to the client portal.",
        )) + quoteForm(),
        "",
        "03",
      )
    }${
      section(
        "Private notes",
        `<form id="notesForm"><label><span class="sr-only">Private project notes</span><textarea name="notes" rows="5" maxlength="4000" placeholder="Production details, preferences, things to remember…">${
          esc(p.notes_internal)
        }</textarea></label><div class="actions" style="margin-top:12px"><button class="btn small ink">Save notes</button></div><p class="form-error" role="alert"></p></form>`,
        "",
        "04",
      )
    }</div><div>${
      section("Billing", billingHtml(p, d.invoices || []), "", "05")
    }${
      section(
        "Production & delivery",
        `<p class="muted">Use tasks for preparation, editing, revisions and delivery. Contracts, proofing selections, storyboard approvals and final files stay attached to this project in Studio.</p><div class="detail-facts"><span>Shot date: <strong>${
          esc(date(p.event_date))
        }</strong></span><span>Delivery: <strong>${
          esc(date(p.delivery_target))
        }</strong></span></div><a class="btn small" href="../admin.html?p=${
          encodeURIComponent(p.id)
        }">Open proofing & delivery ↗</a>`,
        "",
        "06",
      )
    }${
      section(
        "Client history",
        (d.history || []).filter((h) => h.id !== p.id).map((h) =>
          `<div class="compact-row"><div><strong>${
            projectLink(h)
          }</strong><small>${esc(date(h.created_at))}</small></div>${
            pill(h.status)
          }</div>`
        ).join("") ||
          empty(
            "First project together",
            "Future jobs linked to this client will appear here.",
          ),
        "",
        "07",
      )
    }${
      section(
        "Activity",
        `<ul class="plain-list">${
          (d.activities || []).map((a) =>
            `<li class="activity">${esc(a.summary)}<small>${
              esc(time(a.created_at))
            }${a.actor_name ? ` · ${esc(a.actor_name)}` : ""}</small></li>`
          ).join("") ||
          '<li class="empty">Changes and milestones will appear here.</li>'
        }</ul>`,
        "",
        "08",
      )
    }</div></div><div id="projectOperations"></div>`;
}
function renderReports() {
  const d = state.dashboard,
    s = d.stats || {},
    counts = d.stage_counts || {},
    sum = Object.values(counts).reduce((n, v) => n + Number(v), 0);
  workspace.innerHTML = head(
    "Reports",
    "Live CRM totals across the full project history.",
    '<button class="btn" data-export="projects">Export projects</button>',
  ) +
    `<div class="summary-strip"><div><b>${
      esc(s.newLeads ?? 0)
    }</b><span>New leads this week</span></div><div><b>${
      esc(s.activeProjects ?? 0)
    }</b><span>Active projects</span></div><div><b>${
      money(s.collected)
    }</b><span>Collected in ${
      esc(s.monthName || "this month")
    }</span></div><div><b>${
      money(s.unpaid)
    }</b><span>Recorded outstanding</span></div></div>${healthPanel()}<div class="sections"><div>${
      section(
        "Projects by stage",
        Object.entries(STAGES).map(([k, label]) =>
          `<div class="report-row"><span>${
            esc(label)
          }</span><div class="report-bar" aria-hidden="true"><i style="width:${
            sum ? Number(counts[k] || 0) / sum * 100 : 0
          }%"></i></div><b>${esc(counts[k] || 0)}</b></div>`
        ).join(""),
      )
    }${
      section(
        "Lead sources",
        (d.sources || d.source_counts || []).length
          ? (d.sources || d.source_counts).map((s) =>
            `<div class="compact-row"><span>${
              esc(s.source || s.referral_source || "Unknown")
            }</span><strong>${Number(s.count || 0)}</strong></div>`
          ).join("")
          : empty(
            "Source reporting",
            "Record the source on every new lead. Source totals appear as the reporting data is available.",
          ),
      )
    }</div><div>${
      section(
        "Follow-up health",
        `<div class="compact-row"><span>Overdue</span><strong class="red">${
          esc(s.overdue ?? 0)
        }</strong></div><div class="compact-row"><span>Due today</span><strong>${
          esc(s.dueToday ?? 0)
        }</strong></div><div class="compact-row"><span>Waiting on a reply</span><strong>${
          esc(s.waiting ?? 0)
        }</strong></div><p class="report-caption">Due dates use Central Time. Collected totals use recorded paid invoices and payment dates.</p><a class="btn small" href="?view=today" data-view="today">Work through today</a>`,
      )
    }${
      section(
        "Marketing & revenue",
        '<p class="muted">Subscriber campaigns, outreach and the existing revenue summary remain in Growth. Campaign sends always require an explicit action.</p><a class="btn small" href="../growth.html">Open Growth ↗</a>',
      )
    }<p class="note">HoneyBook payment information is accurate only when its invoices and payments have been recorded in the CRM. This workspace does not claim an automatic HoneyBook sync.</p></div></div><div id="sourceReport"></div>`;
}
function getTask(id) {
  return [
    ...(state.detail?.tasks || []),
    ...(state.taskRows || []),
    ...(state.dashboard?.tasks || []),
  ].find((t) => t.id === id);
}
async function refreshContent() {
  state.dirty = false;
  if (
    extensionDirty.size &&
    !confirm("Reload this project and discard other unsaved changes?")
  ) return;
  extensionDirty.clear();
  await load();
}
async function mutateButton(button, work) {
  button.disabled = true;
  try {
    await work();
  } catch (e) {
    toast(e.message || "Couldn't save. Try again.");
  } finally {
    button.disabled = false;
  }
}
function dataForm(form) {
  return Object.fromEntries(new FormData(form));
}
function readLines(form) {
  return $$(".quote-line", form).map((row) => ({
    description: $("[data-line=description]", row).value.trim(),
    quantity: Number($("[data-line=quantity]", row).value),
    unit_cents: Math.round(Number($("[data-line=unit]", row).value) * 100),
  }));
}
function updateTotal(form) {
  const total = totalLines(readLines(form));
  $("#quoteTotal", form).textContent = money(
    Number.isFinite(total) ? total : 0,
  );
}
async function openContact(id) {
  const c = state.rows.find((x) => x.id === id),
    el = $(`[data-contact-detail="${id}"]`);
  if (!c || !el) return;
  if (!el.hidden) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = '<p class="muted">Loading client…</p>';
  try {
    const projects = await result(
      sb.from("bk_projects").select("id,title,client_name,status,created_at")
        .eq("contact_id", id).order("created_at", { ascending: false }),
    );
    el.innerHTML = `<div class="contact-projects">${
      (projects || []).map((p) => projectLink(p)).join("") ||
      '<span class="muted">No projects linked yet.</span>'
    }</div><form data-contact-form="${
      esc(id)
    }" class="form-grid contact-edit"><label>Name<input name="name" value="${
      esc(c.name)
    }" maxlength="120" required></label><label>Email<input name="email" type="email" value="${
      esc(c.email)
    }" maxlength="200"></label><label>Phone<input name="phone" value="${
      esc(c.phone)
    }" maxlength="40"></label><label>Instagram<input name="instagram" value="${
      esc(c.instagram)
    }" maxlength="31" pattern="@?[A-Za-z0-9._]{1,30}"></label><label>Company<input name="company" value="${
      esc(c.company)
    }" maxlength="160"></label><label>Source<input name="source" value="${
      esc(c.source)
    }" maxlength="120"></label><label class="full">Client preferences & notes<textarea name="notes" maxlength="4000">${
      esc(c.notes)
    }</textarea></label><div class="full actions"><button class="btn small ink">Save client</button><button class="btn small" type="button" data-new-client-project="${
      esc(c.id)
    }">+ New project</button></div><p class="full form-error" role="alert"></p></form>`;
  } catch (e) {
    el.textContent = e.message || "Couldn't load this client.";
  }
}
async function exportRows(kind, button) {
  await mutateButton(button, async () => {
    const name = kind === "contacts" ? "bk_crm_contacts" : "bk_crm_projects",
      rows = [];
    let offset = 0, total = Infinity;
    while (offset < total) {
      const r = await rpc(name, {
        p_query: state.view === (kind === "contacts" ? "clients" : "pipeline")
          ? state.q
          : "",
        ...(kind === "projects"
          ? { p_status: state.view === "pipeline" ? state.status : "all" }
          : {}),
        p_offset: offset,
        p_limit: 100,
      });
      total = Number(r.total || 0);
      if (!r.rows?.length) break;
      rows.push(...r.rows);
      offset += r.rows.length;
    }
    const columns = kind === "contacts"
      ? [
        ["Name", "name"],
        ["Email", "email"],
        ["Phone", "phone"],
        ["Company", "company"],
        ["Instagram", "instagram"],
        ["Source", "source"],
        ["Projects", "project_count"],
      ]
      : [
        ["Project ID", "id"],
        ["Client", "client_name"],
        ["Project", "title"],
        ["Email", "client_email"],
        ["Phone", "client_phone"],
        ["Service", "service"],
        ["Stage", "status"],
        ["Source", "referral_source"],
        ["Shoot date", "event_date"],
        ["Delivery target", "delivery_target"],
        ["Billing provider", "billing_provider"],
        ["Recorded paid", (r) => invoiceTotals(r).paid / 100],
        ["Recorded unpaid", (r) => invoiceTotals(r).due / 100],
      ];
    const url = URL.createObjectURL(
      new Blob(["\ufeff" + csvText(rows, columns)], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `taylormade-${kind}-${centralDay(new Date())}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Exported ${rows.length} ${kind}.`);
  });
}

document.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-view]");
  if (a) {
    e.preventDefault();
    navigate(a.dataset.view);
    return;
  }
  const p = e.target.closest("[data-project]");
  if (p) {
    e.preventDefault();
    navigate("pipeline", p.dataset.project);
    return;
  }
  const b = e.target.closest("button,a");
  if (!b) return;
  if (b.matches("[data-health-refresh]")) {
    loadHealth(state.seq, true);
    return;
  }
  if (b.matches("[data-new-lead]")) {
    openLead();
    return;
  }
  if (b.matches("[data-close-lead]")) {
    if (canLeave()) {
      $("#newLead").hidden = true;
      state.dirty = false;
    }
    return;
  }
  if (b.matches("[data-capture-close]")) {
    navigate("today");
    return;
  }
  if (b.matches("[data-retry],[data-refresh],[data-extension-retry]")) {
    if (canLeave()) {
      state.dirty = false;
      load();
    }
    return;
  }
  if (b.dataset.stage) {
    e.preventDefault();
    if (!canLeave()) return;
    state.view = "pipeline";
    state.project = null;
    state.status = b.dataset.stage;
    state.q = "";
    state.offset = 0;
    history.pushState({}, "", "?view=pipeline");
    load();
    return;
  }
  if (b.dataset.page) {
    if (!canLeave()) return;
    state.offset = Math.max(
      0,
      state.offset + (b.dataset.page === "next" ? state.limit : -state.limit),
    );
    load();
    return;
  }
  if (b.dataset.taskFilter) {
    if (!canLeave()) return;
    state.taskFilter = b.dataset.taskFilter;
    state.taskOffset = 0;
    await mutateButton(b, async () => {
      if (await loadTasks()) renderToday();
    });
    return;
  }
  if (b.dataset.taskPage) {
    if (!canLeave()) return;
    state.taskOffset = Math.max(
      0,
      state.taskOffset + (b.dataset.taskPage === "next" ? 30 : -30),
    );
    await mutateButton(b, async () => {
      if (await loadTasks()) renderToday();
    });
    return;
  }
  if (b.dataset.taskToggle) {
    if (!canLeave()) return;
    await mutateButton(b, async () => {
      await write("bk_tasks", b.dataset.taskToggle, {
        status: b.dataset.status !== "open" ? "open" : "done",
      });
      toast("Task updated");
      await refreshContent();
    });
    return;
  }
  if (b.dataset.taskWait) {
    if (!canLeave()) return;
    await mutateButton(b, async () => {
      const t = getTask(b.dataset.taskWait);
      const due = new Date(t?.due_at || Date.now());
      due.setDate(due.getDate() + 1);
      if (due < new Date()) due.setTime(Date.now() + 86400000);
      await write("bk_tasks", b.dataset.taskWait, {
        due_at: due.toISOString(),
      });
      toast("Moved to tomorrow");
      await refreshContent();
    });
    return;
  }
  if (b.dataset.taskEdit) {
    if (!canLeave()) return;
    const t = getTask(b.dataset.taskEdit), row = b.closest(".task");
    row.classList.add("inline-editor");
    row.innerHTML = `<form data-task-form="${
      esc(t.id)
    }"><div class="task-inline"><label>Next action<input name="title" value="${
      esc(t.title)
    }" maxlength="180" required></label><label>Due date & time (local)<input name="due_at" type="datetime-local" value="${
      esc(localInput(t.due_at))
    }" required></label><div class="actions"><button class="btn small ink">Save</button><button class="btn small" type="button" data-cancel-task>Keep task</button><button class="btn small danger" type="button" data-task-cancel="${
      esc(t.id)
    }">Cancel task</button></div></div><p class="form-error" role="alert"></p></form>`;
    $("input", row).focus();
    return;
  }
  if (b.dataset.taskCancel) {
    if (
      !confirm(
        "Cancel this task? It will leave the open queue, and its history stays on the project.",
      )
    ) return;
    await mutateButton(b, async () => {
      await write("bk_tasks", b.dataset.taskCancel, { status: "cancelled" });
      toast("Task canceled");
      await refreshContent();
    });
    return;
  }
  if (b.matches("[data-cancel-task]")) {
    if (canLeave()) refreshContent();
    return;
  }
  if (b.dataset.contactOpen) {
    openContact(b.dataset.contactOpen);
    return;
  }
  if (b.dataset.newClientProject) {
    const c = state.rows.find((c) => c.id === b.dataset.newClientProject);
    if (!openLead()) return;
    const form = $("#leadForm");
    state.contact = c.id;
    for (
      const [k, v] of Object.entries({
        client_name: c.name,
        client_email: c.email,
        client_phone: c.phone,
        instagram: c.instagram,
        company: c.company,
        referral_source: "Returning client",
      })
    ) if (form.elements[k]) form.elements[k].value = v || "";
    return;
  }
  if (b.matches("[data-copy-portal]")) {
    await mutateButton(b, async () => {
      const p = state.detail.project;
      await navigator.clipboard.writeText(
        `${location.origin}/portal.html?p=${encodeURIComponent(p.id)}&t=${
          encodeURIComponent(p.access_token)
        }`,
      );
      toast("Portal link copied");
    });
    return;
  }
  if (b.matches("[data-add-line]")) {
    $("#quoteLines").insertAdjacentHTML("beforeend", quoteLine());
    state.dirty = true;
    return;
  }
  if (b.matches("[data-remove-line]")) {
    const form = b.closest("form");
    if ($$(".quote-line", form).length > 1) b.closest(".quote-line").remove();
    updateTotal(form);
    state.dirty = true;
    return;
  }
  if (b.dataset.quoteEdit || b.dataset.quoteCopy) {
    if (!canLeave()) return;
    const q = state.detail.quotes.find((q) =>
        q.id === (b.dataset.quoteEdit || b.dataset.quoteCopy)
      ),
      editor = $("#quoteEditor"),
      form = $("#quoteForm");
    editor.open = true;
    if (b.dataset.quoteCopy) delete form.dataset.quote;
    else form.dataset.quote = q.id;
    form.elements.title.value = q.title;
    form.elements.notes.value = q.notes || "";
    form.elements.valid_until.value = q.valid_until || "";
    $("#quoteLines").innerHTML =
      "<label>Description</label><label>Qty</label><label>Unit $</label><span></span>" +
      q.lines.map(quoteLine).join("");
    updateTotal(form);
    form.scrollIntoView({ block: "center" });
    form.elements.title.focus();
    if (b.dataset.quoteCopy) {
      state.dirty = true;
      toast("Copied into a new draft. Review it before saving.");
    }
    return;
  }
  if (b.dataset.quoteStatus) {
    if (!canLeave()) return;
    if (
      b.dataset.quoteStatus === "sent" &&
      !confirm(
        "Publish this quote to the client's portal? Its scope and price will be locked. No email will be sent.",
      )
    ) return;
    if (
      b.dataset.quoteStatus === "void" &&
      !confirm(
        "Void this quote? The client will no longer be able to accept it.",
      )
    ) return;
    await mutateButton(b, async () => {
      await rpc("bk_crm_quote_status", {
        p_quote: b.dataset.id,
        p_status: b.dataset.quoteStatus,
      });
      toast(
        b.dataset.quoteStatus === "sent"
          ? "Quote published in portal"
          : "Quote voided",
      );
      await refreshContent();
    });
    return;
  }
  if (b.dataset.export) {
    await exportRows(b.dataset.export, b);
    return;
  }
});
document.addEventListener("input", (e) => {
  if (
    e.target.closest("form") &&
    !e.target.closest("#searchForm,#loginForm,[data-crm-extension]")
  ) {
    state.dirty = true;
  }
  if (e.target.closest("#quoteForm")) updateTotal($("#quoteForm"));
});
document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (f.id === "loginForm") return;
  e.preventDefault();
  if (f.id === "searchForm") {
    if (!canLeave()) return;
    state.q = f.elements.q.value.trim();
    state.status = f.elements.stage?.value || "all";
    state.offset = 0;
    load();
    return;
  }
  if (f.id === "leadForm" || f.id === "projectForm") {
    await saving(f, async () => {
      const p = dataForm(f);
      for (const k of ["event_date", "delivery_target", "owner_id"]) {
        p[k] = p[k] || null;
      }
      for (
        const k of ["client_email", "client_phone", "instagram", "company"]
      ) p[k] = p[k]?.trim() || null;
      p.instagram = p.instagram?.replace(/^@/, "") || null;
      if (!p.client_email && !p.client_phone && !p.instagram) {
        throw Error("Add an email, phone number or Instagram handle.");
      }
      if (p.status === "lost" && !p.lost_reason?.trim()) {
        throw Error("Add a reason before marking this project lost.");
      }
      if (f.id === "leadForm") {
        p.request_id = f.dataset.requestId;
        if (state.contact) p.contact_id = state.contact;
        const created = await rpc("bk_crm_create_project", { p_data: p });
        $("#newLead").hidden = true;
        state.dirty = false;
        toast("Lead created with a follow-up task");
        await navigate("pipeline", created.id || created.project?.id);
      } else {
        await rpc("bk_crm_save_project", {
          p_project: state.project,
          p_data: p,
        });
        toast("Project saved");
        await refreshContent();
      }
    });
    return;
  }
  if (f.id === "notesForm") {
    await saving(f, async () => {
      await write("bk_projects", state.project, {
        notes_internal: f.elements.notes.value,
      });
      toast("Notes saved");
    });
    return;
  }
  if (f.id === "taskForm") {
    await saving(f, async () => {
      const p = dataForm(f);
      await insert("bk_tasks", {
        project_id: state.project,
        contact_id: state.detail.project.contact_id,
        title: p.title.trim(),
        kind: p.kind,
        due_at: new Date(p.due_at).toISOString(),
        owner_id: p.owner_id || null,
        notes: p.notes || "",
      });
      toast("Next action added");
      await refreshContent();
    });
    return;
  }
  if (f.dataset.taskForm) {
    await saving(f, async () => {
      await write("bk_tasks", f.dataset.taskForm, {
        title: f.elements.title.value.trim(),
        due_at: new Date(f.elements.due_at.value).toISOString(),
      });
      toast("Next action rescheduled");
      await refreshContent();
    });
    return;
  }
  if (f.dataset.contactForm) {
    await saving(f, async () => {
      const p = dataForm(f);
      for (const k of ["email", "phone", "instagram", "company"]) {
        p[k] = p[k]?.trim() || null;
      }
      p.instagram = p.instagram?.replace(/^@/, "") || null;
      if (!p.email && !p.phone && !p.instagram) {
        throw Error("Keep at least one contact channel.");
      }
      await write("bk_contacts", f.dataset.contactForm, p);
      toast("Client saved");
      await refreshContent();
    });
    return;
  }
  if (f.id === "billingReconcileForm") {
    const p = dataForm(f);
    if (
      !confirm(
        p.provider === "stripe"
          ? "Record this project as fully paid through Stripe and archive its historical HoneyBook payment links? Existing invoices, paid amounts and project stage will stay unchanged."
          : "Record HoneyBook as the provider for remaining payments? The review reason will be saved privately and the decision recorded in activity history.",
      )
    ) return;
    await saving(f, async () => {
      if (
        !state.staff.some((s) => s.id === state.userId && s.role === "admin")
      ) {
        throw Error(
          "A studio administrator must reconcile this billing history.",
        );
      }
      if (!["stripe", "honeybook"].includes(p.provider)) {
        throw Error("Choose the confirmed payment provider.");
      }
      if (p.note.trim().length < 20 || p.note.trim().length > 400) {
        throw Error("Add a review note between 20 and 400 characters.");
      }
      if (p.url && !safeUrl(p.url)) {
        throw Error("Use a full https:// billing link.");
      }
      await rpc("bk_reconcile_project_billing", {
        p_project: state.project,
        p_provider: p.provider,
        p_note: p.note.trim(),
        p_url: p.url || null,
        p_ref: p.ref || null,
      });
      toast("Billing reconciliation recorded");
      await refreshContent();
    });
    return;
  }
  if (f.id === "billingForm") {
    await saving(f, async () => {
      const p = dataForm(f),
        provider = f.elements.provider.disabled
          ? state.detail.project.billing_provider
          : p.provider;
      if (provider === "unassigned") {
        throw Error("Choose Stripe or HoneyBook before saving billing.");
      }
      if (p.url && !safeUrl(p.url)) {
        throw Error("Use a full https:// billing link.");
      }
      await rpc("bk_set_project_billing", {
        p_project: state.project,
        p_provider: provider,
        p_url: p.url || null,
        p_ref: p.ref || null,
      });
      toast("Billing saved");
      await refreshContent();
    });
    return;
  }
  if (f.id === "quoteForm") {
    await saving(f, async () => {
      const p = dataForm(f);
      p.lines = readLines(f);
      p.valid_until = p.valid_until || null;
      if (
        !p.lines.length ||
        p.lines.some((l) =>
          !l.description || !(Number.isInteger(l.quantity) && l.quantity > 0) ||
          !Number.isSafeInteger(l.unit_cents) || l.unit_cents < 0
        )
      ) {
        throw Error(
          "Each line needs a description, a positive quantity and a valid price.",
        );
      }
      await rpc("bk_crm_save_quote", {
        p_project: state.project,
        p_data: p,
        p_quote: f.dataset.quote || null,
      });
      toast("Quote draft saved");
      await refreshContent();
    });
    return;
  }
});
$("#newLeadBtn").addEventListener("click", openLead);
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = $("#loginBtn");
  b.disabled = true;
  $("#loginErr").textContent = "";
  try {
    const { error } = await sb.auth.signInWithPassword({
      email: $("#email").value.trim(),
      password: $("#password").value,
    });
    if (error) throw error;
    await boot();
  } catch (e) {
    $("#loginErr").textContent = e.message || "Couldn't sign in.";
  } finally {
    b.disabled = false;
  }
});
$("#googleBtn").addEventListener("click", async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: location.origin + "/crm/" + location.search },
  });
  if (error) $("#loginErr").textContent = error.message;
});
$("#logoutBtn").addEventListener("click", async () => {
  if (!canLeave()) return;
  await sb.auth.signOut();
  location.replace("/crm/");
});
window.addEventListener("beforeunload", (e) => {
  if (state.dirty || extensionDirty.size) {
    e.preventDefault();
    e.returnValue = "";
  }
});
window.addEventListener("popstate", () => {
  if (!canLeave()) {
    history.pushState(
      {},
      "",
      `?view=${state.view}${
        state.project ? `&p=${encodeURIComponent(state.project)}` : ""
      }`,
    );
    return;
  }
  state.dirty = false;
  extensionDirty.clear();
  readRoute();
  load();
});
function readRoute() {
  const q = new URLSearchParams(location.search);
  state.view = [
      "today",
      "pipeline",
      "clients",
      "reports",
      "capacity",
      "retainers",
      "profit",
      "capture",
    ].includes(q.get("view"))
    ? q.get("view")
    : "today";
  state.project = q.get("p");
  if (q.get("capture") === "1") state.view = "capture";
}
async function boot() {
  const { data, error } = await sb.auth.getSession();
  if (error) {
    $("#loginErr").textContent = error.message;
    return;
  }
  if (!data.session) return;
  state.userId = data.session.user.id;
  $("#loginView").hidden = true;
  $("#appView").hidden = false;
  readRoute();
  await load();
}
boot();
