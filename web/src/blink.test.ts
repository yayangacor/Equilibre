import { describe, expect, it } from "vitest";
import { detectEyeClosures } from "./blink.ts";
import { earSeries, frame, repeat } from "./test-helpers.ts";

const OPEN = 0.3;
const SHUT = 0.1;
const THRESHOLD = 0.2;

describe("blink detection", () => {
  it("counts a single-frame blink", () => {
    const events = detectEyeClosures(earSeries([OPEN, OPEN, SHUT, OPEN, OPEN]), THRESHOLD);
    expect(events).toEqual([{ kind: "blink", startT: 200, endT: 300, durationMs: 100 }]);
  });

  it("measures a three-frame blink", () => {
    const events = detectEyeClosures(earSeries([OPEN, SHUT, SHUT, SHUT, OPEN]), THRESHOLD);
    expect(events).toEqual([{ kind: "blink", startT: 100, endT: 400, durationMs: 300 }]);
  });

  it("reports eyes closed for 1.2 s as a long closure, not a blink", () => {
    const events = detectEyeClosures(earSeries([OPEN, ...repeat(SHUT, 12), OPEN]), THRESHOLD);
    expect(events).toEqual([{ kind: "long", startT: 100, endT: 1300, durationMs: 1200 }]);
  });

  it("treats exactly 1000 ms as a long closure", () => {
    const events = detectEyeClosures(earSeries([OPEN, ...repeat(SHUT, 10), OPEN]), THRESHOLD);
    expect(events.map((e) => e.kind)).toEqual(["long"]);
  });

  it("drops a long closure whose eye never really shut (head tilted over a phone)", () => {
    // HALF is under the blink threshold but above the confirm threshold: the lid only
    // looks lowered. 23 Sep recording: EAR 0.05–0.09 while looking down, 0.02–0.035 shut.
    const HALF = 0.15;
    const events = detectEyeClosures(earSeries([OPEN, ...repeat(HALF, 12), OPEN]), THRESHOLD, (f) => f.face, SHUT + 0.01);
    expect(events).toEqual([]);
  });

  it("keeps a long closure once most of its frames are fully shut", () => {
    const HALF = 0.15;
    const series = [OPEN, HALF, HALF, ...repeat(SHUT, 10), OPEN];
    const events = detectEyeClosures(earSeries(series), THRESHOLD, (f) => f.face, SHUT + 0.01);
    expect(events).toEqual([{ kind: "long", startT: 100, endT: 1300, durationMs: 1200 }]);
  });

  it("leaves blinks alone, however shallow, so the blink rate keeps its meaning", () => {
    const HALF = 0.15;
    const events = detectEyeClosures(earSeries([OPEN, HALF, HALF, OPEN]), THRESHOLD, (f) => f.face, SHUT + 0.01);
    expect(events).toEqual([{ kind: "blink", startT: 100, endT: 300, durationMs: 200 }]);
  });

  it("cancels a blink when the face disappears in the middle", () => {
    expect(detectEyeClosures(earSeries([OPEN, SHUT, SHUT, null, OPEN, OPEN]), THRESHOLD)).toEqual([]);
  });

  it("still reports a long closure when the face disappears after 1 s (dozing off, then the head drops)", () => {
    const events = detectEyeClosures(earSeries([OPEN, ...repeat(SHUT, 11), null, null]), THRESHOLD);
    expect(events).toEqual([{ kind: "long", startT: 100, endT: 1200, durationMs: 1100 }]);
  });

  it("ends a closure on frames marked unreadable (head down), like a missing face", () => {
    const headDownAt = (t: number) => t >= 400;
    const events = detectEyeClosures(earSeries([OPEN, SHUT, SHUT, SHUT, SHUT, OPEN]), THRESHOLD, (f) => !headDownAt(f.t));
    expect(events).toEqual([]);
  });

  it("cancels a blink across a gap in the frame stream", () => {
    const frames = [frame(0, { ear: OPEN }), frame(100, { ear: SHUT }), frame(1100, { ear: OPEN })];
    expect(detectEyeClosures(frames, THRESHOLD)).toEqual([]);
  });

  it("counts separate blinks separately", () => {
    const events = detectEyeClosures(earSeries([OPEN, SHUT, OPEN, OPEN, SHUT, SHUT, OPEN]), THRESHOLD);
    expect(events.map((e) => e.durationMs)).toEqual([100, 200]);
  });
});

