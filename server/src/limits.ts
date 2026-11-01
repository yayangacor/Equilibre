// Limits for requests that reach this server through the tunnel from the online demo (NOTES D-80).
// The demo link is public and every advice or answer there is an LLM call on the developer's quota,
// so there is a daily cap for everyone together and a minimum gap per visitor. Requests from the
// local app (port 8787) never pass through here. Counters live in memory: a restart starts the day
// again, which only ever gives more requests, never blocks one wrongly.
// The tunnel's secret: long enough not to be guessed, compared in constant time for its length (only
// the length can leak, which says nothing useful). No node:crypto, so the web tests can import this file.
export const PROXY_SECRET_MIN = 32;
export function secretMatches(given: string | undefined, expected: string): boolean {
  if (expected.length < PROXY_SECRET_MIN || typeof given !== "string" || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export const PUBLIC_LIMITS = {
  perDay: { analyze: 40, tanya: 15 },
  clientGapMs: 60_000,
} as const;

export type PublicRoute = keyof typeof PUBLIC_LIMITS.perDay;
export type Verdict = { ok: true } | { ok: false; error: string; retryAfterS: number };

const WIB_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

// The calendar day in Jakarta (WIB, UTC+7, no daylight saving), as yyyy-mm-dd.
export const wibDay = (now: number) => new Date(now + WIB_OFFSET_MS).toISOString().slice(0, 10);
const secondsToWibMidnight = (now: number) => Math.ceil((DAY_MS - ((now + WIB_OFFSET_MS) % DAY_MS)) / 1000);

const NOUN: Record<PublicRoute, string> = { analyze: "advice requests", tanya: "questions" };

export class DailyLimits {
  private day = "";
  private used: Record<PublicRoute, number> = { analyze: 0, tanya: 0 };
  private last = new Map<string, number>();
  private readonly perDay: Record<PublicRoute, number>;
  private readonly gapMs: number;

  constructor(perDay: Record<PublicRoute, number> = PUBLIC_LIMITS.perDay, gapMs: number = PUBLIC_LIMITS.clientGapMs) {
    this.perDay = perDay;
    this.gapMs = gapMs;
  }

  private roll(now: number) {
    const day = wibDay(now);
    if (day === this.day) return;
    this.day = day;
    this.used = { analyze: 0, tanya: 0 };
    this.last.clear();
  }

  /** Counts the request when it may go ahead; a refused request counts for nothing. */
  take(route: PublicRoute, client: string, now = Date.now()): Verdict {
    this.roll(now);
    if (this.used[route] >= this.perDay[route]) {
      return {
        ok: false,
        error: `Today's limit of ${this.perDay[route]} ${NOUN[route]} for the online demo is used up. It resets at midnight Jakarta time (WIB).`,
        retryAfterS: secondsToWibMidnight(now),
      };
    }
    const key = `${route}:${client}`;
    const last = this.last.get(key);
    if (last !== undefined && now - last < this.gapMs) {
      const wait = Math.ceil((this.gapMs - (now - last)) / 1000);
      return {
        ok: false,
        error: `The online demo allows one request a minute per visitor. Try again in ${wait} s.`,
        retryAfterS: wait,
      };
    }
    this.used[route]++;
    this.last.set(key, now);
    return { ok: true };
  }

  remaining(now = Date.now()): Record<PublicRoute, number> {
    this.roll(now);
    return { analyze: this.perDay.analyze - this.used.analyze, tanya: this.perDay.tanya - this.used.tanya };
  }
}
