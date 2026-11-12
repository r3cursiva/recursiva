import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeDateRange, formatQuery, isEmptyFilter, namesOrder, parseQuery, resolveDateExpr, withOrder, type Filter } from "../src/index.ts";
import { ctx, L, projectMap, S, U } from "./fixture.ts";

const c = ctx();
const parse = (q: string) => parseQuery(q, c);

describe("parseQuery", () => {
  test("the example from the plan", () => {
    const { filter, errors } = parse('state:"In Review" assignee:me priority:high,urgent label:security due:<2026-11-01 dark mode');
    assert.deepEqual(errors, []);
    assert.deepEqual(filter, {
      state: [S.review.id],
      assignee: ["me"],
      priority: [2, 1],
      label: [L.security.id],
      dueDate: { to: "2026-10-31" },
      text: "dark mode",
    });
  });

  test("names are case-insensitive; aliases of keys", () => {
    const { filter, errors } = parse("status:todo,DONE labels:BUG assignees:zoe author:bot group:started,completed");
    assert.deepEqual(errors, []);
    assert.deepEqual(filter, {
      state: [S.todo.id, S.done.id],
      label: [L.bug.id],
      assignee: [U.zoe.id],
      createdBy: [U.bot.id],
      stateGroup: ["started", "completed"],
    });
  });

  test("users by name, email or email name; none and me", () => {
    assert.deepEqual(parse('assignee:"Zoe Quinn",a@example.com,bot,none').filter.assignee, [U.zoe.id, U.alex.id, U.bot.id, "none"]);
    assert.deepEqual(parse("author:me").filter.createdBy, ["me"]);
    assert.deepEqual(parse("label:none").filter.label, ["none"]);
  });

  test("quoted values are names, never keywords", () => {
    const r = parse('label:"none"');
    assert.equal(r.filter.label, undefined);
    assert.equal(r.errors[0]!.message, 'No label named "none"');
  });

  test("repeated keys add up (any of)", () => {
    assert.deepEqual(parse("label:bug label:security label:bug").filter.label, [L.bug.id, L.security.id]);
  });

  test("ids are accepted", () => {
    assert.deepEqual(parse(`state:${S.todo.id} label:${L.bug.id}`).filter, { state: [S.todo.id], label: [L.bug.id] });
  });

  test("free text keeps quoted phrases; text-only queries", () => {
    assert.deepEqual(parse('fix "dark mode"  now').filter, { text: 'fix "dark mode" now' });
    assert.deepEqual(parse("   ").filter, {});
    assert.deepEqual(parse('priority:high "a:b"').filter, { priority: [2], text: '"a:b"' });
  });

  test("unknown key: error with suggestion, the rest still applies", () => {
    const q = "stat:Todo priority:high";
    const { filter, errors } = parse(q);
    assert.deepEqual(filter, { priority: [2] });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message, 'Unknown filter "stat:"');
    assert.deepEqual(errors[0]!.suggestions, ["state:"]);
    assert.equal(q.slice(errors[0]!.start, errors[0]!.end), "stat:");
  });

  test("unknown value: error points at the value and suggests names", () => {
    const q = 'state:Todo,"In Reveiw" label:secuirty assignee:zoey priority:hihg';
    const { filter, errors } = parse(q);
    assert.deepEqual(filter, { state: [S.todo.id] });
    assert.deepEqual(
      errors.map((e) => [e.message, q.slice(e.start, e.end), e.suggestions]),
      [
        ['No state named "In Reveiw"', '"In Reveiw"', ['"In Review"']],
        ['No label named "secuirty"', "secuirty", ["security"]],
        ['No member named "zoey"', "zoey", []],
        ['No priority named "hihg"', "hihg", ["high"]],
      ],
    );
  });

  test("prefix suggestions", () => {
    assert.deepEqual(parse("assignee:zo").errors[0]!.suggestions, ['"Zoe Quinn"']);
    assert.deepEqual(parse("label:needs").errors[0]!.suggestions, ['"needs owner"']);
  });

  test("missing values and bad dates", () => {
    assert.equal(parse("state:").errors[0]!.message, '"state:" needs a value');
    const bad = parse("due:soon");
    assert.equal(bad.errors[0]!.message, 'Not a date expression: "soon"');
    assert.equal(parse("due:2026-02-30").errors[0]!.message, 'Not a date expression: "2026-02-30"');
    assert.equal(parse("due:2026-11-01..2026-10-01").errors[0]!.message, "The range ends before it starts: 2026-11-01 > 2026-10-01");
    assert.deepEqual(parse("due:next-wek").errors[0]!.suggestions, ["next-week"]);
  });

  test("an unterminated quote runs to the end", () => {
    assert.deepEqual(parse('state:"In Review').filter, { state: [S.review.id] });
  });
});

