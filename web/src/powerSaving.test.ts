import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "./calibration.ts";
import {
  detectIntervalMs,
  initialPowerState,
  isLowBattery,
  loadPowerChoice,
  NORMAL_INTERVAL_MS,
  onBattery,
  onToggle,
  POWER_KEY,
  powerReason,
  SAVING_INTERVAL_MS,
  savePowerChoice,
} from "./powerSaving.ts";

describe("power saving state", () => {
  it("follows the user's choice", () => {
    expect(powerReason(initialPowerState(false))).toBeNull();
    expect(powerReason(initialPowerState(true))).toBe("pilihan");
    expect(powerReason(onToggle(initialPowerState(false), true))).toBe("pilihan");
  });

  it("switches on by itself on a low battery that is not charging, and off once it recovers", () => {
    expect(isLowBattery(0.19, false)).toBe(true);
    expect(isLowBattery(0.19, true)).toBe(false);
    expect(isLowBattery(0.2, false)).toBe(false);

    const low = onBattery(initialPowerState(false), true);
    expect(powerReason(low)).toBe("baterai");
    expect(powerReason(onBattery(low, false))).toBeNull();
  });

  it("stays off after being switched off on a low battery, until the battery recovers", () => {
    const dismissed = onToggle(onBattery(initialPowerState(false), true), false);
    expect(powerReason(dismissed)).toBeNull();
    expect(dismissed.chosen).toBe(false);
    // Still low (e.g. the level drops further): the dismissal holds.
    expect(powerReason(onBattery(dismissed, true))).toBeNull();
    // Charged, then low again: on again.
    expect(powerReason(onBattery(onBattery(dismissed, false), true))).toBe("baterai");
  });

  it("keeps the user's choice when the battery recovers", () => {
    const chosen = onToggle(onBattery(initialPowerState(false), true), true);
    expect(powerReason(onBattery(chosen, false))).toBe("pilihan");
  });

  it("calibrates at the normal rate whatever the mode", () => {
    const on = initialPowerState(true);
    expect(detectIntervalMs(on, false)).toBe(SAVING_INTERVAL_MS);
    expect(detectIntervalMs(on, true)).toBe(NORMAL_INTERVAL_MS);
    expect(detectIntervalMs(initialPowerState(false), false)).toBe(NORMAL_INTERVAL_MS);
  });
});

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("power saving storage", () => {
  it("round-trips the choice and defaults to off", () => {
    const store = memoryStore();
    expect(loadPowerChoice(store)).toBe(false);
    expect(savePowerChoice(store, true)).toBe(true);
    expect(loadPowerChoice(store)).toBe(true);
    expect(savePowerChoice(store, false)).toBe(true);
    expect(store.data.get(POWER_KEY)).toBe("0");
    expect(loadPowerChoice(store)).toBe(false);
  });

  it("survives storage that throws", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(loadPowerChoice(broken)).toBe(false);
    expect(savePowerChoice(broken, true)).toBe(false);
  });
});
