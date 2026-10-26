import { assert, assertEquals } from "jsr:@std/assert@1";
import { todayISO, fmtDate, weekStart, weekLabel, groupByWeek, sortPosts, matchesFilter, stats, filterCounts, pickDefault,
  scriptParas, wordCount, readTime, shotLines, postTimes, formatReminder, rowHtml, statusChip, dayBefore } from "../js/content-view.js";

const post = (id, post_date, extra = {}) => ({ id, post_date, sort: 0, lane: "apps", format: "talking_head", status: "planned", title: `Post ${id}`, ...extra });

Deno.test("today is the Dallas calendar day, not the device's", () => {
  // 03:30 UTC on Oct 28 is still the evening of Oct 27 in Dallas
  assertEquals(todayISO(new Date("2026-10-28T03:30:00Z")), "2026-10-27");
  assertEquals(todayISO(new Date("2026-10-28T15:00:00Z")), "2026-10-28");
  // after DST ends (Nov 1) Dallas is UTC-6
  assertEquals(todayISO(new Date("2026-11-03T05:30:00Z")), "2026-11-02");
});

Deno.test("dates format without slipping a day", () => {
  assertEquals(fmtDate("2026-10-27"), { dow: "Tue", day: "27", mon: "Oct", short: "Tue Oct 27", long: "Tuesday, Oct 27" });
  assertEquals(fmtDate("2026-11-01").dow, "Sun");
});

Deno.test("weeks run Monday to Sunday and read relative to today", () => {
  assertEquals(weekStart("2026-10-27"), "2026-10-26");
  assertEquals(weekStart("2026-11-01"), "2026-10-26");
  assertEquals(weekStart("2026-11-02"), "2026-11-02");
  assertEquals(weekLabel("2026-10-26", "2026-10-27"), { name: "This week", range: "Oct 26–Nov 1" });
  assertEquals(weekLabel("2026-11-02", "2026-10-27").name, "Next week");
  assertEquals(weekLabel("2026-10-19", "2026-10-27").name, "Last week");
  assertEquals(weekLabel("2026-11-09", "2026-10-27"), { name: "Week of Nov 9", range: "Nov 9–15" });
  assertEquals(weekLabel("2026-11-02", "2026-11-10").range, "Nov 2–8");
});

Deno.test("posts group by week in date order", () => {
  const ps = sortPosts([post("c", "2026-11-03"), post("a", "2026-10-27"), post("b", "2026-11-01"), post("d", "2026-10-27", { sort: -1 })]);
  assertEquals(ps.map((p) => p.id), ["d", "a", "b", "c"]);
  const g = groupByWeek(ps, "2026-10-27");
  assertEquals(g.map((x) => [x.name, x.posts.length]), [["This week", 3], ["Next week", 1]]);
});

Deno.test("filters and stats follow the status ladder", () => {
  const ps = [post("1", "2026-10-27"), post("2", "2026-10-28", { status: "filmed", lane: "photo" }),
    post("3", "2026-10-29", { status: "edited", lane: "direction" }), post("4", "2026-10-30", { status: "posted" })];
  assertEquals(stats(ps), { film: 1, post: 2, posted: 1, total: 4 });
  assertEquals(filterCounts(ps), { all: 4, apps: 2, photo: 1, direction: 1 });
  assert(matchesFilter(ps[1], "photo"));
  assert(!matchesFilter(ps[3], "post"));
});

Deno.test("a computer opens today's post, else the next one, else the last", () => {
  const ps = [post("a", "2026-10-27"), post("b", "2026-10-29")];
  assertEquals(pickDefault(ps, "2026-10-27"), "a");
  assertEquals(pickDefault(ps, "2026-10-28"), "b");
  assertEquals(pickDefault(ps, "2026-11-30"), "b");
  assertEquals(pickDefault([], "2026-10-27"), null);
});

Deno.test("scripts split into beats and estimate read time", () => {
  const s = "So this is beat one.\n\nAnd beat two, you know what I mean?\n\n\n   \nBeat three.";
  assertEquals(scriptParas(s), ["So this is beat one.", "And beat two, you know what I mean?", "Beat three."]);
  assertEquals(scriptParas(""), []);
  assertEquals(wordCount("I'm gonna be honest with y'all."), 6);
  assertEquals(readTime(""), "");
  assertEquals(readTime("word ".repeat(130)), "about 50 sec");
  assertEquals(readTime("word ".repeat(200)), "about 1 min 15 sec");
  assertEquals(readTime("word ".repeat(156)), "about 1 min");
});

Deno.test("shot lines split the angle code from the direction", () => {
  assertEquals(shotLines("Film it in the app.\nA1 · Beat 1: direct to camera.\nA12: tight on the lens\n\nB3 - insert"), [
    { code: "", text: "Film it in the app." }, { code: "A1", text: "Beat 1: direct to camera." },
    { code: "A12", text: "tight on the lens" }, { code: "B3", text: "insert" },
  ]);
});

Deno.test("the day before crosses months and DST", () => {
  assertEquals(dayBefore("2026-11-01"), "2026-10-31");
  assertEquals(dayBefore("2026-11-02"), "2026-11-01");
});

Deno.test("LinkedIn moves to 10 AM on weekends", () => {
  assertEquals(postTimes("2026-10-27").linkedin, "8:30 AM");
  assertEquals(postTimes("2026-10-31").linkedin, "10:00 AM");
  assertEquals(postTimes("2026-11-01").tiktok, "6:00 PM");
});

Deno.test("reels get the music reminder; stills don't", () => {
  assert(formatReminder("talking_head").includes("trending audio"));
  assert(formatReminder("bts_reel").includes("20–40%"));
  assertEquals(formatReminder("still"), "");
});

Deno.test("rows escape what's in the database and mark today", () => {
  const html = rowHtml(post("x\"y", "2026-10-27", { title: "<img src=x onerror=alert(1)>" }), { today: "2026-10-27", sel: true });
  assert(!html.includes("<img"));
  assert(html.includes("&lt;img"));
  assert(html.includes('data-id="x&quot;y"'));
  assert(html.includes("is-today") && html.includes("is-sel") && html.includes('aria-current="true"'));
  assert(html.includes(">Today<"));
  assert(statusChip("posted").includes("st-green"));
  assert(statusChip("<b>").includes("&lt;b&gt;"));
});
