import type { KeyValueStore } from "./calibration.ts";

// Developer mode (plans/P17 C11, NOTES D-74): the Debug page is in the menu only while it is on, so a
// worker sees the app rather than its raw signals (mentor feedback, 25 Oct). Switched on in Privasi or with
// ?debug=1, and remembered on this device. The page itself still opens from its address (#debug).
export const DEV_MODE_KEY = "equilibre.mode-pengembang.v1";

export function loadDevMode(store: KeyValueStore): boolean {
  try {
    return store.getItem(DEV_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveDevMode(store: KeyValueStore, on: boolean): boolean {
  try {
    store.setItem(DEV_MODE_KEY, on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}

// The menu link also shows while the Debug page is open, so the open page always has its menu item.
export const showDebugLink = (devMode: boolean, page: string) => devMode || page === "debug";
