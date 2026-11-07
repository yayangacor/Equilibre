import { describe, expect, it } from "vitest";
import { dayKey } from "./history.ts";
import {
  DEFAULT_SLUMP,
  energyPhase,
  inSlump,
  PHASE,
  PHASES,
  SLUMP,
  slumpWindow,
  type PhaseInput,
  type SlumpRecord,
} from "./phase.ts";
import type { Label } from "./rules.ts";

const EACH = 10_000; // main.ts EVAL_INTERVAL_MS
const local = (y: number, month: number, d: number, h = 0, min = 0) => new Date(y, month - 1, d, h, min).getTime();
const AT_10 = local(2026, 11, 9, 10, 0);
const AT_14 = local(2026, 11, 9, 14, 10);

// One evaluation every 10 s for `minutes`, the last one at `end`.
function evals(end: number, minutes: number, label: Label = "normal", dinilai = true) {
  const n = Math.round((minutes * 60_000) / EACH);
  return Array.from({ length: n }, (_, i) => ({ t: end - (n - 1 - i) * EACH, label, dinilai }));
}

const input = (now: number, overrides: Partial<PhaseInput> = {}): PhaseInput => ({
  now,
  label: "normal",
  quality: "nilai",
  recent: evals(now, PHASE.recentMinutes),
  menitSejakJeda: 30,
  kss: null,
  slump: DEFAULT_SLUMP,
  evalIntervalMs: EACH,
  ...overrides,
});

