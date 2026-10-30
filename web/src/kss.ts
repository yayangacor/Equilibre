import type { KeyValueStore } from "./calibration.ts";

// Karolinska Sleepiness Scale (Åkerstedt & Gillberg, 1990), in the version with a label
// on every step (Baulk et al., 2001), as listed in Miley, Kecklund & Åkerstedt (2016),
// Sleep Biol Rhythms 14:257–260. A rating covers the 5 minutes before it, because being
// asked can itself reduce sleepiness (Åkerstedt et al., 2014, J Sleep Res).
// teks is what the screen shows: the English wording of the source (NOTES D-78), the same as asli.
// The earlier Indonesian wording was Equilibre's own translation, not a validated version ⚠️.
// Copyright: Torbjörn Åkerstedt (ePROVIDE); terms of use not checked yet (NOTES Q-13).
// Used for the user test (NOTES D-20, D-36): KSS against the label shown at that moment.

export const KSS_SCALE = [
  { nilai: 1, teks: "Extremely alert", asli: "Extremely alert" },
  { nilai: 2, teks: "Very alert", asli: "Very alert" },
  { nilai: 3, teks: "Alert", asli: "Alert" },
  { nilai: 4, teks: "Rather alert", asli: "Rather alert" },
  { nilai: 5, teks: "Neither alert nor sleepy", asli: "Neither alert nor sleepy" },
  { nilai: 6, teks: "Some signs of sleepiness", asli: "Some signs of sleepiness" },
  { nilai: 7, teks: "Sleepy, but no effort to keep awake", asli: "Sleepy, but no effort to keep awake" },
  { nilai: 8, teks: "Sleepy, some effort to keep awake", asli: "Sleepy, some effort to keep awake" },
  {
    nilai: 9,
    teks: "Very sleepy, great effort to keep awake, fighting sleep",
    asli: "Very sleepy, great effort to keep awake, fighting sleep",
  },
] as const;

// The reminder asks for a rating every 15 minutes (NOTES D-20): always in a user test (?uji=1, ?kode=),
// otherwise when the user switches it on (D-67).
export const KSS_REMINDER_MS = 15 * 60_000;

// `since`: the last rating, or when monitoring started if there is none yet.
export const kssDue = (since: number, now: number) => now - since >= KSS_REMINDER_MS;

export const isKss = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 9;

// The user's choice for the reminder outside a user test, remembered on this device; off unless switched on.
export const KSS_REMINDER_KEY = "equilibre.pengingat-kss.v1";

export function loadKssReminder(store: KeyValueStore): boolean {
  try {
    return store.getItem(KSS_REMINDER_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveKssReminder(store: KeyValueStore, on: boolean): boolean {
  try {
    store.setItem(KSS_REMINDER_KEY, on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}
