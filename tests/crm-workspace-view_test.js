import {
  csvText,
  dueLabel,
  safeUrl,
  totalLines,
} from "../js/crm-workspace-view.js";
function equal(actual, expected) {
  if (actual !== expected) throw Error(`Expected ${expected}, got ${actual}`);
}
Deno.test("CSV protects spreadsheet formulas and preserves quoted client text", () => {
  const csv = csvText([{
    name: '=IMPORTXML("https://example.test")',
    note: 'a,"b"\nc',
  }], [["Name", "name"], ["Note", "note"]]);
  equal(csv.includes("\"'=IMPORTXML("), true);
  equal(csv.includes('"a,""b""\nc"'), true);
});
Deno.test("external billing links allow https only", () => {
  equal(safeUrl("javascript:alert(1)"), null);
  equal(safeUrl("http://example.test"), null);
  equal(
    safeUrl("https://example.test/invoice"),
    "https://example.test/invoice",
  );
});
Deno.test("quote presentation computes rounded line totals", () => {
  equal(
    totalLines([{ quantity: 1.5, unit_cents: 105 }, {
      quantity: 2,
      unit_cents: 200,
    }]),
    558,
  );
});
Deno.test("completed tasks do not present as overdue", () => {
  equal(
    dueLabel({ status: "done", due_at: "2020-01-01T00:00:00Z" }).label,
    "Completed",
  );
  equal(dueLabel({ status: "open", due_at: null }).label, "No due date");
});
