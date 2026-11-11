import { describe, expect, it } from "vitest";
import type { ImportedTask } from "./googleTasks.ts";
import { RUBRIC_CHOICES } from "./planCard.ts";
import { emptyTagMemory, rememberTag } from "./taskTagger.ts";
import { groupTasks, setGroupKind, tasksWithoutKind } from "./tasksView.ts";

const TODAY = "2026-11-11";
const task = (id: string, title: string, order: number): ImportedTask => ({ id, listId: "L1", listTitle: "Work", title, due: null, parent: null, order });
const ACTIVE_HEAVY = RUBRIC_CHOICES[0];
const ROUTINE_LIGHT = RUBRIC_CHOICES[3];

describe("groupTasks (the Tasks page, user 11 Nov)", () => {
  it("puts tasks under one \"[…]\" label in one group, in list order; other tasks stand alone", () => {
    const tasks = [
      task("a", "[Deep Learning] - [Sesi 2]", 2),
      task("b", "[Deep Learning] - [Sesi 1]", 0),
      task("c", "Zorbify thing", 1),
    ];
    const groups = groupTasks(tasks, TODAY, emptyTagMemory());
    expect(groups.map((g) => [g.label, g.tasks.map((t) => t.id)])).toEqual([
      ["[Deep Learning]", ["b", "a"]],
      [null, ["c"]],
    ]);
    expect(groups.every((g) => g.kind === null && !g.mixed)).toBe(true);
  });

  it("one pick gives every task of the group that kind, and teaches the label for new tasks of it", () => {
    const tasks = [task("a", "[Deep Learning] - [Sesi 1]", 0), task("b", "[Deep Learning] - [Sesi 2]", 1)];
    const [group] = groupTasks(tasks, TODAY, emptyTagMemory());
    const memory = setGroupKind(emptyTagMemory(), group, ROUTINE_LIGHT.rubric);
    expect(groupTasks(tasks, TODAY, memory)[0].kind?.text).toBe("Routine, light");
    const later = task("c", "[Deep Learning] - [Sesi 3]", 2);
    expect(groupTasks([later], TODAY, memory)[0].kind?.text).toBe("Routine, light");
    // Negative control: another course is not tagged by it.
    expect(groupTasks([task("d", "[Algorithm and Programming] - [Sesi 1]", 3)], TODAY, memory)[0].kind).toBeNull();
  });

  it("a group whose tasks have different kinds shows as mixed, with no kind", () => {
    const tasks = [task("a", "[Deep Learning] - [Sesi 1]", 0), task("b", "[Deep Learning] - [Sesi 2]", 1)];
    const memory = rememberTag(emptyTagMemory(), tasks[0], ACTIVE_HEAVY.rubric);
    const changed = rememberTag(memory, tasks[1], ROUTINE_LIGHT.rubric);
    const [group] = groupTasks(tasks, TODAY, changed);
    expect(group.mixed).toBe(true);
    expect(group.kind).toBeNull();
  });
});

describe("tasksWithoutKind", () => {
  it("counts the open tasks without a kind, and drops to 0 once their groups are set", () => {
    const tasks = [task("a", "[Deep Learning] - [Sesi 1]", 0), task("b", "[Deep Learning] - [Sesi 2]", 1), task("c", "Zorbify thing", 2)];
    expect(tasksWithoutKind(tasks, TODAY, emptyTagMemory())).toBe(3);
    let memory = setGroupKind(emptyTagMemory(), groupTasks(tasks, TODAY, emptyTagMemory())[0], ACTIVE_HEAVY.rubric);
    expect(tasksWithoutKind(tasks, TODAY, memory)).toBe(1);
    memory = setGroupKind(memory, { tasks: [tasks[2]] }, ROUTINE_LIGHT.rubric);
    expect(tasksWithoutKind(tasks, TODAY, memory)).toBe(0);
  });
});
