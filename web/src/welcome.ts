import type { KeyValueStore } from "./calibration.ts";

// Welcome before the camera (plans/P17 C5): on a first visit the page first says what stays on this
// laptop, and the browser asks for the camera only after the user clicks "Nyalakan kamera". The click
// is remembered on this device, so later visits start the camera on load as before; a calibration saved
// on an earlier visit counts as such a visit.
export const WELCOME_KEY = "equilibre.sambutan.v1";

export function welcomeDone(store: KeyValueStore): boolean {
  try {
    return store.getItem(WELCOME_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveWelcomeDone(store: KeyValueStore): boolean {
  try {
    store.setItem(WELCOME_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

// ?kamera=0 pages never ask for the camera, so they show no welcome either.
export const needsWelcome = (o: { noCamera: boolean; done: boolean; calibrated: boolean }) =>
  !o.noCamera && !o.done && !o.calibrated;

// Runs `start` once, after the first click on any of `buttons`, and never before it.
export function afterClick<T>(buttons: Pick<EventTarget, "addEventListener">[], start: () => Promise<T>): Promise<T> {
  return new Promise<void>((resolve) => {
    for (const button of buttons) button.addEventListener("click", () => resolve(), { once: true });
  }).then(start);
}
