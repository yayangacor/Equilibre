// Reads a session-log CSV ("Unduh log sesi", or scripts/extract-rldd.ts) back into the
// pipeline's types. Shared by scripts/replay.ts and scripts/rldd-dataset.ts.
import { readFileSync } from "node:fs";
import type { BodySample } from "../src/body.ts";
import type { Baseline } from "../src/calibration.ts";
import type { FrameSignal } from "../src/signals.ts";

export type Row = FrameSignal & { waktu: string; body: BodySample | null };

export function parseCsv(path: string) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const comment = (pattern: RegExp) => lines.find((l) => l.startsWith("#") && pattern.test(l))?.match(pattern)?.[1];
  const opened = Date.parse(comment(/dibuka (\S+)/) ?? "");
  const windowMs = Number(comment(/window_ms=(\d+)/) ?? 60_000);
  const tidur = comment(/tidur_menit=(\d+(?:\.\d+)?)/);
  const parsed = JSON.parse(comment(/baseline=(.*)$/) ?? "null") as Baseline | null;
  // CSVs from before body detection have no bodyArea and no body columns.
  const baseline = parsed && { ...parsed, bodyArea: parsed.bodyArea ?? null };

  const header = lines.find((l) => l.startsWith("t_ms"))?.split(",") ?? [];
  const col = (name: string) => header.indexOf(name);
  const num = (x: string | undefined) => (x === undefined || x === "" ? NaN : Number(x));
  const frames: Row[] = lines
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("t_ms"))
    .map((l) => {
      const c = l.split(",");
      const get = (name: string) => num(c[col(name)]);
      const t = get("t_ms");
      const area = col("body_area") >= 0 ? get("body_area") : NaN;
      return {
        t,
        waktu: c[col("waktu")],
        face: c[col("face")] === "1",
        earLeft: get("ear_left"),
        earRight: get("ear_right"),
        ear: get("ear"),
        jawOpen: get("jaw_open"),
        pitchDeg: get("pitch_deg"),
        blinkLeft: get("blink_left"),
        blinkRight: get("blink_right"),
        lookDown: col("look_down") >= 0 ? get("look_down") : NaN,
        body: Number.isFinite(area) ? { t, area, motion: get("body_motion") } : null,
      };
    });
  return { opened, windowMs, tidurMenit: tidur === undefined ? undefined : Number(tidur), baseline, frames, comment };
}
