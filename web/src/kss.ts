// Karolinska Sleepiness Scale (Åkerstedt & Gillberg, 1990), in the version with a label
// on every step (Baulk et al., 2001), as listed in Miley, Kecklund & Åkerstedt (2016),
// Sleep Biol Rhythms 14:257–260. A rating covers the 5 minutes before it, because being
// asked can itself reduce sleepiness (Åkerstedt et al., 2014, J Sleep Res).
// The Indonesian wording is Equilibre's own translation, not a validated version ⚠️.
// Copyright: Torbjörn Åkerstedt (ePROVIDE); terms of use not checked yet (NOTES Q-13).
// Used for the user test (NOTES D-20, D-36): KSS against the label shown at that moment.

export const KSS_SCALE = [
  { nilai: 1, teks: "Sangat-sangat waspada", asli: "Extremely alert" },
  { nilai: 2, teks: "Sangat waspada", asli: "Very alert" },
  { nilai: 3, teks: "Waspada", asli: "Alert" },
  { nilai: 4, teks: "Cukup waspada", asli: "Rather alert" },
  { nilai: 5, teks: "Tidak waspada, tapi juga tidak mengantuk", asli: "Neither alert nor sleepy" },
  { nilai: 6, teks: "Ada sedikit tanda mengantuk", asli: "Some signs of sleepiness" },
  { nilai: 7, teks: "Mengantuk, tapi tidak perlu berusaha untuk tetap terjaga", asli: "Sleepy, but no effort to keep awake" },
  { nilai: 8, teks: "Mengantuk, perlu sedikit usaha untuk tetap terjaga", asli: "Sleepy, some effort to keep awake" },
  {
    nilai: 9,
    teks: "Sangat mengantuk, perlu usaha keras untuk tetap terjaga, melawan kantuk",
    asli: "Very sleepy, great effort to keep awake, fighting sleep",
  },
] as const;

// Test mode (?uji=1) asks for a rating every 15 minutes (NOTES D-20).
export const KSS_REMINDER_MS = 15 * 60_000;

// `since`: the last rating, or when monitoring started if there is none yet.
export const kssDue = (since: number, now: number) => now - since >= KSS_REMINDER_MS;

export const isKss = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 9;
