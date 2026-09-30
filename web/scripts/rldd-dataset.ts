// Session-log CSVs from scripts/extract-rldd.ts → one row per evaluation (60 s window, every
// 10 s) with the app's window features and the rules' label, for plan P04 langkah 3–4.
//   node scripts/rldd-dataset.ts <out.csv> <features dir>... [--dalam=0.2]
// Each <features dir> holds <participant>_<0|5|10>.csv. Prints a per-video summary: the
// negative control of langkah 2 (drowsy video 10 above alert video 0) is read from it.
//
// Baseline per participant = the app's calibration on video 0 (alert): its first 5 minutes
// stand for stage B ("kerja normal", CALIB_NORMAL_MS). The videos have no stage A (eyes closed
// on purpose), so the deepest --dalam share of blink frames in those 5 minutes stands in for
// it. On the user's own sessions this put earClosed 3–10% of the eye range too high with 0.2
// (median of the deepest fifth ≈ p10), against 13–16% for the deepest frame of each blink
// (plan P04, "Hasil eksekusi").
import { readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { BodySample } from "../src/body.ts";
import { detectEyeClosures } from "../src/blink.ts";
import {
  blinkThreshold,
  closureConfirmThreshold,
  computeBaseline,
  looksClosed,
  median,
  percentile,
  type Baseline,
} from "../src/calibration.ts";
import { eyesReadable, type WindowFeatures } from "../src/features.ts";
import { Monitor } from "../src/monitor.ts";
import type { Label } from "../src/rules.ts";
import { parseCsv, type Row } from "./session-csv.ts";

const CALIB_MS = 300_000; // CALIB_NORMAL_MS in main.ts
const WINDOW_MS = 60_000; // the app's default window
const EVAL_INTERVAL_MS = 10_000; // same as main.ts
const CLASSES = ["0", "5", "10"] as const;

const args = process.argv.slice(2);
const flagValue = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [outPath, ...dirs] = args.filter((a) => !a.startsWith("--"));
if (!outPath || dirs.length === 0) {
  console.error("Pemakaian: node scripts/rldd-dataset.ts <keluaran.csv> <folder fitur>... [--dalam=0.2]");
  process.exit(1);
}
const deepShare = Number(flagValue("dalam") ?? 0.2);

const FEATURES = [
  "perclos",
  "kedip_per_menit",
  "durasi_kedip_ms",
  "mata_tertutup_lama",
  "menguap",
  "pct_kepala_menunduk",
  "pct_wajah_hilang",
  "pct_mata_terbuka",
  "pct_mata_tertutup",
  "pct_tubuh_ada",
  "pct_tubuh_diam",
  "gerak_tubuh",
] as const satisfies readonly (keyof WindowFeatures)[];

function calibrate(video0: Row[]): { baseline: Baseline; closedFrames: number } | { error: string } {
  const normal = video0.filter((f) => f.t < video0[0].t + CALIB_MS);
  const bodies = normal.flatMap((f) => (f.body ? [f.body] : []));
  const earOpen = median(normal.filter((f) => f.face && Number.isFinite(f.ear)).map((f) => f.ear));
  const blinkFrames = normal.filter((f) => looksClosed(f, earOpen)).sort((a, b) => a.ear - b.ear);
  const closedFrames = blinkFrames.slice(0, Math.max(3, Math.ceil(deepShare * blinkFrames.length)));
  const result = computeBaseline(closedFrames, normal, 0, bodies);
  return result.ok ? { baseline: result.baseline, closedFrames: closedFrames.length } : { error: result.error };
}

// Continuous per-frame signals, z-scored against the participant's own calibration minutes (mean and
// SD of video 0's first 5 minutes). Reference: the EAR/MAR/MOE features normalised on the alert video
// in Khan & Islam's UTA-RLDD slides (plan P04). Unlike PERCLOS and the eye-closure counts, these need
// no deliberate eye closure, so G-57 does not apply. jawOpen stands in for MAR.
const SIGNALS = {
  ear: (f: Row) => f.ear,
  kedip: (f: Row) => (f.blinkLeft + f.blinkRight) / 2,
  mulut: (f: Row) => f.jawOpen,
  moe: (f: Row) => f.jawOpen / f.ear,
  pitch: (f: Row) => f.pitchDeg,
  bawah: (f: Row) => f.lookDown,
};
type SignalName = keyof typeof SIGNALS;
type Stats = Record<SignalName, { mean: number; sd: number }>;
const CONTINUOUS = [
  "z_ear_rata", "z_ear_p10", "z_ear_sd", "z_kedip_rata", "z_kedip_p90", "z_mulut_rata", "z_mulut_p90", "z_moe_median",
  "z_pitch_rata", "z_bawah_rata", "wajah",
] as const;

const valuesOf = (frames: readonly Row[], name: SignalName) =>
  frames.filter((f) => f.face).map(SIGNALS[name]).filter(Number.isFinite);

function signalStats(frames: readonly Row[]): Stats {
  const entries = (Object.keys(SIGNALS) as SignalName[]).map((name) => {
    const v = valuesOf(frames, name);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
    return [name, { mean: m, sd }] as const;
  });
  return Object.fromEntries(entries) as Stats;
}

function continuousFeatures(window: readonly Row[], stats: Stats): Record<(typeof CONTINUOUS)[number], number | null> {
  const z = (name: SignalName) => valuesOf(window, name).map((v) => (v - stats[name].mean) / stats[name].sd);
  const avg = (v: number[]) => (v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const pct = (v: number[], p: number) => (v.length > 0 ? percentile(v, p) : null);
  const ear = z("ear");
  const earMean = avg(ear);
  return {
    z_ear_rata: earMean,
    z_ear_p10: pct(ear, 0.1),
    z_ear_sd: earMean === null ? null : Math.sqrt(ear.reduce((a, b) => a + (b - earMean) ** 2, 0) / ear.length),
    z_kedip_rata: avg(z("kedip")),
    z_kedip_p90: pct(z("kedip"), 0.9),
    z_mulut_rata: avg(z("mulut")),
    z_mulut_p90: pct(z("mulut"), 0.9),
    z_moe_median: pct(z("moe"), 0.5),
    z_pitch_rata: avg(z("pitch")),
    z_bawah_rata: avg(z("bawah")),
    wajah: window.length > 0 ? window.filter((f) => f.face).length / window.length : null,
  };
}

// Per-blink features of the UTA-RLDD paper (Ghoddoosian et al., CVPRW 2019, eq. 2–5): duration,
// amplitude (EAR[start] − 2·EAR[bottom] + EAR[end]) / 2, eye-opening velocity (EAR[end] − EAR[bottom]) /
// time, and frequency. The blinks come from the app's own detector with the Monitor's thresholds
// (blink.ts), not the paper's SVM + Blink Retrieval Algorithm; start = last open frame, end = first
// reopened frame. As in the paper, each feature is z-scored against the participant's calibration
// blinks and summarised over the last BLINK_SEQUENCE blinks (paper: T = 30).
const BLINK_SEQUENCE = 30;
type Blink = { endT: number; startT: number; durasi: number; amplitudo: number; kecepatan: number };
const BLINK_FEATURES = ["durasi", "amplitudo", "kecepatan"] as const;
const BLINKS = ["zk_durasi_rata", "zk_amplitudo_rata", "zk_kecepatan_rata", "zk_frekuensi_relatif"] as const;
type BlinkStats = Record<(typeof BLINK_FEATURES)[number], { mean: number; sd: number }> & { perMenit: number };

function blinksOf(frames: readonly Row[], baseline: Baseline): Blink[] {
  const events = detectEyeClosures(
    frames,
    blinkThreshold(baseline),
    (f) => eyesReadable(f, baseline),
    closureConfirmThreshold(baseline),
  ).filter((e) => e.kind === "blink");
  const index = new Map(frames.map((f, i) => [f.t, i]));
  return events.flatMap((e) => {
    const s = index.get(e.startT);
    const end = index.get(e.endT);
    if (s === undefined || end === undefined || s === 0) return [];
    let bottom = s;
    for (let i = s; i < end; i++) if (frames[i].ear < frames[bottom].ear) bottom = i;
    const [a, b, c] = [frames[s - 1].ear, frames[bottom].ear, frames[end].ear];
    if (![a, b, c].every(Number.isFinite)) return [];
    return [{
      startT: e.startT,
      endT: e.endT,
      durasi: e.durationMs,
      amplitudo: (a - 2 * b + c) / 2,
      kecepatan: (c - b) / ((frames[end].t - frames[bottom].t) / 1000),
    }];
  });
}

function blinkStats(calibrationBlinks: readonly Blink[], calibrationMinutes: number): BlinkStats {
  const stat = (name: (typeof BLINK_FEATURES)[number]) => {
    const v = calibrationBlinks.map((b) => b[name]);
    const m = v.reduce((x, y) => x + y, 0) / v.length;
    return { mean: m, sd: Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / v.length) || 1 };
  };
  return { durasi: stat("durasi"), amplitudo: stat("amplitudo"), kecepatan: stat("kecepatan"), perMenit: calibrationBlinks.length / calibrationMinutes };
}

// The last BLINK_SEQUENCE blinks that ended by `now`; frequency = their rate over the sequence's span.
function blinkSequenceFeatures(blinks: readonly Blink[], now: number, stats: BlinkStats) {
  const done = blinks.filter((b) => b.endT <= now);
  const seq = done.slice(-BLINK_SEQUENCE);
  const zMean = (name: (typeof BLINK_FEATURES)[number]) =>
    seq.length > 0 ? seq.reduce((a, b) => a + (b[name] - stats[name].mean) / stats[name].sd, 0) / seq.length : null;
  const spanMin = seq.length > 1 ? (now - seq[0].startT) / 60_000 : null;
  return {
    values: {
      zk_durasi_rata: zMean("durasi"),
      zk_amplitudo_rata: zMean("amplitudo"),
      zk_kecepatan_rata: zMean("kecepatan"),
      zk_frekuensi_relatif: spanMin && stats.perMenit > 0 ? seq.length / spanMin / stats.perMenit : null,
    } satisfies Record<(typeof BLINKS)[number], number | null>,
    from: seq.length > 0 ? seq[0].startT : now, // earliest data the sequence rests on
  };
}

type Evaluated = {
  t: number;
  features: WindowFeatures;
  continuous: ReturnType<typeof continuousFeatures>;
  blinks: ReturnType<typeof blinkSequenceFeatures>;
  raw: Label | null;
  shown: Label | null;
  hold: boolean;
};

// `calibratedUntil`: blinks that started before it were used for calibration and never enter a sequence
// (paper: the first third of the alert blinks normalise, the rest are train/test data).
function evaluateVideo(baseline: Baseline, stats: Stats, blinkNorm: BlinkStats, frames: Row[], calibratedUntil: number): Evaluated[] {
  const monitor = new Monitor(baseline, { windowMs: WINDOW_MS, evalIntervalMs: EVAL_INTERVAL_MS });
  const blinks = blinksOf(frames, baseline).filter((b) => b.startT >= calibratedUntil);
  const bodies: BodySample[] = frames.flatMap((f) => (f.body ? [f.body] : []));
  const out: Evaluated[] = [];
  let nextBody = 0;
  let lastEval = frames[0].t;
  for (const f of frames) {
    while (nextBody < bodies.length && bodies[nextBody].t <= f.t) monitor.pushBody(bodies[nextBody++]);
    monitor.pushFrame(f);
    if (f.t - lastEval < EVAL_INTERVAL_MS) continue;
    lastEval = f.t;
    const step = monitor.evaluate(f.t);
    if (f.t - frames[0].t < WINDOW_MS) continue; // the window is not full yet
    out.push({
      t: f.t,
      features: step.features,
      continuous: continuousFeatures(
        frames.filter((g) => g.t > f.t - WINDOW_MS && g.t <= f.t),
        stats,
      ),
      blinks: blinkSequenceFeatures(blinks, f.t, blinkNorm),
      raw: step.latest?.label ?? null,
      shown: monitor.labelState.shown?.label ?? null,
      hold: step.hold !== null,
    });
  }
  return out;
}

const cell = (x: number | null) => (x === null || !Number.isFinite(x) ? "" : String(Number(x.toFixed(5))));
const header = [
  "sumber", "partisipan", "kelas", "t_detik", "kalibrasi", ...FEATURES, "kedip_relatif", "durasi_kedip_relatif",
  ...CONTINUOUS, ...BLINKS, "rules_mentah", "rules_tampil", "ditahan",
];
const lines = [header.join(",")];
const summary: string[] = [];
const baselines: Record<string, Baseline> = {};
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};

