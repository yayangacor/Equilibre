// Replays a session CSV ("Unduh log sesi") through the app's own pipeline (Monitor),
// so threshold changes in src/ can be checked against recorded sessions.
// Run with Node's built-in type stripping:
//   npm run replay -- <file.csv> [--tidur=N] [--window=seconds] [--fps=N [--phase=K]] [--ringkasan]
// --ringkasan also prints what the dashboard would show for the session (history.ts).
import { readFileSync } from "node:fs";
import type { EyeClosure } from "../src/blink.ts";
import type { BodySample } from "../src/body.ts";
import { median, type Baseline } from "../src/calibration.ts";
import { summarizeDay, toEvaluationRecord, type EvaluationRecord } from "../src/history.ts";
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
  console.error("Pemakaian: npm run replay -- <file.csv> [--tidur=N] [--window=detik] [--fps=N [--phase=K]] [--ringkasan]");
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
const fpsFlag = flag("fps");
const phase = Number(flag("phase") ?? 0);

// The live loop starts right after calibration (baseline.createdAt, wall clock), or at
// page load when the baseline came from storage. "dibuka" = performance.timeOrigin.
const startT = Math.max(0, baseline.createdAt - opened);
const recorded = frames.filter((f) => f.t >= startT);
if (recorded.length === 0) {
  console.error("Tidak ada frame setelah kalibrasi.");
  process.exit(1);
}

// --fps=N simulates a slower detection loop (power saving) on a recording made at a
// higher rate: one frame per tick of a 1000/N ms clock, the recorded frame nearest
// each tick (within half a recorded frame). The clock is not locked to the recorded
// frames, as the live loop samples the camera's latest frame; a phase that follows
// the kept frames would re-lock after every stall. --phase=K shifts the clock by K
// recorded frames. The baseline stays the one calibrated at the recorded rate.
function downsample(rows: readonly Row[], fps: number, phase: number): Row[] {
  const stepMs = 1000 / fps;
  const toleranceMs = median(rows.slice(1).map((f, i) => f.t - rows[i].t)) / 2;
  let tick = rows[0].t + phase * 2 * toleranceMs;
  const kept: Row[] = [];
  for (const f of rows) {
    if (f.t < tick - toleranceMs) continue;
    kept.push(f);
    while (tick - toleranceMs <= f.t) tick += stepMs;
  }
  return kept;
}
const live = fpsFlag ? downsample(recorded, Number(fpsFlag), phase) : recorded;
// Body samples keep their own cadence (BODY_INTERVAL_MS), whichever frames are dropped.
const liveBodies = recorded.flatMap((f) => (f.body ? [f.body] : []));
const monitor = new Monitor(baseline, {
  windowMs: windowFlag ? Number(windowFlag) * 1000 : windowMs,
  evalIntervalMs: EVAL_INTERVAL_MS,
  tidurMenit: tidurFlag ? Number(tidurFlag) : tidurMenit,
});
const hasBody = liveBodies.length > 0;
console.log(
  `${frames.length} frame, ${recorded.length} setelah kalibrasi (${live[0].waktu} → ${live[live.length - 1].waktu}), ` +
    (fpsFlag ? `diturunkan ke ${live.length} frame (±${fpsFlag} fps, phase ${phase}), ` : "") +
    `jendela ${monitor.options.windowMs / 1000} detik, deteksi tubuh ${hasBody ? "ada" : "tidak ada di CSV ini"}, ` +
    `tertidur setelah ${monitor.sleepMinutes.eyesClosed} menit mata terpejam / ${monitor.sleepMinutes.eyesHidden} menit mata tidak terlihat`,
);

const closures: EyeClosure[] = [];
const yawns: YawnEvent[] = [];
const records: EvaluationRecord[] = []; // what the live app would store (--ringkasan)
let lastEval = live[0].t;
let nextBody = 0;

const pct = (x: number | null) => (x === null ? "   -" : `${(x * 100).toFixed(0).padStart(3)}%`);
const fixed = (x: number | null, width: number) => (x === null ? "-" : x.toFixed(0)).padStart(width);
const motion = (x: number | null) => (x === null ? "    -" : x.toFixed(3));

