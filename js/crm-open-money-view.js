// Pure helpers for the Open money screen. No DOM, no network.

export const STEPS = { decision: "Decision", signature: "Signature", payment: "Payment" };

export const PROVIDERS = {
  honeybook: "HoneyBook",
  stripe: "Stripe",
  zelle: "Zelle",
  ach: "Bank transfer",
  other: "",
};

export const GROUPS = [
  ["me", "Your move"],
  ["overdue", "Overdue"],
  ["client", "Waiting on the client"],
  ["hold", "On hold"],
];

const MAX_CENTS = 1_000_000_000;
const DOLLARS = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

// Cents from what a person types: null when blank, NaN when it is not a
// plain non-negative amount of at most ten million dollars.
export function parseDollars(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const match = DOLLARS.exec(value);
  if (!match) return NaN;
  const cents = Number(match[1].replaceAll(",", "")) * 100 +
    Number((match[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : NaN;
}

export function groupRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return GROUPS
    .map(([key, label]) => ({ key, label, rows: list.filter((row) => row.group === key) }))
    .filter((group) => group.rows.length);
}

const shortDay = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "short",
  day: "numeric",
});

export function factsLine(row) {
  const parts = [];
  const days = row.days_waiting;
  if (days !== null && days !== undefined) {
    parts.push(days <= 0 ? "Sent today" : days === 1 ? "Sent 1 day ago" : `Sent ${days} days ago`);
  }
  const views = Number(row.view_count) || 0;
  const last = row.last_viewed_at ? shortDay.format(new Date(row.last_viewed_at)) : "";
  if (!views) parts.push("No views recorded");
  else if (views === 1) parts.push(`Viewed once${last ? `, ${last}` : ""}`);
  else parts.push(`Viewed ${views} times${last ? `, last ${last}` : ""}`);
  const provider = PROVIDERS[row.provider];
  if (provider) parts.push(provider);
  return parts.join(" · ");
}

export function trackingTag(key) {
  return `<script async src="https://book.taylormadecreative.net/js/proposal-beacon.js" data-key="${key}"></scr` + "ipt>";
}

const ERRORS = [
  ["client_name_required", "Add the client's name."],
  ["title_required", "Add a short title, like \"Website proposal\"."],
  ["invalid_amount", "That amount doesn't look right. Use numbers, like 2,500."],
  ["invalid_link", "The link has to start with https://"],
  ["item_closed", "This one is closed. Reopen it to make changes."],
  ["money_item_not_found", "That item is gone. Refresh the list."],
];

export function errorText(error) {
  const message = String(error?.message ?? error ?? "");
  const hit = ERRORS.find(([code]) => message.includes(code));
  return hit ? hit[1] : "That didn't save. Nothing was changed. Try again.";
}
