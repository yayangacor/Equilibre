import { describe, expect, it, vi } from "vitest";
import type { KeyValueStore } from "./calibration.ts";
import { afterClick, needsWelcome, saveWelcomeDone, WELCOME_KEY, welcomeDone } from "./welcome.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("welcome before the camera", () => {
  it("asks for the camera only after the click, and only once", async () => {
    const button = new EventTarget();
    const getUserMedia = vi.fn(async () => "stream");
    const started = afterClick([button], getUserMedia);
    await tick();
    expect(getUserMedia).not.toHaveBeenCalled();
    button.dispatchEvent(new Event("click"));
    await expect(started).resolves.toBe("stream");
    button.dispatchEvent(new Event("click"));
    await tick();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("starts from whichever button is clicked first", async () => {
    const [welcomeButton, heroButton] = [new EventTarget(), new EventTarget()];
    const start = vi.fn(async () => undefined);
    const started = afterClick([welcomeButton, heroButton], start);
    heroButton.dispatchEvent(new Event("click"));
    await started;
    welcomeButton.dispatchEvent(new Event("click"));
    await tick();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("shows on a first visit only, and never with ?kamera=0", () => {
    expect(needsWelcome({ noCamera: false, done: false, calibrated: false })).toBe(true);
    expect(needsWelcome({ noCamera: false, done: true, calibrated: false })).toBe(false);
    expect(needsWelcome({ noCamera: false, done: false, calibrated: true })).toBe(false);
    expect(needsWelcome({ noCamera: true, done: false, calibrated: false })).toBe(false);
  });

  it("remembers the click, and shows again when storage throws", () => {
    const data = new Map<string, string>();
    const store: KeyValueStore = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
    expect(welcomeDone(store)).toBe(false);
    expect(saveWelcomeDone(store)).toBe(true);
    expect(data.get(WELCOME_KEY)).toBe("1");
    expect(welcomeDone(store)).toBe(true);
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(welcomeDone(broken)).toBe(false);
    expect(saveWelcomeDone(broken)).toBe(false);
  });
});
