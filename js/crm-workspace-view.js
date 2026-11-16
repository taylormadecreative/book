/* Pure presentation helpers; every dynamic string is escaped at its HTML boundary. */
export const STAGES = {
  new: "New inquiry",
  quoted: "Quoted",
  booked: "Booked",
  in_production: "In production",
  delivered: "Delivered",
  lost: "Lost",
  archived: "Archived",
};
export const SERVICES = {
  photography: "Photography",
  brand_content: "Brand content",
  music_video: "Music video",
  event: "Event",
  digitals: "Digitals",
  other: "Other",
};
export const KINDS = {
  followup: "Follow-up",
  production: "Production",
  delivery: "Delivery",
  rebook: "Rebooking",
  other: "Other",
};
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c]),
  );
export const money = (cents) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (Number(cents) || 0) / 100,
  );
export const date = (iso) =>
  !iso ? "Not set" : new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso));
export const time = (iso) =>
  !iso ? "No due date" : new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
export const centralDay = (iso) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
export const options = (items, value, blank = "") =>
  (blank ? `<option value="">${esc(blank)}</option>` : "") +
  Object.entries(items).map(([k, label]) =>
    `<option value="${esc(k)}"${String(value ?? "") === k ? " selected" : ""}>${
      esc(label)
    }</option>`
  ).join("");
export const pill = (status, label) =>
  `<span class="pill ${esc(status || "")}">${
    esc(label || STAGES[status] || status || "Not set")
  }</span>`;
export const safeUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
};
export function totalLines(lines) {
  return lines.reduce(
    (n, l) => n + Math.round(Number(l.quantity) * Number(l.unit_cents)),
    0,
  );
}
export function csvText(rows, columns) {
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[\s]*[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return [
    columns.map((x) => cell(x[0])).join(","),
    ...rows.map((row) =>
      columns.map(([, key]) =>
        cell(typeof key === "function" ? key(row) : row[key])
      ).join(",")
    ),
  ].join("\r\n");
}
export function localInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString()
    .slice(0, 16);
}
export function dueLabel(task, now = new Date()) {
  if (task.status !== "open") {
    return {
      label: task.status === "done" ? "Completed" : "Canceled",
      tone: task.status === "done" ? "green" : "muted",
    };
  }
  if (!task.due_at) return { label: "No due date", tone: "muted" };
  const due = new Date(task.due_at);
  if (due < now) {
    return { label: "Overdue · " + time(task.due_at), tone: "red" };
  }
  return {
    label: centralDay(due) === centralDay(now)
      ? "Today · " + time(task.due_at)
      : time(task.due_at),
    tone: "muted",
  };
}
