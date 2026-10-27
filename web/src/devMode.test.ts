import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "./calibration.ts";
import { DEV_MODE_KEY, loadDevMode, saveDevMode, showDebugLink } from "./devMode.ts";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("developer mode (P17 C11)", () => {
  it("is off until switched on, and remembered on this device", () => {
    const store = memoryStore();
    expect(loadDevMode(store)).toBe(false);
    expect(saveDevMode(store, true)).toBe(true);
    expect(store.data.get(DEV_MODE_KEY)).toBe("1");
    expect(loadDevMode(store)).toBe(true);
    saveDevMode(store, false);
    expect(loadDevMode(store)).toBe(false);
  });

  it("stays off when storage throws", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    expect(loadDevMode(broken)).toBe(false);
    expect(saveDevMode(broken, true)).toBe(false);
  });

  it("hides the Debug link from the menu unless it is on or the Debug page is open", () => {
    expect(["dashboard", "insight", "tanya", "privasi"].some((page) => showDebugLink(false, page))).toBe(false);
    expect(showDebugLink(false, "debug")).toBe(true);
    expect(showDebugLink(true, "dashboard")).toBe(true);
  });
});