// Frames `stepMs` apart from t = 0, one EAR value each (both eyes the same).
const spaced = (values: readonly number[], stepMs: number) =>
  values.map((v, i) => frame(i * stepMs, { ear: v, earLeft: v, earRight: v }));
const CONFIRM = SHUT + 0.01;
const readable = (f: { face: boolean }) => f.face;

describe("blink detection at low and uneven frame rates (plan P20 W1.2, NOTES G-103)", () => {
  it("keeps a 1.2 s closure cut short by an 800 ms pause, as at least what was seen", () => {
    // 10 fps: closed from 100 to 1300 ms, then nothing until 2100 ms (the loop stalled), eyes open again.
    const frames = [...earSeries([OPEN, ...repeat(SHUT, 13)]), frame(2100, { ear: OPEN })];
    expect(detectEyeClosures(frames, THRESHOLD, readable, CONFIRM)).toEqual([
      { kind: "long", startT: 100, endT: 1300, durationMs: 1200, censored: true },
    ]);
  });

  it("still drops a short closure cut by a pause: it cannot be told from a blink", () => {
    const frames = [...earSeries([OPEN, SHUT, SHUT, SHUT]), frame(1200, { ear: OPEN })];
    expect(detectEyeClosures(frames, THRESHOLD, readable, CONFIRM)).toEqual([]);
  });

  it("judges a closure at 5 fps on the time seen, not on frames × interval", () => {
    // Closed frames at 200..1000 ms: "5 frames × 200 ms" = 1 s, but only 0.8 s was seen. At 10 fps the
    // frame interval is small enough for the old reading.
    expect(detectEyeClosures(spaced([OPEN, ...repeat(SHUT, 5), OPEN], 200), THRESHOLD, readable, CONFIRM)).toEqual([]);
    const seenOneSecond = detectEyeClosures(spaced([OPEN, ...repeat(SHUT, 6), OPEN], 200), THRESHOLD, readable, CONFIRM);
    expect(seenOneSecond).toEqual([{ kind: "long", startT: 200, endT: 1400, durationMs: 1200 }]);
  });

  it("does not turn blinks that merged at 5 fps into a long closure: their lids are not deeply shut", () => {
    // 5 fps misses the open frames between blinks (G-34); the frames caught on the way down or up are shallow.
    const HALF = 0.15;
    const merged = [OPEN, SHUT, HALF, HALF, SHUT, HALF, SHUT, HALF, OPEN];
    expect(detectEyeClosures(spaced(merged, 200), THRESHOLD, readable, CONFIRM)).toEqual([]);
  });

  it("keeps a real closure at 5 fps that starts and ends on a half-closed lid", () => {
    // Every one of the 22 long closures in the UTA-RLDD drowsy videos had a shallow first or last frame.
    const HALF = 0.15;
    const series = [OPEN, HALF, ...repeat(SHUT, 8), HALF, OPEN];
    expect(detectEyeClosures(spaced(series, 200), THRESHOLD, readable, CONFIRM).map((e) => e.kind)).toEqual(["long"]);
  });

  it("reports a 3 s closure at 3 fps", () => {
    const events = detectEyeClosures(spaced([OPEN, ...repeat(SHUT, 9), OPEN], 333), THRESHOLD, readable, CONFIRM);
    expect(events.map((e) => [e.kind, e.startT])).toEqual([["long", 333]]);
  });

  it("loses a closure when every frame is more than 500 ms apart (that window is not assessed at all)", () => {
    const events = detectEyeClosures(spaced([OPEN, ...repeat(SHUT, 6), OPEN], 520), THRESHOLD, readable, CONFIRM);
    expect(events).toEqual([]);
  });
});

describe("both eyes must agree on a deep closure (plan P20 W1.6b)", () => {
  // Mean EAR deep enough, but the right eye reads open: glare on one lens, or one eye covered.
  const oneEye = (yawDeg: number) => [
    frame(0, { ear: OPEN }),
    ...Array.from({ length: 12 }, (_, i) => frame(100 + i * 100, { ear: 0.115, earLeft: 0.02, earRight: 0.21, yawDeg })),
    frame(1300, { ear: OPEN }),
  ];

  it("drops a long closure seen by one eye only", () => {
    expect(detectEyeClosures(oneEye(0), THRESHOLD, readable, 0.12)).toEqual([]);
  });

  it("does not ask for agreement with the head turned away (the far eye is foreshortened)", () => {
    expect(detectEyeClosures(oneEye(25), THRESHOLD, readable, 0.12).map((e) => e.kind)).toEqual(["long"]);
  });
});
