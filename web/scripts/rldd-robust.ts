// Robustness harness (plan P20 W1.7): the app's own pipeline (Monitor, the path replay.ts takes) on the
// UTA-RLDD per-frame CSVs of scripts/extract-rldd.ts, with the detection loop slowed to 10/7/5/3 fps, on a
// regular clock ("rata") and on a clock with jitter and pauses ("jeda"). Calibration as in
// scripts/rldd-dataset.ts, at the recorded 10 fps: power saving keeps the 10 fps baseline (NOTES D-26).
// Per RLDD class 0 (alert) and 10 (drowsy): the share of windows showing "lelah ringan" or heavier (false
// alarms / recall), how many windows were judged, and "mata tertutup lama" events per hour. Definitions and
// pass criteria were locked in plans/P20-final-14-nov.md ("W1.7 — operasionalisasi kriteria") before the
// first run.
//   node scripts/rldd-robust.ts <out.json> <features dir>... [--nama=old] [--cek=<dataset.csv>] [--banding=<old.json>]
//     [--fps=10,7,5,3] [--label=rules|gabungan] [--dalam=0.2]
// --cek: the 10 fps "rata" run must give the label of every window that rldd-dataset.ts wrote (instrument check, B4).
// --banding: pass criteria K1–K3 of this run (new code) against an earlier run (old code).
// --label: which engine sets the label, as in replay.ts (NOTES D-72); default rules, the app's default.
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { calibrateBlinks } from "../src/blinkScore.ts";
import { computeBaseline, looksClosed, median, type Baseline } from "../src/calibration.ts";
import { Monitor } from "../src/monitor.ts";
import { LABELS, lowFpsNote, TANDA, type Label, type Tanda } from "../src/rules.ts";
import { parseCsv, type Row } from "./session-csv.ts";

const CALIB_MS = 300_000; // CALIB_NORMAL_MS in main.ts
const WINDOW_MS = 60_000; // the app's default window
const EVAL_INTERVAL_MS = 10_000; // same as main.ts
const CLASSES = ["0", "10"] as const;
type Kelas = (typeof CLASSES)[number];
const POSITIVE: readonly Label[] = ["lelah ringan", "lelah", "tertidur"];

// The "jeda" clock (HANDOFF 7 Nov §3): every step × (1 ± JITTER), and after PAUSE_SHARE of the kept frames
// the loop stalls PAUSE_MS longer (a busy laptop, a tab switch). Seeded per video and condition.
const JITTER = 0.2;
const PAUSE_SHARE = 0.02;
const PAUSE_MS = [600, 900] as const;
const CLOCKS = ["rata", "jeda"] as const;
type Clock = (typeof CLOCKS)[number];

const args = process.argv.slice(2);
const flagValue = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const [outPath, ...dirs] = args.filter((a) => !a.startsWith("--"));
if (!outPath || dirs.length === 0) {
  console.error(
    "Pemakaian: node scripts/rldd-robust.ts <keluaran.json> <folder fitur>... [--nama=old] [--cek=<dataset.csv>] " +
      "[--banding=<old.json>] [--fps=10,7,5,3] [--label=rules|gabungan] [--dalam=0.2]",
  );
  process.exit(1);
}
const name = flagValue("nama") ?? basename(outPath).replace(/\.json$/, "");
const deepShare = Number(flagValue("dalam") ?? 0.2);
const FPS = (flagValue("fps") ?? "10,7,5,3").split(",").map(Number);
const engine = flagValue("label") ?? "rules";
if (engine !== "rules" && engine !== "gabungan") {
  console.error("--label harus rules atau gabungan.");
  process.exit(1);
}
if (!FPS.includes(10) || !FPS.includes(5) || FPS.some((x) => !(x > 0 && x <= 10))) {
  console.error("--fps harus memuat 10 dan 5 (pembanding kriteria), tiap nilai 0 < fps ≤ 10.");
  process.exit(1);
}

