import { blinkThreshold, CLOSED_BLINK, type Baseline } from "./calibration.ts";
import { HEAD_DOWN_DEG, type WindowFeatures } from "./features.ts";
import { LOCALE } from "./format.ts";
import type { IconName } from "./icons.ts";
import type { Label } from "./rules.ts";
import type { FrameSignal } from "./signals.ts";
import { stateName } from "./stateCopy.ts";
import { YAWN_JAW_OPEN, YAWN_MIN_MS } from "./yawn.ts";

// Numbers of the live view on the dashboard (NOTES D-63, D-65), pure so they can be tested: the eye
// state the mesh is colored by, and the tiles: a label with its icon, the number, and a short line. They are the
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
// icon: the Material Symbol beside the label; the sub line stays short, the tile's title explains it.
export type LiveTile = { key: string; label: string; value: string; sub: string; icon: IconName; hint: string; eye?: EyeState };

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
  const later = "After calibration";
  const last = `Last ${windowSeconds} s`;
  return [
    {
      key: "mata",
      label: "Eyes",
      value: EYE_NAME[eye],
      sub: `EAR ${ear}`,
      icon: "visibility",
      hint: baseline
        ? `Eye openness (EAR). Closed below ${fmt3.format(blinkThreshold(baseline))}, from your calibration.`
        : "Eye openness (EAR).",
      eye,
    },
    {
      key: "kedip",
      label: "Blinks/min",
      value: f?.kedip_per_menit === null || f?.kedip_per_menit === undefined ? "–" : fmt.format(f.kedip_per_menit),
      sub: baseline ? `Normal ${fmt.format(baseline.blinkPerMin)}` : later,
      icon: "eye_tracking",
      hint: "Blinking much more often than your normal can mean tired eyes.",
    },
    {
      key: "perclos",
      label: "Eyes closed",
      value: f ? pct(f.perclos) : "–",
      sub: f ? last : later,
      icon: "visibility_off",
      hint: `PERCLOS: share of time with the eyes closed, last ${windowSeconds} s.`,
    },
    {
      key: "menguap",
      label: "Yawns",
      value: f ? String(f.menguap) : "–",
      sub: f ? last : later,
      icon: "bedtime",
      hint: `A yawn: mouth wide open for ${fmt.format(YAWN_MIN_MS / 1000)} s or longer.`,
    },
    {
      key: "menunduk",
      label: "Head down",
      value: f ? pct(f.pct_kepala_menunduk) : "–",
      sub: f ? last : later,
      icon: "arrow_downward",
      hint: `Share of time with the head more than ${Math.abs(HEAD_DOWN_DEG)}° below its calibration position.`,
    },
    {
      key: "label",
      label: "State",
      value: label ? stateName(label) : "–",
      sub: label ? "Every 10 s" : later,
      icon: "monitor_heart",
      hint: "Judged every 10 s from the signs on the other tiles.",
    },
  ];
}
