import type { FrameSignal } from "./signals.ts";

const COLUMNS = ["t_ms", "waktu", "face", "ear_left", "ear_right", "ear", "jaw_open", "pitch_deg", "blink_left", "blink_right"];

const num = (x: number) => (Number.isFinite(x) ? String(Number(x.toFixed(4))) : "");
const two = (n: number) => String(n).padStart(2, "0");
const clock = (epochMs: number) => {
  const d = new Date(epochMs);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

// Per-frame numbers only (no image data), for threshold tuning on 23 Sep.
// `comments` become leading "# ..." lines (pandas: read_csv(..., comment="#")).
// timeOrigin converts t (performance.now) to wall-clock time for the "waktu" column.
export function framesToCsv(frames: readonly FrameSignal[], timeOrigin: number, comments: readonly string[] = []): string {
  const lines = comments.map((c) => `# ${c.replace(/[\r\n]+/g, " ")}`);
  lines.push(COLUMNS.join(","));
  for (const f of frames) {
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
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
