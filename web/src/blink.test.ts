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

  it("cancels a blink when the face disappears in the middle", () => {
    expect(detectEyeClosures(earSeries([OPEN, SHUT, SHUT, null, OPEN, OPEN]), THRESHOLD)).toEqual([]);
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
