// Offline model experiment (plan P20 W1.8, NOTES D-86): L2 logistic regression vs a shallow GBDT on the
// window features the app's own pipeline computes, against the rules' shown label. Input = the per-window
// rows of `scripts/rldd-robust.ts --fitur-jendela` (UTA-RLDD, clock "rata", 10/7/5 fps mixed). Nothing
// here is wired into the app. The protocol (features, grids, threshold rule, decision rule, pass criterion)
// is fixed in the constants below and was written before the first run.
//
//   node scripts/rldd-model.ts dev <jendela-dev.csv> <hasil.json>
//     development set (Fold1_part1): outer LOSO with inner LOSO, shuffled-label controls, bootstrap
//     ΔAUROC, then the frozen configuration for the locked test, written into <hasil.json>.
//   node scripts/rldd-model.ts uji <jendela-uji.csv> <hasil.json>
//     locked test (Fold1_part2), once: applies the frozen configuration from <hasil.json> and appends the
//     result; refuses when <hasil.json> already holds a locked-test result.
//   node scripts/rldd-model.ts cek
//     the instruments on synthetic data with known answers (AUROC, LR, Platt, GBDT, threshold), no files.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ── Protocol (fixed before the first run) ───────────────────────────────────────
const FPS = [10, 7, 5] as const;
const CLOCK = "rata";
const FEATURES = [
  "perclos", // time-weighted share of readable-eye time below the personal PERCLOS threshold (features.ts)
  "mata_tertutup_lama", // verified closures ≥ 1 s that ended in the window (count)
  "log2_rasio_kedip", // log2((blinks/min + 1) / (baseline blinks/min + 1)); missing below 8 fps (features.ts)
  "log2_rasio_durasi_kedip", // log2(mean blink ms / baseline blink ms); missing below 8 fps (features.ts)
  "pct_kepala_menunduk", // share of face frames with the head ≥ 15° below the calibrated pitch
  "menguap", // yawns that ended in the window (count)
] as const;
const BLINK_FEATURES = [2, 3]; // imputed with 0 (= the person's own baseline) for LR when missing
const LR_C_GRID = [0.01, 0.1, 1, 10]; // sklearn convention: minimise ½‖w‖² + C·Σ log-loss; intercept not penalised
const GBDT = { trees: 50, depth: 2, rate: 0.1, lambda: 1, minLeaf: 20 } as const; // log-loss, Newton leaves, no subsampling
const MAX_FALSE_ALARM = 0.1; // threshold = maximum sensitivity with fresh-window false alarms ≤ 10% (inner folds)
const BOOTSTRAP = { resamples: 2000, seed: 20261108, level: 0.95 } as const;
const CONTROL_SEEDS = 10; // within-subject window-label permutations
const PASS_TEXT =
  "Lulus bila model terpilih, pada 5 fps (jam rata), memberi alarm palsu jendela segar ≤ 10% DAN sensitivitas (porsi jendela " +
  "mengantuk yang dinilai positif, 6 orang digabung) ≥ sensitivitas rules (alarm = label tampil lelah ringan atau lebih berat) " +
  "pada jendela yang sama. 10 dan 7 fps dilaporkan tanpa status lulus/gagal.";

const [mode, csvPath, outPath] = process.argv.slice(2);
if (mode !== "cek" && ((mode !== "dev" && mode !== "uji") || !csvPath || !outPath)) {
  console.error("Pemakaian: node scripts/rldd-model.ts dev|uji <jendela.csv> <hasil.json> · node scripts/rldd-model.ts cek");
  process.exit(1);
}

// ── Data ────────────────────────────────────────────────────────────────────────
type Win = {
  person: string;
  fps: number;
  y: number; // 0 = RLDD class 0 (alert), 1 = class 10 (drowsy)
  x: number[]; // NaN = missing
  alarm: boolean; // the rules' shown label is "lelah ringan" or heavier (rldd-robust.ts)
  skor: number; // the rules' raw score of this evaluation (0 when it gave no label)
  level: string;
};

function load(path: string) {
  const [head, ...body] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  const at = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`${path}: kolom ${name} tidak ada`);
    return i;
  };
  const num = (v: string) => (v === "" ? NaN : Number(v));
  const all = body.map((l) => l.split(","));
  const kept = all.filter((c) => c[at("jam")] === CLOCK && (FPS as readonly number[]).includes(Number(c[at("fps")])));
  const counted = kept.filter((c) => c[at("kalibrasi")] !== "1" && (c[at("kelas")] === "0" || c[at("kelas")] === "10"));
  const coverage: Record<string, { jendela: number; dinilai: number }> = {};
  const wins: Win[] = [];
  const blinkPresent: Record<string, { jendela: number; laju: number; durasi: number }> = {};
  for (const c of counted) {
    const fps = Number(c[at("fps")]);
    const kelas = c[at("kelas")];
    const cov = (coverage[`${fps}|${kelas}`] ??= { jendela: 0, dinilai: 0 });
    cov.jendela++;
    if (c[at("dinilai")] !== "1") continue; // the quality gate: not assessable → not scored by any model
    cov.dinilai++;
    const rate = num(c[at("kedip_per_menit")]);
    const baseRate = num(c[at("base_kedip_per_menit")]);
    const dur = num(c[at("durasi_kedip_ms")]);
    const baseDur = num(c[at("base_durasi_kedip_ms")]);
    const x = [
      num(c[at("perclos")]),
      num(c[at("mata_tertutup_lama")]),
      Number.isFinite(rate) && Number.isFinite(baseRate) ? Math.log2((rate + 1) / (baseRate + 1)) : NaN,
      Number.isFinite(dur) && dur > 0 && Number.isFinite(baseDur) && baseDur > 0 ? Math.log2(dur / baseDur) : NaN,
      num(c[at("pct_kepala_menunduk")]),
      num(c[at("menguap")]),
    ];
    const bp = (blinkPresent[String(fps)] ??= { jendela: 0, laju: 0, durasi: 0 });
    bp.jendela++;
    if (Number.isFinite(x[2])) bp.laju++;
    if (Number.isFinite(x[3])) bp.durasi++;
    const skor = num(c[at("skor_mentah")]);
    wins.push({
      person: c[at("partisipan")],
      fps,
      y: kelas === "10" ? 1 : 0,
      x,
      alarm: c[at("alarm")] === "1",
      skor: Number.isFinite(skor) ? skor : 0,
      level: c[at("tingkat")],
    });
  }
  // Blink timing is the app's (features.ts: null below 8 fps); a value at 7 or 5 fps would mean a different pipeline.
  for (const f of [7, 5]) {
    const bp = blinkPresent[String(f)];
    if (bp && (bp.laju > 0 || bp.durasi > 0)) throw new Error(`fitur kedip ada di ${f} fps: bukan pipeline app sekarang`);
  }
  const missing = FEATURES.map((name, j) => ({ fitur: name, hilang: wins.filter((w) => Number.isNaN(w.x[j])).length }));
  const levels: Record<string, number> = {};
  for (const w of wins) levels[w.level] = (levels[w.level] ?? 0) + 1;
  return { wins, coverage, blinkPresent, missing, levels, subjects: [...new Set(wins.map((w) => w.person))].sort() };
}