describe("dates", () => {
  const today = "2026-10-27"; // a Tuesday
  const r = (e: string) => {
    const x = resolveDateExpr(e, today);
    return "range" in x ? x.range : x;
  };
  test("days and comparisons", () => {
    assert.deepEqual(r("2026-11-01"), { from: "2026-11-01", to: "2026-11-01" });
    assert.deepEqual(r("<2026-11-01"), { to: "2026-10-31" });
    assert.deepEqual(r("<=2026-11-01"), { to: "2026-11-01" });
    assert.deepEqual(r(">2026-10-31"), { from: "2026-11-01" });
    assert.deepEqual(r(">=2026-10-31"), { from: "2026-10-31" });
    assert.deepEqual(r("2026-10-01..2026-10-31"), { from: "2026-10-01", to: "2026-10-31" });
    assert.deepEqual(r("..2026-10-31"), { to: "2026-10-31" });
    assert.deepEqual(r("2026-12-31.."), { from: "2026-12-31" });
  });
  test("relative presets keep their text", () => {
    assert.deepEqual(r("today"), { from: today, to: today, preset: "today" });
    assert.deepEqual(r("Yesterday"), { from: "2026-10-26", to: "2026-10-26", preset: "yesterday" });
    assert.deepEqual(r("<today"), { to: "2026-10-26", preset: "<today" });
    assert.deepEqual(r("last-7-days"), { from: "2026-10-21", to: today, preset: "last-7-days" });
    assert.deepEqual(r("last-30-days"), { from: "2026-09-28", to: today, preset: "last-30-days" });
    assert.deepEqual(r("next-1-week"), { from: today, to: "2026-11-02", preset: "next-1-week" });
    assert.deepEqual(r("next-2-weeks"), { from: today, to: "2026-11-09", preset: "next-2-weeks" });
    assert.deepEqual(r("this-week"), { from: "2026-10-26", to: "2026-11-01", preset: "this-week" });
    assert.deepEqual(r("last-week"), { from: "2026-10-19", to: "2026-10-25", preset: "last-week" });
    assert.deepEqual(r("next-month"), { from: "2026-11-01", to: "2026-11-30", preset: "next-month" });
    assert.deepEqual(r("last-month"), { from: "2026-09-01", to: "2026-09-30", preset: "last-month" });
    assert.deepEqual(r("next-1-month"), { from: today, to: "2026-11-27", preset: "next-1-month" });
  });
  test("weeks start on the Profile's first day (RSVA-13)", () => {
    const w = (e: string, first: number) => {
      const x = resolveDateExpr(e, today, first);
      return "range" in x ? x.range : x;
    };
    assert.deepEqual(w("this-week", 0), { from: "2026-10-25", to: "2026-10-31", preset: "this-week" }, "Sunday");
    assert.deepEqual(w("this-week", 6), { from: "2026-10-24", to: "2026-10-30", preset: "this-week" }, "Saturday");
    assert.deepEqual(w("next-week", 0), { from: "2026-11-01", to: "2026-11-07", preset: "next-week" });
    assert.deepEqual(w("this-week", 2), { from: today, to: "2026-11-02", preset: "this-week" }, "the first day itself");
    assert.deepEqual(parseQuery("due:this-week", ctx({ weekStart: 0 })).filter.dueDate, { from: "2026-10-25", to: "2026-10-31", preset: "this-week" });
  });
  test("none: no such date, for due and start only (RSVA-13)", () => {
    assert.deepEqual(r("none"), { none: true });
    assert.deepEqual(parse("due:none start:None").filter, { dueDate: { none: true }, startDate: { none: true } });
    assert.equal(formatQuery(parse("due:none").filter, ctx()), "due:none");
    assert.equal(describeDateRange({ none: true }), "No date");
    assert.equal(parse("created:none").errors[0]!.message, '"created:none" finds nothing: every issue has one');
    assert.equal(parse("updated:none").filter.updatedAt, undefined);
    // Closed (RSVA-576): a date as the others take it, and `none` for what was never closed.
    assert.deepEqual(parse("closed:2026-10-21 completed:none").filter, { completedAt: { none: true } });
    assert.equal(formatQuery(parse("group:completed closed:2026-10-21").filter, ctx()), "group:completed closed:2026-10-21");
  });
  test("month arithmetic clamps", () => {
    const x = resolveDateExpr("next-1-month", "2026-01-31");
    assert.deepEqual("range" in x && x.range.to, "2026-02-28");
  });
  test("descriptions for chips", () => {
    assert.equal(describeDateRange({ preset: "<today" }), "Overdue");
    assert.equal(describeDateRange({ preset: "last-7-days" }), "Last 7 days");
    assert.equal(describeDateRange({ from: "2026-10-01", to: "2026-10-31" }), "2026-10-01 – 2026-10-31");
    assert.equal(describeDateRange({ to: "2026-10-31" }), "On or before 2026-10-31");
  });
});

