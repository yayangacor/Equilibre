import type { KeyValueStore } from "./calibration.ts";

// Power saving halves the detection rate. What that costs was measured on the 21 Sep
// session (NOTES G-34): 15–21% of blinks are missed, and back-to-back blinks can merge
// into one "eyes closed ≥1 s". Calibration always runs at the normal rate, so one
// baseline serves both modes (user decision 22 Sep).
export const NORMAL_INTERVAL_MS = 100; // ±10 fps
export const SAVING_INTERVAL_MS = 200; // ±5 fps
// ⚠️ Below this battery level, and not charging, power saving switches itself on.
export const LOW_BATTERY = 0.2;

export type PowerState = {
  chosen: boolean; // the user's own choice, remembered on this device
  lowBattery: boolean;
  dismissed: boolean; // switched off by hand while the battery was low: stays off until it recovers
};

export type PowerReason = "pilihan" | "baterai" | null;

export const initialPowerState = (chosen: boolean): PowerState => ({ chosen, lowBattery: false, dismissed: false });

export const isLowBattery = (level: number, charging: boolean) => !charging && level < LOW_BATTERY;

export function powerReason(s: PowerState): PowerReason {
  if (s.chosen) return "pilihan";
  return s.lowBattery && !s.dismissed ? "baterai" : null;
}

// A recovered battery (charging, or level back up) clears the dismissal, so the next
// low battery switches power saving on again.
export function onBattery(s: PowerState, lowBattery: boolean): PowerState {
  return { ...s, lowBattery, dismissed: lowBattery && s.dismissed };
}

// Switching off while the battery holds it on means "not now", not a new choice.
export function onToggle(s: PowerState, on: boolean): PowerState {
  return { chosen: on, lowBattery: s.lowBattery, dismissed: !on && s.lowBattery };
}

export function detectIntervalMs(s: PowerState, calibrating: boolean): number {
  return !calibrating && powerReason(s) !== null ? SAVING_INTERVAL_MS : NORMAL_INTERVAL_MS;
}

// ── Persistence ─────────────────────────────────────────────────────────────────

export const POWER_KEY = "equilibre.hemat-daya.v1";

export function loadPowerChoice(store: KeyValueStore): boolean {
  try {
    return store.getItem(POWER_KEY) === "1";
  } catch {
    return false;
  }
}

export function savePowerChoice(store: KeyValueStore, on: boolean): boolean {
  try {
    store.setItem(POWER_KEY, on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}
