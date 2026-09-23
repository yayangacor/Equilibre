import { describe, expect, it } from "vitest";
import { isKss, KSS_REMINDER_MS, KSS_SCALE, kssDue } from "./kss.ts";

describe("KSS", () => {
  it("has nine labelled steps, 1 to 9", () => {
    expect(KSS_SCALE.map((s) => s.nilai)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(KSS_SCALE.every((s) => s.teks.length > 0 && s.asli.length > 0)).toBe(true);
  });

  it("is due 15 minutes after the last rating, not before", () => {
    expect(KSS_REMINDER_MS).toBe(15 * 60_000);
    expect(kssDue(0, 15 * 60_000 - 1)).toBe(false);
    expect(kssDue(0, 15 * 60_000)).toBe(true);
  });

  it("accepts whole numbers from 1 to 9 only", () => {
    expect([1, 5, 9].every(isKss)).toBe(true);
    expect([0, 10, 5.5, NaN, "7", null].some(isKss)).toBe(false);
  });
});