// Same as rldd-dataset.ts calibrate(); --cek proves the two agree.
function calibrate(video0: Row[]): Baseline | { error: string } {
  const normal = video0.filter((f) => f.t < video0[0].t + CALIB_MS);
  const bodies = normal.flatMap((f) => (f.body ? [f.body] : []));
  const earOpen = median(normal.filter((f) => f.face && Number.isFinite(f.ear)).map((f) => f.ear));
  const blinkFrames = normal.filter((f) => looksClosed(f, earOpen)).sort((a, b) => a.ear - b.ear);
  const closedFrames = blinkFrames.slice(0, Math.max(3, Math.ceil(deepShare * blinkFrames.length)));
  const result = computeBaseline(closedFrames, normal, 0, bodies);
  return result.ok ? result.baseline : { error: result.error };
}

// ── Detection clock ─────────────────────────────────────────────────────────────
// replay.ts downsample() with a step that may vary: one frame per tick, the recorded frame nearest the
// tick (within half a recorded frame). On "rata" at 10 fps every recorded frame is kept.
function resample(rows: readonly Row[], fps: number, clock: Clock, rand: () => number): Row[] {
  const stepMs = 1000 / fps;
  const toleranceMs = median(rows.slice(1).map((f, i) => f.t - rows[i].t)) / 2;
  const step = () => (clock === "jeda" ? stepMs * (1 + JITTER * (2 * rand() - 1)) : stepMs);
  let tick = rows[0].t;
  const kept: Row[] = [];
  for (const f of rows) {
    if (f.t < tick - toleranceMs) continue;
    kept.push(f);
    while (tick - toleranceMs <= f.t) tick += step();
    if (clock === "jeda" && rand() < PAUSE_SHARE) tick += PAUSE_MS[0] + (PAUSE_MS[1] - PAUSE_MS[0]) * rand();
  }
  return kept;
}

