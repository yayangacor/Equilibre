import "./style.css";
import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { toAnswerView, type AnalyzeResponse } from "./answer.ts";
import {
  afterFailedSend,
  AUTO_SEND,
  autoTarget,
  initialAutoSendState,
  loadAutoSend,
  saveAutoSend,
  stepAutoSend,
  type AutoTarget,
} from "./autoSend.ts";
import { bodyPresent, toBodySample, type BodyGrid, type BodySample } from "./body.ts";
import {
  computeBaseline,
  loadBaseline,
  looksClosed,
  median,
  saveBaseline,
  type Baseline,
  type KeyValueStore,
} from "./calibration.ts";
import { downloadFile, fileStamp } from "./download.ts";
import { createDetectors, segmentBody, type Detectors } from "./face.ts";
import {
  breakEnded,
  eyesReadable,
  headDown,
  initialBreakState,
  minutesSinceBreak,
  stepBreak,
  type BreakState,
  type WindowFeatures,
} from "./features.ts";
import { toBreakRecord, toEvaluationRecord, toRecommendationRecord } from "./history.ts";
import { DB_NAME } from "./historyDb.ts";
import { HistoryPanel } from "./historyPanel.ts";
import { Monitor, type EvaluationStep } from "./monitor.ts";
import { toAnalyzePayload, type AnalyzePayload } from "./payload.ts";
import {
  detectIntervalMs,
  initialPowerState,
  isLowBattery,
  loadPowerChoice,
  LOW_BATTERY,
  NORMAL_INTERVAL_MS,
  onBattery,
  onToggle,
  powerReason,
  SAVING_INTERVAL_MS,
  savePowerChoice,
  type PowerReason,
  type PowerState,
} from "./powerSaving.ts";
import { ADVICE, RULES, SLEEP, type Evaluation } from "./rules.ts";
import { SelfReport } from "./selfReport.ts";
import { framesToCsv } from "./sessionLog.ts";
import { LEFT_EYE, matrixLayout, RIGHT_EYE, toFrameSignal, type FrameSignal } from "./signals.ts";

// ── Config. Dev shortcuts: ?calib=30&window=20&tidur=1&debug=1 · test: ?uji=1&riwayat=uji ──