describe("formatQuery", () => {
  const roundTrip = (f: Filter) => {
    const text = formatQuery(f, c);
    const back = parseQuery(text, c);
    assert.deepEqual(back.errors, [], text);
    assert.deepEqual(back.filter, f, text);
    assert.equal(formatQuery(back.filter, c), text);
    return text;
  };

  test("canonical order and quoting", () => {
    const text = roundTrip({
      text: 'dark "mode"',
      label: [L.needsOwner.id, L.bug.id],
      priority: [1, 0],
      state: [S.review.id],
      assignee: ["me", U.zoe.id, "none"],
      createdBy: [U.bot.id],
      stateGroup: ["started"],
      dueDate: { to: "2026-10-31" },
      startDate: { from: "2026-10-01", to: "2026-10-01" },
      createdAt: { from: "2026-10-21", to: "2026-10-27", preset: "last-7-days" },
      updatedAt: { from: "2026-10-01" },
    });
    assert.equal(
      text,
      'state:"In Review" group:started priority:urgent,none assignee:me,"Zoe Quinn",none label:"needs owner",bug author:bot ' +
        'start:2026-10-01 due:<=2026-10-31 created:last-7-days updated:>=2026-10-01 dark "mode"',
    );
  });

  test("names that look like keywords are quoted", () => {
    const named = new Map(c.labels);
    named.set("l-none", { ...L.bug, id: "l-none", name: "None" });
    const cx = { ...c, labels: named };
    assert.equal(formatQuery({ label: ["l-none", "none"] }, cx), 'label:"None",none');
    assert.deepEqual(parseQuery('label:"None",none', cx).filter, { label: ["l-none", "none"] });
  });

  test("unknown ids stay as ids", () => {
    assert.equal(formatQuery({ label: ["gone"] }, c), "label:gone");
  });

  test("parse → format → parse is stable for typed queries", () => {
    for (const q of ['state:"In Review" assignee:me priority:high,urgent label:security due:<2026-11-01 dark mode', "due:<today fix", "created:this-week"]) {
      const f1 = parseQuery(q, c).filter;
      const t = formatQuery(f1, c);
      assert.deepEqual(parseQuery(t, c).filter, f1, t);
    }
  });

  test("empty", () => {
    assert.equal(formatQuery({}, c), "");
    assert.equal(isEmptyFilter({}), true);
    assert.equal(isEmptyFilter({ label: [], text: " " }), true);
    assert.equal(isEmptyFilter({ dueDate: { preset: "today" } }), false);
  });
});

