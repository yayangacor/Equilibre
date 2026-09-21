import "./style.css";
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { initialBlinkState, stepBlink, type EyeClosure } from "./blink.ts";
import {
  blinkThreshold,
  computeBaseline,
  loadBaseline,
  looksClosed,
  median,
  saveBaseline,
  type Baseline,
  type KeyValueStore,
} from "./calibration.ts";
import { createFaceLandmarker } from "./face.ts";
import {
  computeWindowFeatures,
  initialBreakState,
  minutesSinceBreak,
  stepBreak,
  type BreakState,
  type WindowFeatures,
} from "./features.ts";
import { toAnalyzePayload } from "./payload.ts";
import { evaluate, initialLabelState, RULES, type Evaluation, type LabelState } from "./rules.ts";
import { framesToCsv } from "./sessionLog.ts";
import { LEFT_EYE, matrixLayout, RIGHT_EYE, toFrameSignal, type FrameSignal } from "./signals.ts";
import { initialYawnState, stepYawn, type YawnEvent } from "./yawn.ts";

// ── Config. Dev shortcuts: ?calib=30&window=20&debug=1 ──────────────────────────

const params = new URLSearchParams(location.search);
function numberParam(name: string, fallback: number, min: number, max: number): number {
  const value = Number(params.get(name));
  return params.has(name) && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

const DETECT_INTERVAL_MS = 100; // ±10 fps: enough to catch blinks, easy on laptop batteries
const WINDOW_MS = numberParam("window", 60, 10, 600) * 1000;
const EVAL_INTERVAL_MS = 10_000;
const FEATURES_REFRESH_MS = 1_000;
const CALIB_CLOSED_MS = 3_000;
// Stage A records only once the eyes are actually closed, so a slow reaction or
// closing early during the countdown no longer puts open-eye frames in the sample.
const CALIB_CONFIRM_CLOSED_FRAMES = 3;
const CALIB_WAIT_CLOSED_MS = 8_000;
const CALIB_NORMAL_MS = numberParam("calib", 300, 10, 1800) * 1000;
const DEBUG = params.get("debug") === "1";
const MAX_LOG_FRAMES = 3 * 60 * 60 * 10; // 3 h at 10 fps, then the oldest frames are dropped

// ── DOM ─────────────────────────────────────────────────────────────────────────

type FaceState = "loading" | "found" | "missing" | "error";
type AnalyzeResponse = { text: string; result: unknown };

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
const calibStatus = byId("calib-status");
const calibProgress = byId("calib-progress");
const calibButton = byId<HTMLButtonElement>("calib-button");
const baselineList = byId("baseline");
const payloadPre = byId("payload");
const sendButton = byId<HTMLButtonElement>("send-status");
const answer = byId("answer");

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
};

const featuresList = byId("features");
const featureRows = {
  perclos: metricRow(featuresList, "Mata tertutup (PERCLOS)"),
  kedip: metricRow(featuresList, "Kedip per menit"),
  durasi: metricRow(featuresList, "Durasi kedip rata-rata"),
  menguap: metricRow(featuresList, "Menguap"),
  menunduk: metricRow(featuresList, "Kepala menunduk"),
  hilang: metricRow(featuresList, "Wajah tidak terdeteksi"),
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
  cancelled: boolean;
};

let baseline: Baseline | null = store ? loadBaseline(store) : null;
let calibration: CalibrationRun | null = null;
let detecting = false;

// Rolling window (only while calibrated and not calibrating).
let frames: FrameSignal[] = [];
let closures: EyeClosure[] = [];
let yawns: YawnEvent[] = [];
let blinkState = initialBlinkState();
let yawnState = initialYawnState();
let labelState: LabelState = initialLabelState();
let latest: Evaluation | null = null;
let features: WindowFeatures | null = null;
let lastEvalT = 0;
let lastFeaturesT = 0;

let breakState: BreakState | null = null;
const sessionLog: FrameSignal[] = [];
let sending = false;

function resetWindow(t: number) {
  frames = [];
  closures = [];
  yawns = [];
  blinkState = initialBlinkState();
  yawnState = initialYawnState();
  labelState = initialLabelState();
  latest = null;
  features = null;
  lastEvalT = t;
  lastFeaturesT = t;
}

function dropBefore<T>(list: T[], cutoff: number, time: (item: T) => number) {
  let n = 0;
  while (n < list.length && time(list[n]) <= cutoff) n++;
  if (n > 0) list.splice(0, n);
}

