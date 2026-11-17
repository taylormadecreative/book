/* Studio operations: explicit staff saves, internal cost assumptions, and monthly
   allowance accounting. This module never sends an invoice or charges a card. */
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const money = (cents) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(cents || 0) / 100,
  );
const hours = (minutes) => `${(Number(minutes || 0) / 60).toFixed(1)}h`;
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const uuid = () => crypto.randomUUID();
const date = (value) => {
  if (!value) return "No date";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return escape(value);
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return "Invalid date";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const dollars = (cents) => (Number(cents || 0) / 100).toFixed(2);
const option = (value, label, selected) =>
  `<option value="${escape(value)}"${
    String(value) === String(selected) ? " selected" : ""
  }>${escape(label)}</option>`;
const button = (label, action, id = "", extra = "") =>
  `<button type="button" class="ops-button" data-ops-action="${action}" data-id="${
    escape(id)
  }" ${extra}>${escape(label)}</button>`;
const empty = (text) => `<p class="ops-empty">${escape(text)}</p>`;
const field = (label, name, value = "", type = "text", attributes = "") =>
  `<label class="ops-field"><span>${
    escape(label)
  }</span><input name="${name}" type="${type}" value="${
    escape(value)
  }" ${attributes}></label>`;
const select = (label, name, content) =>
  `<label class="ops-field"><span>${
    escape(label)
  }</span><select name="${name}">${content}</select></label>`;
const note = (
  name = "notes",
  value = "",
  max = 2000,
  label = "Internal notes",
) =>
  `<label class="ops-field ops-wide"><span>${label}</span><textarea name="${name}" maxlength="${max}" rows="2">${
    escape(value)
  }</textarea></label>`;
const staffOptions = (staff, selected) =>
  staff.map((s) => option(s.id, s.full_name || "Staff member", selected)).join(
    "",
  );
const projectLink = (id, title) =>
  `<a class="ops-project-link" href="/crm/?view=pipeline&p=${
    encodeURIComponent(id)
  }" data-ops-project="${escape(id)}">${escape(title || "Open project")}</a>`;
const panel = (title, content, actions = "") =>
  `<section class="ops-section"><div class="ops-heading"><h2>${
    escape(title)
  }</h2>${actions}</div>${content}</section>`;
const form = (action, content, title = "", id = "") =>
  `<form class="ops-form" data-ops-form="${action}" data-id="${
    escape(id)
  }" data-request="${uuid()}">${
    title ? `<h3>${escape(title)}</h3>` : ""
  }<div class="ops-fields">${content}</div><p class="ops-form-error" role="alert" hidden></p><div class="ops-actions"><button class="ops-button ops-primary" type="submit">Save${
    action === "prepare_invoice" ? " draft" : ""
  }</button>${button("Cancel", "cancel")}</div></form>`;
const summary = (values) =>
  `<div class="ops-metrics">${
    [
      ["Quoted", "quote_cents"],
      ["Invoiced", "invoiced_cents"],
      ["Received", "received_cents"],
      ["Expenses", "expenses_cents"],
      ["Labor assumption", "labor_cents"],
      ["Contribution", "contribution_cents"],
    ].map(([label, key]) =>
      `<div class="${
        key === "contribution_cents" && Number(values?.[key]) < 0
          ? "ops-warning"
          : ""
      }"><span>${label}</span><strong>${money(values?.[key])}</strong></div>`
    ).join("")
  }</div><p class="ops-help">Contribution = recorded receipts − expenses − labor at saved internal hourly cost. This excludes overhead and taxes. Quotes and issued invoices are shown separately from money received.</p>`;

function periodState(period) {
  if (period.period_state) return period.period_state;
  if (period.status === "closed") return "closed";
  const day = date(new Date().toISOString());
  if (day < period.starts_on) return "upcoming";
  if (day > period.ends_on) return "expired";
  return "open";
}
function allowanceRows(period) {
  const current = periodState(period) === "open" &&
    !["draft", "cancelled"].includes(period.package_status);
  return `<div class="ops-table-wrap"><table class="ops-table"><caption class="ops-sr">Monthly included deliverables and current availability</caption><thead><tr><th>Deliverable</th><th>Included</th><th>Fulfilled</th><th>Unused</th><th>Available now</th></tr></thead><tbody>${
    (period.allowances || []).map((a) =>
      `<tr><th scope="row">${
        escape(a.label)
      }</th><td>${a.included}</td><td>${a.used}</td><td>${a.remaining}</td><td><strong>${
        current ? Number(a.available_now ?? a.remaining) : 0
      }</strong></td></tr>`
    ).join("")
  }</tbody></table></div>`;
}
function periodCard(p, name, allowActions = true) {
  const state = periodState(p);
  const canFulfill = state === "open" &&
    !["draft", "cancelled"].includes(p.package_status);
  const stateMessage = {
    expired:
      "This month has expired. Unused counts are historical and unavailable for new work. Open the current month to record new fulfillment.",
    upcoming:
      "This month has not started. Its allowances become available on the start date.",
    closed:
      "This period is closed. Unused counts are historical and unavailable for new work.",
    open: "Unused allowances expire at the end of this calendar period.",
  }[state];
  return `<article class="ops-period" data-period-state="${state}"><div class="ops-heading"><div><h3>${
    escape(name || p.retainer_name || "Monthly work period")
  }</h3><p>${date(p.starts_on)} – ${
    date(p.ends_on)
  } · <span class="ops-badge">${escape(state)}</span></p></div><strong>${
    money(p.monthly_amount_cents)
  }</strong></div>${allowanceRows(p)}<p class="ops-help">${
    p.package_status ? `Package: ${escape(p.package_status)} · ` : ""
  }${escape(p.billing_provider || "")} · Invoice: ${
    escape(p.invoice_status || "not prepared")
  }. ${escape(stateMessage)}</p>${
    allowActions
      ? `<div class="ops-actions">${
        canFulfill ? button("Record fulfilled work", "use", p.id) : ""
      }${
        p.status === "open" ? button("Adjust allowance", "adjust", p.id) : ""
      }${
        (p.usage || []).some((u) => u.reversible_quantity > 0)
          ? button("Correct usage", "return", p.id)
          : ""
      }${
        !p.invoice_id
          ? button("Prepare monthly invoice", "invoice", p.id)
          : `<a class="ops-button" href="/admin.html?p=${
            encodeURIComponent(p.project_id)
          }">Review invoice in Studio</a>`
      }${
        p.status === "open" ? button("Close period", "close", p.id) : ""
      }</div><details><summary>Usage ledger (${
        (p.usage || []).length
      })</summary>${
        (p.usage || []).map((u) =>
          `<p class="ops-ledger">${date(u.created_at)} · ${
            Number(u.quantity_delta) > 0 ? "+" : ""
          }${u.quantity_delta} ${escape(u.item_key)} · ${escape(u.note)}</p>`
        ).join("") || empty("No fulfilled deliverables recorded.")
      }</details>`
      : ""
  }</article>`;
}