const params = new URLSearchParams(location.search);
function numberParam(name: string, fallback: number, min: number, max: number): number {
  const value = Number(params.get(name));
  return params.has(name) && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

const WINDOW_MS = numberParam("window", 60, 10, 600) * 1000;
const EVAL_INTERVAL_MS = 10_000;
const FEATURES_REFRESH_MS = 1_000;
const CALIB_CLOSED_MS = 3_000;
// Stage A records only once the eyes are actually closed, so a slow reaction or
// closing early during the countdown no longer puts open-eye frames in the sample.
const CALIB_CONFIRM_CLOSED_FRAMES = 3;
const CALIB_WAIT_CLOSED_MS = 8_000;
const CALIB_NORMAL_MS = numberParam("calib", 300, 10, 1800) * 1000;
const BODY_INTERVAL_MS = 500; // body presence changes slowly; ±2×/second is plenty
// Minutes of closed eyes before "tertidur" (twice that with the eyes hidden). ?tidur=1 makes it demo-able.
const TIDUR_MENIT = numberParam("tidur", SLEEP.eyesClosedMinutes, 0.5, 30);
const DEBUG = params.get("debug") === "1";
// ?riwayat=uji keeps the history in its own database (checks, demos), away from the real one.
const HISTORY_SUFFIX = params.get("riwayat")?.match(/^[a-z0-9-]{1,20}$/)?.[0];
const HISTORY_DB = HISTORY_SUFFIX ? `${DB_NAME}-${HISTORY_SUFFIX}` : DB_NAME;
// ?uji=1: user test mode (P08), a KSS reminder every 15 minutes.
const TEST_MODE = params.get("uji") === "1";
// ?kamera=0: the page without camera and models (automated checks, screenshots of the history).
const NO_CAMERA = params.get("kamera") === "0";
const DASHBOARD_REFRESH_MS = 30_000;
const KSS_CHECK_MS = 15_000;
const MAX_LOG_FRAMES = 3 * 60 * 60 * 10; // 3 h at 10 fps, then the oldest frames are dropped
const MAX_LOG_BODIES = MAX_LOG_FRAMES / 5;

// ── DOM ─────────────────────────────────────────────────────────────────────────

type FaceState = "loading" | "found" | "missing" | "error";

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = byId<HTMLVideoElement>("video");
const overlay = byId<HTMLCanvasElement>("overlay");
const faceStatus = byId("face-status");
const cameraPrompt = byId("camera-prompt");
const fpsOutput = byId("fps");
const delegateOutput = byId("delegate");
const labelBadge = byId("label");
const labelMeta = byId("label-meta");
const reasonList = byId("reasons");
const pendingNote = byId("pending");
const longRestNote = byId("long-rest");
const calibStatus = byId("calib-status");
const calibProgress = byId("calib-progress");
const calibButton = byId<HTMLButtonElement>("calib-button");
const baselineList = byId("baseline");
const payloadPre = byId("payload");
const sendButton = byId<HTMLButtonElement>("send-status");
const sendNote = byId("send-note");
const answer = byId("answer");
const powerToggle = byId<HTMLInputElement>("power-saving");
const powerNote = byId("power-note");
const autoSendToggle = byId<HTMLInputElement>("auto-send");
const autoSendNote = byId("auto-send-note");

function el(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

// A <dt>/<dd> row; `fraction` (0–1) drives the optional bar.
function metricRow(list: HTMLElement, name: string, withBar = false) {
  const value = el("output", "–");
  const dd = document.createElement("dd");
  const bar = document.createElement("span");
  if (withBar) {
    const track = document.createElement("div");
    track.className = "bar";
    track.append(bar);
    dd.append(track);
  }
  dd.append(value);
  const row = document.createElement("div");
  row.className = "metric";
  row.append(el("dt", name), dd);
  list.append(row);
  return (text: string, fraction = 0) => {
    value.textContent = text;
    bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  };
}

const fmt = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const fmt2 = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt3 = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const show = (x: number | null | undefined, format: (v: number) => string) =>
  x === null || x === undefined || !Number.isFinite(x) ? "–" : format(x);
const asPct = (x: number) => `${fmt.format(x * 100)}%`;
const asDeg = (x: number) => `${fmt.format(x)}°`;
const clock = (d: Date) => d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const signalsList = byId("signals");
const signalRows = {
  earLeft: metricRow(signalsList, "EAR kiri", true),
  earRight: metricRow(signalsList, "EAR kanan", true),
  ear: metricRow(signalsList, "EAR rata-rata", true),
  pitch: metricRow(signalsList, "pitch absolut"),
  pitchRel: metricRow(signalsList, "pitch relatif"),
  jawOpen: metricRow(signalsList, "jawOpen", true),
  blinkLeft: metricRow(signalsList, "eyeBlinkLeft", true),
  blinkRight: metricRow(signalsList, "eyeBlinkRight", true),
  lookDown: metricRow(signalsList, "eyeLookDown", true),
  eyes: metricRow(signalsList, "Mata dinilai?"),
  bodyArea: metricRow(signalsList, "Tubuh (luas mask)", true),
  bodyMotion: metricRow(signalsList, "Gerak tubuh"),
};

const featuresList = byId("features");
const featureRows = {
  perclos: metricRow(featuresList, "Mata tertutup (PERCLOS)"),
  kedip: metricRow(featuresList, "Kedip per menit"),
  durasi: metricRow(featuresList, "Durasi kedip rata-rata"),
  lama: metricRow(featuresList, "Mata terpejam ≥1 detik"),
  menguap: metricRow(featuresList, "Menguap"),
  menunduk: metricRow(featuresList, "Kepala menunduk"),
  hilang: metricRow(featuresList, "Wajah tidak terdeteksi"),
  terbuka: metricRow(featuresList, "Mata terlihat terbuka"),
  terpejam: metricRow(featuresList, "Mata terlihat terpejam"),
  tubuh: metricRow(featuresList, "Tubuh terdeteksi"),
  diam: metricRow(featuresList, "Tubuh diam"),
  gerak: metricRow(featuresList, "Gerak tubuh (median)"),
  menitLelah: metricRow(featuresList, `Menit "lelah"/"tertidur" (${ADVICE.historyMinutes} menit)`),
  frame: metricRow(featuresList, "Jumlah frame"),
};

// ── State ───────────────────────────────────────────────────────────────────────

function openStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null; // storage blocked: calibration still works, it just isn't remembered
  }
}
const store = openStore();

type CalibrationRun = {
  phase: "countdown" | "waiting" | "closed" | "normal";
  open: FrameSignal[]; // countdown frames: eyes open, the reference for "closed"
  openRef: number;
  closedStreak: number;
  closed: FrameSignal[];
  normal: FrameSignal[];
  normalBodies: BodySample[];
  cancelled: boolean;
};

let baseline: Baseline | null = store ? loadBaseline(store) : null;
let calibration: CalibrationRun | null = null;
let detecting = false;
let bodyDetection = false; // the segmenter loaded

// Rolling window + label (only while calibrated and not calibrating).
let monitor: Monitor | null = null;
let latest: Evaluation | null = null;
let hold: string | null = null;
let menitLelah = 0;
let saran: string | null = null;
let features: WindowFeatures | null = null;
let lastEvalT = 0;
let lastFeaturesT = 0;

// Detection rate (hemat daya). Every change goes into the session log header.
let power: PowerState = initialPowerState(store ? loadPowerChoice(store) : false);
let batteryLevel: number | null = null; // null = Battery Status API not available (Chromium only)
const powerLog: { t_ms: number; sebab: PowerReason }[] = [{ t_ms: 0, sebab: powerReason(power) }];

let breakState: BreakState | null = null;

