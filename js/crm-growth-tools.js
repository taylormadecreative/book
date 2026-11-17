import {
  centralDay,
  csvText,
  esc,
  money,
  time,
} from "./crm-workspace-view.js?v=1";

const SOURCES = [
  "Instagram",
  "Facebook",
  "TikTok",
  "LinkedIn",
  "YouTube",
  "Search",
  "Referral",
  "Email",
  "Phone / text",
  "Website / direct",
  "Other",
  "Unknown",
];

function section(title, body, aside = "") {
  return '<section class="section crm-growth"><header class="section-head"><h2>' +
    esc(title) + "</h2>" + aside + "</header>" + body + "</section>";
}

function errorHtml(message) {
  return '<p class="growth-error" role="alert">' + esc(message) +
    '</p><button class="btn small" type="button" data-growth-retry>Try again</button>';
}

function notify(toast, message) {
  if (typeof toast === "function") toast(message);
}

function requestFor(pending, key, payload) {
  const fingerprint = JSON.stringify(payload);
  const previous = pending.get(key);
  if (previous?.fingerprint === fingerprint) return previous.id;
  const id = crypto.randomUUID();
  pending.set(key, { id, fingerprint });
  return id;
}

function download(rows, name, columns) {
  const blob = new Blob([csvText(rows, columns)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountMorningList(root, {
  rpc,
  toast,
  openProject,
  onChange,
}) {
  let offset = 0;
  let sequence = 0;
  let busy = false;
  const pending = new Map();

  async function refresh() {
    const current = ++sequence;
    root.innerHTML = section(
      "Morning follow-up",
      '<p role="status">Loading due actions…</p>',
    );
    try {
      const result = await rpc("bk_crm_morning", {
        p_day: null,
        p_owner: null,
        p_offset: offset,
        p_limit: 20,
      });
      if (!root.isConnected || current !== sequence) return;
      if (!Array.isArray(result?.rows)) {
        throw Error("The morning list could not load.");
      }
      const rows = result.rows.map((task) => {
        const step = task.cadence_step
          ? " · Touch " + task.cadence_step + " of " + task.cadence_total
          : "";
        const phone = String(task.phone || "").replace(/[^\d+]/g, "");
        return '<article class="growth-action"><div><h3>' +
          esc(task.client_name) +
          '</h3><p class="growth-project">' + esc(task.project_title) +
          '</p><p class="growth-meta">' + esc(task.title) + step +
          '</p><p class="growth-meta">' + esc(time(task.due_at)) + " · " +
          esc(task.source) + '</p></div><div class="growth-actions">' +
          '<button class="btn small" type="button" data-growth-project="' +
          esc(task.project_id) +
          '">Project</button><a class="btn small" href="' +
          esc(task.conversation_url) +
          '">Conversation</a><a class="btn small ink" href="' +
          esc(task.template_url) + '">Open reply template</a>' +
          (phone
            ? '<a class="text-link" href="tel:' + esc(phone) + '">Call</a>'
            : "") +
          '<button class="btn small" type="button" data-growth-done="' +
          esc(task.id) +
          '">Mark followed up</button><button class="btn small" type="button" data-growth-snooze="' +
          esc(task.id) + '">Tomorrow</button></div></article>';
      }).join("");
      const pager = result.total > 20
        ? '<nav class="growth-pagination" aria-label="Morning list pages"><button class="btn small" type="button" data-growth-page="previous" ' +
          (offset === 0 ? "disabled" : "") + ">Previous</button><span>" +
          (offset + 1) + "–" +
          Math.min(offset + result.rows.length, result.total) +
          " of " + result.total +
          '</span><button class="btn small" type="button" data-growth-page="next" ' +
          (offset + result.rows.length >= result.total ? "disabled" : "") +
          ">Next</button></nav>"
        : "";
      const body =
        '<p class="growth-intro">Open a conversation or template, then mark your follow-up complete.</p>' +
        '<div class="growth-counts"><span><b>' +
        Number(result.counts?.overdue || 0) +
        "</b> overdue</span><span><b>" + Number(result.counts?.today || 0) +
        "</b> today</span><span><b>" + Number(result.counts?.unassigned || 0) +
        '</b> unassigned</span></div><div class="growth-action-list">' +
        (rows ||
          '<p class="muted">No follow-ups are due through today. Future actions stay on their scheduled date.</p>') +
        "</div>" + pager +
        '<p class="growth-error" data-growth-error role="alert"></p>';
      root.innerHTML = section(
        "Morning follow-up",
        body,
        '<button class="btn small" type="button" data-growth-refresh>Refresh</button>',
      );
    } catch (error) {
      if (root.isConnected && current === sequence) {
        root.innerHTML = section("Morning follow-up", errorHtml(error.message));
      }
    }
  }

  root.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target || busy) return;
    if (
      target.hasAttribute("data-growth-retry") ||
      target.hasAttribute("data-growth-refresh")
    ) {
      await refresh();
      return;
    }
    if (target.dataset.growthProject) {
      if (openProject) await openProject(target.dataset.growthProject);
      return;
    }
    if (target.dataset.growthPage) {
      offset = Math.max(
        0,
        offset + (target.dataset.growthPage === "next" ? 20 : -20),
      );
      await refresh();
      return;
    }
    const task = target.dataset.growthDone || target.dataset.growthSnooze;
    if (!task) return;
    const action = target.dataset.growthDone ? "done" : "snooze";
    // The server resolves next business morning in Central time. Keeping this
    // intent canonical also preserves retries across a browser's local midnight.
    const payload = { p_task: task, p_action: action, p_due_at: null };
    const key = task + ":" + action;
    const request = requestFor(pending, key, payload);
    busy = true;
    target.disabled = true;
    try {
      await rpc("bk_crm_followup_action", {
        ...payload,
        p_request_id: request,
      });
      pending.delete(key);
      notify(
        toast,
        action === "done"
          ? "Follow-up recorded"
          : "Moved to next business morning",
      );
      if (onChange) await onChange();
      else await refresh();
    } catch (error) {
      const message = root.querySelector("[data-growth-error]");
      if (message) {
        message.textContent = error.message ||
          "That action did not save. Try again.";
      }
      target.disabled = false;
    } finally {
      busy = false;
    }
  });

  refresh();
  return { refresh };
}