const mounted = new WeakMap();

function controller(root, context) {
  mounted.get(root)?.abort();
  const lifecycle = new AbortController();
  mounted.set(root, lifecycle);
  const listen = (type, callback) =>
    root.addEventListener(type, callback, { signal: lifecycle.signal });
  const state = {
    data: null,
    form: "",
    record: null,
    offset: 0,
    query: "",
    week: today(),
    contacts: [],
    contactQuery: "",
    contactOffset: 0,
    contactTotal: 0,
    selectedContact: null,
    projects: [],
    projectQuery: "",
    projectOffset: 0,
    projectTotal: 0,
    selectedProject: null,
    dirty: false,
    saving: false,
  };
  root.classList.add("ops");
  const dirty = (value) => {
    state.dirty = value;
    context.onDirty?.(value);
  };
  const canReplace = () =>
    !state.dirty || confirm("Leave this form without saving your changes?");
  function error(message) {
    const target = root.querySelector(".ops-form-error");
    if (target) {
      target.hidden = false;
      target.textContent = message;
      target.focus?.();
    } else context.toast?.(message);
  }
  async function load() {
    const version = state.version = (state.version || 0) + 1;
    root.setAttribute("aria-busy", "true");
    if (!state.data) {
      root.innerHTML =
        '<p class="ops-help" role="status">Loading studio operations…</p>';
    }
    try {
      const name = context.project ? "bk_ops_project" : ({
        profit: "bk_ops_profit",
        capacity: "bk_ops_capacity",
        retainers: "bk_ops_retainers",
      })[context.view];
      const args = context.project
        ? { p_project: context.project.id }
        : context.view === "capacity"
        ? { p_week: state.week }
        : { p_offset: state.offset, p_limit: 20, p_query: state.query };
      const data = await context.rpc(name, args);
      if (version !== state.version || lifecycle.signal.aborted) return;
      state.data = data;
      render();
    } catch (e) {
      if (version !== state.version || lifecycle.signal.aborted) return;
      root.innerHTML = panel(
        "Studio operations unavailable",
        `<p role="alert">${
          escape(
            e?.message ||
              "The connection could not load these records. No changes were made.",
          )
        }</p><p class="ops-help">If setup is pending, install the studio operations migration before using this tool.</p>${
          button("Try again", "retry")
        }`,
      );
    } finally {
      if (version === state.version) root.removeAttribute("aria-busy");
    }
  }
  function openForm(type, record = null) {
    if (!canReplace()) return;
    state.form = type;
    state.record = record;
    dirty(false);
    render();
    root.querySelector(
      ".ops-form input:not([type=hidden]), .ops-form select, .ops-form textarea",
    )?.focus();
  }
  function expenseForm(record = {}) {
    return form(
      "expense",
      field(
        "Expense description",
        "title",
        record.title,
        "text",
        'required maxlength="180"',
      ) +
        select(
          "Category",
          "category",
          [
            "contractor",
            "rental",
            "travel",
            "location",
            "materials",
            "payment_fees",
            "other",
          ].map((c) => option(c, c.replaceAll("_", " "), record.category)).join(
            "",
          ),
        ) +
        field(
          "Actual expense ($)",
          "amount",
          dollars(record.amount_cents),
          "number",
          'required min="0" max="9999999.99" step="0.01"',
        ) +
        field(
          "Expense date",
          "incurred_on",
          record.incurred_on || today(),
          "date",
          "required",
        ) + note("notes", record.notes),
      record.id ? "Edit expense" : "Record an expense",
      record.id,
    );
  }
  function timeForm(record = {}) {
    const rate = state.data.rates?.find((r) =>
      r.staff_id === (record.staff_id || context.staff?.[0]?.id)
    );
    return form(
      "time",
      field(
        "Work description",
        "title",
        record.title,
        "text",
        'required maxlength="180"',
      ) +
        select(
          "Staff member",
          "staff_id",
          staffOptions(context.staff || [], record.staff_id),
        ) +
        field(
          "Work date",
          "worked_on",
          record.worked_on || today(),
          "date",
          "required",
        ) +
        field(
          "Actual minutes",
          "minutes",
          record.minutes || 60,
          "number",
          'required min="1" max="1440" step="1"',
        ) +
        field(
          "Internal hourly cost ($)",
          "hourly_cost",
          record.hourly_cost_cents != null
            ? dollars(record.hourly_cost_cents)
            : rate
            ? dollars(rate.hourly_cost_cents)
            : "",
          "number",
          'required min="0" max="999999.99" step="0.01"',
        ) +
        '<p class="ops-help">A cost estimate for your time, not your client billing rate. This value is saved with this entry; later rate changes do not rewrite past work.</p>' +
        note("notes", record.notes),
      record.id ? "Edit time entry" : "Log actual work",
      record.id,
    );
  }
  function projectPicker(record) {
    const selected = state.selectedProject ||
      (record.project_id
        ? { id: record.project_id, title: record.project_title || record.title }
        : null);
    return `<div class="ops-field ops-wide"><label for="opsProjectSearch">Find a project</label><div class="ops-search-row"><input id="opsProjectSearch" name="project_query" maxlength="240" value="${
      escape(state.projectQuery)
    }" placeholder="Search client or project">${
      button("Search projects", "projects")
    }</div><input type="hidden" name="project_id" value="${
      escape(selected?.id || "")
    }"><p>${
      selected
        ? `Selected: <strong>${escape(selected.title)}</strong>`
        : "Choose the work project to assign."
    }</p><div class="ops-contact-results">${
      state.projects.map((p) =>
        button(
          `${p.title || p.client_name} · ${p.client_name}`,
          "choose-project",
          p.id,
        )
      ).join("")
    }${
      state.projectTotal > state.projectOffset + state.projects.length
        ? button("More projects", "more-projects")
        : ""
    }</div></div>`;
  }
  function allocationForm(record = {}) {
    return form(
      "allocation",
      (!context.project ? projectPicker(record) : "") +
        field(
          "Editing work",
          "title",
          record.title,
          "text",
          'required maxlength="180"',
        ) +
        select(
          "Assigned to",
          "staff_id",
          staffOptions(context.staff || [], record.staff_id),
        ) +
        field(
          "Editing date",
          "work_on",
          record.work_on || today(),
          "date",
          "required",
        ) +
        field(
          "Planned minutes",
          "minutes",
          record.minutes || 120,
          "number",
          'required min="1" max="1440" step="1"',
        ) +
        select(
          "Work status",
          "status",
          ["planned", "done", "cancelled"].map((s) =>
            option(s, s, record.status || "planned")
          ).join(""),
        ) + note("notes", record.notes) +
        '<p class="ops-help">Creates or updates a production task. Shoot bookings and promised delivery dates are separate.</p>',
      record.id ? "Edit workload block" : "Plan editing work",
      record.id,
    );
  }
  function capacityForm(record = {}) {
    return form(
      "staff_capacity",
      select(
        "Staff member",
        "staff_id",
        staffOptions(context.staff || [], record.id),
      ) +
        field(
          "Weekly editing availability (hours)",
          "weekly_hours",
          record.weekly_minutes != null ? record.weekly_minutes / 60 : 20,
          "number",
          'required min="0" max="168" step="0.25"',
        ) +
        field(
          "Internal hourly cost ($)",
          "hourly_cost",
          record.hourly_cost_cents != null
            ? dollars(record.hourly_cost_cents)
            : "",
          "number",
          'required min="0" max="999999.99" step="0.01"',
        ) +
        `<fieldset class="ops-days ops-wide"><legend>Working days</legend>${
          ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) =>
            `<label><input name="working_days" type="checkbox" value="${index}" ${
              (record.working_days || [1, 2, 3, 4, 5]).includes(index)
                ? "checked"
                : ""
            }>${day}</label>`
          ).join("")
        }</fieldset><p class="ops-help ops-wide">Availability is shared across the week. An internal hourly cost is an assumption for future time entries, not payroll or a client rate.</p>`,
      "Staff capacity & cost assumption",
    );
  }
  function packageForm(record = {}) {
    const contact = state.selectedContact ||
      (record.contact_id
        ? {
          id: record.contact_id,
          name: record.client_name || context.project?.client_name ||
            "Selected client",
        }
        : context.project
        ? { id: context.project.contact_id, name: context.project.client_name }
        : null);
    const client = record.id
      ? field("Client", "client_name", contact?.name || "", "text", "disabled")
      : `<div class="ops-field ops-wide"><label for="opsContactSearch">Find an existing client</label><div class="ops-search-row"><input id="opsContactSearch" name="contact_query" maxlength="240" value="${
        escape(state.contactQuery)
      }" placeholder="Search name, company or email">${
        button("Search clients", "contacts")
      }</div><p>${
        contact
          ? `Selected: <strong>${escape(contact.name)}</strong>`
          : "Choose a client below. Create a new client in the CRM first if needed."
      }</p><div class="ops-contact-results">${
        state.contacts.map((c) =>
          button(
            `${c.name}${c.email ? " · " + c.email : ""}`,
            "choose-contact",
            c.id,
          )
        ).join("")
      }${
        state.contactTotal > state.contactOffset + state.contacts.length
          ? button("More clients", "more-contacts")
          : ""
      }</div></div>`;
    return form(
      "retainer",
      client +
        `<input type="hidden" name="contact_id" value="${
          escape(contact?.id || "")
        }">` +
        field(
          "Package name",
          "name",
          record.name || "",
          "text",
          'required maxlength="180"',
        ) +
        select(
          "Lifecycle",
          "status",
          ["draft", "active", "paused", "cancelled"].map((s) =>
            option(s, s, record.status || "draft")
          ).join(""),
        ) +
        select(
          "Payment provider",
          "billing_provider",
          ["honeybook", "stripe"].map((s) =>
            option(
              s,
              s === "honeybook" ? "HoneyBook" : "Stripe",
              record.billing_provider || "honeybook",
            )
          ).join(""),
        ) +
        field(
          "Monthly package fee ($)",
          "monthly_amount",
          dollars(record.monthly_amount_cents),
          "number",
          'required min="0" max="9999999.99" step="0.01"',
        ) +
        field(
          "Starts on",
          "start_on",
          record.start_on || today(),
          "date",
          "required",
        ) +
        select(
          "Owner",
          "owner_id",
          staffOptions(context.staff || [], record.owner_id),
        ) +
        `<label class="ops-field ops-wide"><span>Included deliverables: one “label | quantity” per line</span><textarea name="allowances" rows="4" required maxlength="4000" placeholder="Reels | 4&#10;Edited photos | 20">${
          escape(
            (record.allowances || []).map((a) => `${a.label} | ${a.quantity}`)
              .join("\n"),
          )
        }</textarea></label>` + note("notes", record.notes, 4000) +
        `<p class="ops-help ops-wide">Calendar-month allowances do not roll over. The first partial month uses the full package fee; review the invoice before sending. Each opened period keeps its original fee, provider and allowances. Activating creates an internal renewal task; no invoice is sent or charged automatically.${
          record.period_count
            ? " The provider is locked because work periods already exist."
            : ""
        }</p>`,
      record.id ? "Edit monthly package" : "New monthly package",
      record.id,
    );
  }
  function periodForm(type, p) {
    const choices = (p.allowances || []).map((a) =>
      option(a.key, `${a.label} · ${a.remaining} remaining`, "")
    ).join("");
    if (type === "use") {
      return form(
        "usage",
        `<input type="hidden" name="period_id" value="${p.id}">` +
          select("Fulfilled deliverable", "item_key", choices) +
          field(
            "Quantity fulfilled",
            "quantity",
            1,
            "number",
            'required min="1" max="100000" step="1"',
          ) +
          note("note", "", 500, "What was delivered? (at least 3 characters)"),
        "Record fulfilled work",
      );
    }
    if (type === "return") {
      return form(
        "usage",
        `<input type="hidden" name="period_id" value="${p.id}">` +
          select(
            "Original entry to correct",
            "reverses_id",
            (p.usage || []).filter((u) => u.reversible_quantity > 0).map((u) =>
              option(
                u.id,
                `${u.item_key} · ${u.reversible_quantity} can be returned · ${u.note}`,
                "",
              )
            ).join(""),
          ) +
          field(
            "Quantity to return",
            "quantity",
            1,
            "number",
            'required min="1" max="100000" step="1"',
          ) +
          note("note", "", 500, "Correction reason (at least 3 characters)"),
        "Correct a usage entry",
      );
    }
    if (type === "adjust") {
      return form(
        "adjust_allowance",
        `<input type="hidden" name="period_id" value="${p.id}">` +
          select("Deliverable", "item_key", choices) +
          field(
            "New total included",
            "included",
            "",
            "number",
            'required min="0" max="100000" step="1"',
          ) +
          note(
            "note",
            "",
            500,
            "Agreed adjustment and reason (at least 10 characters)",
          ),
        "Adjust this month’s allowance",
      );
    }
    if (type === "invoice") {
      return form(
        "prepare_invoice",
        `<input type="hidden" name="period_id" value="${p.id}"><p class="ops-help ops-wide">Prepare a ${
          money(p.monthly_amount_cents)
        } draft for ${
          escape(p.billing_provider)
        }. Review and send it from Studio using the project’s confirmed provider. This does not collect money or contact the client.</p>`,
        "Prepare monthly invoice draft",
      );
    }
    return form(
      "close_period",
      `<p class="ops-help ops-wide">Close ${date(p.starts_on)} through ${
        date(p.ends_on)
      }? Unused deliverables expire. The ledger remains available and mistaken entries can still be corrected.</p>`,
      "Close this work period",
      p.id,
    );
  }
  function activeForm() {
    if (!state.form) return "";
    const r = state.record || {};
    return ({
      expense: expenseForm,
      time: timeForm,
      allocation: allocationForm,
      staff_capacity: capacityForm,
      retainer: packageForm,
    })[state.form]?.(r) || (state.form === "open"
      ? form(
        "open_period",
        `<input type="hidden" name="retainer_id" value="${r.id}">` +
          field(
            "Calendar month",
            "month",
            today().slice(0, 7),
            "month",
            "required",
          ) + `<p class="ops-help ops-wide">${
          context.project
            ? `Link this period to ${
              escape(context.project.title || context.project.client_name)
            }.`
            : "Creates a monthly work project for this client and links the allowances. No shoot booking is created."
        }</p>`,
        "Open monthly work period",
      )
      : periodForm(state.form, r));
  }
  function projectContent(d) {
    const expenses = d.expenses || [],
      entries = d.time_entries || [],
      blocks = d.allocations || [];
    return panel(
      "Project earnings",
      summary(d.profit?.rows?.[0] || {}),
      button("Record expense", "new-expense") + button("Log time", "new-time"),
    ) +
      panel(
        "Expenses & actual work",
        `<div class="ops-columns"><div><h3>Expenses</h3>${
          expenses.map((e) =>
            `<article class="ops-row ${
              e.voided_at ? "ops-void" : ""
            }"><div><strong>${escape(e.title)}</strong><p>${
              date(e.incurred_on)
            } · ${escape(e.category.replaceAll("_", " "))}${
              e.voided_at ? " · voided" : ""
            }</p></div><strong>${money(e.amount_cents)}</strong>${
              !e.voided_at
                ? `<div class="ops-actions">${
                  button("Edit", "edit-expense", e.id)
                }${button("Void", "void-expense", e.id)}</div>`
                : ""
            }</article>`
          ).join("") || empty("No actual expenses recorded.")
        }</div><div><h3>Time entries</h3>${
          entries.map((e) =>
            `<article class="ops-row ${
              e.voided_at ? "ops-void" : ""
            }"><div><strong>${escape(e.title)}</strong><p>${
              date(e.worked_on)
            } · ${escape(e.staff_name)} · ${hours(e.minutes)} at ${
              money(e.hourly_cost_cents)
            }/h${e.voided_at ? " · voided" : ""}</p></div>${
              !e.voided_at
                ? `<div class="ops-actions">${
                  button("Edit", "edit-time", e.id)
                }${button("Void", "void-time", e.id)}</div>`
                : ""
            }</article>`
          ).join("") ||
          empty("Log actual work to include a labor cost assumption.")
        }</div></div>`,
      ) +
      panel(
        "Editing work",
        `<p class="ops-help">Plan staff effort by day. This does not move the shoot booking or the delivery promise.</p>${
          blocks.map((b) =>
            `<article class="ops-row"><div><strong>${
              escape(b.title)
            }</strong><p>${date(b.work_on)} · ${hours(b.minutes)} · ${
              escape(
                context.staff?.find((s) => s.id === b.staff_id)?.full_name ||
                  "Staff",
              )
            } · ${escape(b.status)}</p></div>${
              button("Edit block", "edit-allocation", b.id)
            }</article>`
          ).join("") || empty("No editing blocks planned.")
        }`,
        button("Plan editing block", "new-allocation"),
      ) + panel(
        "Monthly package work",
        (d.periods || []).map((p) => periodCard(p)).join("") +
          (d.retainers?.rows || []).map((r) =>
            `<article class="ops-row"><div><strong>${
              escape(r.name)
            }</strong><p>${escape(r.status)} · ${
              money(r.monthly_amount_cents)
            }/month · ${escape(r.billing_provider)}</p></div>${
              r.status === "active"
                ? button("Open month on this project", "open", r.id)
                : ""
            }${button("Edit package", "edit-retainer", r.id)}</article>`
          ).join(""),
        button("New package for client", "new-retainer"),
      );
  }
  function profitContent(d) {
    return panel(
      "Recorded project earnings",
      `<form data-ops-filter="profit" class="ops-search-row"><label class="ops-sr" for="opsProfitQuery">Search projects</label><input id="opsProfitQuery" name="q" maxlength="240" value="${
        escape(state.query)
      }" placeholder="Search client or project"><button class="ops-button">Search</button></form>${
        summary(d.totals)
      }<p class="ops-help">Totals cover all ${
        d.total || 0
      } matching projects. Each project appears once, including repeat-client monthly work.</p><div class="ops-table-wrap"><table class="ops-table"><thead><tr><th>Project</th><th>Quoted</th><th>Invoiced</th><th>Received</th><th>Expenses</th><th>Labor</th><th>Contribution</th></tr></thead><tbody>${
        (d.rows || []).map((r) =>
          `<tr><th scope="row">${
            projectLink(r.project_id, r.title || r.client_name)
          }<small>${escape(r.client_name)}</small></th>${
            [
              "quote_cents",
              "invoiced_cents",
              "received_cents",
              "expenses_cents",
              "labor_cents",
              "contribution_cents",
            ].map((key) =>
              `<td class="${
                key === "contribution_cents" && r[key] < 0 ? "ops-warning" : ""
              }">${money(r[key])}</td>`
            ).join("")
          }</tr>`
        ).join("")
      }</tbody></table></div>${pagination(d.total)}`,
    );
  }
  function capacityContent(d) {
    return panel(
      "This week’s editing workload",
      `<form data-ops-filter="capacity" class="ops-search-row">${
        field("Week containing", "week", state.week, "date", "required")
      }<button class="ops-button">Show week</button></form><p class="ops-help">Week of ${
        date(d.week)
      }. Workload includes planned and completed blocks. Capacity is a staff assumption; bookings and due tasks are context, not automatic editing estimates.</p><div class="ops-capacity-grid">${
        (d.staff || []).map((s) =>
          `<article class="ops-capacity ${
            s.weekly_minutes != null && s.assigned_minutes > s.weekly_minutes
              ? "ops-overloaded"
              : ""
          }"><h3>${escape(s.full_name)}</h3><strong>${
            hours(s.assigned_minutes)
          } assigned${
            s.weekly_minutes != null
              ? ` / ${hours(s.weekly_minutes)} available`
              : ""
          }</strong><p>${
            s.weekly_minutes == null
              ? "Set weekly availability to see remaining capacity."
              : s.assigned_minutes > s.weekly_minutes
              ? `${hours(s.assigned_minutes - s.weekly_minutes)} over capacity`
              : `${hours(s.weekly_minutes - s.assigned_minutes)} remaining`
          }</p><p>${
            s.working_days
              ? s.working_days.map((n) =>
                ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][n]
              ).join(" · ")
              : ""
          }</p>${
            button("Edit availability & cost", "staff-capacity", s.id)
          }</article>`
        ).join("")
      }</div><div class="ops-day-grid">${
        Array.from({ length: 7 }, (_, n) => {
          const day = new Date(`${d.week}T12:00:00Z`);
          day.setUTCDate(day.getUTCDate() + n);
          const key = day.toISOString().slice(0, 10);
          return `<section><h3>${
            ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][n]
          } <small>${key.slice(5)}</small></h3>${
            (d.allocations || []).filter((a) => a.work_on === key).map((a) =>
              `<article class="ops-day-block ${
                a.status === "cancelled" ? "ops-void" : ""
              }">${projectLink(a.project_id, a.title)}<p>${
                escape(
                  d.staff.find((s) => s.id === a.staff_id)?.full_name ||
                    "Staff",
                )
              } · ${hours(a.minutes)} · ${escape(a.status)}</p>${
                a.delivery_target
                  ? `<p>Delivery: ${date(a.delivery_target)}</p>`
                  : ""
              }${button("Edit", "edit-allocation", a.id)}</article>`
            ).join("") || '<p class="ops-help">No blocks</p>'
          }</section>`;
        }).join("")
      }</div><details class="ops-calendar-context"><summary>Bookings & due tasks this week (${
        (d.bookings || []).length + (d.tasks || []).length
      })</summary>${
        (d.bookings || []).map((b) =>
          `<p>${date(b.starts_at)} · Shoot ${
            projectLink(b.project_id, b.project_title)
          } · ${escape(b.status)}</p>`
        ).join("")
      }${
        (d.tasks || []).map((t) =>
          `<p>${date(t.due_at)} · ${
            t.project_id ? projectLink(t.project_id, t.title) : escape(t.title)
          }</p>`
        ).join("") || empty("No due project tasks.")
      }</details>`,
      button("Plan editing block", "new-allocation"),
    );
  }
  function pagination(total = 0) {
    return `<div class="ops-pagination"><span>${total ? state.offset + 1 : 0}–${
      Math.min(state.offset + 20, total)
    } of ${total}</span>${state.offset ? button("Previous", "previous") : ""}${
      state.offset + 20 < total ? button("Next", "next") : ""
    }</div>`;
  }
  function retainerContent(d) {
    return panel(
      "Monthly client packages",
      `<form data-ops-filter="retainers" class="ops-search-row"><label class="ops-sr" for="opsRetainerQuery">Search packages</label><input id="opsRetainerQuery" name="q" maxlength="240" value="${
        escape(state.query)
      }" placeholder="Search client or package"><button class="ops-button">Search</button></form><p class="ops-help">Active packages create renewal tasks. Staff open each month, record fulfilled work and prepare an invoice with the existing payment provider. No recurring charge is automatic.</p>${
        (d.rows || []).map((r) =>
          `<article class="ops-retainer"><div class="ops-heading"><div><h3>${
            escape(r.name)
          }</h3><p>${escape(r.client_name)} · <span class="ops-badge">${
            escape(r.status)
          }</span> · ${escape(r.billing_provider)}</p></div><strong>${
            money(r.monthly_amount_cents)
          }/month</strong></div><p>${
            (r.allowances || []).map((a) => `${a.quantity} ${escape(a.label)}`)
              .join(" · ")
          }</p><div class="ops-actions">${
            button("Edit package", "edit-retainer", r.id)
          }${
            r.status === "active" ? button("Open work month", "open", r.id) : ""
          }</div><details><summary>Work periods (${
            r.period_count || 0
          })</summary>${
            (r.periods || []).map((p) =>
              `${projectLink(p.project_id, "Open monthly project")}${
                periodCard(p, r.name)
              }`
            ).join("") ||
            empty("Open the first work month when this package is active.")
          }</details></article>`
        ).join("") || empty("No monthly packages match this search.")
      }${pagination(d.total)}`,
      button("New monthly package", "new-retainer"),
    );
  }
  function render() {
    root.innerHTML = activeForm() +
      (context.project
        ? projectContent(state.data)
        : context.view === "profit"
        ? profitContent(state.data)
        : context.view === "capacity"
        ? capacityContent(state.data)
        : retainerContent(state.data));
    if (state.form === "retainer" && state.record?.period_count) {
      root.querySelector("[name=billing_provider]").disabled = true;
    }
  }
  function preserveDraft() {
    const draft = Object.fromEntries(
      new FormData(root.querySelector("[data-ops-form]")),
    );
    const record = { ...state.record, ...draft };
    if (state.form === "retainer") {
      record.monthly_amount_cents = Math.round(
        Number(draft.monthly_amount) * 100,
      );
      record.allowances = draft.allowances.split("\n").filter((s) =>
        s.includes("|")
      ).map((s, index) => ({
        key: `item_${index}`,
        label: s.split("|")[0].trim(),
        quantity: Number(s.split("|")[1]),
      }));
    }
    state.record = record;
    return draft;
  }
  function allPeriods() {
    return context.project
      ? state.data.periods || []
      : (state.data.rows || []).flatMap((r) =>
        (r.periods || []).map((p) => ({
          ...p,
          billing_provider: p.billing_provider || r.billing_provider,
        }))
      );
  }
  function allRetainers() {
    return context.project
      ? state.data.retainers?.rows || []
      : state.data.rows || [];
  }
  async function command(action, data, request = uuid()) {
    return await context.rpc("bk_ops_save", {
      p_action: action,
      p_data: data,
      p_request_id: request,
    });
  }
  async function saveForm(target) {
    const data = Object.fromEntries(new FormData(target));
    const action = target.dataset.opsForm;
    const cents = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) throw Error("Enter a valid dollar amount.");
      return Math.round(n * 100);
    };
    if (target.dataset.id) data.id = target.dataset.id;
    if (["expense", "time", "allocation"].includes(action)) {
      data.project_id = context.project?.id || data.project_id ||
        state.record?.project_id;
    }
    if (action === "expense") {
      data.amount_cents = cents(data.amount);
      delete data.amount;
    }
    if (action === "time") {
      data.minutes = Number(data.minutes);
      data.hourly_cost_cents = cents(data.hourly_cost);
      delete data.hourly_cost;
    }
    if (action === "allocation") {
      if (!data.project_id) {
        throw Error("Choose a project before planning editing work.");
      }
      data.minutes = Number(data.minutes);
      delete data.project_query;
    }
    if (action === "staff_capacity") {
      data.weekly_minutes = Math.round(Number(data.weekly_hours) * 60);
      data.hourly_cost_cents = cents(data.hourly_cost);
      data.working_days = new FormData(target).getAll("working_days").map(
        Number,
      );
      if (!data.working_days.length) {
        throw Error("Choose at least one working day.");
      }
      delete data.weekly_hours;
      delete data.hourly_cost;
    }
    if (action === "retainer") {
      if (!data.contact_id) {
        throw Error("Choose an existing client before saving the package.");
      }
      data.monthly_amount_cents = cents(data.monthly_amount);
      delete data.monthly_amount;
      delete data.contact_query;
      delete data.client_name;
      data.billing_provider ||= state.record?.billing_provider;
      const previous = state.record?.allowances || [];
      data.allowances = data.allowances.split("\n").filter((s) => s.trim()).map(
        (line, index) => {
          const parts = line.split("|");
          const label = parts[0]?.trim();
          const quantity = Number(parts[1]?.trim());
          if (
            parts.length !== 2 || !label || label.length > 120 ||
            !Number.isInteger(quantity) || quantity < 1 || quantity > 100000
          ) {
            throw Error(
              "Use one “deliverable label | whole quantity” per line (1–100000).",
            );
          }
          return {
            key: previous.find((a) => a.label === label)?.key ||
              `item_${index + 1}_${
                label.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20)
              }`,
            label,
            quantity,
          };
        },
      );
      if (!data.allowances.length || data.allowances.length > 20) {
        throw Error("Include 1–20 deliverable types.");
      }
    }
    if (action === "open_period") {
      data.period_month = `${data.month}-01`;
      delete data.month;
      if (context.project) data.project_id = context.project.id;
    }
    if (action === "usage") {
      data.quantity = Number(data.quantity);
      if (data.reverses_id) {
        data.item_key = state.record.usage.find((u) =>
          u.id === data.reverses_id
        )?.item_key;
      }
      if (data.note.trim().length < 3) {
        throw Error(
          "Describe the fulfilled work or correction in at least 3 characters.",
        );
      }
    }
    if (action === "adjust_allowance") {
      data.included = Number(data.included);
      if (data.note.trim().length < 10) {
        throw Error("Explain the agreed adjustment in at least 10 characters.");
      }
    }
    await command(action, data, target.dataset.request);
    dirty(false);
    state.form = "";
    state.record = null;
    context.toast?.(
      action === "prepare_invoice"
        ? "Draft prepared. Review and send in Studio."
        : "Studio operation saved.",
    );
    await load();
    context.onChange?.();
  }
  listen("input", (event) => {
    if (event.target.closest("[data-ops-form]")) dirty(true);
  });
  listen("change", (event) => {
    if (event.target.closest("[data-ops-form]")) dirty(true);
  });
  listen("submit", async (event) => {
    const target = event.target;
    if (!target.matches("[data-ops-form], [data-ops-filter]")) return;
    event.preventDefault();
    event.stopPropagation();
    if (state.saving) return;
    if (target.dataset.opsFilter) {
      if (!canReplace()) return;
      const values = Object.fromEntries(new FormData(target));
      state.query = values.q || "";
      state.week = values.week || state.week;
      state.offset = 0;
      state.form = "";
      dirty(false);
      await load();
      return;
    }
    state.saving = true;
    const submit = target.querySelector("[type=submit]");
    submit.disabled = true;
    try {
      await saveForm(target);
    } catch (e) {
      error(e?.message || "Nothing was saved. Try again.");
    } finally {
      state.saving = false;
      if (submit.isConnected) submit.disabled = false;
    }
  });
  listen("click", async (event) => {
    const link = event.target.closest("[data-ops-project]");
    if (link && context.openProject) {
      event.preventDefault();
      event.stopPropagation();
      if (canReplace()) context.openProject(link.dataset.opsProject);
      return;
    }
    const b = event.target.closest("[data-ops-action]");
    if (!b) return;
    event.preventDefault();
    event.stopPropagation();
    if (state.saving) return;
    const action = b.dataset.opsAction, id = b.dataset.id;
    if (action === "retry") {
      await load();
      return;
    }
    if (action === "cancel") {
      if (canReplace()) {
        state.form = "";
        state.record = null;
        dirty(false);
        render();
      }
      return;
    }
    if (action === "next" || action === "previous") {
      if (!canReplace()) return;
      state.offset += action === "next" ? 20 : -20;
      state.form = "";
      dirty(false);
      await load();
      return;
    }
    if (action === "projects" || action === "more-projects") {
      try {
        const draft = preserveDraft();
        state.projectQuery = draft.project_query || "";
        state.projectOffset = action === "more-projects"
          ? state.projectOffset + 20
          : 0;
        const result = await context.rpc("bk_crm_projects", {
          p_query: state.projectQuery,
          p_status: "all",
          p_offset: state.projectOffset,
          p_limit: 20,
        });
        state.projects = result.rows || [];
        state.projectTotal = result.total || 0;
        render();
      } catch (e) {
        error(e.message);
      }
      return;
    }
    if (action === "choose-project") {
      preserveDraft();
      state.selectedProject = state.projects.find((p) => p.id === id);
      dirty(true);
      render();
      return;
    }
    if (action === "contacts" || action === "more-contacts") {
      try {
        const draft = preserveDraft();
        state.contactQuery = draft.contact_query;
        state.contactOffset = action === "more-contacts"
          ? state.contactOffset + 20
          : 0;
        const result = await context.rpc("bk_crm_contacts", {
          p_query: state.contactQuery,
          p_offset: state.contactOffset,
          p_limit: 20,
        });
        state.contacts = result.rows || [];
        state.contactTotal = result.total || 0;
        render();
      } catch (e) {
        error(e.message);
      }
      return;
    }
    if (action === "choose-contact") {
      preserveDraft();
      state.selectedContact = state.contacts.find((c) => c.id === id);
      dirty(true);
      render();
      return;
    }
    if (action.startsWith("void-")) {
      if (
        !canReplace() ||
        !confirm(
          "Void this record? It will remain in the audit history and leave the cost calculation.",
        )
      ) return;
      b.disabled = true;
      try {
        await command(action.replace("-", "_"), { id });
        context.toast?.("Record voided.");
        dirty(false);
        state.form = "";
        await load();
        context.onChange?.();
      } catch (e) {
        error(e.message);
      } finally {
        if (b.isConnected) b.disabled = false;
      }
      return;
    }
    const simple = {
      "new-expense": "expense",
      "new-time": "time",
      "new-allocation": "allocation",
      "new-retainer": "retainer",
    };
    if (simple[action]) {
      state.selectedContact = null;
      state.selectedProject = null;
      openForm(simple[action]);
      return;
    }
    if (action === "staff-capacity") {
      openForm("staff_capacity", state.data.staff.find((s) => s.id === id));
      return;
    }
    if (action === "edit-expense") {
      openForm("expense", state.data.expenses.find((s) => s.id === id));
      return;
    }
    if (action === "edit-time") {
      openForm("time", state.data.time_entries.find((s) => s.id === id));
      return;
    }
    if (action === "edit-allocation") {
      openForm("allocation", state.data.allocations.find((s) => s.id === id));
      return;
    }
    if (action === "edit-retainer" || action === "open") {
      state.selectedContact = null;
      openForm(
        action === "open" ? "open" : "retainer",
        allRetainers().find((r) => r.id === id),
      );
      return;
    }
    const period = allPeriods().find((p) => p.id === id);
    if (period) openForm(action, period);
  });
  return load();
}

export function mountOperations(root, options) {
  return controller(root, options);
}
export function mountOperationsView(root, options) {
  return controller(root, options);
}
export async function mountPortalRetainers(root, { rpc, projectId, token }) {
  mounted.get(root)?.abort();
  mounted.delete(root);
  root.classList.add("ops", "ops-portal");
  root.hidden = false;
  root.innerHTML =
    '<p class="ops-help" role="status">Loading monthly deliverables…</p>';
  try {
    const data = await rpc("bk_ops_portal_retainers", {
      p_project: projectId,
      p_token: token,
    });
    if (!data?.rows?.length) {
      root.hidden = true;
      root.innerHTML = "";
      return;
    }
    root.innerHTML = panel(
      "Your monthly deliverables",
      data.rows.map((p) => periodCard(p, p.name, false)).join("") +
        '<p class="ops-help">Your studio records fulfilled work here. Contact the studio if a balance needs review. Billing continues through the confirmed payment provider.</p>',
    );
  } catch {
    root.innerHTML = panel(
      "Your monthly deliverables",
      '<p role="status">Monthly allowances are unavailable right now. Please try again later or contact the studio.</p>',
    );
  }
}