// Local history (IndexedDB). The pipeline clock is performance.now(); records use the wall clock.
const SESSION = Math.round(performance.timeOrigin);
const wallClock = (t: number) => Math.round(performance.timeOrigin + t);

const sessionLog: FrameSignal[] = [];
const bodyLog: BodySample[] = [];
let sending = false;

// Automatic sending (NOTES D-37): off unless switched on, remembered on this device.
let autoSendOn = store ? loadAutoSend(store) : false;
let autoState = initialAutoSendState();
let lastAuto: { t: number; target: AutoTarget; ok: boolean | null } | null = null;

function resetWindow(t: number) {
  monitor = baseline
    ? new Monitor(baseline, { windowMs: WINDOW_MS, evalIntervalMs: EVAL_INTERVAL_MS, tidurMenit: TIDUR_MENIT })
    : null;
  latest = null;
  hold = null;
  menitLelah = 0;
  saran = null;
  features = null;
  lastEvalT = t;
  lastFeaturesT = t;
}

// ── Per-frame pipeline ──────────────────────────────────────────────────────────

function onFrame(s: FrameSignal) {
  sessionLog.push(s);
  if (sessionLog.length > MAX_LOG_FRAMES + 1000) sessionLog.splice(0, 1000);
  const prevBreak = breakState;
  breakState = prevBreak ? stepBreak(prevBreak, s.t, s.face) : initialBreakState(s.t);
  const ended = prevBreak && breakEnded(prevBreak, breakState);
  if (ended) panel.save("jeda", toBreakRecord({ mulai: wallClock(ended.mulai), selesai: wallClock(ended.selesai) }, SESSION));

  if (calibration) {
    const run = calibration;
    if (run.phase === "countdown") run.open.push(s);
    if (run.phase === "waiting") run.closedStreak = looksClosed(s, run.openRef) ? run.closedStreak + 1 : 0;
    if (run.phase === "closed") run.closed.push(s);
    if (run.phase === "normal") run.normal.push(s);
    return;
  }
  if (!monitor) return;

  monitor.pushFrame(s);
  if (s.t - lastFeaturesT >= FEATURES_REFRESH_MS) {
    lastFeaturesT = s.t;
    features = monitor.features(s.t);
    menitLelah = monitor.menitLelah(s.t);
    renderFeatures();
  }
  if (s.t - lastEvalT >= EVAL_INTERVAL_MS) {
    lastEvalT = s.t;
    const step = monitor.evaluate(s.t);
    ({ latest, hold, menitLelah, saran } = step);
    recordEvaluation(step, s.t);
    renderStatus();
    renderPayload();
    maybeAutoSend();
  }
}

function maybeAutoSend() {
  const target = autoTarget(monitor?.labelState.shown?.label ?? null, saran !== null);
  const step = stepAutoSend(autoState, target, Date.now(), autoSendOn && !sending);
  autoState = step.state;
  if (!step.send || target === null) return;
  lastAuto = { t: Date.now(), target, ok: null };
  renderAutoSend();
  void sendStatus("otomatis");
}

// ── Local history + what the user tells back ────────────────────────────────────

const panel = new HistoryPanel(EVAL_INTERVAL_MS);
const selfReport = new SelfReport({
  panel,
  session: SESSION,
  shown: () => (calibration ? null : (monitor?.labelState.shown ?? null)),
  testMode: TEST_MODE,
  beep: reminderBeep,
});

function recordEvaluation(step: EvaluationStep, t: number) {
  const shown = monitor?.labelState.shown;
  if (!shown || !breakState) return;
  panel.save(
    "evaluasi",
    toEvaluationRecord(shown, step, {
      t: wallClock(t),
      sesi: SESSION,
      menitSejakJeda: minutesSinceBreak(breakState, t),
      hematDaya: powerReason(power) !== null,
    }),
  );
}

// Runs in the same tick as onFrame for that frame, just before it.
function onBody(b: BodySample) {
  bodyLog.push(b);
  if (bodyLog.length > MAX_LOG_BODIES + 200) bodyLog.splice(0, 200);
  if (calibration?.phase === "normal") calibration.normalBodies.push(b);
  else if (!calibration) monitor?.pushBody(b);
}

// ── Rendering ───────────────────────────────────────────────────────────────────

function setFaceStatus(state: FaceState, text: string) {
  faceStatus.dataset.state = state;
  faceStatus.textContent = text;
}