for (const dir of dirs) {
  const source = basename(dir);
  const files = readdirSync(dir).filter((f) => /^\d+_(0|5|10)\.csv$/.test(f));
  const participants = [...new Set(files.map((f) => f.split("_")[0]))].sort();
  for (const p of participants) {
    if (!CLASSES.every((k) => files.includes(`${p}_${k}.csv`))) {
      summary.push(`${source}/${p}: dilewati, video 0/5/10 tidak lengkap`);
      continue;
    }
    const videos = Object.fromEntries(CLASSES.map((k) => [k, parseCsv(join(dir, `${p}_${k}.csv`)).frames]));
    const cal = calibrate(videos["0"]);
    if ("error" in cal) {
      summary.push(`${source}/${p}: kalibrasi gagal: ${cal.error}`);
      continue;
    }
    const b = cal.baseline;
    baselines[`${source}/${p}`] = b;
    summary.push(
      `${source}/${p}: earOpen ${b.earOpen.toFixed(3)} earClosed ${b.earClosed.toFixed(3)} (${cal.closedFrames} frame kedip terdalam) ` +
        `kedip ${b.blinkPerMin.toFixed(1)}/menit ${b.blinkDurationMs?.toFixed(0) ?? "-"} ms pitch ${b.pitchDeg.toFixed(1)} tubuh ${b.bodyArea?.toFixed(2) ?? "-"}`,
    );
    const calibEnd = videos["0"][0].t + CALIB_MS;
    const calibFrames = videos["0"].filter((f) => f.t < calibEnd);
    const stats = signalStats(calibFrames);
    const calibBlinks = blinksOf(videos["0"], b).filter((bl) => bl.endT < calibEnd);
    const calibMinutes = (CALIB_MS / 60_000) * (calibFrames.filter((f) => f.face).length / calibFrames.length);
    const blinkNorm = blinkStats(calibBlinks, calibMinutes);
    summary.push(`  kedip kalibrasi: ${calibBlinks.length} (${blinkNorm.perMenit.toFixed(1)}/menit), durasi ${blinkNorm.durasi.mean.toFixed(0)} ms, amplitudo ${blinkNorm.amplitudo.mean.toFixed(3)}, kecepatan buka ${blinkNorm.kecepatan.mean.toFixed(2)}/dtk`);
    for (const k of CLASSES) {
      const rows = evaluateVideo(b, stats, blinkNorm, videos[k], k === "0" ? calibEnd : -Infinity);
      const faceShare = videos[k].filter((f) => f.face).length / videos[k].length;
      for (const r of rows) {
        const f = r.features;
        // Calibration data is never used again for training or testing (as in the paper): calibration blinks
        // are kept out of the sequences above, and a row counts as calibration when its frame window reaches
        // into video 0's first 5 minutes.
        const usesCalibration = k === "0" && r.t - WINDOW_MS < calibEnd;
        lines.push(
          [
            source, `${source}/${p}`, k, cell(r.t / 1000), usesCalibration ? "1" : "0",
            ...FEATURES.map((name) => cell(f[name])),
            cell(f.kedip_per_menit === null ? null : f.kedip_per_menit / b.blinkPerMin),
            cell(f.durasi_kedip_ms === null || b.blinkDurationMs === null ? null : f.durasi_kedip_ms / b.blinkDurationMs),
            ...CONTINUOUS.map((name) => cell(r.continuous[name])),
            ...BLINKS.map((name) => cell(r.blinks.values[name])),
            r.raw ?? "", r.shown ?? "", r.hold ? "1" : "0",
          ].join(","),
        );
      }
      const count = (label: Label) => rows.filter((r) => r.shown === label).length;
      summary.push(
        `  video ${k.padStart(2)}: ${rows.length} jendela, wajah ${(faceShare * 100).toFixed(0)}%, ` +
          `perclos ${(mean(rows.map((r) => r.features.perclos)) * 100).toFixed(1)}%, ` +
          `pejam≥1dtk ${mean(rows.map((r) => r.features.mata_tertutup_lama)).toFixed(2)}/jendela, ` +
          `kedip ${mean(rows.map((r) => r.features.kedip_per_menit)).toFixed(1)}/menit ${mean(rows.map((r) => r.features.durasi_kedip_ms)).toFixed(0)} ms, ` +
          `menguap ${mean(rows.map((r) => r.features.menguap)).toFixed(2)}, nunduk ${(mean(rows.map((r) => r.features.pct_kepala_menunduk)) * 100).toFixed(0)}% | ` +
          `rules: normal ${count("normal")}, lelah ringan ${count("lelah ringan")}, lelah ${count("lelah")}, tertidur ${count("tertidur")}, ` +
          `tidak di depan layar ${count("tidak di depan layar")}, ditahan ${rows.filter((r) => r.hold).length}`,
      );
    }
  }
}

writeFileSync(outPath, lines.join("\n") + "\n");
// For replay.ts: add `# baseline=<json>` to a participant's CSV to replay it with this calibration.
writeFileSync(outPath.replace(/\.csv$/, "") + ".baseline.json", JSON.stringify(baselines, null, 1) + "\n");
console.log(summary.join("\n"));
console.log(`\n${lines.length - 1} baris → ${outPath} (kedalaman kalibrasi ${deepShare})`);
