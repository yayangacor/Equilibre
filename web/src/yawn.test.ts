import { describe, expect, it } from "vitest";
import { detectYawns } from "./yawn.ts";
import { jawSeries, repeat } from "./test-helpers.ts";

describe("yawn detection", () => {
  it("does not count talking (jaw opening and closing quickly)", () => {
    const talking = Array.from({ length: 60 }, (_, i) => (Math.floor(i / 2) % 2 === 0 ? 0.65 : 0.2));
    expect(detectYawns(jawSeries(talking))).toEqual([]);
  });

  it("counts a 3-second yawn exactly once", () => {
    const events = detectYawns(jawSeries([...repeat(0.1, 5), ...repeat(0.7, 30), ...repeat(0.1, 5)]));
    expect(events).toEqual([{ startT: 500, endT: 3500, durationMs: 3000 }]);
  });

  it("ignores a mouth opening shorter than 1.5 s", () => {
    expect(detectYawns(jawSeries([0.1, ...repeat(0.7, 14), 0.1]))).toEqual([]);
  });

  it("splits episodes at a single closed frame", () => {
    const events = detectYawns(jawSeries([...repeat(0.7, 16), 0.1, ...repeat(0.7, 16), 0.1]));
    expect(events.map((e) => e.durationMs)).toEqual([1600, 1600]);
  });

  it("still counts a yawn when the face is lost after 1.5 s (hand over mouth)", () => {
    const events = detectYawns(jawSeries([0.1, ...repeat(0.7, 20), null, null, 0.1]));
    expect(events).toEqual([{ startT: 100, endT: 2100, durationMs: 2000 }]);
  });

  it("does not count a short opening cut off by a lost face", () => {
    expect(detectYawns(jawSeries([0.1, ...repeat(0.7, 5), null, 0.1]))).toEqual([]);
  });
});
