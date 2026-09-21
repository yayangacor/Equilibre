// Replays a session CSV ("Unduh log sesi") through the app's own pipeline (Monitor),
// so threshold changes in src/ can be checked against recorded sessions.
// Run with Node's built-in type stripping: npm run replay -- <file.csv> [--tidur=N] [--window=seconds]
import { readFileSync } from "node:fs";
import type { EyeClosure } from "../src/blink.ts";
import type { BodySample } from "../src/body.ts";
import type { Baseline } from "../src/calibration.ts";
import { Monitor } from "../src/monitor.ts";
import type { FrameSignal } from "../src/signals.ts";
import type { YawnEvent } from "../src/yawn.ts";

const EVAL_INTERVAL_MS = 10_000; // same as main.ts

type Row = FrameSignal & { waktu: string; body: BodySample | null };

function parseCsv(path: string) {
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
  return { opened, windowMs, tidurMenit: tidur === undefined ? undefined : Number(tidur), baseline, frames };
}

const [path, ...flags] = process.argv.slice(2);
if (!path) {
  console.error("Pemakaian: npm run replay -- <file.csv> [--tidur=N] [--window=detik]");
  process.exit(1);
}
const { opened, windowMs, tidurMenit, baseline, frames } = parseCsv(path);
if (!baseline) {
  console.error("CSV ini tidak punya baseline (belum dikalibrasi saat diunduh), jadi tidak ada label untuk diputar ulang.");
  process.exit(1);
}
const flag = (name: string) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const tidurFlag = flag("tidur");
const windowFlag = flag("window");

// The live loop starts right after calibration (baseline.createdAt, wall clock), or at
// page load when the baseline came from storage. "dibuka" = performance.timeOrigin.
const startT = Math.max(0, baseline.createdAt - opened);
const live = frames.filter((f) => f.t >= startT);
if (live.length === 0) {
  console.error("Tidak ada frame setelah kalibrasi.");
  process.exit(1);
}
const monitor = new Monitor(baseline, {
  windowMs: windowFlag ? Number(windowFlag) * 1000 : windowMs,
  evalIntervalMs: EVAL_INTERVAL_MS,
  tidurMenit: tidurFlag ? Number(tidurFlag) : tidurMenit,
});
const hasBody = live.some((f) => f.body !== null);
console.log(
  `${frames.length} frame, ${live.length} setelah kalibrasi (${live[0].waktu} → ${live[live.length - 1].waktu}), ` +
    `jendela ${monitor.options.windowMs / 1000} detik, deteksi tubuh ${hasBody ? "ada" : "tidak ada di CSV ini"}, ` +
    `tertidur setelah ${monitor.sleepMinutes.eyesClosed} menit mata terpejam / ${monitor.sleepMinutes.eyesHidden} menit mata tidak terlihat`,
);

const closures: EyeClosure[] = [];
const yawns: YawnEvent[] = [];
let lastEval = live[0].t;

const pct = (x: number | null) => (x === null ? "   -" : `${(x * 100).toFixed(0).padStart(3)}%`);
const fixed = (x: number | null, width: number) => (x === null ? "-" : x.toFixed(0)).padStart(width);
const motion = (x: number | null) => (x === null ? "    -" : x.toFixed(3));

console.log(
  "waktu    | fps  perclos kedip/m durasi lama menguap nunduk hilang terbuka terpejam tubuh diam gerak | mentah               -> tampil               | alasan",
);
for (const f of live) {
  if (f.body) monitor.pushBody(f.body);
  const step = monitor.pushFrame(f);
  if (step.closure) closures.push(step.closure);
  if (step.yawn) yawns.push(step.yawn);

  if (f.t - lastEval < EVAL_INTERVAL_MS) continue;
  lastEval = f.t;
  const { features: feat, latest, hold } = monitor.evaluate(f.t);
  const fps = feat.durasi_jendela_detik > 0 ? feat.n_frame / feat.durasi_jendela_detik : 0;
  const shown = monitor.labelState.shown;
  console.log(
    `${f.waktu.slice(0, 8)} | ${fps.toFixed(1).padStart(4)} ${pct(feat.perclos)} ${fixed(feat.kedip_per_menit, 7)} ` +
      `${fixed(feat.durasi_kedip_ms, 5)}ms ${String(feat.mata_tertutup_lama).padStart(4)} ${String(feat.menguap).padStart(7)}  ` +
      `${pct(feat.pct_kepala_menunduk)}  ${pct(feat.pct_wajah_hilang)}    ${pct(feat.pct_mata_terbuka)}     ${pct(feat.pct_mata_tertutup)}  ` +
      `${pct(feat.pct_tubuh_ada)} ${pct(feat.pct_tubuh_diam)} ${motion(feat.gerak_tubuh)} | ` +
      `${(latest?.label ?? (hold ? "(tahan)" : "-")).padEnd(20)} -> ${(shown?.label ?? "-").padEnd(20)} | ` +
      [...(latest?.alasan ?? []), ...(latest?.catatan ?? []).map((c) => `(${c})`), ...(hold ? [hold] : [])].join(" / "),
  );
}

const at = (t: number) => frames.find((f) => f.t >= t)?.waktu.slice(0, 10) ?? "?";
console.log(`\nKedip: ${closures.filter((c) => c.kind === "blink").length}`);
for (const c of closures.filter((c) => c.kind === "long")) {
  console.log(`Mata tertutup lama: ${at(c.startT)}, ${Math.round(c.durationMs)} ms`);
}
for (const y of yawns) console.log(`Menguap: ${at(y.startT)}, ${Math.round(y.durationMs)} ms`);
