import { describe, expect, it } from "vitest";
import { heroCopy, lastAssessedNote, limitedNote, UNASSESSED } from "./statusCopy.ts";

describe("Can't assess (plan P20 W1.4)", () => {
  it("names the reason and what helps, and adds the power saving tip only for too few frames", () => {
    const fps = heroCopy({ kind: "unassessed", reason: "fps", powerSaving: true });
    expect(fps.chip).toBe("Can't assess");
    expect(fps.text).toMatch(/too few frames/);
    expect(fps.text).toMatch(/Power saving is on/);
    expect(heroCopy({ kind: "unassessed", reason: "wajah", powerSaving: true }).text).not.toMatch(/Power saving/);
    expect(heroCopy({ kind: "unassessed", reason: null, powerSaving: false }).title).toBe(UNASSESSED.fps.title);
  });

  it("says when the last state was read instead of showing it as current", () => {
    expect(lastAssessedNote("lelah ringan", 3.4)).toBe("Last assessed 3 min ago: Mildly tired.");
    expect(lastAssessedNote("normal", 0.2)).toMatch(/less than a minute ago/);
    expect(lastAssessedNote(null, null)).toMatch(/No state/);
  });

  it("explains a limited check, and nothing for a full one", () => {
    expect(limitedNote("nilai", null, true)).toBeNull();
    expect(limitedNote("terbatas-fps", "fps", false)).toMatch(/blinks are not timed/);
    expect(limitedNote("terbatas-mata", "kacamata", false)).toMatch(/often glasses/);
    expect(limitedNote("terbatas-mata", "mata", false)).toMatch(/only yawning counts/);
  });
});
