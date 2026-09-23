import type { KeyValueStore } from "./calibration.ts";
import type { Label } from "./rules.ts";

// Sending the status to Langflow without the button (NOTES D-37, user decision 23 Sep).
// Each send is one LLM call, so: only when the shown label turns into one of
// AUTO_SEND.labels or the long rest advice appears, at most once every minGapMs, and
// only while the user has switched it on (off by default, remembered on this device).
// Details (agent, D-37): a change that falls inside the gap is sent once the gap is over
// if it still holds; the same condition is not sent twice in a row; back to "normal" or
// away from the screen ends the episode; a failed send still starts the gap, then the
// same condition is tried again after it.

export const AUTO_SEND = {
  labels: ["lelah ringan", "lelah", "tertidur"] as readonly Label[],
  minGapMs: 10 * 60_000,
} as const;

// What a send would be about. The long rest advice wins over the label, as on the server.
export type AutoTarget = Label | "istirahat panjang";

export type AutoSendState = {
  lastT: number | null; // last attempt (wall clock), successful or not
  sentFor: AutoTarget | null; // the condition of the current episode already sent
};

export const initialAutoSendState = (): AutoSendState => ({ lastT: null, sentFor: null });

export function autoTarget(shown: Label | null, longRest: boolean): AutoTarget | null {
  if (longRest) return "istirahat panjang";
  return shown !== null && AUTO_SEND.labels.includes(shown) ? shown : null;
}

// One evaluation. `enabled`: the toggle is on and no other send is in flight.
export function stepAutoSend(
  state: AutoSendState,
  target: AutoTarget | null,
  now: number,
  enabled: boolean,
): { send: boolean; state: AutoSendState } {
  if (target === null) return { send: false, state: { ...state, sentFor: null } }; // the episode is over
  if (!enabled || target === state.sentFor) return { send: false, state };
  if (state.lastT !== null && now - state.lastT < AUTO_SEND.minGapMs) return { send: false, state }; // waits for the gap
  return { send: true, state: { lastT: now, sentFor: target } };
}

// The send failed: keep the gap, but let the same condition be tried again after it.
export const afterFailedSend = (state: AutoSendState): AutoSendState => ({ ...state, sentFor: null });

// ── Persistence ─────────────────────────────────────────────────────────────────

export const AUTO_SEND_KEY = "equilibre.kirim-otomatis.v1";

export function loadAutoSend(store: KeyValueStore): boolean {
  try {
    return store.getItem(AUTO_SEND_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAutoSend(store: KeyValueStore, on: boolean): boolean {
  try {
    store.setItem(AUTO_SEND_KEY, on ? "1" : "0");
    return true;
  } catch {
    return false;
  }
}
