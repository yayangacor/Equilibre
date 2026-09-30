// Replays a session CSV ("Unduh log sesi") through the app's own pipeline (Monitor),
// so threshold changes in src/ can be checked against recorded sessions.
// Run with Node's built-in type stripping:
//   npm run replay -- <file.csv> [--tidur=N] [--window=seconds] [--fps=N [--phase=K]] [--ringkasan] [--kirim-otomatis] [--kedip-dari=N]
// --ringkasan also prints what the dashboard would show for the session (history.ts);
// --kirim-otomatis, when the automatic sending would have called Langflow (autoSend.ts, no network).
import { autoTarget, initialAutoSendState, stepAutoSend } from "../src/autoSend.ts";
import type { EyeClosure } from "../src/blink.ts";
import { calibrateBlinks } from "../src/blinkScore.ts";
import { median } from "../src/calibration.ts";
import { atScreen, breakEnded, initialBreakState, minutesSinceBreak, stepBreak } from "../src/features.ts";
import { summarizeDay, toBreakRecord, toEvaluationRecord, type BreakRecord, type EvaluationRecord } from "../src/history.ts";
import { Monitor } from "../src/monitor.ts";
import type { YawnEvent } from "../src/yawn.ts";
import { parseCsv, type Row } from "./session-csv.ts";

const EVAL_INTERVAL_MS = 10_000; // same as main.ts

const [path, ...flags] = process.argv.slice(2);
if (!path) {
  console.error(
    "Pemakaian: npm run replay -- <file.csv> [--tidur=N] [--window=detik] [--fps=N [--phase=K]] [--ringkasan] [--kirim-otomatis]",
  );
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
// Blink-pattern score (blinkScore.ts): from the baseline's blink norm, or, for a CSV calibrated before the
// score existed, --kedip-dari=N takes the norm from the first N minutes after calibration (an approximation:
// the app takes it from calibration stage B). Without either, the output is unchanged.
const kedipFlag = flag("kedip-dari");
const kedip =
  baseline.kedip ?? (kedipFlag ? calibrateBlinks(live.filter((f) => f.t < live[0].t + Number(kedipFlag) * 60_000), baseline) : null);
if (kedipFlag && !baseline.kedip) {
  console.log(kedip ? `Norma kedip dari ${kedipFlag} menit pertama: ${kedip.n} kedip, ${Math.round(kedip.durasi.mean)} ms, ${kedip.perMenit.toFixed(1)}/menit` : "Kurang dari 5 kedip untuk norma kedip.");
}
const monitor = new Monitor(kedip ? { ...baseline, kedip } : baseline, {
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
let autoState = initialAutoSendState(); // --kirim-otomatis, as if the toggle were on
const autoSends: string[] = [];
let lastEval = live[0].t;
let nextBody = 0;
// Break tracking as in main.ts onFrame (NOTES D-42), starting after calibration instead of at page load.
const recent: Row[] = [];
let breakState = initialBreakState(live[0].t);
const breaks: BreakRecord[] = [];

const pct = (x: number | null) => (x === null ? "   -" : `${(x * 100).toFixed(0).padStart(3)}%`);
const fixed = (x: number | null, width: number) => (x === null ? "-" : x.toFixed(0)).padStart(width);
const motion = (x: number | null) => (x === null ? "    -" : x.toFixed(3));

console.log(
  `waktu    | fps  perclos kedip/m durasi lama menguap nunduk hilang terbuka terpejam tubuh diam gerak${kedip ? " pola" : ""} | mentah               -> tampil               | alasan`,
);
for (const f of live) {
  while (nextBody < liveBodies.length && liveBodies[nextBody].t <= f.t) monitor.pushBody(liveBodies[nextBody++]);
  recent.push(f);
  if (recent.length > 60) recent.shift();
  const prevBreak = breakState;
  breakState = stepBreak(prevBreak, f.t, atScreen(recent, liveBodies[nextBody - 1] ?? null, baseline.bodyArea));
  const ended = breakEnded(prevBreak, breakState);
  if (ended) breaks.push(toBreakRecord({ mulai: opened + ended.mulai, selesai: opened + ended.selesai }, opened));
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
    const menitSejakJeda = minutesSinceBreak(breakState, f.t);
    const context = { t: opened + f.t, sesi: opened, menitSejakJeda, hematDaya: fpsFlag !== undefined };
    records.push(toEvaluationRecord(shown, evaluation, context));
  }
  const target = autoTarget(shown?.label ?? null, saran !== null);
  const auto = stepAutoSend(autoState, target, opened + f.t, true);
  autoState = auto.state;
  if (auto.send) autoSends.push(`${f.waktu.slice(0, 8)} ${target}`);
  console.log(
    `${f.waktu.slice(0, 8)} | ${fps.toFixed(1).padStart(4)} ${pct(feat.perclos)} ${fixed(feat.kedip_per_menit, 7)} ` +
      `${fixed(feat.durasi_kedip_ms, 5)}ms ${String(feat.mata_tertutup_lama).padStart(4)} ${String(feat.menguap).padStart(7)}  ` +
      `${pct(feat.pct_kepala_menunduk)}  ${pct(feat.pct_wajah_hilang)}    ${pct(feat.pct_mata_terbuka)}     ${pct(feat.pct_mata_tertutup)}  ` +
      `${pct(feat.pct_tubuh_ada)} ${pct(feat.pct_tubuh_diam)} ${motion(feat.gerak_tubuh)}` +
      `${kedip ? ` ${pct(monitor.blinkScore(f.t)?.chance ?? null)}` : ""} | ` +
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
console.log(`Jeda (wajah stabil dan tubuh tidak terlihat ≥ 2 menit): ${breaks.length}`);
for (const b of breaks) console.log(`  ${at(b.mulai - opened)} → ${at(b.selesai - opened)}, ${b.menit} menit`);
console.log(`Menit sejak jeda di akhir rekaman: ${minutesSinceBreak(breakState, live[live.length - 1].t).toFixed(1)}`);

if (flags.includes("--kirim-otomatis")) {
  console.log(`\nKirim otomatis (toggle menyala): ${autoSends.length} panggilan Langflow`);
  for (const line of autoSends) console.log(`  ${line}`);
}

if (flags.includes("--ringkasan")) {
  for (const hari of [...new Set(records.map((r) => r.hari))]) {
    const evaluasi = records.filter((r) => r.hari === hari);
    const jeda = breaks.filter((b) => b.hari === hari);
    const s = summarizeDay({ evaluasi, jeda, rekomendasi: [], koreksi_label: [], kss: [] }, EVAL_INTERVAL_MS);
    const m = (x: number) => x.toFixed(2);
    console.log(`\nRingkasan ${hari} (${evaluasi.length} evaluasi dengan label tampil, menit):`);
    console.log(`  dinilai: ${Object.entries(s.menit).map(([label, x]) => `${label} ${m(x)}`).join(" · ")}`);
    console.log(`  ditahan: fps ${m(s.ditahan.fps)} · mata ${m(s.ditahan.mata)} · lain ${m(s.ditahan.lain)}`);
    console.log(`  jeda: ${s.jeda.jumlah}× · ${m(s.jeda.menit)}`);
    for (const h of s.perJam) {
      const parts = Object.entries(h.menit).filter(([, x]) => x > 0).map(([label, x]) => `${label} ${m(x)}`);
      console.log(`  jam ${String(h.jam).padStart(2, "0")}: ${parts.join(" · ") || "-"}${h.ditahan > 0 ? ` · ditahan ${m(h.ditahan)}` : ""}`);
    }
  }
}
