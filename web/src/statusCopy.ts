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
  | { kind: "label"; label: Label };

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
  }
}

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
