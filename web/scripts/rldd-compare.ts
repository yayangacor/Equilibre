// Which engine should set the label (plan P17 C3, D-68)? Rules vs the blink-pattern classifier vs both,
// leave-one-subject-out over the UTA-RLDD participants, alert (0) vs drowsy (10) windows, calibration
// windows (video 0's first 5 minutes) left out. Protocol and selection rule were locked in
// plans/P17-semifinal-audit.md before this script was written:
//   R = rules: lelah ringan, lelah or tertidur is positive; normal and held windows are negative.
//   K = the blink-pattern classifier (rldd-evaluate.ts --fitur=kedipan): positive when P(drowsy) ≥ t.
//   G = R or K (the classifier may only raise the label to lelah ringan, D-49 option 2).
// t never sees the test participant: an inner leave-one-subject-out over the training participants gives
// out-of-fold P(drowsy), and t is the smallest of 0.01…0.99 whose false alarms on the training alert
// windows stay ≤ 10% (for G: false alarms of "R or p ≥ t"). Pick: false alarms ≤ 10% on the test folds,
// then the highest recall; recalls within 1 point → more participants caught, then fewer false alarms.
//   node scripts/rldd-compare.ts <dataset.csv> [--ambang-tetap=0.5] [--ambang-app]
// --ambang-tetap skips the inner search: a descriptive run, also the control against rldd-evaluate.ts.
// --ambang-app runs the same search once over all participants, for the model the app ships (trained on all of
// them, web/src/blinkScore.ts MODEL): out-of-fold P(drowsy) from leave-one-subject-out, then the threshold (D-72).
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flagValue = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const path = args.find((a) => !a.startsWith("--"));
if (!path) {
  console.error("Pemakaian: node scripts/rldd-compare.ts <dataset.csv> [--ambang-tetap=0.5] [--ambang-app]");
  process.exit(1);
}
const fixed = flagValue("ambang-tetap");
const fixedThreshold = fixed === undefined ? null : Number(fixed);
const MAX_FALSE_ALARM = 0.1;
const GRID = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);
// The UTA-RLDD paper's per-blink features over the last 30 blinks (rldd-dataset.ts BLINKS).
const FEATURES = ["zk_durasi_rata", "zk_amplitudo_rata", "zk_kecepatan_rata", "zk_frekuensi_relatif"];
const RULES_POSITIVE = new Set(["lelah ringan", "lelah", "tertidur"]);

type Sample = { subject: string; drowsy: boolean; x: (number | null)[]; rules: boolean };
type Scored = Sample & { p: number; tK: number; tG: number };

function load(file: string): Sample[] {
  const [head, ...body] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  const at = (name: string) => cols.indexOf(name);
  const missing = [...FEATURES, "partisipan", "kelas", "kalibrasi", "rules_tampil"].filter((f) => at(f) < 0);
  if (missing.length > 0) throw new Error(`${file}: kolom tidak ada: ${missing.join(", ")}`);
  return body
    .map((l) => l.split(","))
    .filter((c) => (c[at("kelas")] === "0" || c[at("kelas")] === "10") && c[at("kalibrasi")] !== "1")
    .map((c) => ({
      subject: c[at("partisipan")].split("/").pop() as string,
      drowsy: c[at("kelas")] === "10",
      x: FEATURES.map((f) => (c[at(f)] === "" ? null : Number(c[at(f)]))),
      rules: RULES_POSITIVE.has(c[at("rules_tampil")]),
    }));
}

// ── Model: the softmax regression of rldd-evaluate.ts, two classes (L2 0.01, 3000 steps, rate 0.2) ──
const L2 = 0.01;
const STEPS = 3000;
const RATE = 0.2;
const D = FEATURES.length;

type Model = { center: number[]; scale: number[]; fill: number[]; w: number[][] }; // w[k] = [bias, ...D]

const medianOf = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function prepare(train: Sample[]) {
  const fill = FEATURES.map((_, j) => medianOf(train.flatMap((s) => (s.x[j] === null ? [] : [s.x[j] as number]))));
  const rows = train.map((s) => s.x.map((v, j) => v ?? fill[j]));
  const center = FEATURES.map((_, j) => rows.reduce((a, r) => a + r[j], 0) / rows.length);
  const scale = FEATURES.map((_, j) => Math.sqrt(rows.reduce((a, r) => a + (r[j] - center[j]) ** 2, 0) / rows.length) || 1);
  return { fill, center, scale };
}

const standardize = (m: Pick<Model, "fill" | "center" | "scale">, s: Sample) =>
  s.x.map((v, j) => ((v ?? m.fill[j]) - m.center[j]) / m.scale[j]);