describe("agent and project keys (PLNR-74)", () => {
  const cx = ctx({ projects: projectMap([{ id: "00000000-0000-4000-8000-000000000001", key: "PLNR", name: "Planner" }]) });

  test("agent:any,none,me and names; project by key or name", () => {
    const { filter, errors } = parseQuery("agent:any,bot project:plnr delegate:none", cx);
    assert.deepEqual(errors, []);
    assert.deepEqual(filter, { delegate: ["any", U.bot.id, "none"], project: ["00000000-0000-4000-8000-000000000001"] });
    assert.deepEqual(parseQuery('project:"Planner"', cx).filter.project, ["00000000-0000-4000-8000-000000000001"]);
  });

  test("round trip", () => {
    const f: Filter = { project: ["00000000-0000-4000-8000-000000000001"], delegate: ["any", U.zoe.id] };
    const text = formatQuery(f, cx);
    assert.equal(text, 'project:PLNR agent:any,"Zoe Quinn"');
    assert.deepEqual(parseQuery(text, cx).filter, f);
  });
});

describe("a renamed project's former key (PLNR-455)", () => {
  const A = "00000000-0000-4000-8000-000000000001";
  const B = "00000000-0000-4000-8000-000000000002";

  test("project: and #KEY find the project by a key it had before; the text names it by its key now", () => {
    const cx = ctx({ projects: projectMap([{ id: A, key: "RSVA", name: "Recursiva", formerKeys: ["PLANE", "PLNR"] }]) });
    const { filter, errors } = parseQuery('project:PLNR state:"In Review"', cx);
    assert.deepEqual(errors, []);
    assert.deepEqual(filter, { project: [A], state: [S.review.id] });
    assert.deepEqual(parseQuery("#plane fix", cx).filter, { project: [A], text: "fix" });
    assert.equal(formatQuery(filter, cx), 'project:RSVA state:"In Review"');
  });

  test("a key another project took over means the new owner, and a former key never shadows a current key or name", () => {
    // A copy mid-sync can hold the key twice: the server takes it from the old project's former keys in the same change.
    const cx = ctx({
      projects: projectMap([
        { id: A, key: "RSVA", name: "Recursiva", formerKeys: ["PLNR", "SITE"] },
        { id: B, key: "PLNR", name: "Plans" },
        { id: "00000000-0000-4000-8000-000000000003", key: "WEB", name: "Site" },
      ]),
    });
    assert.deepEqual(parseQuery("project:PLNR", cx).filter.project, [B]);
    assert.deepEqual(parseQuery("project:site", cx).filter.project, ["00000000-0000-4000-8000-000000000003"]);
    assert.match(parseQuery("project:NOPE", cx).errors[0]!.message, /No project named "NOPE"/);
  });
});

describe("is not (PLNR-74)", () => {
  test("-key:values parse into not, format back, and mix with the positive keys", () => {
    const { filter, errors } = parse("-label:security,bug group:started -status:Done");
    assert.deepEqual(errors, []);
    assert.deepEqual(filter, { stateGroup: ["started"], not: { label: [L.security.id, L.bug.id], state: [S.done.id] } });
    const text = formatQuery(filter, c);
    assert.equal(text, "-state:Done group:started -label:security,bug");
    assert.deepEqual(parse(text).filter, filter);
    assert.equal(isEmptyFilter({ not: { label: [L.bug.id] } }), false);
  });

  test("dates are not negated; a lone minus word stays text", () => {
    assert.match(parse("-due:today").errors[0]!.message, /not supported/);
    assert.equal(parse("-x fix").filter.text, "-x fix");
  });
});