function renderSignals(s: FrameSignal) {
  setFaceStatus(s.face ? "found" : "missing", s.face ? "Wajah terdeteksi" : "Wajah tidak terdeteksi");
  const ear = (x: number) => show(x, (v) => fmt3.format(v));
  signalRows.earLeft(ear(s.earLeft), s.earLeft / 0.5);
  signalRows.earRight(ear(s.earRight), s.earRight / 0.5);
  signalRows.ear(ear(s.ear), s.ear / 0.5);
  signalRows.pitch(show(s.pitchDeg, asDeg));
  signalRows.pitchRel(baseline ? show(s.pitchDeg - baseline.pitchDeg, asDeg) : "belum kalibrasi");
  const score = (x: number) => show(x, (v) => fmt2.format(v));
  signalRows.jawOpen(score(s.jawOpen), s.jawOpen);
  signalRows.blinkLeft(score(s.blinkLeft), s.blinkLeft);
  signalRows.blinkRight(score(s.blinkRight), s.blinkRight);
  signalRows.lookDown(score(s.lookDown), s.lookDown);
  signalRows.eyes(
    !baseline
      ? "belum kalibrasi"
      : eyesReadable(s, baseline)
        ? "ya"
        : !s.face
          ? "tidak (wajah hilang)"
          : headDown(s, baseline)
            ? "tidak (menunduk)"
            : "tidak",
  );
}

function renderBody(b: BodySample) {
  const present = bodyPresent(b, baseline?.bodyArea ?? null);
  signalRows.bodyArea(`${asPct(b.area)} · ${present ? "ada orang" : "kosong"}`, b.area);
  signalRows.bodyMotion(show(b.motion, (v) => fmt3.format(v)));
}

function renderFeatures() {
  const f = features;
  byId("window-title").textContent = `${WINDOW_MS / 1000} detik terakhir`;
  featureRows.perclos(show(f?.perclos, asPct));
  featureRows.kedip(show(f?.kedip_per_menit, (v) => fmt.format(v)));
  featureRows.durasi(show(f?.durasi_kedip_ms, (v) => `${Math.round(v)} ms`));
  featureRows.lama(f ? `${f.mata_tertutup_lama}×` : "–");
  featureRows.menguap(f ? String(f.menguap) : "–");
  featureRows.menunduk(show(f?.pct_kepala_menunduk, asPct));
  featureRows.hilang(show(f?.pct_wajah_hilang, asPct));
  featureRows.terbuka(show(f?.pct_mata_terbuka, asPct));
  featureRows.terpejam(show(f?.pct_mata_tertutup, asPct));
  featureRows.tubuh(bodyDetection ? show(f?.pct_tubuh_ada, asPct) : "nonaktif (model gagal dimuat)");
  featureRows.diam(show(f?.pct_tubuh_diam, asPct));
  featureRows.gerak(show(f?.gerak_tubuh, (v) => fmt3.format(v)));
  featureRows.menitLelah(monitor ? fmt.format(menitLelah) : "–");
  featureRows.frame(f ? `${f.n_frame} (data ${Math.round(f.durasi_jendela_detik)} detik)` : "–");
}

function setLabel(text: string, label = "none") {
  labelBadge.textContent = text;
  labelBadge.dataset.label = label;
}

function renderStatus() {
  reasonList.replaceChildren();
  pendingNote.hidden = true;
  longRestNote.hidden = saran === null || calibration !== null;
  longRestNote.textContent = saran ?? "";
  labelMeta.textContent = "";
  selfReport.renderCorrection(calibration ? null : (monitor?.labelState.shown ?? null));

  if (calibration) {
    setLabel("Kalibrasi…");
    labelMeta.textContent = "Label dihitung lagi setelah kalibrasi selesai.";
    return;
  }
  if (!baseline) {
    setLabel("Belum dikalibrasi");
    labelMeta.textContent = "Kalibrasi dulu supaya Equilibre mengenal kondisi normalmu.";
    return;
  }
  const labelState = monitor?.labelState;
  const shown = labelState?.shown;
  if (!labelState || !shown) {
    setLabel("Menganalisis…");
    labelMeta.textContent = hold ?? `Label pertama muncul sekitar ${EVAL_INTERVAL_MS / 1000} detik setelah kamera berjalan.`;
    return;
  }

  setLabel(shown.label, shown.label);
  labelMeta.textContent = `Skor ${fmt2.format(shown.skor)} · dievaluasi ${clock(new Date())} · tiap ${EVAL_INTERVAL_MS / 1000} detik`;
  if (shown.alasan.length === 0) {
    reasonList.append(el("li", shown.label === "normal" ? "Tidak ada tanda kelelahan di jendela ini." : "–"));
  }
  for (const reason of shown.alasan) reasonList.append(el("li", reason));
  for (const note of shown.catatan) reasonList.append(el("li", note, "muted"));

  if (hold) {
    pendingNote.hidden = false;
    pendingNote.textContent = hold;
  } else if (labelState.candidate && latest) {
    pendingNote.hidden = false;
    pendingNote.textContent =
      `Evaluasi terakhir: "${labelState.candidate}" (${labelState.streak}/${RULES.confirmEvaluations}). ` +
      `Label berganti kalau hasil ini muncul lagi. ${latest.alasan.join(" ")}`;
  }
}

function currentPayload() {
  const shown = monitor?.labelState.shown;
  if (!shown || !features || !breakState) return null;
  return toAnalyzePayload(shown, features, minutesSinceBreak(breakState, performance.now()), menitLelah);
}

// The server answers 422 for "tidak di depan layar" (nothing to recommend while away),
// so the button does not offer it.
const notSent = (payload: AnalyzePayload | null) => payload?.label === "tidak di depan layar";

