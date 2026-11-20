/* Entirely synthetic. SDK calls stay in page memory; no live data or client sends. */
export function stubCRM() {
  const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const now = new Date(),
    iso = now.toISOString(),
    day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  const p = {
    id: id(1),
    contact_id: id(2),
    client_name: 'Avery Test <img src=x onerror="window.pwned=1">',
    client_email: "avery@example.test",
    client_phone: "555-0101",
    company: "Example Studio",
    service: "photography",
    title: "Autumn product shoot",
    status: "quoted",
    referral_source: "Instagram",
    event_date: day,
    delivery_target: day,
    created_at: iso,
    updated_at: iso,
    billing_provider: "honeybook",
    external_billing_url: "https://example.test/invoice",
    external_billing_ref: "TEST-100",
    owner_id: id(9),
    notes_internal: "Keep the warm lighting.",
    details: "Photograph four products.",
    access_token: id(99),
  };
  const contact = {
    id: id(2),
    name: p.client_name,
    email: p.client_email,
    phone: p.client_phone,
    instagram: "@example_test",
    company: p.company,
    source: "Instagram",
    notes: "Warm product lighting",
    project_count: 2,
  };
  const task = {
    id: id(3),
    project_id: p.id,
    contact_id: contact.id,
    project_title: p.title,
    client_name: p.client_name,
    title: "Follow up on quote",
    kind: "followup",
    status: "open",
    due_at: new Date(now - 86400000).toISOString(),
    owner_id: id(9),
    notes: null,
  };
  const invoice = {
    id: id(4),
    project_id: p.id,
    title: "Deposit",
    amount_cents: 25000,
    status: "sent",
    kind: "deposit",
    created_at: iso,
  };
  const data = {
    projects: [p],
    contacts: [contact],
    tasks: [task],
    invoices: [invoice],
    quotes: [],
    activities: [{
      id: id(7),
      project_id: p.id,
      kind: "created",
      summary: "Project created",
      created_at: iso,
    }],
    bookings: [],
    history: [{
      id: id(8),
      title: "Earlier test shoot",
      status: "delivered",
      created_at: iso,
    }],
    staff: [{ id: id(9), full_name: "Test Owner", role: "admin" }],
    logs: [],
    failWrite: false,
    missing: false,
    nextId: 100,
    health: {
      email_failed: 0,
      email_waiting: 0,
      email_stalled: 0,
      email_issues: [],
      billing_unassigned: 0,
      billing_issues: [],
      content_ready: true,
      checked_at: iso,
    },
    failHealth: false,
  };
  window.__crm = data;
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const response = (data, error = null) =>
    Promise.resolve({ data: copy(data), error });
  const stats = () => ({
    newLeads: data.projects.length,
    unpaid: 25000,
    collected: 50000,
    waiting: 2,
    overdue:
      data.tasks.filter((t) => t.status === "open" && new Date(t.due_at) < now)
        .length,
    dueToday: 0,
    activeProjects: data.projects.length,
    noNextAction:
      data.projects.filter((p) =>
        ["new", "quoted", "booked", "in_production"].includes(p.status) &&
        !data.tasks.some((t) => t.project_id === p.id && t.status === "open")
      ).length,
    monthName: "November",
  });
  const listProjects = (args) => {
    let rows = data.projects.filter((p) =>
      (args.p_status === "all" || !args.p_status ||
        args.p_status === "active" &&
          !["archived", "lost"].includes(p.status) ||
        p.status === args.p_status) &&
      (!args.p_query ||
        [p.title, p.client_name, p.referral_source].join(" ").toLowerCase()
          .includes(args.p_query.toLowerCase()))
    ).map((p) => ({
      ...p,
      bk_invoices: data.invoices.filter((i) => i.project_id === p.id),
      next_task: data.tasks.find((t) =>
        t.project_id === p.id && t.status === "open"
      ),
    }));
    return {
      rows: rows.slice(
        args.p_offset || 0,
        (args.p_offset || 0) + (args.p_limit || 30),
      ),
      total: rows.length,
    };
  };
  const client = {
    auth: {
      getSession: () =>
        response({
          session: { user: { id: id(9), email: "owner@example.test" } },
        }),
      signInWithPassword: () => response({ session: {} }),
      signInWithOAuth: () => response({}),
      signOut: () => response({}),
    },
    rpc(name, args = {}) {
      data.logs.push({ rpc: name, args: copy(args) });
      if (data.missing) {
        return response(null, {
          message:
            "Could not find the function bk_crm_staff in the schema cache",
          code: "PGRST202",
        });
      }
      switch (name) {
        case "bk_crm_client_experience":
          return response({ preparations: [], reviews: [], video_items: [], prep_defaults: {
            title: "Prepare for your shoot", instructions: "Share your goals before production.",
            questions: [{ id: "goal", label: "What should this shoot accomplish?", type: "long", required: true }],
          } });
        case "bk_crm_morning": {
          const rows = data.tasks.filter(t => t.kind === "followup" && t.status === "open").map(t => {
            const project = data.projects.find(p => p.id === t.project_id);
            return { ...t, client_name: project.client_name, project_title: project.title, stage: project.status,
              phone: project.client_phone, source: project.referral_source,
              conversation_url: "/inbox/?p=" + project.id, template_url: "/inbox/?p=" + project.id + "&template=call" };
          });
          return response({ rows, total: rows.length, counts: { overdue: rows.length, today: 0, unassigned: 0 } });
        }
        case "bk_money_board":
          return response({ day: "2026-11-17", show: args.p_show,
            totals: { open_cents: 250000, items: 1, unpriced: 0, me: 1, overdue: 0, hold: 0, viewed_waiting: 0 },
            rows: args.p_show === "closed" ? [] : [{ id: "00000000-0000-4000-8000-0000000000a1", project_id: null,
              client_name: "Synthetic Money Client", title: "Synthetic invoice", amount_cents: 250000, step: "payment",
              ball: "me", provider: "honeybook", link_url: "https://example.test/invoice", next_move: "Send the invoice",
              next_move_on: "2026-11-17", staged_note: null, hold_reason: null, sent_on: null, due_on: null, notes: null,
              view_key: "synthetic0000000000000000000000a1", view_count: 0, first_viewed_at: null, last_viewed_at: null,
              closed_at: null, outcome: null, overdue: false, due: true, days_waiting: null, group: "me" }] });
        case "bk_crm_followup_settings":
          return response({ project_id: args.p_project, enabled: false, lead_days: [1,3,7], quote_days: [3,7,14], phase: "quote", state: "paused", step: 0 });
        case "bk_crm_source_report":
          return response({ from: args.p_from, to: args.p_to, basis: "lead_created_date", totals: { leads: 1, booked: 0, receipts_cents: 0, responded: 0 },
            rows: [{ source: "Instagram", leads: 1, booked: 0, receipts_cents: 0, conversion_pct: 0, responded: 0, median_response_hours: null }], campaigns: [], campaign_total: 0 });
        case "bk_ops_project": {
          const project = data.projects.find(p => p.id === args.p_project);
          return response({ expenses: [], time_entries: [], allocations: [], rates: [], periods: [], retainers: { rows: [], total: 0 },
            profit: { rows: [{ project_id: project.id, title: project.title, client_name: project.client_name,
              quote_cents: 0, invoiced_cents: 25000, received_cents: 0, expenses_cents: 0, labor_cents: 0, minutes: 0, contribution_cents: 0 }] } });
        }
        case "bk_ops_retainers":
          return response({ rows: [], total: 0 });
        case "bk_ops_capacity":
          return response({ week: args.p_week, staff: data.staff.map(s => ({ ...s, weekly_minutes: null, working_days: null, assigned_minutes: 0 })), allocations: [], tasks: data.tasks, bookings: [] });
        case "bk_crm_health":
          return data.failHealth
            ? response(null, { message: "Health connection unavailable" })
            : response(data.health);
        case "bk_crm_staff":
          return response(data.staff);
        case "bk_crm_dashboard":
          return response({
            stats: stats(),
            tasks: data.tasks,
            stage_counts: {
              new: data.projects.filter((p) => p.status === "new").length,
              quoted: 1,
              delivered: 1,
            },
            sources: [{ source: "Instagram", count: 2 }],
            tasks_total: data.tasks.filter((t) => t.status === "open").length,
            no_next_action: data.projects.filter((p) =>
              ["new", "quoted", "booked", "in_production"].includes(p.status) &&
              !data.tasks.some((t) =>
                t.project_id === p.id && t.status === "open"
              )
            ).map((p) => ({
              id: p.id,
              client_name: p.client_name,
              title: p.title,
              status: p.status,
            })),
          });
        case "bk_crm_tasks": {
          const rows = data.tasks.filter((t) =>
            t.status === "open" &&
            (args.p_filter === "all" ||
              args.p_filter === "due" && t.due_at &&
                new Date(t.due_at) <= now ||
              args.p_filter === "upcoming" && t.due_at &&
                new Date(t.due_at) > now)
          );
          return response({
            rows: rows.slice(
              args.p_offset || 0,
              (args.p_offset || 0) + (args.p_limit || 30),
            ),
            total: rows.length,
          });
        }
        case "bk_crm_projects":
          return response(listProjects(args));
        case "bk_crm_contacts":
          return response({ rows: data.contacts, total: data.contacts.length });
        case "bk_crm_project": {
          const project = data.projects.find((p) => p.id === args.p_project);
          return response({
            project,
            contact: data.contacts.find((c) => c.id === project?.contact_id),
            tasks: data.tasks.filter((t) => t.project_id === args.p_project),
            invoices: data.invoices.filter((i) =>
              i.project_id === args.p_project
            ),
            quotes: data.quotes.filter((q) => q.project_id === args.p_project),
            activities: data.activities,
            history: data.history,
            bookings: data.bookings.filter((b) =>
              b.project_id === args.p_project
            ),
            messages: [],
          });
        }
        case "bk_crm_create_project": {
          const v = args.p_data,
            c = {
              id: id(data.nextId++),
              name: v.client_name,
              email: v.client_email,
              phone: v.client_phone,
              instagram: v.instagram,
              source: v.referral_source,
            };
          data.contacts.push(c);
          const project = {
            ...v,
            id: id(data.nextId++),
            contact_id: c.id,
            status: "new",
            created_at: iso,
            billing_provider: "unassigned",
          };
          data.projects.push(project);
          data.tasks.push({
            id: id(data.nextId++),
            project_id: project.id,
            contact_id: c.id,
            title: "Respond to inquiry",
            kind: "followup",
            status: "open",
            due_at: iso,
            client_name: project.client_name,
          });
          return response(project);
        }
        case "bk_crm_save_project": {
          const project = data.projects.find((p) => p.id === args.p_project);
          Object.assign(project, args.p_data);
          return response(project);
        }
        case "bk_crm_save_quote": {
          let q = data.quotes.find((q) => q.id === args.p_quote);
          if (!q) {
            q = {
              id: id(data.nextId++),
              project_id: args.p_project,
              status: "draft",
              version: id(data.nextId++),
              created_at: iso,
            };
            data.quotes.push(q);
          }
          Object.assign(q, args.p_data, {
            total_cents: args.p_data.lines.reduce(
              (n, l) => n + Math.round(l.quantity * l.unit_cents),
              0,
            ),
          });
          return response(q);
        }
        case "bk_crm_quote_status": {
          const q = data.quotes.find((q) => q.id === args.p_quote);
          q.status = args.p_status;
          return response(q);
        }
        case "bk_reconcile_project_billing": {
          const p = data.projects.find((p) => p.id === args.p_project);
          Object.assign(p, {
            billing_provider: args.p_provider,
            external_billing_url: args.p_url,
            external_billing_ref: args.p_ref,
            billing_locked: true,
            billing_requires_reconciliation: false,
          });
          return response(p);
        }
        case "bk_set_project_billing": {
          const p = data.projects.find((p) => p.id === args.p_project);
          Object.assign(p, {
            billing_provider: args.p_provider,
            external_billing_url: args.p_url,
            external_billing_ref: args.p_ref,
          });
          return response(p);
        }
        default:
          return response(null, { message: "Unstubbed RPC " + name });
      }
    },
    from(table) {
      let patch = null, row = null, where = {};
      const collections = {
        bk_tasks: data.tasks,
        bk_projects: data.projects,
        bk_contacts: data.contacts,
      };
      const q = {
        select() {
          return q;
        },
        update(v) {
          patch = v;
          return q;
        },
        insert(v) {
          row = v;
          return q;
        },
        eq(k, v) {
          where[k] = v;
          return q;
        },
        order() {
          return q;
        },
        then(resolve, reject) {
          data.logs.push({
            table,
            patch: copy(patch),
            row: copy(row),
            where: copy(where),
          });
          let rows = (collections[table] || []).filter((v) =>
            Object.entries(where).every(([k, x]) => v[k] === x)
          );
          if ((patch || row) && data.failWrite) {
            return response([]).then(resolve, reject);
          }
          if (patch) rows.forEach((v) => Object.assign(v, patch));
          if (row) {
            const v = { ...row, id: id(data.nextId++), status: "open" };
            collections[table].push(v);
            rows = [v];
          }
          return response(rows).then(resolve, reject);
        },
      };
      return q;
    },
  };
  window.supabase = { createClient: () => client };
}