// ── Per-frame pipeline ──────────────────────────────────────────────────────────

function onFrame(s: FrameSignal) {
  sessionLog.push(s);
  if (sessionLog.length > MAX_LOG_FRAMES + 1000) sessionLog.splice(0, 1000);
  breakState = breakState ? stepBreak(breakState, s.t, s.face) : initialBreakState(s.t);

  if (calibration) {
    const run = calibration;
    if (run.phase === "countdown") run.open.push(s);
    if (run.phase === "waiting") run.closedStreak = looksClosed(s, run.openRef) ? run.closedStreak + 1 : 0;
    if (run.phase === "closed") run.closed.push(s);
    if (run.phase === "normal") run.normal.push(s);
    return;
  }
  if (!baseline) return;

  frames.push(s);
  const blink = stepBlink(blinkState, s.t, s.ear, blinkThreshold(baseline), s.face);
  blinkState = blink.state;
  if (blink.event) closures.push(blink.event);
  const yawn = stepYawn(yawnState, s.t, s.jawOpen, s.face);
  yawnState = yawn.state;
  if (yawn.event) yawns.push(yawn.event);

  const cutoff = s.t - WINDOW_MS;
  dropBefore(frames, cutoff, (f) => f.t);
  dropBefore(closures, cutoff, (c) => c.endT);
  dropBefore(yawns, cutoff, (y) => y.endT);

  if (s.t - lastFeaturesT >= FEATURES_REFRESH_MS) {
    lastFeaturesT = s.t;
    features = computeWindowFeatures(frames, closures, yawns, baseline, s.t, WINDOW_MS);
    renderFeatures();
  }
  if (s.t - lastEvalT >= EVAL_INTERVAL_MS) {
    lastEvalT = s.t;
    const current = computeWindowFeatures(frames, closures, yawns, baseline, s.t, WINDOW_MS);
    const result = evaluate(current, baseline, labelState);
    labelState = result.state;
    latest = result.latest;
    renderStatus();
    renderPayload();
  }
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
}

function renderFeatures() {
  const f = features;
  byId("window-title").textContent = `${WINDOW_MS / 1000} detik terakhir`;
  featureRows.perclos(show(f?.perclos, asPct));
  featureRows.kedip(show(f?.kedip_per_menit, (v) => fmt.format(v)));
  featureRows.durasi(show(f?.durasi_kedip_ms, (v) => `${Math.round(v)} ms`));
  featureRows.menguap(f ? String(f.menguap) : "–");
  featureRows.menunduk(show(f?.pct_kepala_menunduk, asPct));
  featureRows.hilang(show(f?.pct_wajah_hilang, asPct));
  featureRows.frame(f ? `${f.n_frame} (data ${Math.round(f.durasi_jendela_detik)} detik)` : "–");
}

function setLabel(text: string, label = "none") {
  labelBadge.textContent = text;
  labelBadge.dataset.label = label;
}

function renderStatus() {
  reasonList.replaceChildren();
  pendingNote.hidden = true;
  labelMeta.textContent = "";

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
  const shown = labelState.shown;
  if (!shown) {
    setLabel("Menganalisis…");
    labelMeta.textContent = `Label pertama muncul sekitar ${EVAL_INTERVAL_MS / 1000} detik setelah kamera berjalan.`;
    return;
  }

  setLabel(shown.label, shown.label);
  labelMeta.textContent = `Skor ${fmt2.format(shown.skor)} · dievaluasi ${clock(new Date())} · tiap ${EVAL_INTERVAL_MS / 1000} detik`;
  if (shown.alasan.length === 0) {
    reasonList.append(el("li", shown.label === "normal" ? "Tidak ada tanda kelelahan di jendela ini." : "–"));
  }
  for (const reason of shown.alasan) reasonList.append(el("li", reason));

  if (labelState.candidate && latest) {
    pendingNote.hidden = false;
    pendingNote.textContent =
      `Evaluasi terakhir: "${labelState.candidate}" (${labelState.streak}/${RULES.confirmEvaluations}). ` +
      `Label berganti kalau hasil ini muncul lagi. ${latest.alasan.join(" ")}`;
  }
}

function currentPayload() {
  if (!labelState.shown || !features || !breakState) return null;
  return toAnalyzePayload(labelState.shown, features, minutesSinceBreak(breakState, performance.now()));
}

