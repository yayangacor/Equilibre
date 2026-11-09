import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyValueStore } from "./calibration.ts";
import { loadTestState, phase } from "./userTest.ts";
import { UserTestPanel, type UserTestDeps } from "./userTestPanel.ts";

// The consent card of the ?kode= user test (userTestPanel.ts) over a minimal fake DOM: it names the "Plan my next
// hour" plans before the tester can agree, and agreeing is what lets them be sent (NOTES D-105). Logic and copy only;
// how it looks is the browser check.

class FakeElement {
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  className = "";
  type = "";
  value = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: (FakeElement | string)[] = [];
  private readonly listeners = new Map<string, (() => void)[]>();
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  click() {
    if (!this.disabled) this.dispatch("click");
  }
  setAttribute() {}
  replaceChildren(...nodes: (FakeElement | string)[]) {
    this.children = nodes;
  }
  append(...nodes: (FakeElement | string)[]) {
    this.children.push(...nodes);
  }
  querySelector(): FakeElement | null {
    return null; // no radio answer picked: the intake is optional
  }
}

const descendants = (node: FakeElement): FakeElement[] =>
  node.children.flatMap((c) => (typeof c === "string" ? [] : [c, ...descendants(c)]));
const text = (node: FakeElement): string => node.textContent + node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");

let elements: Map<string, FakeElement>;
const body = () => elements.get("uji-body")!;

beforeEach(() => {
  elements = new Map(["uji-card", "uji-body", "uji-code", "flow-uji"].map((id) => [id, new FakeElement()]));
  vi.stubGlobal("document", { getElementById: (id: string) => elements.get(id) ?? null, createElement: () => new FakeElement() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

function open(store: KeyValueStore) {
  const deps: UserTestDeps = {
    store,
    code: "EQ-7K2M",
    isCalibrating: () => false,
    startCalibration: () => {},
    openCompanion: null,
    records: async () => null,
    device: () => ({ browser: "x", os: "x", kamera: null, fps_rata: null }),
    baseline: () => null,
    beep: () => {},
    onStarted: () => {},
  };
  const panel = new UserTestPanel(deps);
  panel.render();
  return panel;
}

describe("the consent card and the plans (NOTES D-105)", () => {
  it('names the "Plan my next hour" plans and the "Fits" answers under what is sent, before the agree box', () => {
    open(memoryStore());
    const parts = body().children.filter((c): c is FakeElement => typeof c !== "string");
    const plans = parts.findIndex((p) => text(p).includes("Plan my next hour"));
    const sentHeading = parts.findIndex((p) => text(p).startsWith("What is sent"));
    const neverHeading = parts.findIndex((p) => text(p).startsWith("What is never sent"));
    const agree = parts.findIndex((p) => p.className === "check");
    expect(sentHeading).toBeGreaterThanOrEqual(0);
    expect(plans).toBeGreaterThan(sentHeading);
    expect(plans).toBeLessThan(neverHeading);
    expect(plans).toBeLessThan(agree);
    const copy = text(parts[plans]);
    expect(copy).toContain("never their titles");
    expect(copy).toContain('"Fits" / "Doesn\'t fit"');
  });

  it("agreeing on this card records that it named the plans; the button waits for the box", () => {
    const store = memoryStore();
    open(store);
    const start = descendants(body()).find((e) => e.textContent === "Agree and continue to calibration")!;
    start.click(); // disabled until the box is ticked
    expect(loadTestState(store, "EQ-7K2M").setuju).toBeNull();

    const box = descendants(body()).find((e) => e.type === "checkbox")!;
    box.checked = true;
    box.dispatch("change");
    start.click();
    const saved = loadTestState(store, "EQ-7K2M");
    expect(saved.setuju).not.toBeNull();
    expect(saved.setuju_keputusan).toBe(true);
    expect(phase(saved, Date.now())).toBe("kalibrasi");
  });
});