function responseHours(value) {
  return value == null ? "No recorded reply" : Number(value).toFixed(1) + " h";
}

function reportTable(rows, campaign = false) {
  if (!rows.length) {
    return '<p class="muted">No project opportunities match these filters.</p>';
  }
  const headings = campaign ? "<th>Source / campaign</th>" : "<th>Source</th>";
  return '<div class="growth-table-wrap"><table class="growth-table"><thead><tr>' +
    headings +
    "<th>Leads / jobs</th><th>Booked</th><th>Conversion</th><th>Recorded receipts</th><th>First reply median</th></tr></thead><tbody>" +
    rows.map((row) =>
      "<tr><th>" + esc(row.source) +
      (campaign ? "<small>" + esc(row.campaign) + "</small>" : "") +
      "</th><td>" + Number(row.leads) + "</td><td>" + Number(row.booked) +
      "</td><td>" + Number(row.conversion_pct || 0).toFixed(1) + "%</td><td>" +
      money(row.receipts_cents) + "</td><td>" +
      esc(responseHours(row.median_response_hours)) +
      "<small>" + Number(row.responded) + " recorded replies</small></td></tr>"
    ).join("") + "</tbody></table></div>";
}

export function mountSourceReport(root, { rpc, toast, onDirty }) {
  let currentReport = null;
  let busy = false;
  const today = centralDay(new Date());
  const past = centralDay(new Date(Date.now() - 90 * 86400000));
  root.innerHTML = section(
    "Where opportunities come from",
    '<p class="growth-intro">Choose an acquisition cohort. Each project opportunity counts once, including repeat jobs for an existing client. Outcomes and receipts are recorded to date.</p>' +
      '<form class="growth-filters"><label>Acquired from<input type="date" name="from" value="' +
      past +
      '" required></label><label>Through<input type="date" name="to" value="' +
      today +
      '" required></label><label>Source<select name="source"><option value="">All sources</option>' +
      SOURCES.map((source) =>
        '<option value="' + esc(source) + '">' + esc(source) + "</option>"
      ).join("") +
      '</select></label><label>Campaign<input name="campaign" maxlength="180" placeholder="Exact campaign name"></label><button class="btn ink" type="submit">Apply filters</button></form>' +
      '<div data-growth-report role="status">Loading source report…</div>',
  );

  const form = root.querySelector("form");
  const result = root.querySelector("[data-growth-report]");

  async function refresh() {
    if (busy) return;
    busy = true;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      const report = await rpc("bk_crm_source_report", {
        p_from: form.elements.from.value,
        p_to: form.elements.to.value,
        p_source: form.elements.source.value || null,
        p_campaign: form.elements.campaign.value.trim() || null,
      });
      if (!root.isConnected) return;
      if (!Array.isArray(report?.rows)) {
        throw Error("The source report could not load.");
      }
      currentReport = report;
      onDirty?.(false);
      result.innerHTML = '<div class="growth-report-totals"><span><b>' +
        Number(report.totals.leads) + "</b> opportunities</span><span><b>" +
        Number(report.totals.booked) + "</b> booked</span><span><b>" +
        money(report.totals.receipts_cents) +
        "</b> recorded paid</span></div>" +
        "<h3>By source</h3>" + reportTable(report.rows) +
        '<button class="btn small" type="button" data-growth-export="sources">Export source CSV</button>' +
        '<h3 class="growth-campaign-heading">By campaign</h3>' +
        reportTable(report.campaigns || [], true) +
        (report.campaign_total > 100
          ? '<p class="muted">Showing 100 of ' + Number(report.campaign_total) +
            " campaign groups. Apply an exact campaign filter for the full selected group.</p>"
          : "") +
        '<p class="growth-footnote">Booked means a booked/production/delivered project or a confirmed/completed booking. Paid extra edits and review-held payments alone do not count as bookings. First reply means the first recorded studio message, not delivery confirmation. Receipts use actual paid amounts; older paid invoices without that value use their recorded face amount. Source and UTM data describe attribution, not a verified cause of a sale.</p>';
    } catch (error) {
      if (root.isConnected) result.innerHTML = errorHtml(error.message);
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  form.addEventListener("input", () => onDirty?.(true));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (form.reportValidity()) refresh();
  });
  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-growth-retry]")) refresh();
    if (event.target.closest("[data-growth-export]") && currentReport) {
      download(currentReport.rows, "source-opportunities.csv", [
        ["Source", "source"],
        ["Opportunities", "leads"],
        ["Booked", "booked"],
        ["Conversion percent", "conversion_pct"],
        ["Recorded receipts cents", "receipts_cents"],
        ["Median first reply hours", "median_response_hours"],
        ["Recorded replies", "responded"],
      ]);
      notify(toast, "Source report exported");
    }
  });
  refresh();
  return { refresh };
}