describe("energyPhase", () => {
  it("siap fokus: 15 calm minutes, all judged, a break 30 min ago", () => {
    expect(energyPhase(input(AT_10))).toEqual({ fase: "siap fokus", jam_rawan: false, reason: "ready" });
  });

  it("negative control: fresh at 10:00 is not low; at 14:10 the slump hours show beside the phase, not in it", () => {
    const morning = energyPhase(input(AT_10));
    expect(morning.fase).not.toMatch(/^rendah/);
    expect(morning.jam_rawan).toBe(false);
    const afternoon = energyPhase(input(AT_14));
    expect(afternoon.jam_rawan).toBe(true); // the control can see the slump window
    expect(afternoon.fase).toBe("siap fokus");
  });

  it("biasa when the evidence for siap fokus falls short", () => {
    const fresh = evals(AT_10, 2); // monitoring started 2 min ago
    expect(energyPhase(input(AT_10, { recent: fresh }))).toMatchObject({ fase: "biasa", reason: "not-enough-evidence" });
    expect(energyPhase(input(AT_10, { menitSejakJeda: PHASE.readyMaxMinutesSinceBreak })).fase).toBe("biasa");
    expect(energyPhase(input(AT_10, { menitSejakJeda: null })).fase).toBe("biasa");
    expect(energyPhase(input(AT_10, { quality: "terbatas-mata" })).fase).toBe("biasa"); // eyes unreadable
    expect(energyPhase(input(AT_10, { quality: "terbatas-fps" })).fase).toBe("siap fokus"); // power saving
  });

  it("biasa when a fatigue label showed in the last 15 min, siap fokus once it is older", () => {
    const tiredTenMinAgo = [...evals(AT_10 - 10 * 60_000, 1, "lelah ringan"), ...evals(AT_10, 9)];
    const recent = [...evals(AT_10 - 10 * 60_000 - EACH * 6, 5), ...tiredTenMinAgo];
    expect(energyPhase(input(AT_10, { recent })).fase).toBe("biasa");
    const older = [...evals(AT_10 - 20 * 60_000, 1, "lelah ringan"), ...evals(AT_10, PHASE.recentMinutes)];
    expect(energyPhase(input(AT_10, { recent: older })).fase).toBe("siap fokus");
  });

  it("siap fokus needs 70% of the 15 minutes judged", () => {
    // 90 evaluations in 15 min; the not-judged ones first. 63 = 70%.
    const mix = (k: number) => evals(AT_10, PHASE.recentMinutes).map((r, i) => ({ ...r, dinilai: i >= 90 - k }));
    expect(energyPhase(input(AT_10, { recent: mix(63) })).fase).toBe("siap fokus");
    expect(energyPhase(input(AT_10, { recent: mix(62) })).fase).toBe("biasa");
  });

  it("rendah ringan: lelah ringan, or a recent KSS of 7 or more", () => {
    expect(energyPhase(input(AT_10, { label: "lelah ringan" }))).toMatchObject({ fase: "rendah ringan", reason: "mildly-tired" });
    const kss = (value: number, minutesAgo: number) => ({ kss: value, t: AT_10 - minutesAgo * 60_000 });
    expect(energyPhase(input(AT_10, { kss: kss(7, 5) }))).toMatchObject({ fase: "rendah ringan", reason: "kss" });
    expect(energyPhase(input(AT_10, { kss: kss(6, 5) })).fase).toBe("siap fokus");
    expect(energyPhase(input(AT_10, { kss: kss(8, 40) })).fase).toBe("siap fokus"); // an old answer does not count
  });

  it("rendah berat: lelah or tertidur, whatever the break", () => {
    expect(energyPhase(input(AT_10, { label: "lelah", menitSejakJeda: 0 }))).toMatchObject({ fase: "rendah berat", reason: "tired" });
    expect(energyPhase(input(AT_10, { label: "tertidur" }))).toMatchObject({ fase: "rendah berat", reason: "asleep" });
  });

  it("tidak tahu: no label yet, no quality yet, or the camera cannot judge now", () => {
    expect(energyPhase(input(AT_10, { label: null, recent: [] }))).toMatchObject({ fase: "tidak tahu", reason: "no-label" });
    expect(energyPhase(input(AT_10, { quality: null }))).toMatchObject({ fase: "tidak tahu", reason: "no-label" });
    // Abstaining wins over a stale fatigue label.
    expect(energyPhase(input(AT_10, { quality: "tidak-dinilai", label: "lelah" }))).toMatchObject({ fase: "tidak tahu", reason: "not-assessed" });
    expect(energyPhase(input(AT_10, { label: "tidak di depan layar" }))).toMatchObject({ fase: "tidak tahu", reason: "away" });
  });

  it("tidak tahu when under half of the recent evaluations were judged; exactly half is enough", () => {
    const mix = (judged: number) => evals(AT_10, PHASE.recentMinutes).map((r, i) => ({ ...r, dinilai: i < judged }));
    expect(energyPhase(input(AT_10, { recent: mix(44) }))).toMatchObject({ fase: "tidak tahu", reason: "mostly-not-assessed" });
    expect(energyPhase(input(AT_10, { recent: mix(44), label: "lelah" })).fase).toBe("tidak tahu");
    expect(energyPhase(input(AT_10, { recent: mix(45) })).fase).toBe("biasa");
  });

  it("ignores evaluations outside the last 15 minutes and from the future", () => {
    const old = evals(AT_10 - 30 * 60_000, 10, "normal", false); // a dark stretch half an hour ago
    expect(energyPhase(input(AT_10, { recent: [...old, ...evals(AT_10, PHASE.recentMinutes)] })).fase).toBe("siap fokus");
    const future = evals(AT_10 + 10 * 60_000, 5, "lelah");
    expect(energyPhase(input(AT_10, { recent: [...evals(AT_10, PHASE.recentMinutes), ...future] })).fase).toBe("siap fokus");
  });

  it("produces every phase", () => {
    const seen = new Set([
      energyPhase(input(AT_10)).fase,
      energyPhase(input(AT_10, { menitSejakJeda: null })).fase,
      energyPhase(input(AT_10, { label: "lelah ringan" })).fase,
      energyPhase(input(AT_10, { label: "lelah" })).fase,
      energyPhase(input(AT_10, { label: null })).fase,
    ]);
    expect([...seen].sort()).toEqual([...PHASES].sort());
  });

  it("uses the personal slump window for jam_rawan", () => {
    const slump = { startHour: 10, endHour: 11, personal: true };
    expect(energyPhase(input(AT_10, { slump })).jam_rawan).toBe(true);
    expect(energyPhase(input(AT_14, { slump })).jam_rawan).toBe(false);
  });
});

// Synthetic history: a working day 08:00–17:00 with one evaluation every 10 s; tiredShare[hour] of that hour's
// evaluations show "lelah ringan" (spread over the hour), the rest "normal".
function workDay(y: number, month: number, d: number, tiredShare: Record<number, number>, from = 8, to = 17): SlumpRecord[] {
  const out: SlumpRecord[] = [];
  for (let hour = from; hour < to; hour++) {
    const share = tiredShare[hour] ?? 0;
    for (let i = 0; i < 360; i++) {
      const t = local(y, month, d, hour) + i * EACH;
      const label: Label = (i % 10) / 10 < share ? "lelah ringan" : "normal";
      out.push({ t, hari: dayKey(t), label, dinilai: true });
    }
  }
  return out;
}
const NOW = local(2026, 11, 9, 9, 0); // Monday morning

