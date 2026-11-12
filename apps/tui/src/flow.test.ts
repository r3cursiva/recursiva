import assert from "node:assert/strict";
import { test } from "node:test";
import { choiceOf, choose, picksOf, rememberedOf } from "./flow.ts";

const config = { model: "opus", effort: "high" } as const;

test("the dispatch mode is remembered whole: model, effort and executor come back after a restart (PLNR-388)", () => {
  // The file is JSON on disk, so what comes back is what JSON keeps.
  const roundTrip = (c: ReturnType<typeof choiceOf>) => picksOf(JSON.parse(JSON.stringify(rememberedOf(c))), config);
  const pair = choiceOf({ model: 0, effort: 3, executor: 3 });
  assert.deepEqual([pair.model, pair.effort, pair.executor], ["fable", "xhigh", "sonnet"]);
  assert.deepEqual(choiceOf(roundTrip(pair)), pair, "a curator with its executor opens as it was left");
  const alone = choiceOf({ model: 1, effort: 2, executor: 0 });
  assert.deepEqual(choiceOf(roundTrip(alone)), alone, "alone");
  // A file from before PLNR-388 has the model and the effort only: Claude, alone.
  assert.deepEqual(choiceOf(picksOf({ model: "sonnet", effort: "low" }, config)), { model: "sonnet", effort: "low", executor: null, context: "" });
  // One from before PLNR-394 may name site-dev: Claude, on its model and effort.
  assert.deepEqual(choiceOf(picksOf(JSON.parse('{"model":"fable","effort":"max","agent":"site-dev","executor":null}'), config)), { model: "fable", effort: "max", executor: null, context: "" });
  assert.deepEqual(choiceOf(picksOf(undefined, config)), { model: "opus", effort: "high", executor: null, context: "" }, "nothing remembered: the config");
  assert.equal(picksOf({ model: "gpt", effort: "high", executor: "y" }, config).executor, 0, "what is not known falls back");
});

test("the executor row passes over the curator's model, and a curator moved onto it works alone", () => {
  const p = picksOf(undefined, config); // opus
  const executor = () => choiceOf(p).executor;
  choose(p, 2, 1);
  assert.equal(executor(), "fable");
  choose(p, 2, 1);
  assert.equal(executor(), "sonnet", "opus, the curator's own, passed over");
  choose(p, 2, 1);
  assert.equal(executor(), null, "round to off");
  choose(p, 2, -1);
  assert.equal(executor(), "sonnet");
  choose(p, 0, 1); // the curator to sonnet: the executor's model
  assert.deepEqual([choiceOf(p).model, executor()], ["sonnet", null]);
});
