import { describe, expect, it } from "vitest";
import {
  BASELINE_KEY,
  blinkThreshold,
  computeBaseline,
  loadBaseline,
  median,
  percentile,
  perclosThreshold,
  saveBaseline,
  type KeyValueStore,
} from "./calibration.ts";
import { BASELINE, earSeries, FRAME_MS, frame, noFace, repeat } from "./test-helpers.ts";

// Stage A: 3 s with eyes closed. Stage B: 30 s of normal work with a 200 ms blink every 5 s.
const closedStage = () => earSeries(repeat(0.1, 30));
function normalStage(start = 10_000) {
  const values = Array.from({ length: 300 }, (_, i) => (i % 50 === 25 || i % 50 === 26 ? 0.12 : 0.3));
  return earSeries(values, start).map((f, i) => ({ ...f, pitchDeg: i % 2 ? -4 : -6, jawOpen: (i % 100) / 100 }));
}

describe("median / percentile", () => {
  it("handles odd, even and empty input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it("interpolates percentiles", () => {
    expect(percentile([0, 10], 0.95)).toBeCloseTo(9.5);
    expect(percentile([5], 0.95)).toBe(5);
  });
});

describe("thresholds", () => {
  it("sit at 50% (blink) and 20% (PERCLOS P80) of the personal range", () => {
    expect(blinkThreshold(BASELINE)).toBeCloseTo(0.2);
    expect(perclosThreshold(BASELINE)).toBeCloseTo(0.14);
  });
});

describe("computeBaseline", () => {
  it("derives personal values from both stages", () => {
    const result = computeBaseline(closedStage(), normalStage(), 42);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const b = result.baseline;
    expect(b.earClosed).toBeCloseTo(0.1);
    expect(b.earOpen).toBeCloseTo(0.3);
    expect(b.pitchDeg).toBeCloseTo(-5);
    expect(b.blinkDurationMs).toBe(200);
    // 6 blinks over 29.9 s of face time.
    expect(b.blinkPerMin).toBeCloseTo(6 / (29.9 / 60), 3);
    expect(b.jawOpenP95).toBeGreaterThan(0.9);
    expect(b.createdAt).toBe(42);
  });

  it("ignores frames without a face", () => {
    const withGaps = normalStage().map((f, i) => (i % 10 === 3 ? noFace(f.t) : f));
    const closedWithGaps = closedStage().map((f, i) => (i % 5 === 0 ? noFace(f.t) : f));
    const result = computeBaseline(closedWithGaps, withGaps, 0);
    expect(result.ok && result.baseline.earOpen).toBeCloseTo(0.3);
    expect(result.ok && result.baseline.earClosed).toBeCloseTo(0.1);
  });

  it("rejects a stage where more than 30% of frames have no face", () => {
    const mostlyAway = normalStage().map((f, i) => (i % 3 === 0 ? noFace(f.t) : f)); // 34% missing
    const result = computeBaseline(closedStage(), mostlyAway, 0);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("kerja normal");
  });

  it("rejects calibration when the eyes were not really closed in stage A", () => {
    const result = computeBaseline(earSeries(repeat(0.28, 30)), normalStage(), 0);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("tidak terpejam");
  });

  it("rejects a normal stage shorter than 10 s", () => {
    const short = Array.from({ length: 50 }, (_, i) => frame(i * FRAME_MS));
    expect(computeBaseline(closedStage(), short, 0).ok).toBe(false);
  });

  it("rejects a normal stage recorded at ~1 fps (hidden tab)", () => {
    const sparse = Array.from({ length: 30 }, (_, i) => frame(i * 1000));
    const result = computeBaseline(closedStage(), sparse, 0);
    expect(!result.ok && result.error).toContain("tersembunyi");
  });

  it("stores null blink duration when no blink was seen", () => {
    const noBlinks = earSeries(repeat(0.3, 200));
    const result = computeBaseline(closedStage(), noBlinks, 0);
    expect(result.ok && result.baseline.blinkDurationMs).toBeNull();
    expect(result.ok && result.baseline.blinkPerMin).toBe(0);
  });
});

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("baseline storage", () => {
  it("round-trips through storage", () => {
    const store = memoryStore();
    expect(saveBaseline(store, BASELINE)).toBe(true);
    expect(loadBaseline(store)).toEqual(BASELINE);
  });

  it("returns null for missing, corrupt or incomplete data", () => {
    const store = memoryStore();
    expect(loadBaseline(store)).toBeNull();
    store.data.set(BASELINE_KEY, "{not json");
    expect(loadBaseline(store)).toBeNull();
    store.data.set(BASELINE_KEY, JSON.stringify({ ...BASELINE, earOpen: "0.3" }));
    expect(loadBaseline(store)).toBeNull();
  });

  it("drops unknown keys", () => {
    const store = memoryStore();
    store.data.set(BASELINE_KEY, JSON.stringify({ ...BASELINE, photo: "data:image/png;base64,..." }));
    expect(loadBaseline(store)).toEqual(BASELINE);
  });

  it("survives storage that throws", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    expect(saveBaseline(broken, BASELINE)).toBe(false);
    expect(loadBaseline(broken)).toBeNull();
  });
});