function renderPayload() {
  const payload = currentPayload();
  payloadPre.textContent = payload ? JSON.stringify(payload, null, 2) : "Belum ada status.";
  sendButton.disabled = payload === null || sending;
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
      ? "Baseline tersimpan di perangkat ini. Kalibrasi ulang kalau posisi duduk, kacamata, atau pencahayaan berubah."
      : `Kalibrasi ±${Math.round((CALIB_NORMAL_MS + CALIB_CLOSED_MS) / 1000) + 4} detik: pejamkan mata sebentar, lalu bekerja seperti biasa.`);
  renderBaseline();
}

// ── Debug overlay (?debug=1) ────────────────────────────────────────────────────

let lastMatrixRender = 0;
function renderDebug(result: FaceLandmarkerResult) {
  if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
  const ctx = overlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
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

function runDetection(landmarker: FaceLandmarker) {
  let lastVideoTime = -1;
  let fpsFrames = 0;
  let fpsWindowStart = performance.now();

  const tick = () => {
    const now = performance.now();
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = landmarker.detectForVideo(video, now);
      const signal = toFrameSignal(result, video.videoWidth, video.videoHeight, now);
      onFrame(signal);
      renderSignals(signal);
      if (DEBUG) renderDebug(result);
      fpsFrames++;
    }
    if (now - fpsWindowStart >= 1000) {
      fpsOutput.textContent = ((fpsFrames * 1000) / (now - fpsWindowStart)).toFixed(1);
      fpsFrames = 0;
      fpsWindowStart = now;
    }
    setTimeout(tick, Math.max(0, DETECT_INTERVAL_MS - (performance.now() - now)));
  };
  tick();
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

    const result = computeBaseline(run.closed, run.normal, Date.now());
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
  const csv = framesToCsv(sessionLog, performance.timeOrigin, [
    `Equilibre log sesi, halaman dibuka ${started.toISOString()}`,
    `window_ms=${WINDOW_MS} eval_interval_ms=${EVAL_INTERVAL_MS} detect_interval_ms=${DETECT_INTERVAL_MS}`,
    `baseline=${JSON.stringify(baseline)}`,
  ]);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const link = document.createElement("a");
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-` +
    `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  link.href = url;
  link.download = `equilibre-sesi-${stamp}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function renderAnswer({ text, result }: AnalyzeResponse) {
  if (result === null || typeof result !== "object") {
    answer.replaceChildren(el("p", text));
    return;
  }
  const list = document.createElement("dl");
  for (const [key, value] of Object.entries(result)) {
    list.append(el("dt", key), el("dd", typeof value === "string" ? value : JSON.stringify(value)));
  }
  answer.replaceChildren(list);
}

// Manual only: the LLM budget is small, automatic sending comes on 28 Sep.
async function sendStatus() {
  const payload = currentPayload();
  if (!payload) return;
  payloadPre.textContent = JSON.stringify(payload, null, 2);
  sending = true;
  sendButton.disabled = true;
  answer.replaceChildren(el("p", "Menunggu jawaban Langflow…", "muted"));
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
    renderAnswer(body as AnalyzeResponse);
  } catch (err) {
    const message = err instanceof TypeError ? "Tidak bisa menghubungi backend." : (err as Error).message;
    answer.replaceChildren(el("p", message, "error"));
  } finally {
    sending = false;
    sendButton.disabled = false;
  }
}
sendButton.addEventListener("click", sendStatus);

// ── Start ───────────────────────────────────────────────────────────────────────

async function main() {
  overlay.hidden = !DEBUG;
  byId("debug").hidden = !DEBUG;
  renderFeatures();
  renderStatus();
  renderCalibrationIdle();

  const [camera, model] = await Promise.allSettled([startCamera(), createFaceLandmarker()]);
  if (camera.status === "rejected") {
    console.error(camera.reason);
    setFaceStatus("error", cameraErrorMessage(camera.reason));
    return;
  }
  if (model.status === "rejected") {
    console.error(model.reason);
    setFaceStatus("error", "Model MediaPipe gagal dimuat. Cek koneksi internet (WASM diambil dari CDN).");
    return;
  }

  delegateOutput.textContent = model.value.delegate;
  resetWindow(performance.now());
  detecting = true;
  renderCalibrationIdle();
  runDetection(model.value.landmarker);
}

void main();
