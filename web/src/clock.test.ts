import { describe, expect, it } from "vitest";
import { toWallClock } from "./clock.ts";
import { DEFAULT_SLUMP, energyPhase, PHASE, type PhaseInput } from "./phase.ts";

// Pipeline time → wall time (clock.ts) with the two clocks apart, as after a laptop sleep on a system where
// performance.now() stops counting. The plan card asks energyPhase about the last 15 minutes with Date.now().

const EACH = 10_000; // main.ts EVAL_INTERVAL_MS
const ORIGIN = new Date(2026, 10, 9, 9, 0).getTime(); // performance.timeOrigin: page opened 09:00
const ASLEEP = 60 * 60_000; // the laptop slept an hour; performance.now() did not count it

// 15 calm, judged minutes measured just before `perfNow`, one evaluation every 10 s, as main.ts writes them.
function evaluations(wall: (t: number) => number, perfNow: number) {
  const n = (PHASE.recentMinutes * 60_000) / EACH;
  return Array.from({ length: n }, (_, i) => ({ t: wall(perfNow - (n - 1 - i) * EACH), label: "normal" as const, dinilai: true }));
}

const input = (now: number, recent: PhaseInput["recent"]): PhaseInput => ({
  now,
  label: "normal",
  quality: "nilai",
  recent,
  menitSejakJeda: 30,
  kss: null,
  slump: DEFAULT_SLUMP,
  evalIntervalMs: EACH,
});

describe("toWallClock", () => {
  it("is timeOrigin + t while the clocks agree", () => {
    const perfNow = 30 * 60_000;
    expect(toWallClock(perfNow - 5_000, perfNow, ORIGIN + perfNow)).toBe(ORIGIN + perfNow - 5_000);
  });

  it("after an hour asleep, the last 15 minutes still count for the plan card (review, 8 Nov)", () => {
    const perfNow = 2 * 60 * 60_000; // two hours of performance.now() since 09:00, plus the hour it missed
    const dateNow = ORIGIN + perfNow + ASLEEP;
    const recent = evaluations((t) => toWallClock(t, perfNow, dateNow), perfNow);
    expect(energyPhase(input(dateNow, recent))).toMatchObject({ fase: "siap fokus", reason: "ready" });

    // Negative control: the old conversion, timeOrigin + t, dates the same evaluations an hour back, so none is
    // recent and the evidence for "Ready to focus" is gone.
    const old = evaluations((t) => Math.round(ORIGIN + t), perfNow);
    expect(old.every((r) => r.t < dateNow - PHASE.recentMinutes * 60_000)).toBe(true);
    expect(energyPhase(input(dateNow, old))).toMatchObject({ fase: "biasa", reason: "not-enough-evidence" });
  });
});