function renderPayload() {
  const payload = currentPayload();
  payloadPre.textContent = payload ? JSON.stringify(payload, null, 2) : "Belum ada status.";
  sendButton.disabled = payload === null || sending || notSent(payload);
  sendNote.hidden = !notSent(payload);
}

function renderBaseline() {
  baselineList.hidden = !baseline;
  baselineList.replaceChildren();
  if (!baseline) return;
  const b = baseline;
  const rows: [string, string][] = [
    ["EAR mata terbuka", fmt3.format(b.earOpen)],
    ["EAR mata terpejam", fmt3.format(b.earClosed)],
    ["Kedip per menit", fmt.format(b.blinkPerMin)],
    ["Durasi kedip", b.blinkDurationMs === null ? "tidak ada kedip terekam" : `${Math.round(b.blinkDurationMs)} ms`],
    ["Pitch normal", asDeg(b.pitchDeg)],
    ["jawOpen P95", fmt2.format(b.jawOpenP95)],
    ["Luas tubuh normal", b.bodyArea === null ? "belum ada (kalibrasi ulang)" : asPct(b.bodyArea)],
    ["Dibuat", new Date(b.createdAt).toLocaleString("id-ID")],
  ];
  for (const [name, value] of rows) metricRow(baselineList, name)(value);
}

function renderCalibrationIdle(message?: string, isError = false) {
  calibProgress.hidden = true;
  cameraPrompt.hidden = true;
  calibButton.textContent = baseline ? "Kalibrasi ulang" : "Mulai kalibrasi";
  calibButton.disabled = !detecting;
  calibStatus.dataset.state = isError ? "error" : "";
  calibStatus.textContent =
    message ??
    (baseline
      ? baseline.bodyArea === null && bodyDetection
        ? "Baseline ini dibuat sebelum ada deteksi tubuh. Kalibrasi ulang supaya Equilibre juga mengenal posisi dudukmu."
        : "Baseline tersimpan di perangkat ini. Kalibrasi ulang kalau posisi duduk, kacamata, atau pencahayaan berubah."
      : `Kalibrasi ±${Math.round((CALIB_NORMAL_MS + CALIB_CLOSED_MS) / 1000) + 4} detik: pejamkan mata sebentar, lalu bekerja seperti biasa.`);
  renderBaseline();
}

// ── Debug overlay (?debug=1) ────────────────────────────────────────────────────

let lastMatrixRender = 0;
function renderDebug(result: FaceLandmarkerResult, grid: BodyGrid | null) {
  if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
  const ctx = overlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (grid) {
    // The coarse person mask the body features are computed from.
    const w = overlay.width / grid.cols;
    const h = overlay.height / grid.rows;
    ctx.fillStyle = "#7c5cff";
    for (let i = 0; i < grid.cells.length; i++) {
      ctx.globalAlpha = 0.35 * grid.cells[i];
      ctx.fillRect((i % grid.cols) * w, Math.floor(i / grid.cols) * h, w, h);
    }
    ctx.globalAlpha = 1;
  }
  const landmarks = result.faceLandmarks[0];
  if (landmarks) {
    const eyes: [readonly number[], string][] = [
      [RIGHT_EYE, "#ff4d6d"],
      [LEFT_EYE, "#4dd2ff"],
    ];
    for (const [indices, color] of eyes) {
      const p = indices.map((i) => ({ x: landmarks[i].x * overlay.width, y: landmarks[i].y * overlay.height }));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [a, b] of [
        [0, 3],
        [1, 5],
        [2, 4],
      ]) {
        ctx.moveTo(p[a].x, p[a].y);
        ctx.lineTo(p[b].x, p[b].y);
      }
      ctx.stroke();
      ctx.fillStyle = color;
      for (const { x, y } of p) {
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const now = performance.now();
  const matrix = result.facialTransformationMatrixes[0];
  if (matrix && now - lastMatrixRender > 250) {
    lastMatrixRender = now;
    byId("matrix-layout").textContent = matrixLayout(matrix.data);
    const rows = [0, 1, 2, 3].map((r) =>
      matrix.data
        .slice(r * 4, r * 4 + 4)
        .map((v) => v.toFixed(3).padStart(9))
        .join(" "),
    );
    byId("matrix").textContent = `data[0..15], 4 per baris:\n${rows.join("\n")}`;
  }
}

// ── Camera + detection loop ─────────────────────────────────────────────────────

async function startCamera() {
  video.srcObject = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" },
    audio: false,
  });
  await video.play();
}

function cameraErrorMessage(err: unknown): string {
  switch ((err as DOMException)?.name) {
    case "NotAllowedError":
      return "Izin kamera ditolak. Izinkan kamera di pengaturan browser, lalu muat ulang halaman.";
    case "NotFoundError":
      return "Kamera tidak ditemukan.";
    case "NotReadableError":
      return "Kamera sedang dipakai aplikasi lain.";
    default:
      return "Kamera tidak bisa dinyalakan.";
  }
}

