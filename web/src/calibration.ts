import { detectEyeClosures } from "./blink.ts";
import type { FrameSignal } from "./signals.ts";

// Personal reference values. Numbers only: nothing here can reconstruct a face.
export type Baseline = {
  earOpen: number; // median EAR while working normally
  earClosed: number; // median EAR with eyes deliberately closed
  blinkPerMin: number;
  blinkDurationMs: number | null; // null when no blink was seen during calibration
  pitchDeg: number; // median head elevation while working normally
  jawOpenP95: number;
  createdAt: number; // epoch ms
};

type EyeRange = Pick<Baseline, "earOpen" | "earClosed">;

// ⚠️ Initial thresholds, tuned on 23 Sep from recorded sessions.
export const MAX_MISSING_FACE = 0.3;
export const MIN_EAR_RANGE = 0.05; // open and closed eyes must differ at least this much
export const MIN_NORMAL_STAGE_MS = 10_000;
// Blink stats need ~10 fps. A hidden tab gets its timers throttled to ~1 fps,
// which would silently record "no blinks" as the personal baseline.
export const MAX_MEDIAN_FRAME_INTERVAL_MS = 250;

// Midpoint of the personal range: below it the eye counts as closed for blink detection.
export const blinkThreshold = (b: EyeRange) => b.earClosed + 0.5 * (b.earOpen - b.earClosed);
// PERCLOS P80: eye at least 80% closed.
export const perclosThreshold = (b: EyeRange) => b.earClosed + 0.2 * (b.earOpen - b.earClosed);

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Linear interpolation between closest ranks; p in 0–1.
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export type CalibrationResult = { ok: true; baseline: Baseline } | { ok: false; error: string };

// closedFrames: stage A (eyes closed on purpose). normalFrames: stage B (working as usual).
// Frames without a face are ignored, but too many of them make the stage invalid.
export function computeBaseline(
  closedFrames: readonly FrameSignal[],
  normalFrames: readonly FrameSignal[],
  createdAt: number,
): CalibrationResult {
  const withFace = (frames: readonly FrameSignal[]) => frames.filter((f) => f.face && Number.isFinite(f.ear));
  const closed = withFace(closedFrames);
  const normal = withFace(normalFrames);

  for (const [all, faces, stage] of [
    [closedFrames, closed, "mata terpejam"],
    [normalFrames, normal, "kerja normal"],
  ] as const) {
    if (all.length === 0) {
      return { ok: false, error: `Tidak ada frame yang terekam saat tahap ${stage}. Pastikan kamera menyala, lalu ulangi.` };
    }
    const missing = 1 - faces.length / all.length;
    if (missing > MAX_MISSING_FACE) {
      return {
        ok: false,
        error: `Wajah tidak terdeteksi di ${pct(missing)} frame saat tahap ${stage} (maksimal ${pct(MAX_MISSING_FACE)}). Pastikan wajah terlihat jelas di kamera, lalu ulangi.`,
      };
    }
  }

  const spanMs = normalFrames[normalFrames.length - 1].t - normalFrames[0].t;
  if (spanMs < MIN_NORMAL_STAGE_MS) {
    return { ok: false, error: "Tahap kerja normal terlalu singkat. Ulangi kalibrasi." };
  }

  const intervals = normalFrames.slice(1).map((f, i) => f.t - normalFrames[i].t);
  if (median(intervals) > MAX_MEDIAN_FRAME_INTERVAL_MS) {
    return {
      ok: false,
      error: "Kamera terlalu jarang dibaca (tab ini tersembunyi?). Ulangi kalibrasi dengan tab Equilibre tetap terlihat.",
    };
  }

  const range = { earClosed: median(closed.map((f) => f.ear)), earOpen: median(normal.map((f) => f.ear)) };
  if (range.earOpen - range.earClosed < MIN_EAR_RANGE) {
    return {
      ok: false,
      error: "Mata tampak tidak terpejam saat tahap mata terpejam. Ulangi, dan tetap pejamkan mata sampai terdengar bunyi beep.",
    };
  }

  const pitches = normal.map((f) => f.pitchDeg).filter(Number.isFinite);
  if (pitches.length === 0) {
    return { ok: false, error: "Posisi kepala tidak terbaca. Ulangi kalibrasi." };
  }

  const blinks = detectEyeClosures(normalFrames, blinkThreshold(range)).filter((e) => e.kind === "blink");
  const faceMinutes = (spanMs / 60_000) * (normal.length / normalFrames.length);

  return {
    ok: true,
    baseline: {
      ...range,
      blinkPerMin: blinks.length / faceMinutes,
      blinkDurationMs: blinks.length > 0 ? blinks.reduce((sum, b) => sum + b.durationMs, 0) / blinks.length : null,
      pitchDeg: median(pitches),
      jawOpenP95: percentile(normal.map((f) => f.jawOpen).filter(Number.isFinite), 0.95),
      createdAt,
    },
  };
}

// ── Persistence (localStorage today, IndexedDB from 28 Sep) ─────────────────────

export const BASELINE_KEY = "equilibre.baseline.v1";

export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const NUMBER_FIELDS = ["earOpen", "earClosed", "blinkPerMin", "pitchDeg", "jawOpenP95", "createdAt"] as const;

// Storage can throw (private mode, quota, blocked site data), so every call is guarded.
export function saveBaseline(store: KeyValueStore, baseline: Baseline): boolean {
  try {
    store.setItem(BASELINE_KEY, JSON.stringify(baseline));
    return true;
  } catch {
    return false;
  }
}

export function loadBaseline(store: KeyValueStore): Baseline | null {
  try {
    const raw = store.getItem(BASELINE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const v = value as Record<string, unknown>;
    const isNumber = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
    if (!NUMBER_FIELDS.every((key) => isNumber(v[key]))) return null;
    if (v.blinkDurationMs !== null && !isNumber(v.blinkDurationMs)) return null;
    // Rebuild instead of trusting the parsed object, so unknown keys are dropped.
    return {
      earOpen: v.earOpen as number,
      earClosed: v.earClosed as number,
      blinkPerMin: v.blinkPerMin as number,
      blinkDurationMs: v.blinkDurationMs as number | null,
      pitchDeg: v.pitchDeg as number,
      jawOpenP95: v.jawOpenP95 as number,
      createdAt: v.createdAt as number,
    };
  } catch {
    return null;
  }
}