function seedOf(text: string): number {
  let h = 0x811c9dc5; // FNV-1a, 32 bit
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── One video through the Monitor ───────────────────────────────────────────────
type WindowRow = {
  t: number;
  slot: [number, number]; // (previous evaluation, this one]: the time this evaluation stands for
  calibration: boolean; // class 0 window reaching into the calibration minutes: left out of every number
  raw: Label | null;
  shown: Label | null;
  tanda: readonly Tanda[]; // the signs behind the shown label
  hold: "fps" | "mata" | null;
  alarm: boolean; // what the person sees as a fatigue state right now
  judged: boolean;
  level: string | null; // quality level the UI shows (quality.ts), null for code without it
  fps: number;
};
type VideoRun = { windows: WindowRow[]; long: number[]; blinks: number[]; yawns: number[]; kept: number; recorded: number };

function runVideo(baseline: Baseline, rows: readonly Row[], kept: readonly Row[], calibEnd: number | null): VideoRun {
  const monitor = new Monitor(baseline, {
    windowMs: WINDOW_MS,
    evalIntervalMs: EVAL_INTERVAL_MS,
    blinkPattern: engine === "gabungan",
    // The glasses check (plan P20 W1.6a) needs a deliberate eyes-closed stage; this calibration stands in the deepest
    // blink frames, which puts the closed/open ratio at 0.07–0.44 without glasses (NOTES G-57), so it stays off here.
    eyesClosedStage: false,
  });
  // Body samples keep their own cadence whichever frames are dropped (replay.ts).
  const bodies = rows.flatMap((f) => (f.body ? [f.body] : []));
  const run: VideoRun = { windows: [], long: [], blinks: [], yawns: [], kept: kept.length, recorded: rows.length };
  let nextBody = 0;
  let lastEval = kept[0].t;
  for (const f of kept) {
    while (nextBody < bodies.length && bodies[nextBody].t <= f.t) monitor.pushBody(bodies[nextBody++]);
    const step = monitor.pushFrame(f);
    if (step.closure) (step.closure.kind === "long" ? run.long : run.blinks).push(step.closure.endT);
    if (step.yawn) run.yawns.push(step.yawn.endT);
    if (f.t - lastEval < EVAL_INTERVAL_MS) continue;
    const slot: [number, number] = [lastEval, f.t];
    lastEval = f.t;
    const e = monitor.evaluate(f.t);
    if (f.t - kept[0].t < WINDOW_MS) continue; // the window is not full yet (rldd-dataset.ts)
    const shown = monitor.labelState.shown?.label ?? null;
    // Code with the quality gate (W1.4): a label shown grey ("last assessed N min ago") is not an alarm, and a window
    // counts as judged unless the UI says it cannot assess. Older code: every shown label looks current.
    const level = (e as { assessed?: { level: string | null } }).assessed?.level ?? null;
    const stale = level === "tidak-dinilai";
    run.windows.push({
      t: f.t,
      slot,
      calibration: calibEnd !== null && f.t - WINDOW_MS < calibEnd,
      raw: e.latest?.label ?? null,
      shown,
      tanda: monitor.labelState.shown?.tanda ?? [],
      hold: e.hold === null ? null : lowFpsNote(e.features) !== null ? "fps" : "mata",
      alarm: shown !== null && POSITIVE.includes(shown) && !stale,
      judged: level === null ? e.latest !== null : !stale,
      level,
      fps: e.features.durasi_jendela_detik > 0 ? e.features.n_frame / e.features.durasi_jendela_detik : 0,
    });
  }
  return run;
}

// ── Numbers per condition and class ─────────────────────────────────────────────
type PersonStats = { jendela: number; positif: number; dinilai: number; mata_tertutup_lama: number };
type ClassStats = {
  jendela: number;
  dinilai: number;
  ditahan: { fps: number; mata: number };
  tanpa_label: number;
  label: Record<string, number>;
  positif: number;
  positif_ditahan: number; // positive windows whose label was only kept from an earlier evaluation, shown as current
  tingkat: Record<string, number>; // windows per quality level the UI showed (code with quality.ts)
  tanda: Record<string, number>; // positive windows whose shown label rests on this sign (one window can have several)
  porsi_positif: number; // false alarms (class 0) or recall (class 10)
  porsi_positif_dinilai: number | null;
  coverage: number; // judged windows / windows
  jam: number; // hours of slots counted
  jam_dinilai: number;
  mata_tertutup_lama: { n: number; n_dinilai: number; per_jam: number; per_jam_dinilai: number | null };
  kedip_per_menit: number;
  menguap: number;
  fps_median: number;
  frame_disimpan: number; // kept / recorded frames over the counted videos
  orang_positif: number; // people with at least one positive window (class 0: wrongly warned; 10: caught)
  per_orang: Record<string, PersonStats>;
};

const inSlots = (times: readonly number[], windows: readonly WindowRow[]) =>
  times.filter((t) => windows.some((w) => w.slot[0] < t && t <= w.slot[1])).length;
const hoursOf = (windows: readonly WindowRow[]) => windows.reduce((sum, w) => sum + (w.slot[1] - w.slot[0]), 0) / 3_600_000;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function classStats(runs: Map<string, VideoRun>): ClassStats {
  const all: WindowRow[] = [];
  const perOrang: Record<string, PersonStats> = {};
  let long = 0;
  let longJudged = 0;
  let blinks = 0;
  let yawns = 0;
  let kept = 0;
  let recorded = 0;
  for (const [person, run] of runs) {
    const counted = run.windows.filter((w) => !w.calibration);
    const judged = counted.filter((w) => w.judged);
    all.push(...counted);
    const personLong = inSlots(run.long, counted);
    long += personLong;
    longJudged += inSlots(run.long, judged);
    blinks += inSlots(run.blinks, counted);
    yawns += inSlots(run.yawns, counted);
    kept += run.kept;
    recorded += run.recorded;
    perOrang[person] = {
      jendela: counted.length,
      positif: counted.filter((w) => w.alarm).length,
      dinilai: judged.length,
      mata_tertutup_lama: personLong,
    };
  }
  const judged = all.filter((w) => w.judged);
  const positif = all.filter((w) => w.alarm).length;
  const jam = hoursOf(all);
  const jamDinilai = hoursOf(judged);
  const label = Object.fromEntries(LABELS.map((l) => [l, all.filter((w) => w.shown === l).length]));
  return {
    jendela: all.length,
    dinilai: judged.length,
    ditahan: { fps: all.filter((w) => w.hold === "fps").length, mata: all.filter((w) => w.hold === "mata").length },
    tanpa_label: all.filter((w) => w.shown === null).length,
    label,
    positif,
    positif_ditahan: all.filter((w) => w.alarm && w.raw === null).length,
    tingkat: Object.fromEntries(
      [...new Set(all.map((w) => w.level ?? "-"))].sort().map((l) => [l, all.filter((w) => (w.level ?? "-") === l).length]),
    ),
    tanda: Object.fromEntries(TANDA.map((t) => [t, all.filter((w) => w.alarm && w.tanda.includes(t)).length])),
    porsi_positif: positif / all.length,
    porsi_positif_dinilai: ratio(judged.filter((w) => w.alarm).length, judged.length),
    coverage: judged.length / all.length,
    jam,
    jam_dinilai: jamDinilai,
    mata_tertutup_lama: { n: long, n_dinilai: longJudged, per_jam: long / jam, per_jam_dinilai: ratio(longJudged, jamDinilai) },
    kedip_per_menit: blinks / (jam * 60),
    menguap: yawns,
    fps_median: median(all.map((w) => w.fps)),
    frame_disimpan: kept / recorded,
    orang_positif: Object.values(perOrang).filter((p) => p.positif > 0).length,
    per_orang: perOrang,
  };
}

// Negative control: swap alert ↔ drowsy within each person, every one of the 2^n patterns. With the labels
// shuffled, recall − false alarms must average ≈ 0; p = share of patterns at or above the observed gap.
function labelShuffle(alert: ClassStats, drowsy: ClassStats) {
  const people = Object.keys(alert.per_orang).filter((p) => p in drowsy.per_orang);
  const gapOf = (swap: number) => {
    let pos0 = 0, n0 = 0, pos10 = 0, n10 = 0;
    people.forEach((p, i) => {
      const [a, d] = swap & (1 << i) ? [drowsy.per_orang[p], alert.per_orang[p]] : [alert.per_orang[p], drowsy.per_orang[p]];
      pos0 += a.positif;
      n0 += a.jendela;
      pos10 += d.positif;
      n10 += d.jendela;
    });
    return pos10 / n10 - pos0 / n0;
  };
  const observed = gapOf(0);
  const patterns = 2 ** people.length;
  const gaps = Array.from({ length: patterns }, (_, swap) => gapOf(swap));
  return {
    pola: patterns,
    selisih_teramati: observed,
    selisih_acak_rata: gaps.reduce((a, b) => a + b, 0) / patterns,
    selisih_acak_maks_abs: Math.max(...gaps.map(Math.abs)),
    p: gaps.filter((g) => g >= observed - 1e-12).length / patterns,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────────
type Condition = { fps: number; jam: Clock };
const conditions: Condition[] = FPS.flatMap((fps) => CLOCKS.map((jam) => ({ fps, jam })));
const key = (c: Condition) => `${c.fps}|${c.jam}`;
const runs = new Map<string, Record<Kelas, Map<string, VideoRun>>>(
  conditions.map((c) => [key(c), { "0": new Map(), "10": new Map() }]),
);
const notes: string[] = [];
const started = Date.now();

for (const dir of dirs) {
  const source = basename(dir);
  const files = readdirSync(dir).filter((f) => /^\d+_(0|5|10)\.csv$/.test(f));
  const participants = [...new Set(files.map((f) => f.split("_")[0]))].sort();
  for (const p of participants) {
    const person = `${source}/${p}`;
    if (!CLASSES.every((k) => files.includes(`${p}_${k}.csv`))) {
      notes.push(`${person}: dilewati, video 0/10 tidak lengkap`);
      continue;
    }
    const videos = Object.fromEntries(CLASSES.map((k) => [k, parseCsv(join(dir, `${p}_${k}.csv`)).frames])) as Record<Kelas, Row[]>;
    const calibrated = calibrate(videos["0"]);
    if ("error" in calibrated) {
      notes.push(`${person}: kalibrasi gagal: ${calibrated.error}`);
      continue;
    }
    const calibEnd = videos["0"][0].t + CALIB_MS;
    // rldd-dataset.ts leaves out people with fewer than 5 calibration blinks; same set of people here.
    const blinkNorm = calibrateBlinks(videos["0"].filter((f) => f.t < calibEnd), calibrated);
    if (!blinkNorm) {
      notes.push(`${person}: dilewati, kurang dari 5 kedip di kalibrasi`);
      continue;
    }
    const baseline = engine === "gabungan" ? { ...calibrated, kedip: blinkNorm } : calibrated;
    for (const c of conditions) {
      for (const k of CLASSES) {
        const rand = mulberry32(seedOf(`${person}|${k}|${c.fps}|${c.jam}`));
        const kept = resample(videos[k], c.fps, c.jam, rand);
        runs.get(key(c))![k].set(person, runVideo(baseline, videos[k], kept, k === "0" ? calibEnd : null));
      }
    }
  }
}

const results = conditions.map((c) => {
  const r = runs.get(key(c))!;
  const kelas = { "0": classStats(r["0"]), "10": classStats(r["10"]) };
  return { fps: c.fps, jam: c.jam, kelas, kontrol: labelShuffle(kelas["0"], kelas["10"]) };
});
const resultOf = (list: typeof results, fps: number, jam: Clock) => list.find((x) => x.fps === fps && x.jam === jam);

// ── Instrument check against rldd-dataset.ts ────────────────────────────────────
const cell = (x: number) => String(Number(x.toFixed(5))); // rldd-dataset.ts cell()
let check: { jendela: number; identik: number; beda: string[]; hilang: number; berlebih: number } | null = null;
const checkPath = flagValue("cek");
if (checkPath) {
  const [head, ...body] = readFileSync(checkPath, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  const at = (n: string) => cols.indexOf(n);
  const expected = new Map(
    body
      .map((l) => l.split(","))
      .filter((c) => (CLASSES as readonly string[]).includes(c[at("kelas")]))
      .map((c) => [`${c[at("partisipan")]}|${c[at("kelas")]}|${c[at("t_detik")]}`, `${c[at("rules_mentah")]}|${c[at("rules_tampil")]}|${c[at("ditahan")]}`]),
  );
  const got = new Map<string, string>();
  const r = runs.get(key({ fps: 10, jam: "rata" }))!;
  for (const k of CLASSES) {
    for (const [person, run] of r[k]) {
      for (const w of run.windows) got.set(`${person}|${k}|${cell(w.t / 1000)}`, `${w.raw ?? ""}|${w.shown ?? ""}|${w.hold ? "1" : "0"}`);
    }
  }
  const beda = [...got].filter(([k, v]) => expected.has(k) && expected.get(k) !== v).map(([k, v]) => `${k}: ${expected.get(k)} → ${v}`);
  check = {
    jendela: expected.size,
    identik: [...got].filter(([k, v]) => expected.get(k) === v).length,
    beda: beda.slice(0, 20),
    hilang: [...expected.keys()].filter((k) => !got.has(k)).length,
    berlebih: [...got.keys()].filter((k) => !expected.has(k)).length,
  };
}

// ── Pass criteria against an earlier run ────────────────────────────────────────
type Saved = { nama: string; hasil: typeof results };
let criteria: { nama_pembanding: string; kriteria: { id: string; jam: Clock; teks: string; lulus: boolean }[]; info: string[] } | null = null;
const comparePath = flagValue("banding");
const pts = (x: number) => (x * 100).toFixed(1);
if (comparePath) {
  const old = JSON.parse(readFileSync(comparePath, "utf8")) as Saved;
  const list: { id: string; jam: Clock; teks: string; lulus: boolean }[] = [];
  const info: string[] = [];
  for (const jam of CLOCKS) {
    const n10 = resultOf(results, 10, jam);
    const n5 = resultOf(results, 5, jam);
    const o10 = resultOf(old.hasil, 10, jam);
    const o5 = resultOf(old.hasil, 5, jam);
    if (!n10 || !n5 || !o10 || !o5) throw new Error(`kondisi 10/5 fps jam ${jam} tidak ada di salah satu run`);
    const fa5 = n5.kelas["0"].porsi_positif;
    const fa10 = n10.kelas["0"].porsi_positif;
    list.push({ id: "K1", jam, teks: `alarm palsu 5 fps ${pts(fa5)}% ≤ 10 fps ${pts(fa10)}% + 3 poin`, lulus: fa5 <= fa10 + 0.03 + 1e-12 });
    const long5 = n5.kelas["0"].mata_tertutup_lama.per_jam;
    const oldLong5 = o5.kelas["0"].mata_tertutup_lama.per_jam;
    list.push({
      id: "K2",
      jam,
      teks: `mata tertutup lama segar 5 fps ${long5.toFixed(2)}/jam ≤ 50% kode lama ${oldLong5.toFixed(2)}/jam`,
      lulus: oldLong5 === 0 ? long5 === 0 : long5 <= 0.5 * oldLong5 + 1e-12,
    });
    const rec5 = n5.kelas["10"].porsi_positif;
    const oldRec5 = o5.kelas["10"].porsi_positif;
    list.push({ id: "K3", jam, teks: `recall 5 fps ${pts(rec5)}% ≥ kode lama ${pts(oldRec5)}% − 5 poin`, lulus: rec5 >= oldRec5 - 0.05 - 1e-12 });
    info.push(
      `${jam}: recall 5 fps ${pts(rec5)}% vs 10 fps ${pts(n10.kelas["10"].porsi_positif)}% (kode ini) · recall 10 fps ` +
        `${pts(n10.kelas["10"].porsi_positif)}% vs kode lama ${pts(o10.kelas["10"].porsi_positif)}% · coverage 5 fps segar ` +
        `${pts(n5.kelas["0"].coverage)}% / mengantuk ${pts(n5.kelas["10"].coverage)}%`,
    );
  }
  criteria = { nama_pembanding: old.nama, kriteria: list, info };
}

// ── Output ──────────────────────────────────────────────────────────────────────
const git = (cmd: string) => {
  try {
    return execSync(`git ${cmd}`, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const output = {
  nama: name,
  dibuat: new Date().toISOString(),
  kode: { commit: git("rev-parse --short HEAD"), berubah_belum_commit: git("status --porcelain -- ../src ../scripts") },
  argumen: args,
  protokol: {
    label: engine,
    kalibrasi: `rldd-dataset.ts: 5 menit pertama video 0, 10 fps asli, --dalam=${deepShare}`,
    jendela_ms: WINDOW_MS,
    evaluasi_ms: EVAL_INTERVAL_MS,
    positif: POSITIVE,
    jam: { rata: "langkah 1000/fps ms", jeda: `langkah × (1 ± ${JITTER}), jeda ${PAUSE_MS[0]}–${PAUSE_MS[1]} ms sesudah ${PAUSE_SHARE * 100}% frame` },
    seed: "FNV-1a(partisipan|kelas|fps|jam) → mulberry32",
    kacamata: "tidak tercatat untuk 12 subjek ini; cek rasio kalibrasi W1.6a dimatikan (kalibrasi RLDD tanpa tahap mata terpejam, G-57)",
  },
  catatan: notes,
  cek: check,
  kriteria: criteria,
  hasil: results,
};
writeFileSync(outPath, JSON.stringify(output, null, 1) + "\n");

const pct = (x: number | null) => (x === null ? "  -  " : `${(x * 100).toFixed(1).padStart(5)}%`);
const people = results[0] ? Object.keys(results[0].kelas["0"].per_orang).length : 0;
console.log(`${name}: ${people} orang, label ${engine}, ${((Date.now() - started) / 1000).toFixed(1)} dtk${notes.length ? `\n${notes.join("\n")}` : ""}`);
console.log(
  "fps jam  | segar: jendela  dinilai  positif  ditahan fps/mata  pejam≥1dtk/jam  kedip/mnt | mengantuk: jendela  dinilai  positif  pejam≥1dtk/jam | acak: selisih rata, p",
);
for (const r of results) {
  const a = r.kelas["0"];
  const d = r.kelas["10"];
  console.log(
    `${String(r.fps).padStart(3)} ${r.jam.padEnd(4)} | ${String(a.jendela).padStart(14)} ${pct(a.coverage)} ${pct(a.porsi_positif)} ` +
      `${String(a.ditahan.fps).padStart(8)}/${String(a.ditahan.mata).padEnd(4)} ${a.mata_tertutup_lama.per_jam.toFixed(2).padStart(14)} ` +
      `${a.kedip_per_menit.toFixed(1).padStart(9)} | ${String(d.jendela).padStart(18)} ${pct(d.coverage)} ${pct(d.porsi_positif)} ` +
      `${d.mata_tertutup_lama.per_jam.toFixed(2).padStart(14)} | ${pct(r.kontrol.selisih_acak_rata)}, ${r.kontrol.p.toFixed(4)}` +
      `  (fps median ${a.fps_median.toFixed(1)}/${d.fps_median.toFixed(1)}; ditegur palsu ${a.orang_positif}, tertangkap ${d.orang_positif})`,
  );
}
const signs = (s: ClassStats) =>
  Object.entries(s.tanda)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${t} ${n}`)
    .join(", ") || "-";
console.log("\nTanda di balik jendela positif (satu jendela bisa punya beberapa) · positif yang hanya ditahan dari evaluasi lama:");
for (const r of results) {
  const a = r.kelas["0"];
  const d = r.kelas["10"];
  console.log(
    `${String(r.fps).padStart(3)} ${r.jam.padEnd(4)} | segar ${a.positif} (ditahan ${a.positif_ditahan}): ${signs(a)} | ` +
      `mengantuk ${d.positif} (ditahan ${d.positif_ditahan}): ${signs(d)}` +
      (a.tingkat["-"] === undefined ? ` | tingkat segar ${JSON.stringify(a.tingkat)} mengantuk ${JSON.stringify(d.tingkat)}` : ""),
  );
}
if (check) {
  console.log(
    `\ncek alat ukur (10 fps rata vs ${basename(checkPath!)}): ${check.identik}/${check.jendela} jendela identik, ` +
      `${check.beda.length} beda, ${check.hilang} hilang, ${check.berlebih} berlebih`,
  );
  for (const line of check.beda) console.log(`  ${line}`);
}
if (criteria) {
  console.log(`\nKriteria lulus vs ${criteria.nama_pembanding}:`);
  for (const k of criteria.kriteria) console.log(`  ${k.id} ${k.jam.padEnd(4)} ${k.lulus ? "LULUS" : "GAGAL"}  ${k.teks}`);
  for (const line of criteria.info) console.log(`  info ${line}`);
}
console.log(`\n→ ${outPath}`);
if (check && (check.identik !== check.jendela || check.berlebih > 0)) process.exit(2);