function runDetection({ landmarker, segmenter }: Detectors) {
  let lastVideoTime = -1;
  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  let lastBodyT = -Infinity;
  let grid: BodyGrid | null = null;

  const tick = () => {
    const now = performance.now();
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = landmarker.detectForVideo(video, now);
      if (segmenter && now - lastBodyT >= BODY_INTERVAL_MS) {
        lastBodyT = now;
        const next = segmentBody(segmenter, video, now);
        if (next) {
          const body = toBodySample(next, grid, now);
          grid = next;
          onBody(body);
          renderBody(body);
        }
      }
      const signal = toFrameSignal(result, video.videoWidth, video.videoHeight, now);
      onFrame(signal);
      renderSignals(signal);
      if (DEBUG) renderDebug(result, grid);
      fpsFrames++;
    }
    if (now - fpsWindowStart >= 1000) {
      fpsOutput.textContent = ((fpsFrames * 1000) / (now - fpsWindowStart)).toFixed(1);
      fpsFrames = 0;
      fpsWindowStart = now;
    }
    setTimeout(tick, Math.max(0, detectIntervalMs(power, calibration !== null) - (performance.now() - now)));
  };
  tick();
}

// ── Power saving (hemat daya) ───────────────────────────────────────────────────

function renderPower() {
  const reason = powerReason(power);
  powerToggle.checked = reason !== null;
  const battery = batteryLevel === null ? "" : `baterai ${asPct(batteryLevel)}`;
  powerNote.textContent =
    reason === "baterai"
      ? `Aktif otomatis: ${battery} dan tidak sedang diisi. Deteksi ±5 fps, kalibrasi tetap ±10 fps.`
      : reason === "pilihan"
        ? "Deteksi ±5 fps: baterai lebih awet, tapi sebagian kedip singkat tidak terbaca. Kalibrasi tetap ±10 fps."
        : power.dismissed
          ? `Dimatikan (${battery}). Tidak menyala otomatis lagi sampai baterai diisi.`
          : batteryLevel !== null
            ? `Deteksi ±10 fps. Menyala otomatis saat baterai di bawah ${asPct(LOW_BATTERY)} dan tidak diisi.`
            : "Deteksi ±10 fps.";
}

function setPower(next: PowerState) {
  const before = powerReason(power);
  power = next;
  const reason = powerReason(power);
  if (reason !== before) powerLog.push({ t_ms: Math.round(performance.now() * 10) / 10, sebab: reason });
  renderPower();
}

powerToggle.addEventListener("change", () => {
  setPower(onToggle(power, powerToggle.checked));
  if (store) savePowerChoice(store, power.chosen);
});

// Battery Status API: Chromium only, and it may be blocked by a permissions policy.
// Without it the toggle is simply manual.
type BatteryInfo = EventTarget & { level: number; charging: boolean };

async function watchBattery() {
  const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryInfo> };
  if (!nav.getBattery) return;
  try {
    const battery = await nav.getBattery();
    const update = () => {
      batteryLevel = battery.level;
      setPower(onBattery(power, isLowBattery(battery.level, battery.charging)));
    };
    battery.addEventListener("levelchange", update);
    battery.addEventListener("chargingchange", update);
    update();
  } catch (err) {
    console.warn("Status baterai tidak tersedia; hemat daya hanya manual.", err);
  }
}

// ── Calibration ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Short ticks during the countdown double as a sound check, so the user can
// trust the final (long, higher) beep instead of peeking at the screen.
function tone(audio: AudioContext, frequency: number, seconds: number) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const t = audio.currentTime;
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.3, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + seconds);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + seconds);
}

// KSS reminder in test mode. Before the first click on the page the browser may keep it
// silent; the highlighted panel is the reminder then.
function reminderBeep() {
  try {
    const audio = new AudioContext();
    tone(audio, 660, 0.25);
    setTimeout(() => void audio.close(), 1000);
  } catch {
    // no audio output: nothing else to do
  }
}

function setCalibStatus(text: string) {
  calibStatus.dataset.state = "";
  calibStatus.textContent = text;
}

