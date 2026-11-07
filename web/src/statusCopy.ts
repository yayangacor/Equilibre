import type { QualityLevel, QualityReason } from "./quality.ts";
import type { Label } from "./rules.ts";
import { stateName } from "./stateCopy.ts";

// The words of the dashboard hero (plan P14): the label in plain, kind language, in the tone of
// Gentler Streak and LookAway (no blame, no alarm, a next step), one short line each (D-64). The
// label name itself stays in the chip next to it; specific advice comes from the Langflow flow.

export type HeroState =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "uncalibrated" }
  | { kind: "calibrating" }
  | { kind: "paused" }
  | { kind: "analyzing" }
  | { kind: "label"; label: Label }
  // The camera could not read the last windows (quality.ts, plan P20 W1.4): the last label is stale.
  | { kind: "unassessed"; reason: QualityReason | null; powerSaving: boolean };

export type HeroCopy = { chip: string; title: string; text: string };

const LABEL_COPY: Record<Label, { title: string; text: string }> = {
  normal: {
    title: "You look fresh",
    text: "No signs of fatigue in the last minute.",
  },
  "lelah ringan": {
    title: "Early signs of fatigue",
    text: "Rest your eyes for a moment.",
  },
  lelah: {
    title: "You look tired",
    text: "Time for a short break.",
  },
  tertidur: {
    title: "You seem to have fallen asleep",
    text: "Once you are awake, move around a little and consider proper rest before you continue.",
  },
  "tidak di depan layar": {
    title: "You are away from the screen",
    text: "Time away from the screen of 2 min or more counts as a break.",
  },
};

export function heroCopy(state: HeroState): HeroCopy {
  switch (state.kind) {
    case "off":
      return {
        chip: "Camera off",
        title: "The camera is off",
        text: "Video never leaves this laptop. Turn on the camera to start.",
      };
    case "loading":
      return {
        chip: "Loading…",
        title: "Getting Equilibre ready…",
        text: "Loading the camera and the detection model. Everything runs on this device.",
      };
    case "error":
      return { chip: "Camera off", title: "The camera cannot be used yet", text: state.message };
    case "uncalibrated":
      return {
        chip: "Not calibrated",
        title: "Start with a calibration",
        text: "About 5 min, so Equilibre learns what normal looks like for you.",
      };
    case "calibrating":
      return { chip: "Calibrating…", title: "Calibration in progress", text: "Follow the prompts on the camera view." };
    case "paused":
      return { chip: "Paused", title: "Monitoring is paused", text: "The camera is off. Resume when you're back at work." };
    case "analyzing":
      return { chip: "Analyzing…", title: "Reading your state", text: "The first reading appears in about 10 s." };
    case "label":
      return { chip: stateName(state.label), ...LABEL_COPY[state.label] };
    case "unassessed": {
      const copy = UNASSESSED[state.reason ?? "fps"];
      const power = state.reason === "fps" && state.powerSaving ? ` ${POWER_TIP}` : "";
      return { chip: "Can't assess", title: copy.title, text: copy.text + power };
    }
  }
}

// "Can't assess": what went wrong, then what helps (research report §2.7: try to fix it before giving up).
// No blame, one step each.
export const UNASSESSED: Readonly<Record<QualityReason, { title: string; text: string }>> = {
  fps: {
    title: "Can't assess right now",
    text: "The camera is reading too few frames. Keep this tab or the Picture-in-Picture window open.",
  },
  mata: {
    title: "Can't see your eyes",
    text: "Looking at a phone or a document? Checking resumes when you look at the screen.",
  },
  wajah: { title: "Can't read your face", text: "Face the screen, about an arm's length from the camera." },
  cahaya: { title: "Too dark to read your face", text: "Turn on a light in front of you, or face a window." },
  kacamata: {
    title: "Can't read your eyes",
    text: "Your calibration couldn't tell open from closed eyes. Recalibrate with light from the front.",
  },
};

export const POWER_TIP = "Power saving is on: turning it off helps.";

// The level under a fresh label when only part of the signs could be read. null for a full check.
export function limitedNote(level: QualityLevel | null, reason: QualityReason | null, powerSaving: boolean): string | null {
  if (level === "terbatas-fps") {
    return (
      "Limited check: the camera runs below 8 frames per second, so blinks are not timed. " +
      "Eye closure, long closures and yawns still count." +
      (powerSaving ? ` ${POWER_TIP}` : "")
    );
  }
  if (level === "terbatas-mata") {
    return reason === "kacamata"
      ? "Limited check: your calibration couldn't tell open from closed eyes (often glasses), so only yawning counts. " +
          "Recalibrating with light from the front can help."
      : "Limited check: your eyes were hard to read, so only yawning counts.";
  }
  return null;
}

// Under "Can't assess": the label that was last read, and how long ago. Never shown as if it were current.
export function lastAssessedNote(label: Label | null, minutesAgo: number | null): string {
  if (label === null || minutesAgo === null) return "No state has been read yet.";
  const when = minutesAgo < 1 ? "less than a minute ago" : `${Math.round(minutesAgo)} min ago`;
  return `Last assessed ${when}: ${stateName(label)}.`;
}

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