// ── Small numeric helpers ───────────────────────────────────────────────────────
const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));
const mean = (v: readonly number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const sd = (v: readonly number[]) => (v.length < 2 ? 0 : Math.sqrt(v.reduce((a, b) => a + (b - mean(v)) ** 2, 0) / (v.length - 1)));
function medianOf(v: readonly number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(v: readonly number[], q: number): number {
  const s = [...v].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
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

// Solves A·x = b (small dense systems), Gaussian elimination with partial pivoting.
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-300) throw new Error("matriks singular");
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// AUROC = Mann–Whitney U with average ranks for ties.
function auroc(scores: readonly number[], y: readonly number[]): number {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a] - scores[b]);
  let rankPos = 0;
  let nPos = 0;
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]] === scores[idx[i]]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (y[idx[k]] === 1) (rankPos += rank), nPos++;
    i = j + 1;
  }
  const nNeg = y.length - nPos;
  return nPos === 0 || nNeg === 0 ? NaN : (rankPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

// ── Logistic regression (L2, Newton) ────────────────────────────────────────────
type Lr = { kind: "lr"; C: number; fill: number[]; center: number[]; scale: number[]; b: number; w: number[] };

function fitLr(X: readonly number[][], y: readonly number[], C: number): Lr {
  const D = FEATURES.length;
  const fill = FEATURES.map((_, j) =>
    BLINK_FEATURES.includes(j) ? 0 : medianOf(X.map((x) => x[j]).filter((v) => !Number.isNaN(v))),
  );
  const filled = X.map((x) => x.map((v, j) => (Number.isNaN(v) ? fill[j] : v)));
  const center = FEATURES.map((_, j) => mean(filled.map((r) => r[j])));
  const scale = FEATURES.map((_, j) => Math.sqrt(mean(filled.map((r) => (r[j] - center[j]) ** 2))) || 1);
  const Z = filled.map((r) => [1, ...r.map((v, j) => (v - center[j]) / scale[j])]);
  let theta = new Array<number>(D + 1).fill(0);
  const objective = (t: number[]) => {
    let loss = 0;
    for (let i = 0; i < Z.length; i++) {
      const z = Z[i].reduce((a, v, k) => a + v * t[k], 0);
      loss += Math.max(z, 0) - z * y[i] + Math.log1p(Math.exp(-Math.abs(z)));
    }
    return 0.5 * t.slice(1).reduce((a, v) => a + v * v, 0) + C * loss;
  };
  let current = objective(theta);
  for (let iter = 0; iter < 200; iter++) {
    const grad = theta.map((v, k) => (k === 0 ? 0 : v));
    const H = theta.map((_, r) => theta.map((_, c) => (r === c && r > 0 ? 1 : 0)));
    for (let i = 0; i < Z.length; i++) {
      const p = sigmoid(Z[i].reduce((a, v, k) => a + v * theta[k], 0));
      const e = C * (p - y[i]);
      const h = C * p * (1 - p);
      for (let r = 0; r <= D; r++) {
        grad[r] += e * Z[i][r];
        for (let c = 0; c <= D; c++) H[r][c] += h * Z[i][r] * Z[i][c];
      }
    }
    const step = solve(H, grad);
    let t = 1;
    let next = theta.map((v, k) => v - t * step[k]);
    let value = objective(next);
    while (value > current + 1e-12 && t > 1e-8) {
      t /= 2;
      next = theta.map((v, k) => v - t * step[k]);
      value = objective(next);
    }
    theta = next;
    const moved = Math.max(...step.map((s) => Math.abs(s * t)));
    current = value;
    if (moved < 1e-10) break;
  }
  return { kind: "lr", C, fill, center, scale, b: theta[0], w: theta.slice(1) };
}

const scoreLr = (m: Lr, x: readonly number[]) =>
  m.b + x.reduce((a, v, j) => a + (m.w[j] * ((Number.isNaN(v) ? m.fill[j] : v) - m.center[j])) / m.scale[j], 0);

// ── Shallow GBDT (log-loss, depth ≤ 2, Newton leaves, learned direction for missing values) ──
type Node = { leaf: number } | { f: number; thr: number; missLeft: boolean; left: Node; right: Node };
type Gbdt = { kind: "gbdt"; f0: number; trees: Node[] };

// order[f]: the rows with feature f present, sorted by it once per fit; a node keeps the rows it holds.
type TreeData = { X: readonly number[][]; g: readonly number[]; h: readonly number[]; order: number[][] };

function buildNode(d: TreeData, idx: number[], depth: number): Node {
  const { X, g, h } = d;
  let G = 0;
  let H = 0;
  for (const i of idx) (G += g[i]), (H += h[i]);
  const leaf: Node = { leaf: (GBDT.rate * -G) / (H + GBDT.lambda) };
  if (depth >= GBDT.depth || idx.length < 2 * GBDT.minLeaf) return leaf;
  const parent = (G * G) / (H + GBDT.lambda);
  const inNode = new Uint8Array(X.length);
  for (const i of idx) inNode[i] = 1;
  let best: { gain: number; f: number; thr: number; missLeft: boolean } | null = null;
  for (let f = 0; f < FEATURES.length; f++) {
    const present = d.order[f].filter((i) => inNode[i] === 1);
    const missing = idx.filter((i) => Number.isNaN(X[i][f]));
    let Gm = 0;
    let Hm = 0;
    for (const i of missing) (Gm += g[i]), (Hm += h[i]);
    let GL = 0;
    let HL = 0;
    for (let k = 0; k < present.length - 1; k++) {
      const i = present[k];
      GL += g[i];
      HL += h[i];
      const v = X[i][f];
      const vNext = X[present[k + 1]][f];
      if (v === vNext) continue;
      const nLeftPresent = k + 1;
      // With no missing values at this node both directions score the same: unseen missing values go to the larger side.
      const directions = missing.length > 0 ? [true, false] : [nLeftPresent >= present.length - nLeftPresent];
      for (const missLeft of directions) {
        const gl = GL + (missLeft ? Gm : 0);
        const hl = HL + (missLeft ? Hm : 0);
        const nl = nLeftPresent + (missLeft ? missing.length : 0);
        const nr = idx.length - nl;
        if (nl < GBDT.minLeaf || nr < GBDT.minLeaf) continue;
        const gr = G - gl;
        const hr = H - hl;
        const gain = (gl * gl) / (hl + GBDT.lambda) + (gr * gr) / (hr + GBDT.lambda) - parent;
        if (gain > 1e-12 && (best === null || gain > best.gain + 1e-12)) best = { gain, f, thr: (v + vNext) / 2, missLeft };
      }
    }
  }
  if (!best) return leaf;
  const b = best;
  const goesLeft = (i: number) => (Number.isNaN(X[i][b.f]) ? b.missLeft : X[i][b.f] <= b.thr);
  return {
    f: b.f,
    thr: b.thr,
    missLeft: b.missLeft,
    left: buildNode(d, idx.filter(goesLeft), depth + 1),
    right: buildNode(d, idx.filter((i) => !goesLeft(i)), depth + 1),
  };
}

function predictNode(n: Node, x: readonly number[]): number {
  if ("leaf" in n) return n.leaf;
  const v = x[n.f];
  return predictNode(Number.isNaN(v) ? (n.missLeft ? n.left : n.right) : v <= n.thr ? n.left : n.right, x);
}

function fitGbdt(X: readonly number[][], y: readonly number[]): Gbdt {
  const p0 = mean(y as number[]);
  const f0 = Math.log(p0 / (1 - p0));
  const F = y.map(() => f0);
  const idx = y.map((_, i) => i);
  const order = FEATURES.map((_, f) => idx.filter((i) => !Number.isNaN(X[i][f])).sort((a, b) => X[a][f] - X[b][f] || a - b));
  const trees: Node[] = [];
  for (let m = 0; m < GBDT.trees; m++) {
    const p = F.map(sigmoid);
    const g = p.map((pi, i) => pi - y[i]);
    const h = p.map((pi) => pi * (1 - pi));
    const tree = buildNode({ X, g, h, order }, idx, 0);
    trees.push(tree);
    for (let i = 0; i < F.length; i++) F[i] += predictNode(tree, X[i]);
  }
  return { kind: "gbdt", f0, trees };
}

const scoreGbdt = (m: Gbdt, x: readonly number[]) => m.trees.reduce((a, t) => a + predictNode(t, x), m.f0);

// ── Platt scaling (Platt 1999: smoothed targets, Newton with step halving) ──────
type Platt = { a: number; b: number };

function fitPlatt(s: readonly number[], y: readonly number[]): Platt {
  const nPos = y.filter((v) => v === 1).length;
  const nNeg = y.length - nPos;
  const target = y.map((v) => (v === 1 ? (nPos + 1) / (nPos + 2) : 1 / (nNeg + 2)));
  const loss = (a: number, b: number) =>
    s.reduce((acc, si, i) => {
      const z = a * si + b;
      return acc + Math.max(z, 0) - z * target[i] + Math.log1p(Math.exp(-Math.abs(z)));
    }, 0);
  let a = 0;
  let b = Math.log((nPos + 1) / (nNeg + 1));
  let current = loss(a, b);
  for (let iter = 0; iter < 200; iter++) {
    let ga = 0, gb = 0, haa = 1e-12, hab = 0, hbb = 1e-12;
    s.forEach((si, i) => {
      const p = sigmoid(a * si + b);
      const e = p - target[i];
      const w = p * (1 - p);
      ga += e * si;
      gb += e;
      haa += w * si * si;
      hab += w * si;
      hbb += w;
    });
    const [da, db] = solve([[haa, hab], [hab, hbb]], [ga, gb]);
    let t = 1;
    let value = loss(a - da, b - db);
    while (value > current + 1e-12 && t > 1e-8) {
      t /= 2;
      value = loss(a - t * da, b - t * db);
    }
    a -= t * da;
    b -= t * db;
    current = value;
    if (Math.max(Math.abs(t * da), Math.abs(t * db)) < 1e-10) break;
  }
  return { a, b };
}

const calibrate = (p: Platt, s: number) => sigmoid(p.a * s + p.b);

// ── Threshold: maximum sensitivity with fresh-window false alarms ≤ MAX_FALSE_ALARM ──────
// Candidates sit between consecutive distinct probabilities; among those with the highest sensitivity the one
// with the fewest false alarms wins (then the highest threshold).
function chooseThreshold(p: readonly number[], y: readonly number[]): { ambang: number; sensitivitas: number; alarm_palsu: number } {
  const values = [...new Set(p)].sort((a, b) => a - b);
  const candidates = [values[0] - 1e-9, ...values.slice(1).map((v, i) => (v + values[i]) / 2), values[values.length - 1] + 1e-9];
  const nPos = y.filter((v) => v === 1).length;
  const nNeg = y.length - nPos;
  let best = { ambang: candidates[candidates.length - 1], sensitivitas: 0, alarm_palsu: 0 };
  for (const t of candidates) {
    let tp = 0;
    let fp = 0;
    p.forEach((pi, i) => {
      if (pi >= t) y[i] === 1 ? tp++ : fp++;
    });
    const sens = tp / nPos;
    const fa = fp / nNeg;
    if (fa > MAX_FALSE_ALARM + 1e-12) continue;
    if (sens > best.sensitivitas + 1e-12 || (Math.abs(sens - best.sensitivitas) <= 1e-12 && (fa < best.alarm_palsu - 1e-12 || (Math.abs(fa - best.alarm_palsu) <= 1e-12 && t > best.ambang)))) {
      best = { ambang: t, sensitivitas: sens, alarm_palsu: fa };
    }
  }
  return best;
}

// ── One model kind through LOSO: C (LR), Platt and threshold from the out-of-fold scores of `train` ──
type Kind = "lr" | "gbdt";
type Model = Lr | Gbdt;
const fitKind = (kind: Kind, X: number[][], y: number[], C: number) => (kind === "lr" ? fitLr(X, y, C) : fitGbdt(X, y));
const scoreOf = (m: Model, x: readonly number[]) => (m.kind === "lr" ? scoreLr(m, x) : scoreGbdt(m, x));

// Out-of-fold raw scores over `rows` (leave one subject out among them).
function oofScores(kind: Kind, rows: readonly Win[], y: readonly number[], C: number): number[] {
  const out = new Array<number>(rows.length).fill(NaN);
  const subjects = [...new Set(rows.map((r) => r.person))];
  for (const s of subjects) {
    const tr = rows.map((_, i) => i).filter((i) => rows[i].person !== s);
    const te = rows.map((_, i) => i).filter((i) => rows[i].person === s);
    const m = fitKind(kind, tr.map((i) => rows[i].x), tr.map((i) => y[i]), C);
    for (const i of te) out[i] = scoreOf(m, rows[i].x);
  }
  return out;
}

type Fitted = { model: Model; C: number | null; inner_auroc: Record<string, number> | null; platt: Platt; ambang: number; inner: { sensitivitas: number; alarm_palsu: number } };

// Everything chosen from `rows` alone: C by pooled out-of-fold AUROC (ties → smaller C), Platt on the chosen
// out-of-fold scores, threshold on the calibrated out-of-fold probabilities, then the model refit on all of `rows`.
function fitWithSelection(kind: Kind, rows: readonly Win[], y: readonly number[]): Fitted {
  let C: number | null = null;
  let innerAuroc: Record<string, number> | null = null;
  let oof: number[];
  if (kind === "lr") {
    innerAuroc = {};
    let bestAuc = -Infinity;
    let bestOof: number[] = [];
    for (const c of LR_C_GRID) {
      const s = oofScores("lr", rows, y, c);
      const auc = auroc(s, y);
      innerAuroc[String(c)] = auc;
      if (auc > bestAuc + 1e-12) (bestAuc = auc), (C = c), (bestOof = s);
    }
    oof = bestOof;
  } else {
    oof = oofScores("gbdt", rows, y, 0);
  }
  const platt = fitPlatt(oof, y);
  const t = chooseThreshold(oof.map((s) => calibrate(platt, s)), y);
  const model = fitKind(kind, rows.map((r) => r.x), [...y], C ?? 0);
  return { model, C, inner_auroc: innerAuroc, platt, ambang: t.ambang, inner: { sensitivitas: t.sensitivitas, alarm_palsu: t.alarm_palsu } };
}

// Outer LOSO: per held-out subject, everything is chosen on the other subjects (inner LOSO).
function outerLoso(kind: Kind, rows: readonly Win[], y: readonly number[]) {
  const prob = new Array<number>(rows.length).fill(NaN);
  const flag = new Array<boolean>(rows.length).fill(false);
  const folds: { subjek: string; C: number | null; platt: Platt; ambang: number; inner: { sensitivitas: number; alarm_palsu: number } }[] = [];
  const subjects = [...new Set(rows.map((r) => r.person))].sort();
  for (const s of subjects) {
    const tr = rows.map((_, i) => i).filter((i) => rows[i].person !== s);
    const te = rows.map((_, i) => i).filter((i) => rows[i].person === s);
    const fitted = fitWithSelection(kind, tr.map((i) => rows[i]), tr.map((i) => y[i]));
    for (const i of te) {
      prob[i] = calibrate(fitted.platt, scoreOf(fitted.model, rows[i].x));
      flag[i] = prob[i] >= fitted.ambang;
    }
    folds.push({ subjek: s, C: fitted.C, platt: fitted.platt, ambang: fitted.ambang, inner: fitted.inner });
  }
  return { prob, flag, folds };
}

// ── Metrics ─────────────────────────────────────────────────────────────────────
type Metric = {
  jendela: { segar: number; mengantuk: number };
  auroc: number | null;
  auroc_per_subjek_rata: number | null;
  brier: number | null;
  brier_rujukan: number; // constant prediction at this group's prevalence
  sensitivitas: number;
  alarm_palsu: number;
  balanced_accuracy: number;
  sensitivitas_per_subjek: { rata: number; sd: number; nilai: Record<string, number> };
  orang_alarm_palsu: number; // people with at least one false alarm
};

function metric(rows: readonly Win[], y: readonly number[], flag: readonly boolean[], prob: readonly number[] | null, rankScore: readonly number[] | null): Metric {
  const nPos = y.filter((v) => v === 1).length;
  const nNeg = y.length - nPos;
  const tp = flag.filter((f, i) => f && y[i] === 1).length;
  const fp = flag.filter((f, i) => f && y[i] === 0).length;
  const subjects = [...new Set(rows.map((r) => r.person))].sort();
  const perSubject: Record<string, number> = {};
  const perAuc: number[] = [];
  let wronglyWarned = 0;
  for (const s of subjects) {
    const ix = rows.map((_, i) => i).filter((i) => rows[i].person === s);
    const pos = ix.filter((i) => y[i] === 1);
    perSubject[s] = pos.length > 0 ? pos.filter((i) => flag[i]).length / pos.length : NaN;
    if (ix.some((i) => y[i] === 0 && flag[i])) wronglyWarned++;
    if (rankScore) {
      const a = auroc(ix.map((i) => rankScore[i]), ix.map((i) => y[i]));
      if (!Number.isNaN(a)) perAuc.push(a);
    }
  }
  const sens = tp / nPos;
  const fa = fp / nNeg;
  const prev = nPos / y.length;
  const sensValues = Object.values(perSubject).filter((v) => !Number.isNaN(v));
  return {
    jendela: { segar: nNeg, mengantuk: nPos },
    auroc: rankScore ? auroc(rankScore, y) : null,
    auroc_per_subjek_rata: rankScore && perAuc.length > 0 ? mean(perAuc) : null,
    brier: prob ? mean(prob.map((p, i) => (p - y[i]) ** 2)) : null,
    brier_rujukan: prev * (1 - prev),
    sensitivitas: sens,
    alarm_palsu: fa,
    balanced_accuracy: (sens + (1 - fa)) / 2,
    sensitivitas_per_subjek: { rata: mean(sensValues), sd: sd(sensValues), nilai: perSubject },
    orang_alarm_palsu: wronglyWarned,
  };
}

const GROUPS = [...FPS.map(String), "gabungan"];
const inGroup = (w: Win, g: string) => g === "gabungan" || w.fps === Number(g);

function metricsByGroup(rows: readonly Win[], y: readonly number[], flag: readonly boolean[], prob: readonly number[] | null, rankScore: readonly number[] | null) {
  return Object.fromEntries(
    GROUPS.map((g) => {
      const ix = rows.map((_, i) => i).filter((i) => inGroup(rows[i], g));
      return [
        g,
        metric(
          ix.map((i) => rows[i]),
          ix.map((i) => y[i]),
          ix.map((i) => flag[i]),
          prob ? ix.map((i) => prob[i]) : null,
          rankScore ? ix.map((i) => rankScore[i]) : null,
        ),
      ];
    }),
  ) as Record<string, Metric>;
}

// ── Output helpers ──────────────────────────────────────────────────────────────
const git = (cmd: string) => {
  try {
    return execSync(`git ${cmd}`, { cwd: import.meta.dirname, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
const pct = (x: number | null) => (x === null || Number.isNaN(x) ? "  -  " : `${(x * 100).toFixed(1).padStart(5)}%`);
const f3 = (x: number | null) => (x === null || Number.isNaN(x) ? "  -  " : x.toFixed(3));
function printTable(title: string, rows: { name: string; m: Record<string, Metric> }[]) {
  console.log(`\n${title}`);
  console.log("fps       model  | segar/ngantuk | AUROC  AUROC/subj  Brier (ruj.)   | sens    alarm palsu  BA     | sens/subjek rata ± SD | orang alarm palsu");
  for (const g of GROUPS) {
    for (const r of rows) {
      const m = r.m[g];
      console.log(
        `${g.padEnd(9)} ${r.name.padEnd(6)} | ${String(m.jendela.segar).padStart(5)}/${String(m.jendela.mengantuk).padEnd(7)} | ` +
          `${f3(m.auroc)}  ${f3(m.auroc_per_subjek_rata).padStart(10)}  ${f3(m.brier)} (${m.brier_rujukan.toFixed(3)}) | ` +
          `${pct(m.sensitivitas)} ${pct(m.alarm_palsu).padStart(11)}  ${f3(m.balanced_accuracy)}  | ` +
          `${pct(m.sensitivitas_per_subjek.rata)} ± ${pct(m.sensitivitas_per_subjek.sd)}     | ${m.orang_alarm_palsu}`,
      );
    }
  }
}

// ── cek: the instruments on synthetic data with known answers (B4) ──────────────
if (mode === "cek") {
  const rand = mulberry32(42);
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const results: { cek: string; nilai: string; lulus: boolean }[] = [];
  const check = (name: string, value: string, ok: boolean) => results.push({ cek: name, nilai: value, lulus: ok });
  // AUROC: the scikit-learn documentation example (0.75); all ties → 0.5; reversed scores → 1 − AUROC.
  check("AUROC contoh sklearn", f3(auroc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1])), Math.abs(auroc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]) - 0.75) < 1e-12);
  check("AUROC semua seri", f3(auroc([1, 1, 1, 1], [0, 1, 0, 1])), auroc([1, 1, 1, 1], [0, 1, 0, 1]) === 0.5);
  check("AUROC dibalik", f3(auroc([-0.1, -0.4, -0.35, -0.8], [0, 0, 1, 1])), Math.abs(auroc([-0.1, -0.4, -0.35, -0.8], [0, 0, 1, 1]) - 0.25) < 1e-12);
  // LR: logit = 0.5 + 1·x0 − 2·x1 (x ~ N(0,1), 6 features), C large → coefficients recovered; KKT at the optimum.
  const n = 6000;
  const X = Array.from({ length: n }, () => FEATURES.map(() => normal()));
  const yl = X.map((x) => (rand() < sigmoid(0.5 + x[0] - 2 * x[1]) ? 1 : 0));
  const lrBig = fitLr(X, yl, 1e6);
  const raw = lrBig.w.map((w, j) => w / lrBig.scale[j]);
  const rawB = lrBig.b - lrBig.w.reduce((a, w, j) => a + (w * lrBig.center[j]) / lrBig.scale[j], 0);
  check("LR koefisien (0,5 / 1 / −2 / 0…)", [rawB, ...raw].map((v) => v.toFixed(2)).join(" "),
    Math.abs(rawB - 0.5) < 0.12 && Math.abs(raw[0] - 1) < 0.12 && Math.abs(raw[1] + 2) < 0.15 && raw.slice(2).every((v) => Math.abs(v) < 0.12));
  const lrSmall = fitLr(X, yl, 0.001);
  const kkt = lrSmall.w.map((w, j) => {
    let s = w;
    X.forEach((x, i) => {
      s += 0.001 * (sigmoid(scoreLr(lrSmall, x)) - yl[i]) * ((x[j] - lrSmall.center[j]) / lrSmall.scale[j]);
    });
    return Math.abs(s);
  });
  check("LR gradien nol di optimum (C=0,001)", Math.max(...kkt).toExponential(1), Math.max(...kkt) < 1e-6);
  check("LR C kecil menyusutkan bobot", `${Math.hypot(...lrSmall.w).toFixed(3)} < ${Math.hypot(...lrBig.w).toFixed(3)}`, Math.hypot(...lrSmall.w) < Math.hypot(...lrBig.w));
  // Missing blink features are imputed with 0 for LR.
  const Xm = X.map((x, i) => x.map((v, j) => (BLINK_FEATURES.includes(j) && i % 3 === 0 ? NaN : v)));
  const lrMissing = fitLr(Xm, yl, 1);
  check("LR imputasi fitur kedip = 0", lrMissing.fill.filter((_, j) => BLINK_FEATURES.includes(j)).join(","), BLINK_FEATURES.every((j) => lrMissing.fill[j] === 0));
  // Platt: y ~ Bernoulli(σ(2s − 1)) → a ≈ 2, b ≈ −1.
  const s = Array.from({ length: 20000 }, () => normal());
  const ys = s.map((v) => (rand() < sigmoid(2 * v - 1) ? 1 : 0));
  const platt = fitPlatt(s, ys);
  check("Platt a≈2 b≈−1", `${platt.a.toFixed(3)} ${platt.b.toFixed(3)}`, Math.abs(platt.a - 2) < 0.1 && Math.abs(platt.b + 1) < 0.08);
  // GBDT: y = [x0 > 0.3] with 10% noise; rows with x0 missing are mostly positive → they must score high.
  const Xg = X.map((x) => [...x]);
  const yg = Xg.map((x, i) => {
    const truth = i % 10 === 0 ? 1 : x[0] > 0.3 ? 1 : 0;
    if (i % 10 === 0) x[0] = NaN;
    return rand() < 0.1 ? 1 - truth : truth;
  });
  const gb = fitGbdt(Xg, yg);
  const gs = Xg.map((x) => scoreGbdt(gb, x));
  const logloss = (F: number[]) => mean(F.map((f, i) => Math.max(f, 0) - f * yg[i] + Math.log1p(Math.exp(-Math.abs(f)))));
  const lossFirst = logloss(Xg.map(() => gb.f0));
  const lossLast = logloss(gs);
  const depthOk = gb.trees.every((t) => {
    const depth = (nd: Node): number => ("leaf" in nd ? 0 : 1 + Math.max(depth(nd.left), depth(nd.right)));
    return depth(t) <= GBDT.depth;
  });
  const missMean = mean(gs.filter((_, i) => i % 10 === 0));
  const lowMean = mean(gs.filter((_, i) => i % 10 !== 0 && Xg[i][0] <= 0.3));
  check("GBDT AUROC dalam sampel > 0,85", f3(auroc(gs, yg)), auroc(gs, yg) > 0.85);
  check("GBDT log-loss turun", `${lossFirst.toFixed(3)} → ${lossLast.toFixed(3)}`, lossLast < lossFirst - 0.1);
  check("GBDT kedalaman ≤ 2, 50 pohon", `${gb.trees.length} pohon`, depthOk && gb.trees.length === GBDT.trees);
  check("GBDT nilai hilang mendapat skor tinggi", `${missMean.toFixed(2)} > ${lowMean.toFixed(2)}`, missMean > lowMean + 1);
  // The first split must be x0 ≈ 0.3 with the missing rows sent right (with the positives): a split that may only send
  // them left could still isolate them at the lowest x0, so the score check above cannot tell the two apart.
  const root = gb.trees[0];
  check("GBDT arah nilai hilang dipelajari (akar)", "leaf" in root ? "daun" : `f${root.f} ≤ ${root.thr.toFixed(2)} hilang→${root.missLeft ? "kiri" : "kanan"}`,
    !("leaf" in root) && root.f === 0 && Math.abs(root.thr - 0.3) < 0.1 && !root.missLeft);
  // Threshold: 10 fresh, 10 drowsy probabilities; at most 1 fresh window may be flagged. A 20% limit would catch the
  // drowsy 0.43 too (sensitivity 100%), so a looser limit fails this check.
  const pt = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.9, 0.43, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.95];
  const yt = pt.map((_, i) => (i < 10 ? 0 : 1));
  const th = chooseThreshold(pt, yt);
  check("ambang: alarm palsu ≤ 10%, sensitivitas maks", `t=${th.ambang.toFixed(3)} sens ${pct(th.sensitivitas)} fa ${pct(th.alarm_palsu)}`,
    th.alarm_palsu <= 0.1 && Math.abs(th.sensitivitas - 0.9) < 1e-12 && th.ambang > 0.45 && th.ambang <= 0.5);
  for (const r of results) console.log(`${r.lulus ? "LULUS" : "GAGAL"}  ${r.cek.padEnd(42)} ${r.nilai}`);
  const failed = results.filter((r) => !r.lulus).length;
  console.log(`${results.length - failed}/${results.length} lulus`);
  process.exit(failed > 0 ? 1 : 0);
}

