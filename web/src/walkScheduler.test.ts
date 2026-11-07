import { describe, expect, it } from "vitest";
import { DEFAULT_SLUMP, type SlumpWindow } from "./phase.ts";
import { dismissWalk, initialWalkState, stepWalk, WALK, type WalkInput, type WalkState, type WalkTrigger } from "./walkScheduler.ts";

// The short-walk scheduler (plan P20 W2.5): each trigger, the 30-minute cap, the meeting block, the break reset, and
// the negative control (a fresh morning right after a break: nothing to say).

const at = (h: number, min = 0) => new Date(2026, 10, 10, h, min).getTime();
const PERSONAL: SlumpWindow = { startHour: 15, endHour: 16, personal: true };

const input = (now: number, minutesSinceBreak: number | null, extra: Partial<WalkInput> = {}): WalkInput => ({
  now,
  minutesSinceBreak,
  slump: DEFAULT_SLUMP,
  meeting: false,
  quiet: false,
  ...extra,
});

// Steps through the inputs in order and collects what was said.
function run(inputs: WalkInput[], start: WalkState = initialWalkState()) {
  let state = start;
  const said: (WalkTrigger | null)[] = [];
  const hidden: boolean[] = [];
  for (const i of inputs) {
    const out = stepWalk(state, i);
    state = out.state;
    said.push(out.say);
    hidden.push(out.hide);
  }
  return { state, said, hidden };
}

const once = (i: WalkInput, state: WalkState = initialWalkState()) => stepWalk(state, i).say;

describe("short-walk scheduler: triggers", () => {
  it("negative control: a fresh morning just after a break says nothing, and neither does a long morning stretch", () => {
    expect(once(input(at(9, 0), 2))).toBeNull();
    expect(once(input(at(9, 0), 0))).toBeNull(); // away on a break right now
    expect(once(input(at(10, 30), 120))).toBeNull(); // outside the slump and its lead time
    expect(once(input(at(17, 0), 90))).toBeNull(); // after the default window
  });

  it("before the slump: from 12:30 for the default 13:00 window, only with ≥ 30 min since the last break", () => {
    expect(WALK.leadMinutes).toBe(30);
    expect(once(input(at(12, 29), 60))).toBeNull();
    expect(once(input(at(12, 30), 30))).toBe("sebelum-rawan");
    expect(once(input(at(12, 45), 29))).toBeNull();
    expect(once(input(at(12, 59), 45))).toBe("sebelum-rawan");
  });

  it("before the slump follows the personal window: 14:30 for a 15:00 low hour, not 12:30", () => {
    expect(once(input(at(12, 30), 60, { slump: PERSONAL }))).toBeNull();
    expect(once(input(at(13, 30), 60, { slump: PERSONAL }))).toBeNull();
    expect(once(input(at(14, 30), 30, { slump: PERSONAL }))).toBe("sebelum-rawan");
    expect(once(input(at(15, 10), 30, { slump: PERSONAL }))).toBe("rawan");
    expect(once(input(at(16, 0), 90, { slump: PERSONAL }))).toBeNull();
  });

  it("during the slump: after 30 min of continuous screen time, then every 30 min while no break is taken", () => {
    expect(once(input(at(13, 10), 29))).toBeNull();
    const { said } = run([
      input(at(13, 10), 30),
      input(at(13, 20), 40),
      input(at(13, 39), 59),
      input(at(13, 40), 60),
      input(at(15, 59), 199),
    ]);
    expect(said).toEqual(["rawan", null, null, "rawan", "rawan"]);
  });

  it("after a task is marked done: at any hour, even with the camera off", () => {
    expect(once(input(at(10, 0), 5, { taskDone: true }))).toBe("tugas-selesai");
    expect(once(input(at(10, 0), null, { taskDone: true }))).toBe("tugas-selesai");
    expect(once(input(at(10, 0), null))).toBeNull();
    // Camera off: no screen time, so no slump walk either.
    expect(once(input(at(13, 30), null))).toBeNull();
  });
});

describe("short-walk scheduler: limits", () => {
  it("at most one suggestion per 30 minutes, whichever trigger; a task done inside the cap is dropped", () => {
    const { said } = run([
      input(at(12, 40), 40), // before the slump
      input(at(12, 50), 50, { taskDone: true }),
      input(at(13, 9), 69),
      input(at(13, 10), 70), // 30 min after the first
      input(at(13, 11), 71, { taskDone: true }),
      input(at(13, 12), 72), // the dropped task-done walk is not caught up
    ]);
    expect(said).toEqual(["sebelum-rawan", null, null, "rawan", null, null]);
  });

  it("never while marked in a meeting; a suggestion on screen is withdrawn when the meeting starts", () => {
    const { said, hidden } = run([
      input(at(13, 10), 30),
      input(at(13, 15), 35, { meeting: true }),
      input(at(13, 45), 65, { meeting: true }),
      input(at(13, 46), 66, { meeting: true, taskDone: true }),
      input(at(14, 0), 80), // the meeting is over
    ]);
    expect(said).toEqual(["rawan", null, null, null, "rawan"]);
    expect(hidden).toEqual([false, true, false, false, false]);
  });

  it("never while nudges are quiet (snoozed, or another nudge on screen)", () => {
    expect(once(input(at(13, 30), 60, { quiet: true }))).toBeNull();
    expect(once(input(at(10, 0), 5, { quiet: true, taskDone: true }))).toBeNull();
  });
});

describe("short-walk scheduler: a break counts as the walk (NOTES D-42)", () => {
  it("withdraws the suggestion and starts the screen time again", () => {
    const { said, hidden, state } = run([
      input(at(12, 40), 40), // suggested
      input(at(12, 44), 44), // still at the screen: stays
      input(at(12, 46), 0), // away for ≥ 2 min: on the walk now
      input(at(12, 50), 2), // back, count restarted at 12:48
      input(at(13, 17), 29), // 29 min since that break: not yet
      input(at(13, 18), 30),
    ]);
    expect(said).toEqual(["sebelum-rawan", null, null, null, null, "rawan"]);
    expect(hidden).toEqual([false, false, true, false, false, false]);
    expect(state.shown?.trigger).toBe("rawan");
  });

  it("a break does not lift the cap: a task done 15 min after the suggestion is dropped", () => {
    const { said } = run([input(at(12, 40), 40), input(at(12, 48), 0), input(at(12, 55), 5, { taskDone: true })]);
    expect(said).toEqual(["sebelum-rawan", null, null]);
  });
});

describe("short-walk scheduler: on screen", () => {
  it("dismiss hides it and still counts for the cap; an undismissed one goes after 30 min", () => {
    const first = stepWalk(initialWalkState(), input(at(13, 10), 30));
    const dismissed = dismissWalk(first.state);
    expect(dismissed.shown).toBeNull();
    expect(stepWalk(dismissed, input(at(13, 20), 40)).say).toBeNull();

    const later = stepWalk(first.state, input(at(13, 39), 59));
    expect(later).toMatchObject({ say: null, hide: false });
    expect(later.state.shown?.at).toBe(at(13, 10));
    const replaced = stepWalk(first.state, input(at(13, 40), 60));
    expect(replaced).toMatchObject({ say: "rawan", hide: false });
    expect(replaced.state.shown?.at).toBe(at(13, 40));
    const gone = stepWalk(first.state, input(at(13, 40), 60, { quiet: true }));
    expect(gone).toMatchObject({ say: null, hide: true });
    expect(gone.state.shown).toBeNull();
  });
});