describe("slumpWindow", () => {
  it("keeps the default 13:00–16:00 with fewer than 3 days of data", () => {
    const history = [...workDay(2026, 11, 6, { 10: 0.6 }), ...workDay(2026, 11, 5, { 10: 0.6 })];
    expect(slumpWindow(history, NOW, EACH)).toEqual(DEFAULT_SLUMP);
    expect(DEFAULT_SLUMP).toEqual({ startHour: 13, endHour: 16, personal: false });
    expect(slumpWindow([], NOW, EACH)).toEqual(DEFAULT_SLUMP);
  });

  it("moves to the hour with the highest share of fatigue over the last 7 days", () => {
    const history = [
      ...workDay(2026, 11, 4, { 10: 0.5, 14: 0.2 }),
      ...workDay(2026, 11, 5, { 10: 0.4, 14: 0.3 }),
      ...workDay(2026, 11, 6, { 10: 0.6, 15: 0.2 }),
    ];
    expect(slumpWindow(history, NOW, EACH)).toEqual({ startHour: 10, endHour: 11, personal: true });
  });

  it("counts a share, not minutes: an hour worked on fewer days can win", () => {
    const history = [
      ...workDay(2026, 11, 4, { 14: 0.2 }),
      ...workDay(2026, 11, 5, { 14: 0.2 }),
      ...workDay(2026, 11, 6, { 14: 0.2, 18: 0.5 }, 8, 19), // stayed late once: 30 min tired out of 60
    ];
    expect(slumpWindow(history, NOW, EACH)).toMatchObject({ startHour: 18, personal: true });
  });

  it("ignores days older than 7 days", () => {
    const history = [
      ...workDay(2026, 10, 28, { 9: 0.9 }),
      ...workDay(2026, 10, 29, { 9: 0.9 }),
      ...workDay(2026, 11, 6, { 9: 0.9 }),
      ...workDay(2026, 11, 7, { 9: 0.9 }),
    ];
    expect(slumpWindow(history, NOW, EACH)).toEqual(DEFAULT_SLUMP); // 2 days in the window
  });

  it("needs enough minutes in an hour: a short burst does not move the window", () => {
    const burst = (d: number) =>
      Array.from({ length: 30 }, (_, i) => {
        const t = local(2026, 11, d, 7, 0) + i * EACH; // 5 min at 07:00, all tired
        return { t, hari: dayKey(t), label: "lelah" as Label, dinilai: true };
      });
    const history = [4, 5, 6].flatMap((d) => [...burst(d), ...workDay(2026, 11, d, { 15: 0.3 })]);
    expect(slumpWindow(history, NOW, EACH)).toEqual({ startHour: 15, endHour: 16, personal: true });
  });

  it("leaves out evaluations not judged and time away from the screen", () => {
    const hidden = (d: number, label: Label, dinilai: boolean) =>
      Array.from({ length: 360 }, (_, i) => {
        const t = local(2026, 11, d, 7, 0) + i * EACH;
        return { t, hari: dayKey(t), label, dinilai };
      });
    const history = [4, 5, 6].flatMap((d) => [
      ...hidden(d, "lelah", false), // a stale label carried through a dark hour
      ...workDay(2026, 11, d, { 11: 0.3 }),
    ]);
    expect(slumpWindow(history, NOW, EACH).startHour).toBe(11);
    const away = [4, 5, 6].flatMap((d) => [...hidden(d, "tidak di depan layar", true), ...workDay(2026, 11, d, { 11: 0.3 })]);
    expect(slumpWindow(away, NOW, EACH).startHour).toBe(11);
  });

  it("keeps the default when there was (almost) no fatigue", () => {
    const calm = [4, 5, 6].flatMap((d) => workDay(2026, 11, d, {}));
    expect(slumpWindow(calm, NOW, EACH)).toEqual(DEFAULT_SLUMP);
    // One tired evaluation a day at 10:00: 30 s in all, under SLUMP.minTiredMinutes.
    const almost = calm.map((r) => (new Date(r.t).getHours() === 10 && new Date(r.t).getMinutes() === 0 && new Date(r.t).getSeconds() < 10 ? { ...r, label: "lelah ringan" as Label } : r));
    expect(almost.filter((r) => r.label !== "normal").length).toBeLessThan((SLUMP.minTiredMinutes * 60_000) / EACH);
    expect(slumpWindow(almost, NOW, EACH)).toEqual(DEFAULT_SLUMP);
  });
});

describe("inSlump", () => {
  it("is the local hours [start, end)", () => {
    expect(inSlump(local(2026, 11, 9, 12, 59), DEFAULT_SLUMP)).toBe(false);
    expect(inSlump(local(2026, 11, 9, 13, 0), DEFAULT_SLUMP)).toBe(true);
    expect(inSlump(local(2026, 11, 9, 15, 59), DEFAULT_SLUMP)).toBe(true);
    expect(inSlump(local(2026, 11, 9, 16, 0), DEFAULT_SLUMP)).toBe(false);
  });
});