const started = Date.now();
const data = load(csvPath!);
const y = data.wins.map((w) => w.y);
const rulesFlag = data.wins.map((w) => w.alarm);
const rulesScore = data.wins.map((w) => w.skor);
const dataSummary = {
  file: csvPath,
  subjek: data.subjects,
  jendela_dinilai: data.wins.length,
  cakupan: Object.fromEntries(
    Object.entries(data.coverage).map(([k, v]) => [k, { ...v, porsi: v.dinilai / v.jendela }]),
  ),
  fitur_kedip_ada: data.blinkPresent,
  fitur_hilang: data.missing,
  tingkat_kualitas: data.levels,
  kelas_5: "dibuang (rldd-robust.ts hanya menjalankan kelas 0 dan 10)",
};

if (mode === "dev") {
  if (existsSync(outPath)) {
    const old = JSON.parse(readFileSync(outPath, "utf8")) as { uji_terkunci?: unknown };
    if (old.uji_terkunci) {
      console.error(`${outPath} sudah memuat hasil uji terkunci; dev tidak ditulis ulang.`);
      process.exit(1);
    }
  }
  console.log(`dev: ${data.subjects.length} subjek, ${data.wins.length} jendela dinilai (${CLOCK}, ${FPS.join("/")} fps)`);
  console.log(`cakupan (dinilai/jendela): ${Object.entries(dataSummary.cakupan).map(([k, v]) => `${k} ${v.dinilai}/${v.jendela}`).join(" · ")}`);
  console.log(`fitur hilang: ${data.missing.map((m) => `${m.fitur} ${m.hilang}`).join(" · ")}`);

  // Main run.
  const lr = outerLoso("lr", data.wins, y);
  const gb = outerLoso("gbdt", data.wins, y);
  const result = {
    lr: { lipatan: lr.folds, metrik: metricsByGroup(data.wins, y, lr.flag, lr.prob, lr.prob) },
    gbdt: { lipatan: gb.folds, metrik: metricsByGroup(data.wins, y, gb.flag, gb.prob, gb.prob) },
    rules: { metrik: metricsByGroup(data.wins, y, rulesFlag, null, rulesScore) },
  };
  printTable("Set pengembangan (LOSO luar, 6 subjek; rules: AUROC dari skor mentah rules, keputusan = label tampil)", [
    { name: "LR", m: result.lr.metrik },
    { name: "GBDT", m: result.gbdt.metrik },
    { name: "rules", m: result.rules.metrik },
  ]);
  console.log(`\nLR per lipatan: ${lr.folds.map((f) => `${f.subjek.split("/").pop()} C=${f.C} a=${f.platt.a.toFixed(2)} b=${f.platt.b.toFixed(2)} t=${f.ambang.toFixed(3)}`).join(" · ")}`);
  console.log(`GBDT per lipatan: ${gb.folds.map((f) => `${f.subjek.split("/").pop()} a=${f.platt.a.toFixed(2)} b=${f.platt.b.toFixed(2)} t=${f.ambang.toFixed(3)}`).join(" · ")}`);

  // Negative control 1 (primary): labels permuted among each subject's own windows, CONTROL_SEEDS seeds.
  const permuted = (seed: number) => {
    const rand = mulberry32(seed);
    const out = [...y];
    for (const s of data.subjects) {
      const ix = data.wins.map((_, i) => i).filter((i) => data.wins[i].person === s);
      for (let k = ix.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        [out[ix[k]], out[ix[j]]] = [out[ix[j]], out[ix[k]]];
      }
    }
    return out;
  };
  const windowControl = { lr: [] as number[], gbdt: [] as number[], lr_ba: [] as number[], gbdt_ba: [] as number[] };
  for (let seed = 1; seed <= CONTROL_SEEDS; seed++) {
    const yp = permuted(seed);
    const a = outerLoso("lr", data.wins, yp);
    const b = outerLoso("gbdt", data.wins, yp);
    windowControl.lr.push(auroc(a.prob, yp));
    windowControl.gbdt.push(auroc(b.prob, yp));
    windowControl.lr_ba.push(metric(data.wins, yp, a.flag, a.prob, a.prob).balanced_accuracy);
    windowControl.gbdt_ba.push(metric(data.wins, yp, b.flag, b.prob, b.prob).balanced_accuracy);
  }
  // Negative control 2: which video of a subject is called "drowsy", every one of the 2^n patterns. Not a clean null for a
  // trained model (swapping every subject keeps the signal learnable: that pattern scores like the true one), reported as a
  // permutation distribution with p = share of patterns at or above the observed AUROC.
  const nSub = data.subjects.length;
  const swapControl = { lr: [] as number[], gbdt: [] as number[] };
  for (let pattern = 0; pattern < 2 ** nSub; pattern++) {
    const ys = data.wins.map((w) => ((pattern >> data.subjects.indexOf(w.person)) & 1 ? 1 - w.y : w.y));
    swapControl.lr.push(auroc(outerLoso("lr", data.wins, ys).prob, ys));
    swapControl.gbdt.push(auroc(outerLoso("gbdt", data.wins, ys).prob, ys));
  }
  const summary = (v: number[]) => ({ rata: mean(v), sd: sd(v), min: Math.min(...v), maks: Math.max(...v) });
  const observed = { lr: result.lr.metrik.gabungan.auroc!, gbdt: result.gbdt.metrik.gabungan.auroc! };
  const control = {
    acak_jendela_dalam_subjek: {
      cara: `label diacak di antara jendela tiap subjek sendiri (jumlah kelas per subjek tetap), seed 1..${CONTROL_SEEDS}, pipeline bersarang penuh`,
      lr_auroc: summary(windowControl.lr),
      gbdt_auroc: summary(windowControl.gbdt),
      lr_balanced_accuracy: summary(windowControl.lr_ba),
      gbdt_balanced_accuracy: summary(windowControl.gbdt_ba),
      nilai: windowControl,
    },
    tukar_video_per_subjek: {
      cara: `video mana yang disebut mengantuk ditukar per subjek, semua ${2 ** nSub} pola, pipeline bersarang penuh`,
      lr_auroc: { ...summary(swapControl.lr), p: swapControl.lr.filter((a) => a >= observed.lr - 1e-12).length / swapControl.lr.length },
      gbdt_auroc: { ...summary(swapControl.gbdt), p: swapControl.gbdt.filter((a) => a >= observed.gbdt - 1e-12).length / swapControl.gbdt.length },
      nilai: swapControl,
    },
  };
  const ctl = control.acak_jendela_dalam_subjek;
  console.log(
    `\nKontrol 1 (label diacak dalam subjek, ${CONTROL_SEEDS} seed): AUROC LR ${ctl.lr_auroc.rata.toFixed(3)} ± ${ctl.lr_auroc.sd.toFixed(3)} ` +
      `[${ctl.lr_auroc.min.toFixed(3)}–${ctl.lr_auroc.maks.toFixed(3)}] · GBDT ${ctl.gbdt_auroc.rata.toFixed(3)} ± ${ctl.gbdt_auroc.sd.toFixed(3)} ` +
      `[${ctl.gbdt_auroc.min.toFixed(3)}–${ctl.gbdt_auroc.maks.toFixed(3)}] · BA LR ${ctl.lr_balanced_accuracy.rata.toFixed(3)} GBDT ${ctl.gbdt_balanced_accuracy.rata.toFixed(3)}`,
  );
  const sw = control.tukar_video_per_subjek;
  console.log(
    `Kontrol 2 (tukar video per subjek, ${2 ** nSub} pola): AUROC LR ${sw.lr_auroc.rata.toFixed(3)} ± ${sw.lr_auroc.sd.toFixed(3)} ` +
      `[${sw.lr_auroc.min.toFixed(3)}–${sw.lr_auroc.maks.toFixed(3)}] p=${sw.lr_auroc.p.toFixed(4)} · GBDT ${sw.gbdt_auroc.rata.toFixed(3)} ± ` +
      `${sw.gbdt_auroc.sd.toFixed(3)} [${sw.gbdt_auroc.min.toFixed(3)}–${sw.gbdt_auroc.maks.toFixed(3)}] p=${sw.gbdt_auroc.p.toFixed(4)}`,
  );

  // Bootstrap over subjects: ΔAUROC = GBDT − LR on the outer out-of-fold probabilities.
  const rand = mulberry32(BOOTSTRAP.seed);
  const bySubject = data.subjects.map((s) => data.wins.map((_, i) => i).filter((i) => data.wins[i].person === s));
  const deltas: Record<string, number[]> = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (let r = 0; r < BOOTSTRAP.resamples; r++) {
    const pick = data.subjects.map(() => bySubject[Math.floor(rand() * nSub)]).flat();
    for (const g of GROUPS) {
      const ix = pick.filter((i) => inGroup(data.wins[i], g));
      const yy = ix.map((i) => y[i]);
      deltas[g].push(auroc(ix.map((i) => gb.prob[i]), yy) - auroc(ix.map((i) => lr.prob[i]), yy));
    }
  }
  const alpha = (1 - BOOTSTRAP.level) / 2;
  const bootstrap = Object.fromEntries(
    GROUPS.map((g) => [
      g,
      {
        delta_teramati: result.gbdt.metrik[g].auroc! - result.lr.metrik[g].auroc!,
        ci: [quantile(deltas[g], alpha), quantile(deltas[g], 1 - alpha)],
        resampel: BOOTSTRAP.resamples,
      },
    ]),
  );
  console.log("\nBootstrap per subjek, ΔAUROC = GBDT − LR (95%, 2000 resampel):");
  for (const g of GROUPS) {
    const b = bootstrap[g];
    console.log(`  ${g.padEnd(9)} Δ ${b.delta_teramati.toFixed(3)}  CI [${b.ci[0].toFixed(3)}, ${b.ci[1].toFixed(3)}]`);
  }
  const primary = bootstrap.gabungan;
  const gbdtWins = primary.ci[0] > 0;
  const chosen: Kind = gbdtWins ? "gbdt" : "lr";
  const decision = {
    aturan: "D-86: GBDT hanya bila CI bootstrap per subjek (95%, ≥ 2000 resampel) untuk ΔAUROC (GBDT − LR) tidak memuat 0 dan berada di atas 0; kelompok utama = gabungan 10/7/5 fps",
    ci_gabungan: primary.ci,
    terpilih: chosen,
  };
  console.log(`Keputusan aturan D-86: CI gabungan [${primary.ci[0].toFixed(3)}, ${primary.ci[1].toFixed(3)}] → model terpilih: ${chosen.toUpperCase()}`);

  // Frozen configuration for the locked test: the chosen kind with everything selected on all 6 development subjects.
  const frozenFit = fitWithSelection(chosen, data.wins, y);
  const frozen = {
    model: chosen,
    fitur: FEATURES,
    imputasi_lr: "fitur kedip (log2 rasio laju, log2 rasio durasi) hilang → 0 (= baseline orang itu); fitur lain hilang → median data latih",
    C: frozenFit.C,
    auroc_dalam_per_C: frozenFit.inner_auroc,
    platt: frozenFit.platt,
    ambang: frozenFit.ambang,
    ambang_pada_oof_dev: frozenFit.inner,
    gbdt_parameter: chosen === "gbdt" ? GBDT : null,
    parameter_model: frozenFit.model,
    dilatih_pada: `${data.subjects.join(", ")} (${data.wins.length} jendela, ${CLOCK}, ${FPS.join("/")} fps)`,
    kriteria_lulus: PASS_TEXT,
    catatan_data_uji:
      "Fold1_part2 pernah dipakai: (1) uji terkunci P04 (D-48, model fitur kedipan yang lain), (2) harness rules W1.7 (tanpa pelatihan). " +
      "Belum pernah dipakai untuk melatih atau memilih model ini.",
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(frozen)).digest("hex");
  if (chosen === "lr") {
    const m = frozenFit.model as Lr;
    console.log(
      `\nKonfigurasi beku: LR C=${m.C}, Platt a=${frozenFit.platt.a.toFixed(4)} b=${frozenFit.platt.b.toFixed(4)}, ambang ${frozenFit.ambang.toFixed(4)} ` +
        `(OOF dev: sens ${pct(frozenFit.inner.sensitivitas)}, alarm palsu ${pct(frozenFit.inner.alarm_palsu)})`,
    );
    console.log(`  bobot (terstandardisasi): bias ${m.b.toFixed(3)} · ${FEATURES.map((f, j) => `${f} ${m.w[j].toFixed(3)}`).join(" · ")}`);
  } else {
    console.log(
      `\nKonfigurasi beku: GBDT ${GBDT.trees} pohon, kedalaman ${GBDT.depth}, Platt a=${frozenFit.platt.a.toFixed(4)} b=${frozenFit.platt.b.toFixed(4)}, ` +
        `ambang ${frozenFit.ambang.toFixed(4)} (OOF dev: sens ${pct(frozenFit.inner.sensitivitas)}, alarm palsu ${pct(frozenFit.inner.alarm_palsu)})`,
    );
  }
  console.log(`  sidik jari sha256: ${fingerprint}`);

  const output = {
    nama: "w18-model",
    dibuat: new Date().toISOString(),
    kode: { commit: git("rev-parse --short HEAD"), berubah_belum_commit: git("status --porcelain -- ../scripts ../src") },
    protokol: {
      jam: CLOCK,
      fps: FPS,
      fitur: FEATURES,
      label: "kelas RLDD 0 (segar) = 0, kelas 10 (mengantuk) = 1; kelas 5 dibuang; jendela kelas 0 yang menyentuh 5 menit kalibrasi dibuang (rldd-robust.ts)",
      gerbang_kualitas: "jendela dengan dinilai = 0 (tingkat tampil 'tidak-dinilai', rldd-robust.ts) tidak dinilai model mana pun; cakupan dilaporkan",
      lr: { grid_C: LR_C_GRID, konvensi: "½‖w‖² + C·Σ log-loss, intercept tidak dipenalti, fitur distandardisasi pada data latih", pilih_C: "AUROC OOF gabungan LOSO dalam tertinggi, seri → C terkecil" },
      gbdt: GBDT,
      platt: "Platt 1999 (target dihaluskan), dipasang pada skor mentah OOF LOSO dalam",
      ambang: `sensitivitas maksimum dengan alarm palsu jendela segar ≤ ${MAX_FALSE_ALARM * 100}% pada probabilitas OOF terkalibrasi LOSO dalam; seri → alarm palsu terkecil`,
      rules: "keputusan = alarm rldd-robust.ts (label tampil lelah ringan/lelah/tertidur, bukan basi); AUROC dari skor mentah evaluasi itu (0 bila tanpa label)",
      bootstrap: BOOTSTRAP,
      kontrol_seed: CONTROL_SEEDS,
    },
    dev: { data: dataSummary, hasil: result, kontrol: control, bootstrap, keputusan_d86: decision },
    beku: { ...frozen, sidik_jari_sha256: fingerprint, ditulis: new Date().toISOString() },
    uji_terkunci: null,
  };
  writeFileSync(outPath, JSON.stringify(output, null, 1) + "\n");
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} dtk → ${outPath}`);
} else {
  // ── Locked test, once ─────────────────────────────────────────────────────────
  type Saved = { beku: Record<string, unknown> & { sidik_jari_sha256: string; model: Kind; platt: Platt; ambang: number; parameter_model: Model }; dev: { data: { subjek: string[] } }; uji_terkunci: unknown };
  const saved = JSON.parse(readFileSync(outPath, "utf8")) as Saved;
  if (saved.uji_terkunci) {
    console.error(`${outPath} sudah memuat hasil uji terkunci: uji hanya dijalankan sekali.`);
    process.exit(1);
  }
  const { sidik_jari_sha256: fingerprint, ditulis: _written, ...frozen } = saved.beku;
  const recomputed = createHash("sha256").update(JSON.stringify(frozen)).digest("hex");
  if (recomputed !== fingerprint) {
    console.error("Sidik jari konfigurasi beku tidak cocok: konfigurasi berubah sesudah dev.");
    process.exit(1);
  }
  const overlap = data.subjects.filter((s) => saved.dev.data.subjek.includes(s));
  if (overlap.length > 0) {
    console.error(`Data uji memuat subjek set pengembangan: ${overlap.join(", ")}`);
    process.exit(1);
  }
  const model = saved.beku.parameter_model;
  const prob = data.wins.map((w) => calibrate(saved.beku.platt, scoreOf(model, w.x)));
  const flag = prob.map((p) => p >= saved.beku.ambang);
  const chosen = metricsByGroup(data.wins, y, flag, prob, prob);
  const rules = metricsByGroup(data.wins, y, rulesFlag, null, rulesScore);
  const m5 = chosen["5"];
  const r5 = rules["5"];
  const pass = {
    alarm_palsu_5fps: { nilai: m5.alarm_palsu, batas: MAX_FALSE_ALARM, lulus: m5.alarm_palsu <= MAX_FALSE_ALARM + 1e-12 },
    sensitivitas_5fps: { nilai: m5.sensitivitas, rules: r5.sensitivitas, lulus: m5.sensitivitas >= r5.sensitivitas - 1e-12 },
  };
  const passed = pass.alarm_palsu_5fps.lulus && pass.sensitivitas_5fps.lulus;
  console.log(`uji terkunci: ${data.subjects.length} subjek (${data.subjects.join(", ")}), ${data.wins.length} jendela dinilai; model beku ${saved.beku.model.toUpperCase()} (sidik jari cocok)`);
  console.log(`cakupan (dinilai/jendela): ${Object.entries(dataSummary.cakupan).map(([k, v]) => `${k} ${v.dinilai}/${v.jendela}`).join(" · ")}`);
  printTable("Uji terkunci (konfigurasi beku, dijalankan sekali)", [
    { name: saved.beku.model.toUpperCase(), m: chosen },
    { name: "rules", m: rules },
  ]);
  console.log(
    `\nKriteria: alarm palsu 5 fps ${pct(m5.alarm_palsu)} ≤ 10% → ${pass.alarm_palsu_5fps.lulus ? "LULUS" : "GAGAL"} · ` +
      `sensitivitas 5 fps ${pct(m5.sensitivitas)} ≥ rules ${pct(r5.sensitivitas)} → ${pass.sensitivitas_5fps.lulus ? "LULUS" : "GAGAL"} · ` +
      `keseluruhan ${passed ? "LULUS" : "GAGAL"}`,
  );
  saved.uji_terkunci = {
    dijalankan: new Date().toISOString(),
    kode: { commit: git("rev-parse --short HEAD"), berubah_belum_commit: git("status --porcelain -- ../scripts ../src") },
    data: dataSummary,
    sidik_jari_dipakai: fingerprint,
    hasil: { model: chosen, rules },
    kriteria: pass,
    lulus: passed,
  };
  writeFileSync(outPath, JSON.stringify(saved, null, 1) + "\n");
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} dtk → ${outPath}`);
}
