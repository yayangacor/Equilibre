import { blinkThreshold, CLOSED_BLINK, type Baseline } from "./calibration.ts";
import { HEAD_DOWN_DEG, type WindowFeatures } from "./features.ts";
import type { Label } from "./rules.ts";
import type { FrameSignal } from "./signals.ts";
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

export type LiveTile = { key: string; label: string; value: string; sub: string };

const fmt = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const fmt3 = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "–" : `${Math.round(x * 100)}%`);
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function liveTiles(
  s: FrameSignal | null,
  f: WindowFeatures | null,
  baseline: Baseline | null,
  label: Label | null,
  windowSeconds: number,
): LiveTile[] {
  const eye = s ? eyeState(s, baseline) : "tidak terlihat";
  const ear = s?.face && Number.isFinite(s.ear) ? fmt3.format(s.ear) : "–";
  const later = "Muncul setelah kalibrasi.";
  return [
    {
      key: "mata",
      label: "Mata sekarang",
      value: cap(eye),
      sub: baseline ? `EAR ${ear}; tertutup di bawah ${fmt3.format(blinkThreshold(baseline))}.` : `EAR ${ear}.`,
    },
    {
      key: "kedip",
      label: "Kedip per menit",
      value: f?.kedip_per_menit === null || f?.kedip_per_menit === undefined ? "–" : fmt.format(f.kedip_per_menit),
      sub: baseline ? `Normalmu ${fmt.format(baseline.blinkPerMin)}; jauh lebih sering bisa tanda mata lelah.` : later,
    },
    {
      key: "perclos",
      label: "Mata terpejam (PERCLOS)",
      value: f ? pct(f.perclos) : "–",
      sub: f ? `Waktu mata terpejam, ${windowSeconds} detik terakhir.` : later,
    },
    {
      key: "menguap",
      label: "Menguap",
      value: f ? `${f.menguap}×` : "–",
      sub: f ? `Mulut terbuka lebar ≥ ${fmt.format(YAWN_MIN_MS / 1000)} detik, ${windowSeconds} detik terakhir.` : later,
    },
    {
      key: "menunduk",
      label: "Kepala menunduk",
      value: f ? pct(f.pct_kepala_menunduk) : "–",
      sub: f ? `Kepala > ${Math.abs(HEAD_DOWN_DEG)}° di bawah posisi kalibrasi.` : later,
    },
    {
      key: "label",
      label: "Label sekarang",
      value: label ? cap(label) : "–",
      sub: label ? "Dinilai tiap 10 detik dari tanda di atas." : "Muncul setelah kalibrasi dan penilaian pertama.",
    },
  ];
}
