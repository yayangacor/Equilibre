// Leave-one-subject-out evaluation on the rows of scripts/rldd-dataset.ts (plan P04 langkah 4):
// a multinomial logistic regression on the app's window features against (a) the training
// fold's majority class and (b) the rules' shown label (normal → 0, lelah ringan → 5,
// lelah/tertidur → 10). Control: the same model trained on shuffled labels must fall to chance.
//   node scripts/rldd-evaluate.ts <dataset.csv> [--kelas=0,5,10|0,10] [--fitur=app|kontinu|kedipan|kontinu+kedipan|semua] [--split=loso|acak75]
//     [--tanpa-kalibrasi] [--koefisien] [--uji=<dataset orang baru.csv>]
// Body features are left out on purpose: they depend on how far the camera sits (webcam vs
// phone in the dataset), not on drowsiness.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flagValue = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const path = args.find((a) => !a.startsWith("--"));
if (!path) {
  console.error("Pemakaian: node scripts/rldd-evaluate.ts <dataset.csv> [--kelas=0,5,10|0,10] [--tanpa-kalibrasi] [--koefisien]");
  process.exit(1);
}
const classes = (flagValue("kelas") ?? "0,5,10").split(",");
// app = the rules' window features; kontinu = z-scored continuous signals (rldd-dataset.ts CONTINUOUS).
const APP_FEATURES = [
  "perclos",
  "kedip_relatif",
  "durasi_kedip_relatif",
  "mata_tertutup_lama",
  "menguap",
  "pct_kepala_menunduk",
  "pct_wajah_hilang",
  "pct_mata_tertutup",
];
const CONTINUOUS_FEATURES = [
  "z_ear_rata", "z_ear_p10", "z_ear_sd", "z_kedip_rata", "z_kedip_p90", "z_mulut_rata", "z_mulut_p90", "z_moe_median",
  "z_pitch_rata", "z_bawah_rata",
];
// kedipan = the UTA-RLDD paper's per-blink features over the last 30 blinks (rldd-dataset.ts BLINKS).
const BLINK_FEATURES = ["zk_durasi_rata", "zk_amplitudo_rata", "zk_kecepatan_rata", "zk_frekuensi_relatif"];
const FEATURE_SETS: Record<string, string[]> = {
  app: APP_FEATURES,
  kontinu: CONTINUOUS_FEATURES,
  kedipan: BLINK_FEATURES,
  "kontinu+kedipan": [...CONTINUOUS_FEATURES, ...BLINK_FEATURES],
  semua: [...APP_FEATURES, ...CONTINUOUS_FEATURES, ...BLINK_FEATURES],
};
const featureSet = flagValue("fitur") ?? "app";
const FEATURES = FEATURE_SETS[featureSet];
if (!FEATURES) {
  console.error(`--fitur harus salah satu dari: ${Object.keys(FEATURE_SETS).join(", ")}`);
  process.exit(1);
}
// loso = leave one participant out (people the model has never seen); acak75 = one random 75/25 split of
// windows, the protocol in Khan & Islam's slides, where every participant is in both halves.
const split = flagValue("split") ?? "loso";
const RULES_CLASS: Record<string, string> = { normal: "0", "lelah ringan": "5", lelah: "10", tertidur: "10" };

type Sample = { subject: string; video: string; y: number; x: (number | null)[]; rules: string | null };

function load(file: string): Sample[] {
  const [head, ...body] = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  const at = (name: string) => cols.indexOf(name);
  const missing = FEATURES.filter((f) => at(f) < 0);
  if (missing.length > 0) throw new Error(`${file}: kolom tidak ada: ${missing.join(", ")}`);
  return body
    .map((l) => l.split(","))
    .filter((c) => classes.includes(c[at("kelas")]))
    .filter((c) => !args.includes("--tanpa-kalibrasi") || c[at("kalibrasi")] !== "1")
    .map((c) => {
      const rules = RULES_CLASS[c[at("rules_tampil")]];
      return {
        subject: c[at("partisipan")],
        video: `${c[at("partisipan")]}/${c[at("kelas")]}`,
        y: classes.indexOf(c[at("kelas")]),
        x: FEATURES.map((f) => (c[at(f)] === "" ? null : Number(c[at(f)]))),
        // Rules labels outside the task's classes (e.g. 5 in a 0-vs-10 run) count as wrong.
        rules: rules === undefined ? null : rules,
      };
    });
}