console.log(
  "waktu    | fps  perclos kedip/m durasi lama menguap nunduk hilang terbuka terpejam tubuh diam gerak | mentah               -> tampil               | alasan",
);
for (const f of live) {
  while (nextBody < liveBodies.length && liveBodies[nextBody].t <= f.t) monitor.pushBody(liveBodies[nextBody++]);
  const step = monitor.pushFrame(f);
  if (step.closure) closures.push(step.closure);
  if (step.yawn) yawns.push(step.yawn);

  if (f.t - lastEval < EVAL_INTERVAL_MS) continue;
  lastEval = f.t;
  const evaluation = monitor.evaluate(f.t);
  const { features: feat, latest, hold, menitLelah, saran } = evaluation;
  const fps = feat.durasi_jendela_detik > 0 ? feat.n_frame / feat.durasi_jendela_detik : 0;
  const shown = monitor.labelState.shown;
  if (shown) {
    // menit_sejak_jeda is not in the summary, so the break tracking of main.ts is left out.
    const context = { t: opened + f.t, sesi: opened, menitSejakJeda: 0, hematDaya: fpsFlag !== undefined };
    records.push(toEvaluationRecord(shown, evaluation, context));
  }
  console.log(
    `${f.waktu.slice(0, 8)} | ${fps.toFixed(1).padStart(4)} ${pct(feat.perclos)} ${fixed(feat.kedip_per_menit, 7)} ` +
      `${fixed(feat.durasi_kedip_ms, 5)}ms ${String(feat.mata_tertutup_lama).padStart(4)} ${String(feat.menguap).padStart(7)}  ` +
      `${pct(feat.pct_kepala_menunduk)}  ${pct(feat.pct_wajah_hilang)}    ${pct(feat.pct_mata_terbuka)}     ${pct(feat.pct_mata_tertutup)}  ` +
      `${pct(feat.pct_tubuh_ada)} ${pct(feat.pct_tubuh_diam)} ${motion(feat.gerak_tubuh)} | ` +
      `${(latest?.label ?? (hold ? "(tahan)" : "-")).padEnd(20)} -> ${(shown?.label ?? "-").padEnd(20)} | ` +
      [
        ...(latest?.alasan ?? []),
        ...(latest?.catatan ?? []).map((c) => `(${c})`),
        ...(hold ? [hold] : []),
        ...(saran ? [`[SARAN ISTIRAHAT PANJANG: ${menitLelah.toFixed(1)} menit lelah/tertidur]`] : []),
      ].join(" / "),
  );
}

const at = (t: number) => frames.find((f) => f.t >= t)?.waktu.slice(0, 10) ?? "?";
console.log(`\nKedip: ${closures.filter((c) => c.kind === "blink").length}`);
for (const c of closures.filter((c) => c.kind === "long")) {
  console.log(`Mata tertutup lama: ${at(c.startT)}, ${Math.round(c.durationMs)} ms`);
}
for (const y of yawns) console.log(`Menguap: ${at(y.startT)}, ${Math.round(y.durationMs)} ms`);

if (flags.includes("--ringkasan")) {
  for (const hari of [...new Set(records.map((r) => r.hari))]) {
    const evaluasi = records.filter((r) => r.hari === hari);
    const s = summarizeDay({ evaluasi, jeda: [], rekomendasi: [], koreksi_label: [], kss: [] }, EVAL_INTERVAL_MS);
    const m = (x: number) => x.toFixed(2);
    console.log(`\nRingkasan ${hari} (${evaluasi.length} evaluasi dengan label tampil, menit):`);
    console.log(`  dinilai: ${Object.entries(s.menit).map(([label, x]) => `${label} ${m(x)}`).join(" · ")}`);
    console.log(`  ditahan: fps ${m(s.ditahan.fps)} · mata ${m(s.ditahan.mata)} · lain ${m(s.ditahan.lain)}`);
    for (const h of s.perJam) {
      const parts = Object.entries(h.menit).filter(([, x]) => x > 0).map(([label, x]) => `${label} ${m(x)}`);
      console.log(`  jam ${String(h.jam).padStart(2, "0")}: ${parts.join(" · ") || "-"}${h.ditahan > 0 ? ` · ditahan ${m(h.ditahan)}` : ""}`);
    }
  }
}