function softmax(z: number[]) {
  const top = Math.max(...z);
  const e = z.map((v) => Math.exp(v - top));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

const scores = (m: Model, x: number[]) => softmax(m.w.map((wk) => wk[0] + x.reduce((a, v, j) => a + v * wk[j + 1], 0)));

function train(samples: Sample[]): Model {
  const norm = prepare(samples);
  const xs = samples.map((s) => standardize(norm, s));
  const labels = samples.map((s) => (s.drowsy ? 1 : 0));
  const w = [new Array(D + 1).fill(0), new Array(D + 1).fill(0)];
  const model: Model = { ...norm, w };
  for (let step = 0; step < STEPS; step++) {
    const grad = [new Array(D + 1).fill(0), new Array(D + 1).fill(0)];
    xs.forEach((x, i) => {
      const p = scores(model, x);
      for (let k = 0; k < 2; k++) {
        const err = p[k] - (labels[i] === k ? 1 : 0);
        grad[k][0] += err;
        for (let j = 0; j < D; j++) grad[k][j + 1] += err * x[j];
      }
    });
    for (let k = 0; k < 2; k++)
      for (let j = 0; j <= D; j++) w[k][j] -= RATE * (grad[k][j] / xs.length + (j > 0 ? L2 * w[k][j] : 0));
  }
  return model;
}

const drowsyProbability = (m: Model, s: Sample) => scores(m, standardize(m, s))[1];

// Smallest grid threshold whose false alarms on the alert windows stay within MAX_FALSE_ALARM; Infinity
// when none does, so the classifier never fires.
function pickThreshold(windows: (Sample & { p: number })[], withRules: boolean) {
  const alert = windows.filter((w) => !w.drowsy);
  for (const t of GRID) {
    if (alert.filter((w) => (withRules && w.rules) || w.p >= t).length <= MAX_FALSE_ALARM * alert.length) return t;
  }
  return Infinity;
}

// ── Leave-one-subject-out ───────────────────────────────────────────────────────
const samples = load(path);
const subjects = [...new Set(samples.map((s) => s.subject))].sort();

if (args.includes("--ambang-app")) {
  const outOfFold = subjects.flatMap((u) => {
    const model = train(samples.filter((s) => s.subject !== u));
    return samples.filter((s) => s.subject === u).map((s) => ({ ...s, p: drowsyProbability(model, s) }));
  });
  const alert = outOfFold.filter((s) => !s.drowsy);
  const drowsy = outOfFold.filter((s) => s.drowsy);
  const share = (n: number, of: number) => `${((n / of) * 100).toFixed(1)}% (${n}/${of})`;
  for (const [name, withRules] of [["K classifier", false], ["G rules atau classifier", true]] as const) {
    const t = pickThreshold(outOfFold, withRules);
    const positive = (s: (typeof outOfFold)[number]) => (withRules && s.rules) || s.p >= t;
    console.log(
      `${name}: ambang ${t.toFixed(2)} · di luar fold: alarm palsu ${share(alert.filter(positive).length, alert.length)}, ` +
        `recall ${share(drowsy.filter(positive).length, drowsy.length)}`,
    );
  }
  // The model on all participants, in blinkScore.ts's BlinkModel form: the two-class softmax as one logistic.
  const all = train(samples);
  const round = (v: number[]) => v.map((x) => Number(x.toFixed(6)));
  console.log(
    `model semua partisipan (bandingkan dengan MODEL di web/src/blinkScore.ts): fill ${JSON.stringify(round(all.fill))} ` +
      `center ${JSON.stringify(round(all.center))} scale ${JSON.stringify(round(all.scale))} ` +
      `weights ${JSON.stringify(round(all.w[1].slice(1).map((w, j) => w - all.w[0][j + 1])))} bias ${(all.w[1][0] - all.w[0][0]).toFixed(6)}`,
  );
  process.exit(0);
}
const scored: Scored[] = [];
const thresholds: string[] = [];
for (const subject of subjects) {
  const trainSet = samples.filter((s) => s.subject !== subject);
  let tK = fixedThreshold ?? Infinity;
  let tG = tK;
  if (fixedThreshold === null) {
    const outOfFold = subjects
      .filter((u) => u !== subject)
      .flatMap((u) => {
        const inner = train(trainSet.filter((s) => s.subject !== u));
        return trainSet.filter((s) => s.subject === u).map((s) => ({ ...s, p: drowsyProbability(inner, s) }));
      });
    tK = pickThreshold(outOfFold, false);
    tG = pickThreshold(outOfFold, true);
  }
  const model = train(trainSet);
  for (const s of samples.filter((q) => q.subject === subject)) scored.push({ ...s, p: drowsyProbability(model, s), tK, tG });
  thresholds.push(`${subject} K ${tK.toFixed(2)} G ${tG.toFixed(2)}`);
}

// ── Metrics ─────────────────────────────────────────────────────────────────────
const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(1)}% (${n}/${of})`;

function measure(name: string, positive: (s: Scored) => boolean) {
  const alert = scored.filter((s) => !s.drowsy);
  const drowsy = scored.filter((s) => s.drowsy);
  const fp = alert.filter(positive).length;
  const tp = drowsy.filter(positive).length;
  const tn = alert.length - fp;
  const fn = drowsy.length - tp;
  const f1 = (hit: number, wrong: number) => (hit === 0 ? 0 : (2 * hit) / (2 * hit + wrong));
  const perSubject = subjects.map((subject) => {
    const a = alert.filter((s) => s.subject === subject);
    const d = drowsy.filter((s) => s.subject === subject);
    return { subject, fa: a.filter(positive).length, nAlert: a.length, hit: d.filter(positive).length, nDrowsy: d.length };
  });
  // Video vote as in rldd-evaluate.ts: the most common window class, ties to alert.
  const videosRight =
    perSubject.filter((v) => v.fa * 2 <= v.nAlert).length + perSubject.filter((v) => v.hit * 2 > v.nDrowsy).length;
  return {
    name,
    fp,
    tp,
    tn,
    fn,
    falseAlarm: fp / alert.length,
    recall: tp / drowsy.length,
    macroF1: (f1(tp, fp + fn) + f1(tn, fn + fp)) / 2,
    accuracy: (tp + tn) / scored.length,
    caught: perSubject.filter((v) => v.hit > 0).length,
    falselyAlerted: perSubject.filter((v) => v.fa > 0).length,
    videosRight,
    perSubject,
    line: () =>
      `${name.padEnd(30)} alarm palsu ${pct(fp, alert.length).padStart(15)}  recall ${pct(tp, drowsy.length).padStart(16)}  ` +
      `macro-F1 ${((f1(tp, fp + fn) + f1(tn, fn + fp)) / 2).toFixed(3)}  akurasi ${(((tp + tn) / scored.length) * 100).toFixed(1)}%  ` +
      `tertangkap ${perSubject.filter((v) => v.hit > 0).length}/${subjects.length} org  ditegur palsu ${perSubject.filter((v) => v.fa > 0).length}/${subjects.length} org  ` +
      `video benar ${videosRight}/${subjects.length * 2}  matriks [segar→${tn}/${fp} mengantuk→${fn}/${tp}]`,
  };
}

const alertCount = scored.filter((s) => !s.drowsy).length;
console.log(
  `${scored.length} jendela (${alertCount} segar, ${scored.length - alertCount} mengantuk), ${subjects.length} partisipan, LOSO, ` +
    `tanpa jendela kalibrasi; ambang ${fixedThreshold === null ? "dari LOSO dalam, alarm palsu latih ≤ 10%" : `tetap ${fixedThreshold}`}`,
);
console.log(`ambang per orang uji: ${thresholds.join(" · ")}`);
const candidates = [
  measure("R  rules (label tampil)", (s) => s.rules),
  measure("K  classifier pola kedip", (s) => s.p >= s.tK),
  measure("G  rules atau classifier", (s) => s.rules || s.p >= s.tG),
];
const descriptive =
  fixedThreshold === null
    ? [measure("K  ambang 0,5 (deskriptif)", (s) => s.p >= 0.5), measure("G  ambang 0,5 (deskriptif)", (s) => s.rules || s.p >= 0.5)]
    : [];
for (const c of [...candidates, ...descriptive]) console.log(c.line());
console.log("per partisipan, alarm palsu/jendela segar · tertangkap/jendela mengantuk:");
for (const c of [...candidates, ...descriptive])
  console.log(`  ${c.name.slice(0, 2).trim()}${c.name.includes("0,5") ? "@0,5" : ""}: ${c.perSubject.map((v) => `${v.subject} ${v.fa}/${v.nAlert}·${v.hit}/${v.nDrowsy}`).join("  ")}`);

if (fixedThreshold !== null) {
  console.log("ambang tetap: deskriptif, aturan pilih D-68 tidak dipakai");
} else {
  const eligible = candidates.filter((c) => c.falseAlarm <= MAX_FALSE_ALARM);
  let best = eligible[0];
  for (const c of eligible.slice(1)) {
    const better =
      c.recall >= best.recall + 0.01 ||
      (Math.abs(c.recall - best.recall) < 0.01 &&
        (c.caught > best.caught || (c.caught === best.caught && c.falseAlarm < best.falseAlarm)));
    if (better) best = c;
  }
  const out = candidates.filter((c) => !eligible.includes(c)).map((c) => c.name.slice(0, 2).trim());
  console.log(
    `aturan pilih D-68: gugur (alarm palsu > 10%) ${out.length > 0 ? out.join(", ") : "tidak ada"} → ` +
      (best ? `terpilih ${best.name}` : "tidak ada kandidat yang lolos"),
  );
}
