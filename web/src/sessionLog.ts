import type { BodySample } from "./body.ts";
import type { FrameSignal } from "./signals.ts";

// body_* are filled only on the frames where the segmenter ran (±2×/second).
const COLUMNS = [
  "t_ms",
  "waktu",
  "face",
  "ear_left",
  "ear_right",
  "ear",
  "jaw_open",
  "pitch_deg",
  "blink_left",
  "blink_right",
  "look_down",
  "body_area",
  "body_motion",
];

const num = (x: number) => (Number.isFinite(x) ? String(Number(x.toFixed(4))) : "");
const two = (n: number) => String(n).padStart(2, "0");
const clock = (epochMs: number) => {
  const d = new Date(epochMs);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

// Per-frame numbers only (no image data), for threshold tuning.
// `comments` become leading "# ..." lines (pandas: read_csv(..., comment="#")).
// timeOrigin converts t (performance.now) to wall-clock time for the "waktu" column.
// A body sample is written on the frame with the same t (both come from one tick).
export function framesToCsv(
  frames: readonly FrameSignal[],
  bodies: readonly BodySample[],
  timeOrigin: number,
  comments: readonly string[] = [],
): string {
  const bodyAt = new Map(bodies.map((b) => [b.t, b]));
  const lines = comments.map((c) => `# ${c.replace(/[\r\n]+/g, " ")}`);
  lines.push(COLUMNS.join(","));
  for (const f of frames) {
    const body = bodyAt.get(f.t);
    lines.push(
      [
        num(f.t),
        clock(timeOrigin + f.t),
        f.face ? "1" : "0",
        num(f.earLeft),
        num(f.earRight),
        num(f.ear),
        num(f.jawOpen),
        num(f.pitchDeg),
        num(f.blinkLeft),
        num(f.blinkRight),
        num(f.lookDown),
        body ? num(body.area) : "",
        body ? num(body.motion) : "",
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
