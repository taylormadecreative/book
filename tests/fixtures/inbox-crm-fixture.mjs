// Made-up clients for the stubbed Inbox CRM test (this repo is public: never put real client data here).
const H = 3600e3, D = 24 * H;

export function build(now = Date.now(), { evil = false } = {}) {
  const at = (ms) => new Date(now - ms).toISOString();
  const day = (offsetDays) => new Date(now + offsetDays * D).toISOString().slice(0, 10);
  const id = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-a${String(n).repeat(3)}-${String(n).repeat(12)}`;

  const P = [
    { n: 1, name: evil ? "<img src=x onerror=window.pwned=1>Imani Okafor" : "Imani Okafor", svc: "brand_content", what: "Brand Content", company: "Okafor Skin",
      status: "new", created: 2 * H, phone: "(469) 381-2207", email: "imani@okaforskin.co", ref: "Instagram",
      details: "We're launching a body oil line in January. Looking for a 30-second spot plus stills for the site and Instagram. Studio or outdoors, open to your ideas.",
      budget: "$3,000 to $5,000", date: day(19), loc: "Dallas", alerts: [{ type: "inquiry", at: 2 * H }], msgs: [], inv: [], waiting: true, past: [9] },
    { n: 2, name: "Marcus Bell", svc: "music_video", what: "Music Video", status: "quoted", created: 3 * D, phone: "214-555-0182", email: "marcusbellmusic@gmail.com",
      details: "Single drops Nov 30. Performance + a simple story, one location if possible.", budget: "$2,500", date: day(26), loc: "Deep Ellum",
      alerts: [{ type: "inquiry", at: 3 * D }],
      msgs: [{ s: "studio", b: "Hi Marcus,\n\nLoved the demo. I put the quote in your portal: deposit holds the 21st.\n\n— Nelson", at: 2 * D },
             { s: "client", b: "Can we push the shoot to the 21st? My DP fell through and I'd rather have you run camera too.", at: 5 * H }],
      inv: [{ title: "Deposit", kind: "deposit", cents: 125000, status: "sent", at: 2 * D }], waiting: true },
    { n: 3, name: "Dr. Alana Price", svc: "photography", what: "Faculty Headshots", company: "Brookhaven College", status: "delivered", created: 12 * D,
      phone: "972-555-0144", email: "aprice@brookhaven.edu", ref: "Referral",
      details: "Headshots for 6 faculty, consistent background for the new site.", date: day(-6), loc: "Farmers Branch",
      alerts: [{ type: "inquiry", at: 12 * D }],
      msgs: [{ s: "client", b: "Selected 6 images for editing from \"Faculty Headshots, Oct 20\". Ready when you are.\nDSC06421, DSC06433, DSC06450, DSC06467, DSC06502, DSC06519", at: 26 * H }],
      inv: [{ title: "Headshots, 6 faculty", kind: "full", cents: 45000, status: "paid", at: 11 * D, paid: 10 * D },
            { title: "Extra edits", kind: "custom", cents: 7000, status: "sent", at: 26 * H }], waiting: true },
    { n: 4, name: "Renée Castillo", svc: "photography", what: "Digitals Session", status: "booked", created: 2 * D, phone: "817-555-0119", email: "renee.castillo@outlook.com",
      details: "New to modeling, need digitals for agency submissions.", date: day(3), loc: "Studio",
      alerts: [{ type: "payment", at: 2 * D - H }], msgs: [],
      inv: [{ title: "Digitals Session", kind: "full", cents: 10000, status: "paid", at: 2 * D, paid: 2 * D - H }],
      bookings: [{ name: "Digitals Session", slug: "digitals", start: 3 * D + 11.5 * H, status: "confirmed" }], waiting: true },
    { n: 7, name: "Kendra Moss", svc: "photography", what: "Birthday Shoot, Full", status: "booked", created: 10 * D, email: "kendramoss@icloud.com", phone: null,
      details: "30th birthday shoot, two looks.", date: day(5), loc: "Studio",
      alerts: [{ type: "payment_stuck", at: 9 * D }], msgs: [], inv: [], waiting: true },
    { n: 5, name: "Theo Walker", svc: "event", what: "Album Release Party", company: "Walker House Records", status: "booked", created: 20 * D,
      phone: "214-555-0175", email: "theo@walkerhouse.com", ref: "Website",
      details: "Release party at the Bomb Factory. Photo + a 60-second recap.", budget: "$1,800", date: day(12), loc: "Bomb Factory, Dallas",
      alerts: [{ type: "contract_signed", at: 6 * D }],
      msgs: [{ s: "client", b: "Contract's signed. Send the deposit link whenever.", at: 6 * D + 2 * H },
             { s: "studio", b: "Got it. Deposit is in your portal now.\n\n— Nelson", at: 6 * D }],
      inv: [{ title: "Deposit", kind: "deposit", cents: 90000, status: "paid", at: 6 * D, paid: 5 * D },
            { title: "Balance", kind: "balance", cents: 90000, status: "sent", at: 5 * D }], waiting: false },
    { n: 8, name: "Andre Lewis", svc: "brand_content", what: "Brand Content", status: "lost", created: 34 * D, email: "andre@lewisfit.com", phone: null,
      details: "Gym promo.", alerts: [{ type: "inquiry", at: 34 * D }], msgs: [], inv: [], waiting: false },
    { n: 9, name: "Imani Okafor", svc: "photography", what: "Product Stills", company: "Okafor Skin", status: "delivered", created: 130 * D, email: "imani@okaforskin.co",
      details: "Stills for the first launch.", alerts: [], msgs: [], inv: [{ title: "Product stills", kind: "full", cents: 60000, status: "paid", at: 128 * D, paid: 127 * D }], waiting: false, noActivity: true },
  ];

  const projects = [], needs = [], all = [], items = {};
  for (const p of P) {
    const pid = id(p.n);
    const title = `${p.name} — ${p.what}`;
    const invoices = p.inv.map((i, k) => ({ id: `${pid.slice(0, 30)}${k}inv`, title: i.title, kind: i.kind, amount_cents: i.cents, status: i.status,
      created_at: at(i.at), paid_at: i.paid != null ? at(i.paid) : null, due_date: null }));
    const messages = p.msgs.map((m) => ({ sender: m.s, body: m.b, created_at: at(m.at) }));
    const alerts = p.alerts.map((a) => ({ type: a.type, created_at: at(a.at) }));
    const handled = p.waiting ? null : at(1 * H);
    projects.push({ id: pid, client_name: p.name, client_email: p.email, client_phone: p.phone || null, company: p.company || null, service: p.svc, title,
      status: p.status, event_date: p.date || null, created_at: at(p.created), updated_at: at(Math.min(p.created, 1 * H)),
      inbox_handled_at: handled, bk_invoices: invoices.map(({ amount_cents, status, paid_at }) => ({ amount_cents, status, paid_at })) });
    const events = [...alerts.map((a) => ({ at: a.created_at, kind: "alert", summary: a.type })),
      ...messages.filter((m) => m.sender === "client").map((m) => ({ at: m.created_at, kind: "message", summary: m.body.slice(0, 140) }))]
      .sort((a, b) => b.at.localeCompare(a.at));
    if (events.length && !p.noActivity) {
      const row = { id: pid, client_name: p.name, title, service: p.svc, inbox_handled_at: handled, last_at: events[0].at, last_kind: events[0].kind, last_summary: events[0].summary };
      all.push(row); if (p.waiting) needs.push(row);
    }
    items[pid] = {
      item: {
        project: { id: pid, client_name: p.name, client_email: p.email, client_phone: p.phone || null, company: p.company || null, service: p.svc, title,
          event_date: p.date || null, event_time: null, location: p.loc || null, budget_range: p.budget || null, details: p.details || null,
          created_at: at(p.created), inbox_handled_at: handled },
        bookings: (p.bookings || []).map((b, k) => ({ id: `${pid}-b${k}`, starts_at: new Date(now + b.start).toISOString(), duration_min: 60, status: b.status,
          balance_cents: null, balance_status: null, service: { name: b.name, slug: b.slug, kind: "session", price_cents: 10000, deposit_cents: null } })),
        messages: messages.slice(-10),
        alerts: alerts.slice().reverse(),
        past_projects: (p.past || []).map((n) => { const q = P.find((x) => x.n === n); return { id: id(n), title: `${q.name} — ${q.what}`, created_at: at(q.created), status: q.status }; }),
      },
      extra: { id: pid, status: p.status, notes_internal: p.n === 3 ? "Prefers email. Invoice goes to the department, not her." : null,
        access_token: `${String(p.n).repeat(8)}-aaaa-4bbb-8ccc-dddddddddddd`, referral_source: p.ref || null, bk_invoices: invoices, bk_messages: messages },
    };
  }
  const sort = (a, b) => b.last_at.localeCompare(a.last_at);
  needs.sort(sort); all.sort(sort);
  return { needs, all, projects, items, id };
}