function parseDays(value) {
  const days = String(value).split(",").map((part) => Number(part.trim()));
  if (
    !days.length || days.length > 8 ||
    days.some((day, index) =>
      !Number.isInteger(day) || day < 1 || day > 60 ||
      (index > 0 && day <= days[index - 1])
    )
  ) {
    throw Error("Enter 1–8 increasing business-day offsets between 1 and 60.");
  }
  return days;
}

export function mountFollowupSettings(root, {
  rpc,
  project,
  toast,
  onChange,
  onDirty,
}) {
  const projectId = typeof project === "string" ? project : project?.id;
  const pending = new Map();
  let busy = false;

  async function refresh() {
    root.innerHTML = section(
      "Follow-up cadence",
      '<p role="status">Loading cadence…</p>',
    );
    try {
      const plan = await rpc("bk_crm_followup_settings", {
        p_project: projectId,
      });
      if (!root.isConnected) return;
      if (!plan?.project_id) throw Error("Follow-up settings could not load.");
      const status = !plan.enabled ? "Paused" : {
        active: "Enabled",
        paused: "Paused",
        client_replied: "Paused after client reply",
        complete: "Complete",
        stopped: "Stopped",
      }[plan.state] || "Paused";
      root.innerHTML = section(
        "Follow-up cadence",
        '<details class="growth-cadence"><summary><strong>' + esc(status) +
          "</strong>" + (plan.next_due_at
            ? " · Next action " + esc(time(plan.next_due_at))
            : "") +
          "<span>Edit reminders</span></summary>" +
          '<p class="growth-intro">These reminders create tasks for you to complete. Choose the business days after an inquiry or quote when each follow-up should be due, at 9am Central.</p>' +
          '<form class="growth-settings"><label class="growth-checkbox"><input type="checkbox" name="enabled" ' +
          (plan.enabled ? "checked" : "") +
          '> Enable staff follow-up cadence</label><label>Inquiry day offsets<input name="lead_days" value="' +
          esc(plan.lead_days.join(", ")) +
          '" required inputmode="numeric"></label><label>Quote day offsets<input name="quote_days" value="' +
          esc(plan.quote_days.join(", ")) +
          '" required inputmode="numeric"></label><label class="growth-checkbox"><input type="checkbox" name="restart"> Start a fresh cycle after this save</label>' +
          '<p class="growth-footnote">Client replies and quote decisions pause reminders until you handle the reply. Booking or closing the project stops follow-ups. Rescheduling a task keeps later reminders spaced apart. A fresh cycle starts the schedule over.</p>' +
          '<button class="btn small ink" type="submit">Save cadence</button><p class="growth-error" role="alert"></p></form></details>',
      );
      const form = root.querySelector("form");
      form.addEventListener("input", () =>
        onDirty?.(true));
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy || !form.reportValidity()) return;
        const error = form.querySelector('[role="alert"]');
        const button = form.querySelector("button");
        try {
          const settings = {
            enabled: form.elements.enabled.checked,
            lead_days: parseDays(form.elements.lead_days.value),
            quote_days: parseDays(form.elements.quote_days.value),
            restart: form.elements.restart.checked,
          };
          const payload = { p_project: projectId, p_settings: settings };
          const request = requestFor(pending, "settings", payload);
          busy = true;
          button.disabled = true;
          error.textContent = "";
          await rpc("bk_crm_set_followup", {
            ...payload,
            p_request_id: request,
          });
          pending.delete("settings");
          onDirty?.(false);
          notify(toast, "Follow-up cadence saved");
          if (onChange) await onChange();
          else await refresh();
        } catch (failure) {
          error.textContent = failure.message ||
            "That did not save. Your settings are still here.";
          button.disabled = false;
        } finally {
          busy = false;
        }
      });
    } catch (error) {
      if (root.isConnected) {
        root.innerHTML = section("Follow-up cadence", errorHtml(error.message));
      }
    }
  }

  root.addEventListener("click", (event) => {
    if (event.target.closest("[data-growth-retry]")) refresh();
  });
  refresh();
  return { refresh };
}