const samples = load(path);
// --uji=<dataset.csv>: train once on every row of <dataset.csv> and test once on the people in this file
// (plan P04: the confirmation on participants never seen while choosing features).
const heldOutPath = flagValue("uji");
const heldOut = heldOutPath ? load(heldOutPath) : null;
const subjects = [...new Set(samples.map((s) => s.subject))].sort();
if (heldOut && heldOut.some((s) => subjects.includes(s.subject))) {
  console.error("Data uji berisi partisipan yang juga ada di data latih.");
  process.exit(1);
}
if (!heldOut && subjects.length < 2) {
  console.error(`Leave-one-subject-out butuh minimal 2 partisipan; dataset ini punya ${subjects.length}.`);
  process.exit(1);
}
const K = classes.length;
const D = FEATURES.length;

// ── Model: softmax regression with L2, full-batch gradient descent ──────────────
const L2 = 0.01;
const STEPS = 3000;
const RATE = 0.2;

type Model = { center: number[]; scale: number[]; fill: number[]; w: number[][] }; // w[k] = [bias, ...D]

const medianOf = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function prepare(train: Sample[]) {
  const fill = FEATURES.map((_, j) => medianOf(train.flatMap((s) => (s.x[j] === null ? [] : [s.x[j] as number]))));
  const filled = (s: Sample) => s.x.map((v, j) => v ?? fill[j]);
  const rows = train.map(filled);
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

function scores(m: Model, x: number[]) {
  return softmax(m.w.map((wk) => wk[0] + x.reduce((a, v, j) => a + v * wk[j + 1], 0)));
}

function train(samples: Sample[], labels: number[]): Model {
  const norm = prepare(samples);
  const xs = samples.map((s) => standardize({ ...norm }, s));
  const w = Array.from({ length: K }, () => new Array(D + 1).fill(0));
  const model: Model = { ...norm, w };
  for (let step = 0; step < STEPS; step++) {
    const grad = Array.from({ length: K }, () => new Array(D + 1).fill(0));
    xs.forEach((x, i) => {
      const p = scores(model, x);
      for (let k = 0; k < K; k++) {
        const err = p[k] - (labels[i] === k ? 1 : 0);
        grad[k][0] += err;
        for (let j = 0; j < D; j++) grad[k][j + 1] += err * x[j];
      }
    });
    for (let k = 0; k < K; k++)
      for (let j = 0; j <= D; j++) w[k][j] -= RATE * (grad[k][j] / xs.length + (j > 0 ? L2 * w[k][j] : 0));
  }
  return model;
}

const predict = (m: Model, s: Sample) => {
  const p = scores(m, standardize(m, s));
  return p.indexOf(Math.max(...p));
};

// ── Metrics ─────────────────────────────────────────────────────────────────────
function report(name: string, pairs: Pair[]) {
  const confusion = Array.from({ length: K }, () => new Array(K + 1).fill(0)); // last column = no label
  for (const { y, p } of pairs) confusion[y][p === null ? K : p]++;
  const correct = pairs.filter((q) => q.p === q.y).length;
  const f1 = classes.map((_, k) => {
    const tp = confusion[k][k];
    const fp = confusion.reduce((a, row, y) => a + (y === k ? 0 : row[k]), 0);
    const fn = confusion[k].reduce((a, v, p) => a + (p === k ? 0 : v), 0);
    return tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
  });
  const macro = f1.reduce((a, b) => a + b, 0) / K;
  console.log(
    `${name.padEnd(34)} akurasi ${((correct / pairs.length) * 100).toFixed(1).padStart(5)}%  macro-F1 ${macro.toFixed(3)}  ` +
      `F1 per kelas ${f1.map((v, k) => `${classes[k]}:${v.toFixed(2)}`).join(" ")}  ` +
      `matriks [${confusion.map((r, k) => `${classes[k]}→${r.join("/")}`).join(" ")}]`,
  );
  return correct / pairs.length;
}

function shuffled(labels: number[], seed: number) {
  const out = [...labels];
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

type Pair = { y: number; p: number | null };
const pairs = { model: [] as Pair[], majority: [] as Pair[], rules: [] as Pair[], control: [] as Pair[] };
const perSubject = new Map<string, { hit: number; n: number }>(); // test participant → classifier hits
const videoVotes = new Map<string, { y: number; votes: number[] }>();

// Each fold: [name, training samples, test samples].
const testMark = shuffled(samples.map((_, i) => (i < Math.round(samples.length / 4) ? 1 : 0)), 7);
const folds: [string, Sample[], Sample[]][] = heldOut
  ? [["uji terpisah", samples, heldOut]]
  : split === "acak75"
    ? [["acak 75/25", samples.filter((_, i) => !testMark[i]), samples.filter((_, i) => testMark[i])]]
    : subjects.map((subject) => [subject, samples.filter((s) => s.subject !== subject), samples.filter((s) => s.subject === subject)]);

for (const [subject, trainSet, testSet] of folds) {
  const labels = trainSet.map((s) => s.y);
  const model = train(trainSet, labels);
  const control = train(trainSet, shuffled(labels, folds.findIndex((f) => f[0] === subject) + 1));
  const counts = classes.map((_, k) => labels.filter((y) => y === k).length);
  const majority = counts.indexOf(Math.max(...counts));
  for (const s of testSet) {
    const p = predict(model, s);
    const score = perSubject.get(s.subject) ?? { hit: 0, n: 0 };
    perSubject.set(s.subject, { hit: score.hit + (p === s.y ? 1 : 0), n: score.n + 1 });
    pairs.model.push({ y: s.y, p });
    pairs.majority.push({ y: s.y, p: majority });
    pairs.control.push({ y: s.y, p: predict(control, s) });
    const r = s.rules === null ? null : classes.indexOf(s.rules);
    pairs.rules.push({ y: s.y, p: r === -1 ? null : r });
    const v = videoVotes.get(s.video) ?? { y: s.y, votes: new Array(K).fill(0) };
    v.votes[p]++;
    videoVotes.set(s.video, v);
  }
}

const testSubjects = heldOut ? [...new Set(heldOut.map((s) => s.subject))].length : subjects.length;
console.log(
  (heldOut
    ? `latih ${samples.length} jendela / ${subjects.length} partisipan, uji ${heldOut.length} jendela / ${testSubjects} partisipan baru`
    : `${samples.length} jendela, ${subjects.length} partisipan, pembagian ${split}`) +
    `, kelas ${classes.join("/")}${args.includes("--tanpa-kalibrasi") ? ", tanpa jendela kalibrasi" : ""}`,
);
console.log(`fitur: ${FEATURES.join(", ")}`);
report(heldOut ? "classifier (uji terpisah)" : split === "acak75" ? "classifier (acak 75/25)" : "classifier (LOSO)", pairs.model);
report("mayoritas kelas latih", pairs.majority);
report("rules (label tampil)", pairs.rules);
report("kontrol: label latih diacak", pairs.control);
console.log(
  `per partisipan (classifier): ${[...perSubject].map(([s, v]) => `${s.split("/").pop()} ${((v.hit / v.n) * 100).toFixed(0)}% (${v.n})`).join(" · ")}`,
);
const videos = [...videoVotes.values()];
const videoHit = videos.filter((v) => v.votes.indexOf(Math.max(...v.votes)) === v.y).length;
console.log(`per video (suara terbanyak jendela): ${videoHit}/${videos.length} benar`);

if (args.includes("--koefisien")) {
  const all = train(samples, samples.map((s) => s.y));
  console.log("\nKoefisien (semua data, fitur distandardisasi):");
  classes.forEach((c, k) => console.log(`  kelas ${c.padStart(2)}: bias ${all.w[k][0].toFixed(2)} ${FEATURES.map((f, j) => `${f} ${all.w[k][j + 1].toFixed(2)}`).join(" · ")}`));
}
