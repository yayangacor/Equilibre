// Replays a session CSV ("Unduh log sesi") through the app's own pipeline modules,
// so threshold changes in src/ can be checked against recorded sessions.
// Run with Node's built-in type stripping: npm run replay -- <file.csv>
import { readFileSync } from "node:fs";
import { initialBlinkState, stepBlink, type EyeClosure } from "../src/blink.ts";
import { blinkThreshold, type Baseline } from "../src/calibration.ts";
import { computeWindowFeatures } from "../src/features.ts";
import { evaluate, initialLabelState } from "../src/rules.ts";
import type { FrameSignal } from "../src/signals.ts";
import { initialYawnState, stepYawn, type YawnEvent } from "../src/yawn.ts";

const EVAL_INTERVAL_MS = 10_000; // same as main.ts

type Row = FrameSignal & { waktu: string };

function parseCsv(path: string) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const comment = (pattern: RegExp) => lines.find((l) => l.startsWith("#") && pattern.test(l))?.match(pattern)?.[1];
  const opened = Date.parse(comment(/dibuka (\S+)/) ?? "");
  const windowMs = Number(comment(/window_ms=(\d+)/) ?? 60_000);
  const baseline = JSON.parse(comment(/baseline=(.*)$/) ?? "null") as Baseline | null;
  const num = (x: string) => (x === "" ? NaN : Number(x));
  const frames: Row[] = lines
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("t_ms"))
    .map((l) => {
      const c = l.split(",");
      return {
        t: num(c[0]),
        waktu: c[1],
        face: c[2] === "1",
        earLeft: num(c[3]),
        earRight: num(c[4]),
        ear: num(c[5]),
        jawOpen: num(c[6]),
        pitchDeg: num(c[7]),
        blinkLeft: num(c[8]),
        blinkRight: num(c[9]),
      };
    });
  return { opened, windowMs, baseline, frames };
}

const path = process.argv[2];
if (!path) {
  console.error("Pemakaian: npm run replay -- <file.csv>");
  process.exit(1);
}
const { opened, windowMs, baseline, frames } = parseCsv(path);
if (!baseline) {
  console.error("CSV ini tidak punya baseline (belum dikalibrasi saat diunduh), jadi tidak ada label untuk diputar ulang.");
  process.exit(1);
}

// The live loop starts right after calibration (baseline.createdAt, wall clock), or at
// page load when the baseline came from storage. "dibuka" = performance.timeOrigin.
const startT = Math.max(0, baseline.createdAt - opened);
const live = frames.filter((f) => f.t >= startT);
if (live.length === 0) {
  console.error("Tidak ada frame setelah kalibrasi.");
  process.exit(1);
}
console.log(
  `${frames.length} frame, ${live.length} setelah kalibrasi (${live[0].waktu} → ${live[live.length - 1].waktu}), ` +
    `jendela ${windowMs / 1000} detik`,
);

let blinkState = initialBlinkState();
let yawnState = initialYawnState();
let labelState = initialLabelState();
const closures: EyeClosure[] = [];
const yawns: YawnEvent[] = [];
const seen: Row[] = [];
let lastEval = live[0].t;

const pct = (x: number | null) => (x === null ? "   -" : `${(x * 100).toFixed(0).padStart(3)}%`);
const fixed = (x: number | null, width: number) => (x === null ? "-" : x.toFixed(0)).padStart(width);

console.log("waktu    | fps  perclos kedip/m durasi menguap nunduk hilang | mentah               -> tampil               | alasan");
for (const f of live) {
  seen.push(f);
  const blink = stepBlink(blinkState, f.t, f.ear, blinkThreshold(baseline), f.face);
  blinkState = blink.state;
  if (blink.event) closures.push(blink.event);
  const yawn = stepYawn(yawnState, f.t, f.jawOpen, f.face);
  yawnState = yawn.state;
  if (yawn.event) yawns.push(yawn.event);

  if (f.t - lastEval < EVAL_INTERVAL_MS) continue;
  lastEval = f.t;
  const feat = computeWindowFeatures(seen, closures, yawns, baseline, f.t, windowMs);
  const result = evaluate(feat, baseline, labelState);
  labelState = result.state;
  const fps = feat.durasi_jendela_detik > 0 ? feat.n_frame / feat.durasi_jendela_detik : 0;
  console.log(
    `${f.waktu.slice(0, 8)} | ${fps.toFixed(1).padStart(4)} ${pct(feat.perclos)} ${fixed(feat.kedip_per_menit, 7)} ` +
      `${fixed(feat.durasi_kedip_ms, 5)}ms ${String(feat.menguap).padStart(5)}  ${pct(feat.pct_kepala_menunduk)}  ` +
      `${pct(feat.pct_wajah_hilang)} | ${(result.latest?.label ?? "-").padEnd(20)} -> ${(labelState.shown?.label ?? "-").padEnd(20)} | ` +
      (result.latest?.alasan.join(" / ") ?? ""),
  );
}

const at = (t: number) => frames.find((f) => f.t >= t)?.waktu.slice(0, 10) ?? "?";
console.log(`\nKedip: ${closures.filter((c) => c.kind === "blink").length}`);
for (const c of closures.filter((c) => c.kind === "long")) {
  console.log(`Mata tertutup lama: ${at(c.startT)}, ${Math.round(c.durationMs)} ms`);
}
for (const y of yawns) console.log(`Menguap: ${at(y.startT)}, ${Math.round(y.durationMs)} ms`);
