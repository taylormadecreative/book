import {
  errorText,
  factsLine,
  GROUPS,
  groupRows,
  parseDollars,
  PROVIDERS,
  STEPS,
  trackingTag,
} from "../js/crm-open-money-view.js";

function assert(condition, message) {
  if (!condition) throw Error(message);
}

Deno.test("parseDollars reads what a person types", () => {
  assert(parseDollars("") === null && parseDollars("   ") === null, "blank means not priced");
  assert(parseDollars(null) === null && parseDollars(undefined) === null, "missing means not priced");
  assert(parseDollars("2,500") === 250000, "commas");
  assert(parseDollars("$1,250.50") === 125050, "dollar sign and cents");
  assert(parseDollars(" $ 75.5 ") === 7550, "spaces and one decimal");
  assert(parseDollars("0") === 0, "zero is a real amount");
  assert(parseDollars("10,000,000") === 1000000000, "ten million is the cap");
  assert(parseDollars("0.10") === 10 && parseDollars("19.99") === 1999, "no float drift");
  for (const bad of ["abc", "-5", "1.999", "10000000.01", "1e3", "2,50", "1,,000", "$", ".", "12.", "NaN", "Infinity"]) {
    assert(Number.isNaN(parseDollars(bad)), bad);
  }
});

Deno.test("groupRows keeps the fixed order and drops empty groups", () => {
  const g = groupRows([{ id: 1, group: "hold" }, { id: 2, group: "me" }, { id: 3, group: "me" }]);
  assert(g.length === 2 && g[0].label === "Your move" && g[0].rows.length === 2 && g[1].label === "On hold", "order");
  assert(g[0].key === "me" && g[0].rows[0].id === 2, "keeps row order inside a group");
  assert(groupRows([]).length === 0 && groupRows(null).length === 0, "nothing in, nothing out");
  assert(GROUPS.map(([key]) => key).join() === "me,overdue,client,hold", "groups");
});

Deno.test("labels", () => {
  assert(STEPS.payment === "Payment" && PROVIDERS.ach === "Bank transfer" && PROVIDERS.other === "", "labels");
});

Deno.test("factsLine", () => {
  assert(factsLine({ days_waiting: 0, view_count: 0, provider: "honeybook" }) === "Sent today · No views recorded · HoneyBook", "today");
  assert(factsLine({ days_waiting: 1, view_count: 1, last_viewed_at: "2026-11-12T18:00:00Z", provider: "other" }) === "Sent 1 day ago · Viewed once, Nov 12", "once, no provider label");
  assert(factsLine({ days_waiting: 5, view_count: 3, last_viewed_at: "2026-11-13T03:30:00Z", provider: "ach" }) === "Sent 5 days ago · Viewed 3 times, last Nov 12 · Bank transfer", "Central date, not UTC");
  assert(factsLine({ days_waiting: null, view_count: 0, provider: "zelle" }) === "No views recorded · Zelle", "no sent day");
});

Deno.test("trackingTag", () => {
  assert(trackingTag("abc123") === '<script async src="https://book.taylormadecreative.net/js/proposal-beacon.js" data-key="abc123"></scr' + 'ipt>', "exact tag");
});

Deno.test("errorText speaks plainly", () => {
  assert(errorText({ message: "client_name_required" }) === "Add the client's name.", "name");
  assert(errorText({ message: "title_required" }) === "Add a short title, like \"Website proposal\".", "title");
  assert(errorText({ message: "invalid_link" }) === "The link has to start with https://", "link");
  assert(errorText({ message: "item_closed" }) === "This one is closed. Reopen it to make changes.", "closed");
  assert(errorText({ message: "invalid_amount" }) === "That amount doesn't look right. Use numbers, like 2,500.", "amount");
  assert(errorText({ message: "money_item_not_found" }) === "That item is gone. Refresh the list.", "gone");
  assert(errorText({ message: 'new row violates check constraint "x": invalid_link' }) === "The link has to start with https://", "code inside a longer message");
  assert(errorText({ message: "anything else" }) === "That didn't save. Nothing was changed. Try again.", "fallback");
  assert(errorText(null) === "That didn't save. Nothing was changed. Try again.", "no error object");
});
