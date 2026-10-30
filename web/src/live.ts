import { blinkThreshold, CLOSED_BLINK, type Baseline } from "./calibration.ts";
import { HEAD_DOWN_DEG, type WindowFeatures } from "./features.ts";
import { LOCALE } from "./format.ts";
import type { Label } from "./rules.ts";
import type { FrameSignal } from "./signals.ts";
import { stateName } from "./stateCopy.ts";
import { YAWN_JAW_OPEN, YAWN_MIN_MS } from "./yawn.ts";

// Numbers of the live view on the dashboard (NOTES D-63, D-65), pure so they can be tested: the eye
// state the mesh is colored by, and the tiles with one line on how to read each. They are the
// numbers the rules read (features.ts); nothing here changes a label.

export type EyeState = "terbuka" | "tertutup" | "tidak terlihat";

// The eye as the mesh colors it: closed below the personal blink midpoint (the line every blink
// crosses, calibration.ts), or by the eyeBlink blendshapes before the first calibration.
export function eyeState(s: FrameSignal, baseline: Baseline | null): EyeState {
  if (!s.face || !Number.isFinite(s.ear)) return "tidak terlihat";
  const closed = baseline ? s.ear < blinkThreshold(baseline) : (s.blinkLeft + s.blinkRight) / 2 >= CLOSED_BLINK;
  return closed ? "tertutup" : "terbuka";
}

export const yawning = (s: FrameSignal) => s.face && s.jawOpen >= YAWN_JAW_OPEN;

// eye: the eye state behind the "mata" tile, for the CSS data attribute (the value is the English text).
export type LiveTile = { key: string; label: string; value: string; sub: string; eye?: EyeState };

const EYE_NAME: Record<EyeState, string> = { terbuka: "Open", tertutup: "Closed", "tidak terlihat": "Not seen" };

const fmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const fmt3 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${Math.round(x * 100)}%`);

export function liveTiles(
  s: FrameSignal | null,
  f: WindowFeatures | null,
  baseline: Baseline | null,
  label: Label | null,
  windowSeconds: number,
): LiveTile[] {
  const eye = s ? eyeState(s, baseline) : "tidak terlihat";
  const ear = s?.face && Number.isFinite(s.ear) ? fmt3.format(s.ear) : "–";
  const later = "Appears after calibration.";
  return [
    {
      key: "mata",
      label: "Eyes now",
      value: EYE_NAME[eye],
      sub: baseline ? `EAR ${ear}; closed below ${fmt3.format(blinkThreshold(baseline))}.` : `EAR ${ear}.`,
      eye,
    },
    {
      key: "kedip",
      label: "Blinks per minute",
      value: f?.kedip_per_menit === null || f?.kedip_per_menit === undefined ? "–" : fmt.format(f.kedip_per_menit),
      sub: baseline ? `Your normal: ${fmt.format(baseline.blinkPerMin)}; much more often can mean tired eyes.` : later,
    },
    {
      key: "perclos",
      label: "Eyes closed (PERCLOS)",
      value: f ? pct(f.perclos) : "–",
      sub: f ? `Share of time with eyes closed, last ${windowSeconds} s.` : later,
    },
    {
      key: "menguap",
      label: "Yawns",
      value: f ? `${f.menguap}×` : "–",
      sub: f ? `Mouth wide open ≥ ${fmt.format(YAWN_MIN_MS / 1000)} s, last ${windowSeconds} s.` : later,
    },
    {
      key: "menunduk",
      label: "Head down",
      value: f ? pct(f.pct_kepala_menunduk) : "–",
      sub: f ? `Head > ${Math.abs(HEAD_DOWN_DEG)}° below the calibration position.` : later,
    },
    {
      key: "label",
      label: "State now",
      value: label ? stateName(label) : "–",
      sub: label ? "Judged every 10 s from the signs above." : "Appears after calibration and the first reading.",
    },
  ];
}
