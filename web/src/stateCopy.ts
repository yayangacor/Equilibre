import { LABELS, type Label } from "./rules.ts";

// What the five labels are called on screen (NOTES D-78: the UI is English). The payload, the history and the
// server keep the Indonesian keys (D-01), so only this table and the CSS know both names.
export const STATE_NAME: Readonly<Record<Label, string>> = {
  normal: "Normal",
  "lelah ringan": "Mildly tired",
  lelah: "Tired",
  tertidur: "Asleep",
  "tidak di depan layar": "Away",
};

// The token suffix of each state in design/tokens.css (--s-normal, --s-mild, …).
export const STATE_TOKEN: Readonly<Record<Label, "normal" | "mild" | "tired" | "asleep" | "away">> = {
  normal: "normal",
  "lelah ringan": "mild",
  lelah: "tired",
  tertidur: "asleep",
  "tidak di depan layar": "away",
};

export const stateName = (label: Label): string => STATE_NAME[label];

// The states in order of how tired they read, Away last (it is time away, not a state at the screen).
export const STATE_ORDER: readonly Label[] = LABELS;