async function runCalibration() {
  const run: CalibrationRun = {
    phase: "countdown",
    open: [],
    openRef: NaN,
    closedStreak: 0,
    closed: [],
    normal: [],
    normalBodies: [],
    cancelled: false,
  };
  calibration = run;
  // Created inside the click handler, so the browser lets it play the beep.
  const audio = new AudioContext();
  calibButton.textContent = "Batalkan kalibrasi";
  renderStatus();

  let outcome: { message: string; isError: boolean } | undefined;
  try {
    cameraPrompt.hidden = false;
    for (const n of [3, 2, 1]) {
      setCalibStatus(
        `Tahap 1 dari 2: lihat ke layar dengan mata terbuka. Saat hitungan habis, pejamkan mata ` +
          `dan tahan sampai terdengar bunyi beep panjang (±3 detik). ${n}…`,
      );
      cameraPrompt.textContent = String(n);
      tone(audio, 440, 0.08);
      await sleep(1000);
      if (run.cancelled) return;
    }

    run.openRef = median(run.open.filter((f) => f.face && Number.isFinite(f.ear)).map((f) => f.ear));
    run.phase = "waiting";
    setCalibStatus("Tahap 1 dari 2: pejamkan mata dan tahan sampai terdengar bunyi beep panjang.");
    cameraPrompt.textContent = "Pejamkan mata";
    const waitStart = performance.now();
    while (run.closedStreak < CALIB_CONFIRM_CLOSED_FRAMES) {
      if (run.cancelled) return;
      if (performance.now() - waitStart > CALIB_WAIT_CLOSED_MS) {
        tone(audio, 220, 0.6);
        outcome = {
          message:
            `Mata tidak terdeteksi terpejam dalam ${CALIB_WAIT_CLOSED_MS / 1000} detik setelah aba-aba. ` +
            "Ulangi, pastikan wajah terlihat jelas, lalu pejamkan mata saat hitungan habis.",
          isError: true,
        };
        return;
      }
      await sleep(50);
    }

    run.phase = "closed";
    await sleep(CALIB_CLOSED_MS);
    if (run.cancelled) return;
    tone(audio, 880, 0.6);

    run.phase = "normal";
    cameraPrompt.hidden = true;
    calibProgress.hidden = false;
    const bar = calibProgress.querySelector("span")!;
    const start = performance.now();
    for (let elapsed = 0; elapsed < CALIB_NORMAL_MS; elapsed = performance.now() - start) {
      if (run.cancelled) return;
      bar.style.width = `${(elapsed / CALIB_NORMAL_MS) * 100}%`;
      setCalibStatus(
        `Tahap 2 dari 2: buka mata dan bekerja seperti biasa di depan kamera. ` +
          `Biarkan tab ini tetap terlihat. Sisa ${Math.ceil((CALIB_NORMAL_MS - elapsed) / 1000)} detik.`,
      );
      await sleep(500);
    }

    const result = computeBaseline(run.closed, run.normal, Date.now(), run.normalBodies);
    if (!result.ok) {
      outcome = { message: result.error, isError: true };
      return;
    }
    baseline = result.baseline;
    const saved = store !== null && saveBaseline(store, baseline);
    resetWindow(performance.now());
    outcome = {
      message: saved
        ? "Kalibrasi selesai dan tersimpan di perangkat ini."
        : "Kalibrasi selesai, tapi tidak bisa disimpan (penyimpanan browser diblokir). Kalibrasi perlu diulang setelah halaman dimuat ulang.",
      isError: !saved,
    };
  } finally {
    calibration = null;
    void audio.close();
    renderCalibrationIdle(outcome?.message ?? (run.cancelled ? "Kalibrasi dibatalkan." : undefined), outcome?.isError);
    renderStatus();
  }
}

calibButton.addEventListener("click", () => {
  if (calibration) {
    calibration.cancelled = true;
    calibButton.disabled = true; // re-enabled once the run notices the cancel
    return;
  }
  void runCalibration();
});

// ── Session log + Langflow ──────────────────────────────────────────────────────

byId("download-log").addEventListener("click", () => {
  const started = new Date(performance.timeOrigin);
  const csv = framesToCsv(sessionLog, bodyLog, performance.timeOrigin, [
    `Equilibre log sesi, halaman dibuka ${started.toISOString()}`,
    `window_ms=${WINDOW_MS} eval_interval_ms=${EVAL_INTERVAL_MS} detect_interval_ms=${NORMAL_INTERVAL_MS} ` +
      `hemat_daya_interval_ms=${SAVING_INTERVAL_MS} body_interval_ms=${bodyDetection ? BODY_INTERVAL_MS : 0} ` +
      `tidur_menit=${TIDUR_MENIT}`,
    // When power saving was on (sebab not null) or off (null); calibration always ran at detect_interval_ms.
    `hemat_daya=${JSON.stringify(powerLog)}`,
    `baseline=${JSON.stringify(baseline)}`,
  ]);
  downloadFile(csv, `equilibre-sesi-${fileStamp(new Date())}.csv`, "text/csv");
});

function renderAnswer(reply: AnalyzeResponse) {
  const view = toAnswerView(reply);
  const parts: HTMLElement[] = [];
  if (view.kind === "text") parts.push(el("p", view.text));
  else {
    const list = document.createElement("dl");
    for (const [name, value] of view.rows) list.append(el("dt", name), el("dd", value));
    if (view.sumber) {
      const sources = document.createElement("dd");
      if (view.sumber.length === 0) sources.textContent = "tidak ada sumber yang dipakai";
      else {
        const items = document.createElement("ul");
        items.className = "sources";
        items.append(...view.sumber.map((s) => el("li", s.text, s.known ? undefined : "error")));
        sources.append(items);
      }
      list.append(el("dt", "Sumber"), sources);
    }
    parts.push(list);
  }
  if (view.cadangan) parts.push(el("p", "Dijawab model cadangan karena model utama gagal.", "note"));
  answer.replaceChildren(...parts);
}

