import type { ImportedTask } from "./googleTasks.ts";
import { kindOf, RUBRIC_CHOICES, tasksToAsk } from "./planCard.ts";
import { bracketPrefix, rememberTag, type Rubric, type TagMemory } from "./taskTagger.ts";

// The Tasks page (user 11 Nov): the open Google tasks, each with the kind of work the user sets. Tasks named under one
// "[…]" label are one group with one kind (NOTES D-107: everyone names tasks their own way); every other task is its
// own row. Pure: tasksPanel.ts draws it.

export type KindChoice = (typeof RUBRIC_CHOICES)[number];

// key: the "[…]" label's key, or "task:<id>" for a task of its own. kind: the kind all its tasks have now; null when
// none is set or they differ (mixed).
export type TaskGroup = { key: string; label: string | null; tasks: ImportedTask[]; kind: KindChoice | null; mixed: boolean };

export function groupTasks(tasks: readonly ImportedTask[], today: string, memory: TagMemory): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const task of [...tasks].sort((a, b) => a.order - b.order)) {
    const prefix = bracketPrefix(task.title);
    const key = prefix ? prefix.key : `task:${task.listId}:${task.id}`;
    const group = groups.get(key) ?? { key, label: prefix?.text ?? null, tasks: [], kind: null, mixed: false };
    group.tasks.push(task);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const kinds = group.tasks.map((t) => kindOf(t, today, memory));
    const first = kinds[0];
    const same = kinds.every((k) => k?.text === first?.text);
    group.kind = same ? first : null;
    group.mixed = !same;
  }
  return [...groups.values()];
}

// One pick for a whole group: every task in it gets the kind as the user's answer (rememberTag), which also teaches the
// "[…]" label or the title's word, so new tasks of the group come in with it.
export function setGroupKind(memory: TagMemory, group: Pick<TaskGroup, "tasks">, rubric: Rubric): TagMemory {
  return group.tasks.reduce((m, task) => rememberTag(m, task, rubric), memory);
}

// Open tasks the next plan would send without a kind: the number the Dashboard links to the Tasks page with.
export function tasksWithoutKind(tasks: readonly ImportedTask[], today: string, memory: TagMemory): number {
  return tasksToAsk(tasks, today, memory, Number.POSITIVE_INFINITY).reduce((sum, item) => sum + item.count, 0);
}
