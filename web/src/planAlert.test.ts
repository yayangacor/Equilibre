import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "./calibration.ts";
import type { PlanView } from "./planCard.ts";
import { alertChannels, loadPlanAlert, planAlertNote, planAlertText, savePlanAlert, type AlertInput } from "./planAlert.ts";

const base: AlertInput = { on: true, meeting: false, away: true, permission: "granted" };

describe("alertChannels: the automatic plan's sound and notification (user 11 Nov)", () => {
  it("away from the tab with permission: sound and notification", () => {
    expect(alertChannels(base)).toEqual({ sound: true, notify: true });
  });

  it("looking at the tab, or no permission: the sound only", () => {
    expect(alertChannels({ ...base, away: false })).toEqual({ sound: true, notify: false });
    for (const permission of ["default", "denied", "unsupported"] as const) {
      expect(alertChannels({ ...base, permission })).toEqual({ sound: true, notify: false });
    }
  });

  it("negative controls: in a meeting (D-106) or switched off, nothing at all", () => {
    expect(alertChannels({ ...base, meeting: true })).toEqual({ sound: false, notify: false });
    expect(alertChannels({ ...base, on: false })).toEqual({ sound: false, notify: false });
  });
});

describe("planAlertText", () => {
  const view = (steps: PlanView["steps"]): PlanView => ({ steps, why: null, badge: "", badgeNote: null, sources: null });

  it("names the plan's first step as the card does", () => {
    const task = { kind: "tugas" as const, label: "Task", minutes: "25 min", text: "", title: "“Reply to Dina”", why: null };
    expect(planAlertText(view([task]))).toEqual({ title: "You look tired", body: "Your next hour is planned. First: Task · 25 min “Reply to Dina”" });
    const walk = { kind: "jalan" as const, label: "Walk", minutes: "5 min", text: "", title: null, why: null };
    expect(planAlertText(view([walk])).body).toBe("Your next hour is planned. First: Walk · 5 min");
    expect(planAlertText(view([])).body).toBe("Your next hour is planned.");
  });
});

describe("the setting", () => {
  const storage = (): KeyValueStore => {
    const items = new Map<string, string>();
    return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) };
  };

  it("is on until the user turns it off, and remembers that", () => {
    const s = storage();
    expect(loadPlanAlert(s)).toBe(true);
    savePlanAlert(s, false);
    expect(loadPlanAlert(s)).toBe(false);
    savePlanAlert(s, true);
    expect(loadPlanAlert(s)).toBe(true);
  });

  it("blocked storage: on, and saving says it did not save", () => {
    const blocked: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(loadPlanAlert(blocked)).toBe(true);
    expect(savePlanAlert(blocked, false)).toBe(false);
  });

  it("the note says what the user will get", () => {
    expect(planAlertNote(false, "granted")).toMatch(/^Off\./);
    expect(planAlertNote(true, "granted")).toMatch(/desktop notification/);
    expect(planAlertNote(true, "default")).toMatch(/Try it/);
    expect(planAlertNote(true, "denied")).toMatch(/blocks notifications/);
  });
});