// ── Automatic sending (NOTES D-37) ──────────────────────────────────────────────

const minuteClock = (t: number) => new Date(t).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

function renderAutoSend() {
  autoSendToggle.checked = autoSendOn;
  const rule =
    "saat label menjadi lelah ringan, lelah, atau tertidur, atau saat saran istirahat panjang muncul, " +
    `paling sering 1× per ${AUTO_SEND.minGapMs / 60_000} menit; tertidur dan saran istirahat panjang boleh ` +
    "menyela sekali. Tiap kiriman memakai satu panggilan LLM.";
  if (!autoSendOn) {
    autoSendNote.textContent = `Mati: status hanya dikirim lewat tombol di bawah. Kalau dinyalakan, status dikirim sendiri ${rule}`;
    return;
  }
  const last =
    lastAuto === null
      ? ""
      : ` Terakhir ${minuteClock(lastAuto.t)} (${lastAuto.target}): ` +
        (lastAuto.ok === null
          ? "menunggu jawaban."
          : lastAuto.ok
            ? "terkirim."
            : `gagal, dicoba lagi paling cepat ${minuteClock(lastAuto.t + AUTO_SEND.minGapMs)}.`);
  autoSendNote.textContent = `Menyala: status dikirim sendiri ${rule}${last}`;
}

autoSendToggle.addEventListener("change", () => {
  autoSendOn = autoSendToggle.checked;
  if (store) saveAutoSend(store, autoSendOn);
  renderAutoSend();
});

// How an automatic send ended. A failure lets the same condition be tried after the gap.
function autoSendDone(ok: boolean) {
  if (!ok) autoState = afterFailedSend(autoState);
  if (lastAuto) lastAuto.ok = ok;
  renderAutoSend();
}

// A reply is stored with the payload's label, and its feedback buttons appear under it.
async function sendStatus(pemicu: "manual" | "otomatis") {
  const payload = currentPayload();
  if (!payload || notSent(payload)) {
    if (pemicu === "otomatis") autoSendDone(false);
    return;
  }
  payloadPre.textContent = JSON.stringify(payload, null, 2);
  sending = true;
  sendButton.disabled = true;
  answer.replaceChildren(el("p", pemicu === "otomatis" ? "Dikirim otomatis, menunggu jawaban Langflow…" : "Menunggu jawaban Langflow…", "muted"));
  selfReport.showRecommendation(null);
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error ?? `Backend tidak menjawab (HTTP ${res.status}). Pastikan server sudah jalan.`);
    }
    const reply = body as AnalyzeResponse;
    renderAnswer(reply);
    if (pemicu === "otomatis") autoSendDone(true);
    const context = { t: Date.now(), sesi: SESSION, pemicu, label: payload.label };
    selfReport.showRecommendation(await panel.add("rekomendasi", toRecommendationRecord(reply, context)));
  } catch (err) {
    const message = err instanceof TypeError ? "Tidak bisa menghubungi backend." : (err as Error).message;
    answer.replaceChildren(el("p", pemicu === "otomatis" ? `Kirim otomatis gagal: ${message}` : message, "error"));
    if (pemicu === "otomatis") autoSendDone(false);
  } finally {
    sending = false;
    renderPayload();
  }
}
sendButton.addEventListener("click", () => void sendStatus("manual"));

// ── Start ───────────────────────────────────────────────────────────────────────

async function main() {
  overlay.hidden = !DEBUG;
  byId("debug").hidden = !DEBUG;
  renderFeatures();
  renderStatus();
  renderCalibrationIdle();
  renderPower();
  renderAutoSend();
  void watchBattery();
  // The history shows even when the camera or the model fails below.
  void panel.open(HISTORY_DB).then(() => selfReport.restoreKssClock());
  setInterval(() => void panel.refresh(), DASHBOARD_REFRESH_MS);
  if (TEST_MODE) setInterval(() => selfReport.tick(Date.now()), KSS_CHECK_MS);
  if (NO_CAMERA) {
    setFaceStatus("error", "Kamera tidak dinyalakan (?kamera=0).");
    return;
  }

  const [camera, model] = await Promise.allSettled([startCamera(), createDetectors()]);
  if (camera.status === "rejected") {
    console.error(camera.reason);
    setFaceStatus("error", cameraErrorMessage(camera.reason));
    return;
  }
  if (model.status === "rejected") {
    console.error(model.reason);
    setFaceStatus("error", "Model MediaPipe gagal dimuat. Muat ulang halaman; kalau tetap gagal, jalankan ulang npm run dev (file WASM disalin saat itu).");
    return;
  }

  bodyDetection = model.value.segmenter !== null;
  delegateOutput.textContent = `${model.value.delegate} · tubuh ${bodyDetection ? "CPU" : "nonaktif"}`;
  resetWindow(performance.now());
  detecting = true;
  renderCalibrationIdle();
  renderFeatures();
  runDetection(model.value);
}

void main();
