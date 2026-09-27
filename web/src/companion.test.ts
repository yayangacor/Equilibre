import { describe, expect, it } from "vitest";
import {
  GREETING,
  GREETING_TEXT,
  initialGreetingState,
  moodFor,
  snoozeGreeting,
  stepGreeting,
  type GreetingState,
} from "./companion.ts";
import { LABELS, type Label } from "./rules.ts";

// Feeds a sequence of shown labels (with or without the long-rest advice) and collects what was said.
function run(steps: Array<[Label | null, boolean?]>, start: GreetingState = initialGreetingState(), now = 1_000) {
  let state = start;
  const said: Array<string | null> = [];
  for (const [label, advice = false] of steps) {
    const out = stepGreeting(state, label, advice, now);
    state = out.state;
    said.push(out.say);
  }
  return { state, said };
}

describe("companion mood", () => {
  it("has a face for every label and one for no label yet", () => {
    expect(LABELS.map(moodFor)).toEqual(["normal", "lelah-ringan", "lelah", "tertidur", "pergi"]);
    expect(moodFor(null)).toBe("menunggu");
  });
});

describe("companion greeting", () => {
  it("speaks up once when the label turns lelah or tertidur", () => {
    const { said } = run([["normal"], ["lelah"], ["lelah"], ["tertidur"], ["tertidur"]]);
    expect(said).toEqual([null, GREETING_TEXT.lelah, null, GREETING_TEXT.tertidur, null]);
  });

  it("stays quiet for normal, lelah ringan, away, and waking from tertidur to lelah", () => {
    const { said } = run([["normal"], ["lelah ringan"], ["tidak di depan layar"], ["tertidur"], ["lelah"], ["normal"]]);
    expect(said).toEqual([null, null, null, GREETING_TEXT.tertidur, null, null]);
  });

  it("greets a first label of lelah (nothing shown before)", () => {
    expect(run([[null], ["lelah"]]).said).toEqual([null, GREETING_TEXT.lelah]);
  });

  it("speaks up when the long-rest advice appears, not while it stays", () => {
    const { said } = run([["lelah"], ["lelah", true], ["lelah", true], ["normal"], ["lelah", true]]);
    expect(said).toEqual([GREETING_TEXT.lelah, GREETING_TEXT.istirahat, null, null, GREETING_TEXT.istirahat]);
  });

  it("says nothing while snoozed, and does not catch up on changes made during the snooze", () => {
    const snoozed = snoozeGreeting(initialGreetingState(), 1_000);
    const during = run([["normal"], ["lelah"], ["tertidur", true]], snoozed, 1_000 + GREETING.snoozeMs - 1);
    expect(during.said).toEqual([null, null, null]);

    const after = run([["tertidur", true], ["lelah", true], ["tertidur", true]], during.state, 1_000 + GREETING.snoozeMs);
    expect(after.said).toEqual([null, null, GREETING_TEXT.tertidur]);
  });
});