describe("short forms (PLNR-359; on everywhere since RSVA-368)", () => {
  const cx = ctx({ projects: projectMap([{ id: "00000000-0000-4000-8000-000000000001", key: "PLNR", name: "Planner" }]) });
  const short = (q: string) => parseQuery(q, cx);

  test("#project @who !priority +label at a word's start, the rest is text", () => {
    const { filter, errors } = short("Fix the login #plnr @me @zoe !high +bug,security");
    assert.deepEqual(errors, []);
    assert.deepEqual(filter, {
      project: ["00000000-0000-4000-8000-000000000001"],
      assignee: ["me", U.zoe.id],
      priority: [2],
      label: [L.bug.id, L.security.id],
      text: "Fix the login",
    });
  });

  test("not inside a word, not alone, not in quotes", () => {
    assert.deepEqual(short('mail a@b.c about "!important" # + C#').filter, { text: 'mail a@b.c about "!important" # + C#' });
    assert.deepEqual(short('"#plnr" fix').filter, { text: '"#plnr" fix' });
  });

  test("the filter bar's line: #project !priority and text; formatQuery writes the long keys", () => {
    const { filter, errors } = short("#plnr !high fix");
    assert.deepEqual(errors, []);
    assert.deepEqual(filter, { project: ["00000000-0000-4000-8000-000000000001"], priority: [2], text: "fix" });
    assert.equal(formatQuery(filter, cx), "project:PLNR priority:high fix");
  });

  test("formatQuery quotes a word of text that would read as a key, so it reads back as text", () => {
    const f = { text: '#123 +1 fix "two words" a@b.c' };
    const text = formatQuery(f, cx);
    assert.equal(text, '"#123" "+1" fix "two words" a@b.c');
    assert.deepEqual(short(text), { filter: { text }, errors: [] });
  });

  test("a sign being typed completes as its key does: projects after #, people after @, priorities after !, labels after +", () => {
    for (const [q, want] of [["#pl", "PLNR"], ["@zo", '"Zoe Quinn"'], ["!hi", "high"], ["+bu", "bug"]] as const) {
      const e = short(q).errors[0]!;
      assert.deepEqual([e.start, e.end], [1, q.length], q);
      assert.equal(e.suggestions[0], want, q);
    }
  });

  test("an unknown name is an error with suggestions; long keys still work", () => {
    const { filter, errors } = short("!urgnt @\"Zoe Quinn\" state:todo");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message, 'No priority named "urgnt"');
    assert.deepEqual(errors[0]!.suggestions, ["urgent"]);
    assert.deepEqual(filter, { assignee: [U.zoe.id], state: [S.todo.id] });
  });
});

describe("order (PLNR-401)", () => {
  test("order: says the order and filters nothing; sort: and the OrderBy names are the same", () => {
    assert.deepEqual(parse("label:bug order:priority fix"), { filter: { label: [L.bug.id], text: "fix" }, errors: [], order: "priority" });
    assert.equal(parse("sort:Due").order, "dueDate");
    assert.equal(parse("order:updatedAt").order, "updatedAt");
    assert.equal(parse("order:created order:start").order, "startDate", "the last one wins");
    assert.equal(parse("label:bug").order, undefined, "no order: the screen keeps its own");
  });

  test("a wrong order is an error with suggestions, and the rest of the query still applies", () => {
    const typo = parse("label:bug order:prio");
    assert.deepEqual(typo.filter, { label: [L.bug.id] });
    assert.equal(typo.order, undefined);
    assert.deepEqual(typo.errors.map((e) => [e.message, e.suggestions]), [['No order named "prio"', ["priority"]]]);
    assert.deepEqual(parse("order:").errors[0]!.suggestions, ["updated", "created", "priority", "due", "start", "manual"], "bare order: offers them all");
    assert.match(parse("-order:priority").errors[0]!.message, /not supported/);
    assert.match(parse("order:priority,due").errors[0]!.message, /one order/);
    assert.deepEqual(parse("ordr:due").errors[0]!.suggestions, ["order:"]);
  });

  test("formatQuery writes it after the filters and before the text; withOrder sets or takes it out, the rest as typed", () => {
    const q = formatQuery({ label: [L.bug.id], text: "fix" }, c, "dueDate");
    assert.equal(q, "label:bug order:due fix");
    assert.deepEqual(parse(q), { filter: { label: [L.bug.id], text: "fix" }, errors: [], order: "dueDate" });
    assert.equal(withOrder('state:"In Review"  sort:due fix', "priority"), 'state:"In Review" fix order:priority');
    assert.equal(withOrder("order:due -label:bug", null), "-label:bug");
    assert.equal(namesOrder("label:bug sort:x"), true);
    assert.equal(namesOrder("label:bug sorted"), false);
  });
});
