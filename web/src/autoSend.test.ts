import { describe, expect, it } from "vitest";
import {
  afterFailedSend,
  AUTO_SEND,
  AUTO_SEND_KEY,
  autoTarget,
  initialAutoSendState,
  loadAutoSend,
  saveAutoSend,
  stepAutoSend,
  type AutoSendState,
  type AutoTarget,
} from "./autoSend.ts";
import type { KeyValueStore } from "./calibration.ts";
import type { Label } from "./rules.ts";

const MIN = 60_000;

// Runs a sequence of (minute, shown label, long rest) evaluations; returns the minutes that sent.
function run(steps: [number, Label | null, boolean?][], enabled = true, start: AutoSendState = initialAutoSendState()) {
  let state = start;
  const sent: [number, AutoTarget][] = [];
  for (const [minute, label, longRest] of steps) {
    const target = autoTarget(label, longRest ?? false);
    const step = stepAutoSend(state, target, minute * MIN, enabled);
    state = step.state;
    if (step.send && target) sent.push([minute, target]);
  }
  return { sent, state };
}

describe("autoTarget", () => {
  it("sends only for the three tired labels, and the long rest advice wins", () => {
    expect(AUTO_SEND.minGapMs).toBe(10 * MIN);
    expect(["lelah ringan", "lelah", "tertidur"].map((l) => autoTarget(l as Label, false))).toEqual(["lelah ringan", "lelah", "tertidur"]);
    // Negative controls: nothing to recommend while normal or away, or before any label.
    expect(autoTarget("normal", false)).toBeNull();
    expect(autoTarget("tidak di depan layar", false)).toBeNull();
    expect(autoTarget(null, false)).toBeNull();
    expect(autoTarget("normal", true)).toBe("istirahat panjang");
    expect(autoTarget("lelah", true)).toBe("istirahat panjang");
  });
});

describe("stepAutoSend", () => {
  it("sends when the shown label turns tired, once per condition", () => {
    const { sent } = run([
      [0, "normal"],
      [1, "lelah ringan"],
      [2, "lelah ringan"],
      [3, "lelah ringan"],
    ]);
    expect(sent).toEqual([[1, "lelah ringan"]]);
  });

  it("keeps a change inside the 10 minutes and sends it when they are over, if it still holds", () => {
    const { sent } = run([
      [0, "lelah ringan"],
      [4, "lelah"], // inside the gap: waits
      [9.9, "lelah"],
      [10, "lelah"], // gap over, still "lelah": sent now
      [11, "lelah"],
    ]);
    expect(sent).toEqual([
      [0, "lelah ringan"],
      [10, "lelah"],
    ]);
  });

  it("drops the waiting change when the episode ends first", () => {
    const { sent } = run([
      [0, "lelah ringan"],
      [3, "lelah"],
      [5, "normal"], // back to normal before the gap is over
      [12, "normal"],
    ]);
    expect(sent).toEqual([[0, "lelah ringan"]]);
  });

  it("sends a new episode after the gap, even with the same label as before", () => {
    const { sent } = run([
      [0, "lelah"],
      [2, "normal"],
      [5, "lelah"], // new episode, inside the gap: waits
      [10, "lelah"],
    ]);
    expect(sent).toEqual([
      [0, "lelah"],
      [10, "lelah"],
    ]);
  });

  it("sends the long rest advice once, whatever the label does under it", () => {
    const { sent } = run([
      [0, "lelah"],
      [15, "lelah", true],
      [16, "lelah ringan", true],
      [30, "tertidur", true],
    ]);
    expect(sent).toEqual([
      [0, "lelah"],
      [15, "istirahat panjang"],
    ]);
  });

  it("never sends while switched off, and sends at the next evaluation once switched on", () => {
    const off = run([
      [0, "lelah"],
      [20, "tertidur"],
    ], false);
    expect(off.sent).toEqual([]);
    const on = run([[21, "tertidur"]], true, off.state);
    expect(on.sent).toEqual([[21, "tertidur"]]);
  });

  it("lets tertidur break through the gap once (Q-14: 23 Sep recording, 07:39 lelah ringan then 07:40 tertidur)", () => {
    const { sent } = run([
      [0, "lelah ringan"],
      [1.5, "tertidur"], // inside the gap, but the heaviest condition: sent now
      [3, "tertidur"],
    ]);
    expect(sent).toEqual([
      [0, "lelah ringan"],
      [1.5, "tertidur"],
    ]);
  });

  it("lets the long rest advice break through too", () => {
    const { sent } = run([
      [0, "lelah"],
      [4, "lelah", true],
    ]);
    expect(sent).toEqual([
      [0, "lelah"],
      [4, "istirahat panjang"],
    ]);
  });

  it("allows one break-through per gap, even when tertidur flickers (negative control)", () => {
    const { sent } = run([
      [0, "lelah ringan"],
      [1, "tertidur"], // break-through
      [2, "normal"],
      [3, "tertidur"], // new episode, but the break-through is used: waits
      [4, "lelah", true], // waits too
      [8, "normal"],
      [11, "tertidur"], // gap after 1 min is over: regular send, frees the break-through
      [12, "lelah", true], // break-through again
    ]);
    expect(sent).toEqual([
      [0, "lelah ringan"],
      [1, "tertidur"],
      [11, "tertidur"],
      [12, "istirahat panjang"],
    ]);
    // Never more than 2 sends in any 10 minutes.
    for (const [t] of sent) expect(sent.filter(([u]) => u >= t && u < t + 10).length).toBeLessThanOrEqual(2);
  });

  it("does not let lelah ringan or lelah break through (negative control)", () => {
    const { sent } = run([
      [0, "lelah ringan"],
      [2, "lelah"],
      [9, "lelah"],
    ]);
    expect(sent).toEqual([[0, "lelah ringan"]]);
  });

  it("does not call a failing server every evaluation, but tries again after the gap", () => {
    let { state } = run([[0, "lelah"]]);
    state = afterFailedSend(state); // Langflow down
    const retry = run([
      [0.2, "lelah"], // inside the gap: not again
      [5, "lelah"],
      [10, "lelah"], // gap over: same condition tried again
    ], true, state);
    expect(retry.sent).toEqual([[10, "lelah"]]);
  });
});

describe("toggle persistence", () => {
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };

  it("is off by default and remembers the user's choice", () => {
    const store = memory();
    expect(loadAutoSend(store)).toBe(false);
    expect(saveAutoSend(store, true)).toBe(true);
    expect(store.data.get(AUTO_SEND_KEY)).toBe("1");
    expect(loadAutoSend(store)).toBe(true);
    saveAutoSend(store, false);
    expect(loadAutoSend(store)).toBe(false);
  });

  it("stays off when storage throws", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(loadAutoSend(broken)).toBe(false);
    expect(saveAutoSend(broken, true)).toBe(false);
  });
});
