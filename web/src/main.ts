import "./style.css";
import "./app.css";
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
import { BLINK_SEQUENCE, calibrateBlinks, MIN_SCORE_BLINKS } from "./blinkScore.ts";
import { bodyPresent, maskToGrid, toBodySample, type BodyGrid, type BodySample } from "./body.ts";
import {
  BASELINE_KEY,
  computeBaseline,
  loadBaseline,
  looksClosed,
  median,
  saveBaseline,
  type Baseline,
  type KeyValueStore,
} from "./calibration.ts";
import { ACCOUNTS, currentAccount, scopeKey, signOut, type Account } from "./auth.ts";
import { DEMO, DEMO_NOTE, demoCallout } from "./demo.ts";
import { loadDevMode, saveDevMode, showDebugLink } from "./devMode.ts";
import { downloadFile, fileStamp } from "./download.ts";
import { EarChart } from "./earChart.ts";
import { createDetectors, segmentBody, type Detectors } from "./face.ts";
import {
  breakEnded,
  eyesReadable,
  HEAD_DOWN_DEG,
  headDown,
  initialBreakState,
  minutesSinceBreak,
  atScreen,
  stepBreak,
  type BreakState,
  type WindowFeatures,
} from "./features.ts";
import { initialGreetingState, snoozeGreeting, stepGreeting } from "./companion.ts";
import { LOCALE } from "./format.ts";
import { toBreakRecord, toEvaluationRecord, toRecommendationRecord, type DaySummary } from "./history.ts";
import { DB_NAME } from "./historyDb.ts";
import { HistoryPanel } from "./historyPanel.ts";
import { mountInsights } from "./insights/insightsPage.ts";
import { formatDuration, monitoredMinutes } from "./insight.ts";
import { loadKssReminder, saveKssReminder } from "./kss.ts";
import { renderTodayStrip } from "./insightCharts.ts";
import { eyeState, liveTiles, yawning } from "./live.ts";
import { drawFaceMesh, LiveView } from "./liveView.ts";
import { Monitor, type EvaluationStep } from "./monitor.ts";
import { toAnalyzePayload, type AnalyzePayload } from "./payload.ts";
import { PipCompanion, type CompanionView } from "./pipCompanion.ts";
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
import { Router } from "./router.ts";
import { ADVICE, BLINK_PATTERN_THRESHOLD, RULES, SLEEP, type Evaluation, type Label } from "./rules.ts";
import { SelfReport } from "./selfReport.ts";
import { faceBox, gridCentre, ScanEffect, SCAN } from "./scanEffect.ts";
import { stateName } from "./stateCopy.ts";
import { heroCopy, type HeroState } from "./statusCopy.ts";
import { TanyaPanel } from "./tanyaPanel.ts";
import { browserOf, osOf, parseCode, testDbSuffix } from "./userTest.ts";
import { UserTestPanel } from "./userTestPanel.ts";
import { framesToCsv } from "./sessionLog.ts";
import { LEFT_EYE, matrixLayout, RIGHT_EYE, toFrameSignal, type FrameSignal } from "./signals.ts";
import { afterClick, needsWelcome, saveWelcomeDone, welcomeDone } from "./welcome.ts";
import { YAWN_JAW_OPEN, YAWN_MIN_MS } from "./yawn.ts";

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
// ?kode=EQ-XXXX: remote user test (plans/P08, NOTES D-57) with its own history database and the test card.
const TEST_CODE = parseCode(params.get("kode"));
// With an account (D-78) the history and the baseline belong to that account on this laptop; ?riwayat= and test
// codes keep their own databases.
const historyDbName = (owner: Account | null) =>
  TEST_CODE
    ? `${DB_NAME}-${testDbSuffix(TEST_CODE)}`
    : HISTORY_SUFFIX
      ? `${DB_NAME}-${HISTORY_SUFFIX}`
      : scopeKey(DB_NAME, owner);
// ?uji=1 (or a ?kode= test): user test mode, the KSS reminder every 15 minutes is always on.
const TEST_MODE = params.get("uji") === "1" || TEST_CODE !== null;
// ?kamera=0: the page without camera and models (automated checks, screenshots of the history).
const NO_CAMERA = params.get("kamera") === "0";
// ?label=gabungan: rules + blink pattern (NOTES D-72), behind this flag until tested on people (P17 H3).
const COMBINED = params.get("label") === "gabungan";
// Accounts (D-78): user-test links and the no-camera check page (R-08) open without one.
const NEEDS_ACCOUNT = ACCOUNTS && TEST_CODE === null && !NO_CAMERA;
// ⚠️ A baseline older than a working day asks for a new calibration: light and seating change (D-78).
const BASELINE_STALE_MS = 12 * 60 * 60_000;
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
const blinkScoreNote = byId("blink-score");
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
const kssReminderToggle = byId<HTMLInputElement>("kss-reminder");
const kssReminderNote = byId("kss-reminder-note");
const devModeToggle = byId<HTMLInputElement>("dev-mode");
const debugLink = byId("nav-debug");
const pipButton = byId<HTMLButtonElement>("pip-open");
const pipNote = byId("pip-note");
// Pages (plan P14, D-65): the header chip, the dashboard hero and today's tiles, the Debug EAR chart.
const topStatus = byId("top-status");
const hero = byId("hero");
const heroTitle = byId("hero-title");
const heroText = byId("hero-text");
const heroProgress = byId("hero-progress");
const heroCalib = byId<HTMLButtonElement>("hero-calib");
const heroSaran = byId("hero-saran");
const why = byId<HTMLDetailsElement>("why");
const whyHint = why.querySelector<HTMLElement>(".summary-hint")!;
const sinceBreakValue = byId("since-break");
const autoPill = byId("auto-pill");
const pauseButton = byId<HTMLButtonElement>("pause-button");
const recalibButton = byId<HTMLButtonElement>("recalib-button");
const pausedVeil = byId("paused-veil");
const askWhy = byId<HTMLButtonElement>("ask-why");
const earChart = new EarChart(byId<HTMLCanvasElement>("ear-chart"), byId("ear-legend"));
const router = new Router();
// Live view (D-63, D-65): the dock's camera box (video, overlay, badge) moves into #live-slot on the
// dashboard and into #debug-slot on the Debug page.
const cameraBox = video.parentElement!;
const dock = cameraBox.parentElement!;
const liveSlot = byId("live-slot");
const debugSlot = byId("debug-slot");
const live = new LiveView({
  tiles: byId("live-tiles"),
  chart: byId<HTMLCanvasElement>("live-ear-chart"),
  legend: byId("live-ear-legend"),
  raw: byId<HTMLVideoElement>("live-raw"),
});
// Calibration instructions (D-63), full screen before stage A.
const calibScreen = byId<HTMLDialogElement>("calib-screen");
const calibCount = byId("calib-count");
const calibError = byId("calib-error");
const calibDone = byId("calib-done");
const calibFace = byId("calib-face");
const calibGo = byId<HTMLButtonElement>("calib-go");
const calibRetry = byId<HTMLButtonElement>("calib-retry");
const calibHide = byId<HTMLButtonElement>("calib-hide");
const calibBar = byId("calib-bar");
const calibLeft = byId("calib-left");
const calibPipOpen = byId<HTMLButtonElement>("calib-pip-open");
const calibPipNote = byId("calib-pip-note");
const calibSlot = byId("calib-slot");
const calibStale = byId("calib-stale");
// Welcome before the camera (P17 C5), first visit only; the hero offers the same button after Esc.
const welcomeScreen = byId<HTMLDialogElement>("welcome");
const welcomeGo = byId<HTMLButtonElement>("welcome-go");
const heroCamera = byId<HTMLButtonElement>("hero-camera");

function el(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

// A tile on the Debug page, like the live view's (D-65): name, value, an optional bar driven by
// `fraction` (0–1), and one line on how to read it.
function metricTile(box: HTMLElement, name: string, sub = "", withBar = false) {
  const value = el("output", "–");
  const valueLine = el("p", "", "tile-value");
  valueLine.append(value);
  const tile = el("div", "", "tile");
  tile.append(el("p", name, "tile-label"), valueLine);
  const bar = document.createElement("span");
  if (withBar) {
    const track = el("div", "", "bar");
    track.append(bar);
    tile.append(track);
  }
  if (sub) tile.append(el("p", sub, "tile-sub"));
  box.append(tile);
  return (text: string, fraction = 0) => {
    value.textContent = text;
    bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  };
}

const fmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const fmt2 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt3 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const show = (x: number | null | undefined, format: (v: number) => string) =>
  x === null || x === undefined || !Number.isFinite(x) ? "–" : format(x);
const asPct = (x: number) => `${fmt.format(x * 100)}%`;
const asDeg = (x: number) => `${fmt.format(x)}°`;
const clock = (d: Date) => d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const signalsList = byId("signals");
const signalRows = {
  earLeft: metricTile(signalsList, "EAR left", "Left eye openness.", true),
  earRight: metricTile(signalsList, "EAR right", "Right eye openness.", true),
  ear: metricTile(signalsList, "EAR average", "What the rules read; drops when you blink.", true),
  pitch: metricTile(signalsList, "Pitch (absolute)", "Head angle, up and down."),
  pitchRel: metricTile(signalsList, "Pitch (relative)", `Against calibration; ${fmt.format(HEAD_DOWN_DEG)}° or less = head down.`),
  jawOpen: metricTile(
    signalsList,
    "jawOpen",
    `≥ ${fmt.format(YAWN_JAW_OPEN)} for ${fmt.format(YAWN_MIN_MS / 1000)} s = yawn.`,
    true,
  ),
  blinkLeft: metricTile(signalsList, "eyeBlinkLeft", "Blink blendshape, 0–1.", true),
  blinkRight: metricTile(signalsList, "eyeBlinkRight", "Blink blendshape, 0–1.", true),
  lookDown: metricTile(signalsList, "eyeLookDown", "Look-down blendshape, 0–1.", true),
  eyes: metricTile(signalsList, "Eyes assessed?", "Not while the face is missing or the head is down."),
  bodyArea: metricTile(signalsList, "Body (mask area)", "Share of the frame that is body.", true),
  bodyMotion: metricTile(signalsList, "Body motion", "Mask change between samples."),
};

const featuresList = byId("features");
const featureRows = {
  perclos: metricTile(featuresList, "Eyes closed (PERCLOS)", "Share of time with the eyes closed."),
  kedip: metricTile(featuresList, "Blinks per minute", "Compare with your baseline."),
  durasi: metricTile(featuresList, "Average blink length", "Slow blinks are a sign of sleepiness."),
  lama: metricTile(featuresList, "Eyes closed ≥ 1 s", "Count of long closures."),
  menguap: metricTile(featuresList, "Yawns", `Mouth wide open ≥ ${fmt.format(YAWN_MIN_MS / 1000)} s.`),
  menunduk: metricTile(featuresList, "Head down", "Share of time with the head down."),
  hilang: metricTile(featuresList, "Face not found", "Share of frames without a face."),
  terbuka: metricTile(featuresList, "Eyes seen open", "Share of frames, head down included."),
  terpejam: metricTile(featuresList, "Eyes seen closed", "Share of frames, head up only."),
  tubuh: metricTile(featuresList, "Body found", "Share of samples with a person."),
  diam: metricTile(featuresList, "Body still", "Share of samples without motion."),
  gerak: metricTile(featuresList, "Body motion (median)", "Median mask change."),
  menitLelah: metricTile(
    featuresList,
    `Minutes Tired or Asleep (last ${ADVICE.historyMinutes} min)`,
    `≥ ${ADVICE.longRestMinutes} min = long-rest advice.`,
  ),
  frame: metricTile(featuresList, "Frames", "Frames in this window."),
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
// Developer mode puts Debug in the menu (devMode.ts); ?debug=1 switches it on, and it stays on.
let devMode = DEBUG || (store !== null && loadDevMode(store));
if (DEBUG && store) saveDevMode(store, true);

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

// The baseline is personal (D-78): with an account its key carries the account id; other settings stay per laptop.
function accountStore(base: KeyValueStore, owner: Account): KeyValueStore {
  const key = (k: string) => (k === BASELINE_KEY ? scopeKey(k, owner) : k);
  return {
    getItem: (k) => base.getItem(key(k)),
    setItem: (k, v) => base.setItem(key(k), v),
    removeItem: (k) => base.removeItem(key(k)),
  };
}

let account: Account | null = null;
let baselineStore: KeyValueStore | null = store;
let baseline: Baseline | null = null; // loaded in main() once the account is known
let calibration: CalibrationRun | null = null;
let detecting = false;
let bodyDetection = false; // the segmenter loaded
let cameraProblem: string | null = null; // why the camera or the model is not running
let cameraOff = false; // waiting for "Turn on camera" on a first visit (P17 C5)
let paused = false; // the user paused monitoring: camera off, nothing read or stored (D-78)

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
let lastCameraBreak: number | null = null; // wall clock end of the last break counted from the camera
let breakMarked = false; // a break was marked by hand in this session

// Local history (IndexedDB). The pipeline clock is performance.now(); records use the wall clock.
const SESSION = Math.round(performance.timeOrigin);
const wallClock = (t: number) => Math.round(performance.timeOrigin + t);

const sessionLog: FrameSignal[] = [];
const bodyLog: BodySample[] = [];
let sending = false;

// Automatic sending (NOTES D-37): off unless switched on, remembered on this device. Never in the demo build.
let autoSendOn = !DEMO && store ? loadAutoSend(store) : false;
// The KSS reminder outside a user test (D-67): off unless switched on, remembered on this device.
let kssReminderOn = store ? loadKssReminder(store) : false;
let autoState = initialAutoSendState();
let lastAuto: { t: number; target: AutoTarget; ok: boolean | null } | null = null;

function resetWindow(t: number) {
  monitor = baseline
    ? new Monitor(baseline, {
        windowMs: WINDOW_MS,
        evalIntervalMs: EVAL_INTERVAL_MS,
        tidurMenit: TIDUR_MENIT,
        blinkPattern: COMBINED,
      })
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
  const present = atScreen(sessionLog.slice(-60), bodyLog.at(-1) ?? null, baseline?.bodyArea ?? null);
  breakState = prevBreak ? stepBreak(prevBreak, s.t, present) : initialBreakState(s.t);
  const ended = prevBreak && breakEnded(prevBreak, breakState);
  if (ended) {
    lastCameraBreak = wallClock(ended.selesai);
    panel.save("jeda", toBreakRecord({ mulai: wallClock(ended.mulai), selesai: lastCameraBreak }, SESSION));
  }

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
    renderSinceBreak();
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
  // With a test code the reminders run only while the test does (after consent and calibration).
  reminders: () => (TEST_MODE ? userTest === null || userTest.running() : kssReminderOn),
  beep: reminderBeep,
  lastCameraBreak: () => lastCameraBreak,
  // Before the first frame there is nothing to restart: the count starts at that frame anyway.
  breakTaken: () => {
    if (!breakState) return;
    breakState = initialBreakState(performance.now());
    breakMarked = true;
    renderPayload();
    renderSinceBreak();
  },
});

// Frames per second between two wall-clock times, from the session log (hidden-tab gaps included).
function framesPerSecond(from: number, to: number): number | null {
  const end = Math.min(to, Date.now());
  if (end <= from) return null;
  const frames = sessionLog.filter((f) => {
    const t = wallClock(f.t);
    return t >= from && t <= end;
  }).length;
  return Math.round((frames / ((end - from) / 1000)) * 10) / 10;
}

// Remote user test card (?kode=), plans/P08.
const userTest: UserTestPanel | null = TEST_CODE
  ? new UserTestPanel({
      store,
      code: TEST_CODE,
      isCalibrating: () => calibration !== null,
      startCalibration: () => {
        if (!calibration) calibButton.click();
      },
      openCompanion: PipCompanion.supported() ? () => openCompanion() : null,
      records: () => panel.allRecords(),
      device: (from, to) => ({
        browser: browserOf(navigator.userAgent),
        os: osOf(navigator.userAgent),
        kamera: video.videoWidth > 0 ? `${video.videoWidth}x${video.videoHeight}` : null,
        fps_rata: framesPerSecond(from, to),
      }),
      baseline: () => baseline,
      beep: reminderBeep,
      onStarted: (t) => selfReport.resetKssClock(t),
    })
  : null;

// Today's numbers on the dashboard, from the same refresh as the Insight page.
let todaySummary: DaySummary | null = null;
panel.onToday = (summary) => {
  todaySummary = summary;
  renderToday();
};

function renderToday() {
  const s = todaySummary;
  byId("today-monitored").textContent = s ? formatDuration(monitoredMinutes(s)) : "–";
  byId("today-breaks").textContent = s ? `${s.jeda.jumlah}×` : "–";
  renderTodayStrip(byId("today-strip"), byId("today-legend"), s);
}

// Minutes since the last break, or since monitoring started when there was none (menit_sejak_jeda).
function renderSinceBreak() {
  if (!breakState || !monitor || calibration) {
    sinceBreakValue.textContent = "–";
    return;
  }
  const since = formatDuration(minutesSinceBreak(breakState, performance.now()));
  sinceBreakValue.textContent = lastCameraBreak === null && !breakMarked ? `${since} (since start)` : since;
}

// "Tanya Equilibre" (plan P07): the shown label and today's numbers go with the question (D-44).
new TanyaPanel({
  context: () => {
    const shown = calibration ? null : (monitor?.labelState.shown ?? null);
    return { label: shown?.label ?? null, menitLelah60: shown ? menitLelah : null };
  },
  todaySummary: () => panel.todaySummary(),
});

// ── Picture-in-Picture window (D-78): the state, its reason, Pause and Recalibrate ─────────

let greeting = initialGreetingState();

const companion = new PipCompanion({
  debug: DEBUG,
  onChange: (open) => {
    renderPipButton();
    renderCalibPip();
    if (open) renderStatus();
  },
  onSnooze: () => {
    greeting = snoozeGreeting(greeting, Date.now());
    renderPipButton();
  },
  onPause: () => void setPaused(!paused),
  // A click in the PiP window cannot start the calibration's sound here, so it opens the instructions in the app.
  onRecalibrate: () => {
    window.focus();
    if (detecting && !paused && !calibration) showCalibScreen("intro");
  },
});

function renderPipButton() {
  if (!PipCompanion.supported()) {
    pipButton.disabled = true;
    pipNote.textContent = "Needs a recent Chrome or Edge (Document Picture-in-Picture).";
    return;
  }
  pipButton.textContent = companion.isOpen ? "Close Picture-in-Picture" : "Picture-in-Picture";
  pipButton.setAttribute("aria-pressed", String(companion.isOpen));
  const snoozed =
    greeting.snoozeUntil > Date.now() ? ` Nudges snoozed until ${clock(new Date(greeting.snoozeUntil))}.` : "";
  pipNote.textContent =
    (companion.isOpen
      ? "Open: monitoring keeps running while you work in other apps."
      : "A small window that stays on top. It opens by itself when you switch tabs, so monitoring keeps running.") +
    snoozed;
}

// Needs a click, or the browser's automatic picture-in-picture handler (openOnTabSwitch).
function openCompanion() {
  if (companion.isOpen) return;
  companion.open().catch((err) => {
    console.error(err);
    pipNote.textContent = "The Picture-in-Picture window can't be opened.";
  });
}

pipButton.addEventListener("click", () => {
  if (companion.isOpen) companion.close();
  else openCompanion();
});

// A hidden tab without the PiP window pauses monitoring (G-56), so switching tabs opens it on every link,
// even after it was closed (D-66). The calibration click opens it too (D-67).
if (PipCompanion.supported()) PipCompanion.openOnTabSwitch(openCompanion);

function companionView(): CompanionView {
  if (paused) return { state: null, label: "Paused", note: "The camera is off. Resume when you're back.", paused: true };
  if (calibration?.phase === "normal" && calibRemaining) {
    return { state: null, label: `Calibrating · ${calibRemaining}`, note: "Work as usual and stay in front of the camera.", paused: false };
  }
  if (calibration) return { state: null, label: "Calibrating…", note: "Look at the screen as usual.", paused: false };
  if (!baseline) return { state: null, label: "Not calibrated", note: "Calibrate in the Equilibre tab first.", paused: false };
  const shown = monitor?.labelState.shown;
  if (!shown) return { state: null, label: "Reading…", note: "Your first state appears in a moment.", paused: false };
  return {
    state: shown.label,
    label: stateName(shown.label),
    note: hold ? "The last state is kept for a moment." : (shown.alasan[0] ?? `Checked at ${clock(new Date())}`),
    paused: false,
  };
}

// Before the window opens the nudge state still follows the label, so opening it later does
// not replay an old change.
function renderCompanion() {
  const shown = calibration || !baseline || paused ? null : (monitor?.labelState.shown?.label ?? null);
  const step = stepGreeting(greeting, shown, saran !== null && !calibration, Date.now());
  greeting = step.state;
  companion.render(companionView());
  if (step.say) companion.say(step.say);
}

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

const CALIB_FACE_TEXT: Partial<Record<FaceState, string>> = {
  found: "Face in view",
  missing: "Face not in view",
};

function setFaceStatus(state: FaceState, text: string) {
  if (faceStatus.dataset.state === state && faceStatus.textContent === text) return;
  faceStatus.dataset.state = state;
  faceStatus.textContent = text;
  calibFace.dataset.state = state;
  calibFace.textContent = CALIB_FACE_TEXT[state] ?? text;
}

let lastEarDraw = 0;
function renderSignals(s: FrameSignal) {
  setFaceStatus(s.face ? "found" : "missing", s.face ? "Face found" : "Face not found");
  earChart.push(s.t, s.face ? s.ear : null);
  live.chart.push(s.t, s.face ? s.ear : null);
  if (router.page === "debug" && s.t - lastEarDraw >= 100) {
    lastEarDraw = s.t;
    earChart.draw(baseline);
  }
  const ear = (x: number) => show(x, (v) => fmt3.format(v));
  signalRows.earLeft(ear(s.earLeft), s.earLeft / 0.5);
  signalRows.earRight(ear(s.earRight), s.earRight / 0.5);
  signalRows.ear(ear(s.ear), s.ear / 0.5);
  signalRows.pitch(show(s.pitchDeg, asDeg));
  signalRows.pitchRel(baseline ? show(s.pitchDeg - baseline.pitchDeg, asDeg) : "not calibrated");
  const score = (x: number) => show(x, (v) => fmt2.format(v));
  signalRows.jawOpen(score(s.jawOpen), s.jawOpen);
  signalRows.blinkLeft(score(s.blinkLeft), s.blinkLeft);
  signalRows.blinkRight(score(s.blinkRight), s.blinkRight);
  signalRows.lookDown(score(s.lookDown), s.lookDown);
  signalRows.eyes(
    !baseline
      ? "not calibrated"
      : eyesReadable(s, baseline)
        ? "yes"
        : !s.face
          ? "no (face missing)"
          : headDown(s, baseline)
            ? "no (head down)"
            : "no",
  );
}

function renderBody(b: BodySample) {
  const present = bodyPresent(b, baseline?.bodyArea ?? null);
  signalRows.bodyArea(`${asPct(b.area)} · ${present ? "person" : "empty"}`, b.area);
  signalRows.bodyMotion(show(b.motion, (v) => fmt3.format(v)));
}

function renderFeatures() {
  const f = features;
  byId("window-title").textContent = `Last ${WINDOW_MS / 1000} seconds`;
  featureRows.perclos(show(f?.perclos, asPct));
  featureRows.kedip(show(f?.kedip_per_menit, (v) => fmt.format(v)));
  featureRows.durasi(show(f?.durasi_kedip_ms, (v) => `${Math.round(v)} ms`));
  featureRows.lama(f ? `${f.mata_tertutup_lama}×` : "–");
  featureRows.menguap(f ? String(f.menguap) : "–");
  featureRows.menunduk(show(f?.pct_kepala_menunduk, asPct));
  featureRows.hilang(show(f?.pct_wajah_hilang, asPct));
  featureRows.terbuka(show(f?.pct_mata_terbuka, asPct));
  featureRows.terpejam(show(f?.pct_mata_tertutup, asPct));
  featureRows.tubuh(bodyDetection ? show(f?.pct_tubuh_ada, asPct) : "off (model failed to load)");
  featureRows.diam(show(f?.pct_tubuh_diam, asPct));
  featureRows.gerak(show(f?.gerak_tubuh, (v) => fmt3.format(v)));
  featureRows.menitLelah(monitor ? fmt.format(menitLelah) : "–");
  featureRows.frame(f ? `${f.n_frame} (${Math.round(f.durasi_jendela_detik)} s of data)` : "–");
}

// The label in the dashboard chip and in the header chip on every page (shape + text, never color alone).
function setLabel(text: string, label: Label | "none" = "none") {
  labelBadge.textContent = text;
  labelBadge.dataset.label = label;
  topStatus.dataset.label = label;
  topStatus.querySelector(".status-text")!.textContent = text;
}

// Blink-pattern score (NOTES D-49): on the Debug page; it changes the label only with ?label=gabungan (D-72).
function renderBlinkScore() {
  const score = calibration || !baseline ? null : monitor?.blinkScore(lastEvalT);
  if (!monitor?.labelState.shown || calibration) {
    blinkScoreNote.textContent = "Shows after calibration and the first state.";
  } else if (!score) {
    blinkScoreNote.textContent =
      "Recalibrate to turn this score on (this baseline has no blink data yet)." +
      (COMBINED ? " Until then, the state comes from the rules only." : "");
  } else if (score.chance === null) {
    blinkScoreNote.textContent = `Collecting blinks: ${score.n} of at least ${MIN_SCORE_BLINKS}…`;
  } else {
    // 0.5 alarmed falsely on 30% of the alert windows of people the model had not seen (plan P17 C3).
    const verdict = score.chance >= BLINK_PATTERN_THRESHOLD ? "like a sleepy person" : "like an alert person";
    const role = COMBINED
      ? `helps decide the state: ≥ ${asPct(BLINK_PATTERN_THRESHOLD)} raises Normal to Mildly tired`
      : "shown only; the state comes from the rules";
    const value = document.createElement("strong");
    value.textContent = asPct(score.chance);
    blinkScoreNote.replaceChildren(value, ` ${verdict} · last ${score.n} blinks (max ${BLINK_SEQUENCE}) · ${role}`);
  }
}

function heroState(): HeroState {
  if (cameraProblem) return { kind: "error", message: cameraProblem };
  if (paused) return { kind: "paused" };
  if (cameraOff) return { kind: "off" };
  if (calibration) return { kind: "calibrating" };
  if (!detecting) return { kind: "loading" };
  if (!baseline) return { kind: "uncalibrated" };
  const shown = monitor?.labelState.shown;
  return shown ? { kind: "label", label: shown.label } : { kind: "analyzing" };
}

function renderStatus() {
  renderCompanion();
  reasonList.replaceChildren();
  pendingNote.hidden = true;
  longRestNote.hidden = saran === null || calibration !== null;
  longRestNote.textContent = saran ?? "";
  labelMeta.textContent = "";
  selfReport.renderCorrection(calibration ? null : (monitor?.labelState.shown ?? null));
  renderBlinkScore();

  const state = heroState();
  const copy = heroCopy(state);
  const label = state.kind === "label" ? state.label : "none";
  setLabel(copy.chip, label);
  hero.dataset.label = label;
  heroTitle.textContent = copy.title;
  if (state.kind !== "calibrating") heroText.textContent = copy.text; // calibration writes its own steps
  heroProgress.hidden = state.kind !== "calibrating" || calibProgress.hidden;
  heroCamera.hidden = state.kind !== "off";
  heroCalib.hidden = state.kind !== "uncalibrated";
  heroSaran.hidden = !(saran !== null || label === "lelah ringan" || label === "lelah" || label === "tertidur");
  document.body.toggleAttribute("data-calibrated", baseline !== null);
  renderControls();

  const labelState = monitor?.labelState;
  const shown = state.kind === "label" ? labelState?.shown : undefined;
  if (state.kind === "analyzing" && hold) labelMeta.textContent = hold;
  why.hidden = !labelState || !shown; // nothing to explain before the first label
  if (!labelState || !shown) return;

  labelMeta.textContent = `Updated ${clock(new Date())}`;
  whyHint.textContent =
    shown.alasan.length === 0
      ? "No signs of tiredness in the last window."
      : `${shown.alasan.length} ${shown.alasan.length === 1 ? "sign" : "signs"} read in the last ${WINDOW_MS / 1000} seconds.`;
  if (shown.alasan.length === 0) {
    reasonList.append(el("li", shown.label === "normal" ? "No signs of tiredness in this window." : "–"));
  }
  for (const reason of shown.alasan) reasonList.append(el("li", reason));
  for (const note of shown.catatan) reasonList.append(el("li", note, "muted"));

  if (hold) {
    pendingNote.hidden = false;
    pendingNote.textContent = hold;
  } else if (labelState.candidate && latest) {
    pendingNote.hidden = false;
    pendingNote.textContent =
      `Last reading: "${stateName(labelState.candidate)}" (${labelState.streak}/${RULES.confirmEvaluations}). ` +
      `The state changes if this shows again. ${latest.alasan.join(" ")}`;
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
  payloadPre.textContent = payload ? JSON.stringify(payload, null, 2) : "No state yet.";
  sendButton.disabled = DEMO || payload === null || sending || notSent(payload);
  sendNote.hidden = DEMO || !notSent(payload);
}

function renderBaseline() {
  baselineList.hidden = !baseline;
  byId("baseline-empty").hidden = baseline !== null;
  baselineList.replaceChildren();
  if (!baseline) return;
  const b = baseline;
  const rows: [string, string, string][] = [
    ["EAR, eyes open", fmt3.format(b.earOpen), "Median while working normally (step 2)."],
    // The ratio shows a narrowed eye recorded as "closed" (G-73): developer 0.05–0.15, tester B 0.56 (D-62).
    ["EAR, eyes closed", fmt3.format(b.earClosed), `${fmt2.format(b.earClosed / b.earOpen)} × EAR open.`],
    ["Blinks per minute", fmt.format(b.blinkPerMin), "Your normal during calibration."],
    ["Blink length", b.blinkDurationMs === null ? "no blink recorded" : `${Math.round(b.blinkDurationMs)} ms`, ""],
    ["Normal pitch", asDeg(b.pitchDeg), "Reference for relative pitch."],
    ["jawOpen P95", fmt2.format(b.jawOpenP95), "Mouth while working normally."],
    ["Normal body area", b.bodyArea === null ? "none yet (recalibrate)" : asPct(b.bodyArea), ""],
    [
      "Blinks for the blink pattern",
      b.kedip ? `${b.kedip.n} blinks, ${Math.round(b.kedip.durasi.mean)} ms, ${fmt.format(b.kedip.perMenit)}/min` : "none yet (recalibrate)",
      "",
    ],
    ["Created", new Date(b.createdAt).toLocaleString(LOCALE), ""],
  ];
  for (const [name, value, sub] of rows) metricTile(baselineList, name, sub)(value);
}

// About how long a calibration takes, as the user reads it (±5 menit; seconds for ?calib=30).
function calibLength(): string {
  const seconds = Math.round((CALIB_NORMAL_MS + CALIB_CLOSED_MS) / 1000) + 4;
  return seconds >= 90 ? `about ${Math.round(seconds / 60)} min` : `about ${seconds} s`;
}

function renderCalibrationIdle(message?: string, isError = false) {
  setCalibProgress(null);
  cameraPrompt.hidden = true;
  calibButton.textContent = baseline ? "Recalibrate" : "Start calibration";
  calibButton.disabled = !detecting || paused;
  calibStatus.dataset.state = isError ? "error" : "";
  calibStatus.textContent =
    message ??
    (cameraOff
      ? "The camera is off. Turn it on from the Dashboard."
      : baseline
        ? baseline.bodyArea === null && bodyDetection
          ? "This baseline was made before body detection. Recalibrate so Equilibre also knows how you sit."
          : "Your baseline is saved on this device. Recalibrate when your seating, glasses or lighting change."
        : `Calibration takes ${calibLength()}: close your eyes briefly, then work as usual.`);
  byId("baseline-age").textContent = baseline ? `Baseline · ${ageText(baseline.createdAt)}` : "No baseline";
  renderBaseline();
  renderControls();
}

// "12 min ago", "3 h ago", "2 days ago": how old the baseline is.
function ageText(createdAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const baselineIsStale = (b: Baseline, now = Date.now()) => now - b.createdAt > BASELINE_STALE_MS;

// Pause, Recalibrate and the paused veil on the dashboard (D-78).
function renderControls() {
  pauseButton.textContent = paused ? "Resume" : "Pause";
  pauseButton.classList.toggle("primary", paused);
  pauseButton.classList.toggle("outline", !paused);
  pauseButton.setAttribute("aria-pressed", String(paused));
  pauseButton.disabled = !detecting || calibration !== null;
  recalibButton.disabled = !detecting || paused || calibration !== null;
  pausedVeil.hidden = !paused;
  document.body.toggleAttribute("data-paused", paused);
}

// ── Debug overlay (?debug=1) ────────────────────────────────────────────────────

// The overlay canvas in video pixels, cleared; null without a 2D context.
function overlayContext(): CanvasRenderingContext2D | null {
  if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
  const ctx = overlay.getContext("2d");
  ctx?.clearRect(0, 0, overlay.width, overlay.height);
  return ctx;
}

// Live view (D-63): the face mesh every frame, the tiles ±4×/second, the EAR chart ±10×/second.
let lastLiveTiles = 0;
let lastLiveChart = 0;
function renderLive(result: FaceLandmarkerResult, s: FrameSignal) {
  const ctx = overlayContext();
  const landmarks = result.faceLandmarks[0];
  if (ctx && landmarks) drawFaceMesh(ctx, landmarks, overlay.width, overlay.height, eyeState(s, baseline), yawning(s));
  if (s.t - lastLiveChart >= 100) {
    lastLiveChart = s.t;
    live.chart.draw(baseline);
  }
  if (s.t - lastLiveTiles >= 250) {
    lastLiveTiles = s.t;
    renderLiveTiles(s);
  }
}

function renderLiveTiles(s: FrameSignal | null = sessionLog.at(-1) ?? null) {
  const shown = calibration ? null : (monitor?.labelState.shown?.label ?? null);
  live.render(liveTiles(s, calibration ? null : features, baseline, shown, WINDOW_MS / 1000));
}

let lastMatrixRender = 0;
// Where the body mask puts the person next to where the face is (G-95): the numbers that tell a mask placed beside
// the body from one on it, without a picture of the camera.
let lastBodyDiag = 0;
function renderBodyDiag(result: FaceLandmarkerResult) {
  const now = performance.now();
  if (now - lastBodyDiag < 500) return;
  lastBodyDiag = now;
  const pair = (p: { x: number; y: number } | null) => (p ? `${p.x.toFixed(2)}, ${p.y.toFixed(2)}` : "–");
  const person = bodyView ? gridCentre(bodyView) : null;
  const face = result.faceLandmarks[0] ? faceBox(result.faceLandmarks[0], 1, 1) : null;
  const size = maskSize ? `${maskSize.width}×${maskSize.height} (${maskSize.values} values)` : "–";
  byId("body-diag").textContent =
    `Body mask ${size} · video ${video.videoWidth}×${video.videoHeight} · person centre ${pair(person)} · ` +
    `face centre ${pair(face && { x: face.x + face.w / 2, y: face.y + face.h / 2 })} · ` +
    `last scan: ${scan.followsMask ? "mask" : "silhouette"}`;
}

function renderDebug(result: FaceLandmarkerResult, grid: BodyGrid | null) {
  renderBodyDiag(result);
  const ctx = overlayContext();
  if (!ctx) return;
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
    byId("matrix").textContent = `data[0..15], 4 per row:\n${rows.join("\n")}`;
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
      return "Camera permission was denied. Allow the camera in your browser's site settings, then reload the page.";
    case "NotFoundError":
      return "No camera found.";
    case "NotReadableError":
      return "The camera is being used by another app.";
    default:
      return "The camera can't be turned on.";
  }
}

// The body segmenter reads a 2D-canvas copy of the frame, not the camera's <video> (G-95). With the user's UGREEN
// camera in Brave (30 Oct) it read the video element as an almost empty picture (body 5.7% of the frame, against
// 48–60% in the September logs) while the face landmarker read the same element fine; a dataset clip played into
// the same element segmented normally (37.7%). Same frame, same size, so the rules see what they were tuned on.
const bodyFrame = document.createElement("canvas");
function bodyFrameOf(source: HTMLVideoElement): HTMLCanvasElement {
  if (bodyFrame.width !== source.videoWidth || bodyFrame.height !== source.videoHeight) {
    bodyFrame.width = source.videoWidth;
    bodyFrame.height = source.videoHeight;
  }
  bodyFrame.getContext("2d")?.drawImage(source, 0, 0, bodyFrame.width, bodyFrame.height);
  return bodyFrame;
}

function runDetection({ landmarker, segmenter }: Detectors) {
  let lastVideoTime = -1;
  let fpsFrames = 0;
  let fpsWindowStart = performance.now();
  let lastBodyT = -Infinity;
  let grid: BodyGrid | null = null;
  // Each tick is scheduled on the page and, while the companion is open, on the PiP window too;
  // whichever timer fires first runs it and cancels the other (plan P13). A hidden tab is throttled
  // to ±1 fps (G-03), and a PiP window the browser counts as hidden is throttled as well (G-56), so
  // neither window alone can be trusted. Closing the PiP window cannot stop the loop: the page's
  // timer is always pending too.
  let pending: Array<[Window, number]> = [];
  const schedule = (delay: number) => {
    const fire = () => {
      for (const [win, id] of pending) win.clearTimeout(id);
      pending = [];
      tick();
    };
    const pip = companion.pipWindow;
    pending = (pip ? [window, pip] : [window]).map((win) => [win, win.setTimeout(fire, delay)]);
  };

  const tick = () => {
    const now = performance.now();
    if (!paused && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = landmarker.detectForVideo(video, now);
      if (segmenter && now - lastBodyT >= BODY_INTERVAL_MS) {
        lastBodyT = now;
        const next = segmentBody(segmenter, bodyFrameOf(video), now, (mask, width, height) => {
          bodyView = maskToGrid(mask, width, height, SCAN.viewCols);
          maskSize = { width, height, values: mask.length };
        });
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
      if (scan.running) {
        scanInput = { result, signal };
        renderScan();
      } else if (router.page === "dashboard") renderLive(result, signal);
      else if (DEBUG || router.page === "debug") renderDebug(result, grid);
      fpsFrames++;
    }
    if (now - fpsWindowStart >= 1000) {
      fpsOutput.textContent = ((fpsFrames * 1000) / (now - fpsWindowStart)).toFixed(1);
      companion.setFps(fpsOutput.textContent);
      fpsFrames = 0;
      fpsWindowStart = now;
    }
    schedule(Math.max(0, detectIntervalMs(power, calibration !== null) - (performance.now() - now)));
  };
  tick();
}

// ── Power saving (hemat daya) ───────────────────────────────────────────────────

function renderPower() {
  const reason = powerReason(power);
  powerToggle.checked = reason !== null;
  const battery = batteryLevel === null ? "" : `battery ${asPct(batteryLevel)}`;
  powerNote.textContent =
    reason === "baterai"
      ? `On by itself: ${battery}, not charging.`
      : reason === "pilihan"
        ? "The battery lasts longer, but some short blinks are missed."
        : power.dismissed
          ? "Turned off. It won't switch on by itself until the battery is charged."
          : batteryLevel !== null
            ? `±10 fps. Turns on by itself below ${asPct(LOW_BATTERY)} battery when not charging.`
            : "±10 fps.";
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
    console.warn("Battery status unavailable; power saving is manual only.", err);
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

// The calibration card (Privasi page) and the hero (dashboard) show the same step.
function setCalibStatus(text: string) {
  calibStatus.dataset.state = "";
  calibStatus.textContent = text;
  if (calibration) heroText.textContent = text;
}

// The full-screen calibration (D-63), one section per phase: intro → countdown → closing (eyes shut
// until the beep) → progress (stage B, with the companion) → done; error from either stage.
type CalibScreenPhase = "intro" | "countdown" | "closing" | "progress" | "error" | "done";
const calibSections = [...calibScreen.querySelectorAll<HTMLElement>(".cs")];

function setCalibScreen(phase: CalibScreenPhase, detail = "") {
  calibScreen.dataset.phase = phase;
  for (const section of calibSections) section.hidden = section.dataset.for !== phase;
  if (phase === "countdown") {
    calibCount.textContent = detail;
    calibCount.classList.remove("pop");
    void calibCount.offsetWidth; // restart the animation for each number
    calibCount.classList.add("pop");
  }
  if (phase === "error") calibError.textContent = detail;
  if (phase === "done") calibDone.textContent = detail;
  if (phase === "progress") {
    renderCalibPip();
    scan.startRings(performance.now()); // rings of crosses spread over the person while the progress bar runs
    animateScan();
  } else scan.stopRings();
  calibScreen.scrollTop = 0;
}

// Shows the screen (again) at a phase; a stage B error reopens it after the user hid it.
function showCalibScreen(phase: CalibScreenPhase, detail = "") {
  setCalibScreen(phase, detail);
  if (!calibScreen.open) {
    calibScreen.showModal();
    enterCalibStage();
  }
  const first = calibSections.find((x) => !x.hidden)?.querySelector<HTMLButtonElement>(".cs-go");
  first?.focus({ preventScroll: true }); // headings are read from the top
}

function closeCalibScreen() {
  if (calibScreen.open) calibScreen.close();
}

// ── The calibration scan (scanEffect.ts, the user's "Tab UX Calibration" sheet) ──

const scan = new ScanEffect();
let scanInput: { result: FaceLandmarkerResult; signal: FrameSignal } | null = null;
// A finer grid of the latest body mask (SCAN.viewCols columns), for the scan only; the rules use their own grid.
let bodyView: BodyGrid | null = null;
let maskSize: { width: number; height: number; values: number } | null = null;

function renderScan() {
  const ctx = overlayContext();
  if (!ctx || !scanInput) return;
  const { result, signal } = scanInput;
  const values = signal.face ? { earLeft: signal.earLeft, earRight: signal.earRight, jawOpen: signal.jawOpen } : null;
  scan.draw(ctx, video, result.faceLandmarks[0], values, bodyView, performance.now());
}

// The opening (it starts on the first face) and stage B's rings are drawn every display frame, the rest on
// detector frames only.
let scanFrame = 0;
function animateScan() {
  if (scanFrame) return;
  const frame = () => {
    scanFrame = 0;
    if (!scan.running) return;
    renderScan();
    if (scan.animating(performance.now())) scanFrame = requestAnimationFrame(frame);
  };
  scanFrame = requestAnimationFrame(frame);
}

// The camera box moves into the screen.
function enterCalibStage() {
  calibSlot.prepend(cameraBox);
  if (video.srcObject) void video.play().catch(() => {});
  overlay.hidden = false;
  scanInput = null;
  scan.arm(performance.now());
  animateScan();
}

calibScreen.addEventListener("close", () => {
  scan.stop();
  calibStale.hidden = true;
  onPage(router.page); // the camera goes back where the page wants it
});

// The companion keeps detection at full speed while the user works in another app (G-56, D-59), so
// stage B offers it. Opening it needs a click: the beep comes too long after "Mulai" for that click.
function renderCalibPip() {
  const supported = PipCompanion.supported();
  calibPipOpen.hidden = !supported || companion.isOpen;
  calibPipNote.textContent = !supported
    ? "This browser has no Picture-in-Picture window. Keep the Equilibre tab visible until it's done: a hidden tab slows the camera."
    : companion.isOpen
      ? "Picture-in-Picture is open. You can switch to other apps; it keeps calibration running."
      : "Open the small Picture-in-Picture window so calibration keeps running while you use other apps.";
}

const minSec = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
let calibRemaining = ""; // stage B time left, also shown in the companion

function setCalibProgress(fraction: number | null) {
  calibProgress.hidden = fraction === null;
  heroProgress.hidden = fraction === null;
  const width = `${(fraction ?? 0) * 100}%`;
  calibProgress.querySelector("span")!.style.width = width;
  heroProgress.querySelector("span")!.style.width = width;
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
  calibButton.textContent = "Cancel calibration";
  document.body.dataset.calibrating = "1"; // small screens: the camera preview grows for the prompts
  renderStatus();
  userTest?.render();

  let outcome: { message: string; isError: boolean } | undefined;
  let failed = false; // stage A or B could not make a baseline (a blocked save is not a failure)
  try {
    cameraPrompt.hidden = false;
    for (const n of [3, 2, 1]) {
      setCalibStatus(`Step 1 of 2: close your eyes when the countdown ends. ${n}…`);
      cameraPrompt.textContent = String(n);
      setCalibScreen("countdown", String(n));
      tone(audio, 440, 0.08);
      await sleep(1000);
      if (run.cancelled) return;
    }

    run.openRef = median(run.open.filter((f) => f.face && Number.isFinite(f.ear)).map((f) => f.ear));
    run.phase = "waiting";
    setCalibStatus("Step 1 of 2: keep your eyes closed until the beep.");
    cameraPrompt.textContent = "Close your eyes";
    setCalibScreen("closing");
    const waitStart = performance.now();
    while (run.closedStreak < CALIB_CONFIRM_CLOSED_FRAMES) {
      if (run.cancelled) return;
      if (performance.now() - waitStart > CALIB_WAIT_CLOSED_MS) {
        tone(audio, 220, 0.6);
        outcome = {
          message:
            `Your eyes weren't seen closed within ${CALIB_WAIT_CLOSED_MS / 1000} s of the cue. ` +
            "Try again: keep your face clearly in view and close your eyes fully when the countdown ends.",
          isError: true,
        };
        failed = true;
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
    if (calibScreen.open) setCalibScreen("progress");
    const start = performance.now();
    for (let elapsed = 0; elapsed < CALIB_NORMAL_MS; elapsed = performance.now() - start) {
      if (run.cancelled) return;
      const fraction = elapsed / CALIB_NORMAL_MS;
      setCalibProgress(fraction);
      calibRemaining = minSec(CALIB_NORMAL_MS - elapsed);
      calibBar.querySelector("span")!.style.width = `${fraction * 100}%`;
      calibLeft.textContent = `${calibRemaining} left`;
      setCalibStatus(
        `Step 2 of 2: work as usual. ` +
          (companion.isOpen ? "You can switch apps. " : "Keep this tab visible. ") +
          `${calibRemaining} left.`,
      );
      renderCompanion();
      await sleep(500);
    }

    const result = computeBaseline(run.closed, run.normal, Date.now(), run.normalBodies);
    if (!result.ok) {
      outcome = { message: result.error, isError: true };
      failed = true;
      return;
    }
    // Blink shapes of the same stage B frames, for the blink-pattern score (blinkScore.ts).
    baseline = { ...result.baseline, kedip: calibrateBlinks(run.normal, result.baseline) };
    const saved = baselineStore !== null && saveBaseline(baselineStore, baseline);
    resetWindow(performance.now());
    userTest?.calibrated(Date.now()); // the first calibration after consent starts the test clock
    outcome = {
      message: saved
        ? "Calibration done and saved on this device."
        : "Calibration done, but it couldn't be saved (browser storage is blocked). You'll need to calibrate again after a reload.",
      isError: !saved,
    };
  } finally {
    calibration = null;
    delete document.body.dataset.calibrating;
    void audio.close();
    calibRemaining = "";
    if (run.cancelled || !outcome) closeCalibScreen();
    else if (failed) showCalibScreen("error", outcome.message);
    else if (calibScreen.open) setCalibScreen("done", `${outcome.message} Your first state appears within about a minute.`);
    renderCalibrationIdle(outcome?.message ?? (run.cancelled ? "Calibration cancelled." : undefined), outcome?.isError);
    renderStatus();
    userTest?.render();
  }
}

function cancelCalibration() {
  if (!calibration) return;
  calibration.cancelled = true;
  calibButton.disabled = true; // re-enabled once the run notices the cancel
}

// Every "Mulai kalibrasi" (Privasi card, hero, test card) opens the instructions first; the run
// starts from their "Mulai" button (D-63).
calibButton.addEventListener("click", () => {
  if (calibration) {
    cancelCalibration();
    closeCalibScreen();
    return;
  }
  showCalibScreen("intro");
});

// The run starts inside this click, so the browser lets its AudioContext play the beep.
function startCalibration() {
  if (calibration || !detecting) return;
  void runCalibration();
  // After the AudioContext is made: opening the window may use up the click. Every link (D-67): stage B
  // keeps running at full speed while the user works in another app.
  if (PipCompanion.supported()) openCompanion();
}
calibGo.addEventListener("click", startCalibration);
calibRetry.addEventListener("click", startCalibration);
calibPipOpen.addEventListener("click", () => openCompanion());
calibHide.addEventListener("click", closeCalibScreen); // stage B goes on; the hero shows its progress
for (const button of calibScreen.querySelectorAll<HTMLButtonElement>("[data-calib-close]")) {
  button.addEventListener("click", () => {
    cancelCalibration();
    closeCalibScreen();
  });
}
// Esc hides stage B (minutes of data stay), and otherwise acts as the screen's close button.
calibScreen.addEventListener("cancel", (event) => {
  event.preventDefault();
  if (calibScreen.dataset.phase === "progress") closeCalibScreen();
  else {
    cancelCalibration();
    closeCalibScreen();
  }
});
heroCalib.addEventListener("click", () => calibButton.click());
// The privacy page sits behind the modal screen: close it, the link then opens the page.
byId("welcome-privacy").addEventListener("click", () => welcomeScreen.close());

// The camera box leaves the dock on two pages (D-63, D-65): on the dashboard it goes into the live view,
// where the overlay draws the face mesh and the plain view plays the same stream beside it; on the
// Debug page it goes beside the EAR chart, with the eye points and body mask (also on every page with
// ?debug=1). The detector keeps reading the same <video>, which stays rendered either way; play()
// again in case the move paused it.
// The Insights page (insights/): mounted once the history is open, redrawn when the page is opened.
let insights: ReturnType<typeof mountInsights> | null = null;

function onPage(page: string) {
  insights?.setVisible(page === "insights");
  if (page === "insights") void insights?.refresh();
  if (scan.running) return; // the calibration screen holds the camera until it closes
  const liveOn = page === "dashboard";
  const debugOn = page === "debug";
  const home = liveOn ? liveSlot : debugOn ? debugSlot : dock;
  if (cameraBox.parentElement !== home) {
    home.prepend(cameraBox);
    if (video.srcObject) void video.play().catch(() => {});
  }
  const overlayOn = DEBUG || debugOn || liveOn;
  overlay.hidden = !overlayOn;
  overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
  if (debugOn) earChart.draw(baseline);
  if (liveOn) {
    live.chart.draw(baseline);
    renderLiveTiles();
  }
  debugLink.hidden = !showDebugLink(devMode, page);
}
router.onChange(onPage);

// ── Session log + Langflow ──────────────────────────────────────────────────────

byId("download-log").addEventListener("click", () => {
  const started = new Date(performance.timeOrigin);
  const csv = framesToCsv(sessionLog, bodyLog, performance.timeOrigin, [
    `Equilibre log sesi, halaman dibuka ${started.toISOString()}`,
    `window_ms=${WINDOW_MS} eval_interval_ms=${EVAL_INTERVAL_MS} detect_interval_ms=${NORMAL_INTERVAL_MS} ` +
      `hemat_daya_interval_ms=${SAVING_INTERVAL_MS} body_interval_ms=${bodyDetection ? BODY_INTERVAL_MS : 0} ` +
      `tidur_menit=${TIDUR_MENIT} label=${COMBINED ? "gabungan" : "rules"}`,
    // When power saving was on (sebab not null) or off (null); calibration always ran at detect_interval_ms.
    `hemat_daya=${JSON.stringify(powerLog)}`,
    `baseline=${JSON.stringify(baseline)}`,
  ]);
  downloadFile(csv, `equilibre-sesi-${fileStamp(new Date())}.csv`, "text/csv");
});

// The recommendation as a card: tags (status, break length), the advice itself, why, and sources.
// Fields the prompt did not ask for still show, in a small list under it.
function renderAnswer(reply: AnalyzeResponse, label: Label) {
  const view = toAnswerView(reply);
  const card = el("div", "", "advice");
  if (view.kind === "text") card.append(el("p", view.text, "advice-main"));
  else {
    const rows = new Map(view.rows);
    const tags = el("div", "", "advice-tags");
    const chip = el("span", stateName(label), "label-chip");
    chip.dataset.label = label;
    tags.append(chip);
    if (rows.has("Status")) tags.append(el("span", rows.get("Status")!, "pill"));
    if (rows.has("Break length")) tags.append(el("span", `Break ${rows.get("Break length")}`, "pill"));
    card.append(tags);
    if (rows.has("Recommendation")) card.append(el("p", rows.get("Recommendation")!, "advice-main"));
    if (rows.has("Why")) {
      const why = el("p", "", "advice-why");
      why.append(el("strong", "Why: "), rows.get("Why")!);
      card.append(why);
    }
    const extra = view.rows.filter(([name]) => !["Status", "Recommendation", "Why", "Break length"].includes(name));
    if (extra.length > 0) {
      const list = el("dl", "", "extra");
      for (const [name, value] of extra) list.append(el("dt", name), el("dd", value));
      card.append(list);
    }
    if (view.sumber) {
      if (view.sumber.length === 0) card.append(el("p", "No sources from the knowledge base.", "helper"));
      else {
        const items = el("ul", "", "sources");
        items.append(...view.sumber.map((s) => el("li", s.text, s.known ? undefined : "error")));
        card.append(items);
      }
    }
  }
  if (view.cadangan) card.append(el("p", "Answered by the backup model because the main model failed.", "helper"));
  answer.replaceChildren(card);
}

// ── Automatic sending (NOTES D-37) ──────────────────────────────────────────────

const minuteClock = (t: number) => new Date(t).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });

function renderAutoSend() {
  autoSendToggle.checked = autoSendOn;
  autoPill.textContent = autoSendOn ? "Auto advice on" : "Auto advice off";
  autoPill.dataset.on = autoSendOn ? "1" : "0";
  if (DEMO) {
    autoSendToggle.disabled = true;
    autoSendNote.textContent = DEMO_NOTE.autoSend;
    return;
  }
  const rule = `advice is requested by itself when the state is Mildly tired or worse, at most once every ${AUTO_SEND.minGapMs / 60_000} min.`;
  if (!autoSendOn) {
    autoSendNote.textContent = `Off. When on, ${rule}`;
    return;
  }
  const last =
    lastAuto === null
      ? ""
      : ` Last ${minuteClock(lastAuto.t)} (${lastAuto.target}): ` +
        (lastAuto.ok === null
          ? "waiting for the answer."
          : lastAuto.ok
            ? "sent."
            : `failed; tried again at ${minuteClock(lastAuto.t + AUTO_SEND.minGapMs)} at the earliest.`);
  autoSendNote.textContent = `On: ${rule}${last}`;
}

autoSendToggle.addEventListener("change", () => {
  autoSendOn = autoSendToggle.checked;
  if (store) saveAutoSend(store, autoSendOn);
  renderAutoSend();
});

// ── KSS reminder (D-67): a user's choice, always on in a user test ──────────────

function renderKssReminder() {
  kssReminderToggle.checked = TEST_MODE || kssReminderOn;
  kssReminderToggle.disabled = TEST_MODE;
  kssReminderNote.textContent = TEST_MODE
    ? "Always on during the user test."
    : kssReminderOn
      ? "A beep every 15 min; then fill in the sleepiness check on the Dashboard."
      : "Off. When on, a beep every 15 min reminds you to fill in the sleepiness check.";
}

kssReminderToggle.addEventListener("change", () => {
  kssReminderOn = kssReminderToggle.checked;
  if (store) saveKssReminder(store, kssReminderOn);
  selfReport.resetKssClock(Date.now()); // the first reminder 15 minutes after switching it on
  renderKssReminder();
});

// ── Developer mode (P17 C11, D-74): Debug in the menu ───────────────────────────

function renderDevMode() {
  devModeToggle.checked = devMode;
  debugLink.hidden = !showDebugLink(devMode, router.page);
}

devModeToggle.addEventListener("change", () => {
  devMode = devModeToggle.checked;
  if (store) saveDevMode(store, devMode);
  renderDevMode();
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
  answer.replaceChildren(
    el("p", pemicu === "otomatis" ? "Requested automatically. Langflow is writing your advice…" : "Langflow is writing your advice…", "muted"),
  );
  selfReport.showRecommendation(null);
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error ?? `The backend didn't answer (HTTP ${res.status}). Make sure the server is running.`);
    }
    const reply = body as AnalyzeResponse;
    renderAnswer(reply, payload.label);
    if (pemicu === "otomatis") autoSendDone(true);
    const context = { t: Date.now(), sesi: SESSION, pemicu, label: payload.label };
    selfReport.showRecommendation(await panel.add("rekomendasi", toRecommendationRecord(reply, context)));
  } catch (err) {
    const message = err instanceof TypeError ? "Can't reach the backend." : (err as Error).message;
    answer.replaceChildren(el("p", pemicu === "otomatis" ? `Automatic advice failed: ${message}` : message, "callout danger"));
    if (pemicu === "otomatis") autoSendDone(false);
  } finally {
    sending = false;
    renderPayload();
  }
}
sendButton.addEventListener("click", () => void sendStatus("manual"));

// ── Pause (D-78): the camera off, nothing read or stored, until Resume ─────────

async function setPaused(on: boolean) {
  if (on === paused || calibration || !detecting) return;
  paused = on;
  if (on) {
    for (const track of (video.srcObject as MediaStream | null)?.getTracks() ?? []) track.stop();
    video.srcObject = null;
  } else {
    try {
      await startCamera();
    } catch (err) {
      console.error(err);
      cameraFailed(cameraErrorMessage(err));
      return;
    }
    // Back from a pause: the window and the time since the last break start again.
    breakState = initialBreakState(performance.now());
  }
  resetWindow(performance.now());
  setFaceStatus("loading", paused ? "Paused" : "Reading…");
  renderStatus();
  renderSinceBreak();
  renderCalibrationIdle();
}

pauseButton.addEventListener("click", () => void setPaused(!paused));
recalibButton.addEventListener("click", () => calibButton.click());

// "Why this state?" is answered on this laptop, from the rules and the numbers (no LLM).
askWhy.addEventListener("click", () => {
  if (why.hidden) {
    answer.replaceChildren(el("p", "No state yet. The first one appears about 10 s after calibration.", "muted"));
    return;
  }
  why.open = true;
  why.scrollIntoView({ block: "nearest", behavior: "smooth" });
});

// "What we see" draws the face points over the camera; "What you see" is the plain camera.
for (const button of document.querySelectorAll<HTMLButtonElement>(".stage-view button")) {
  button.addEventListener("click", () => {
    hero.dataset.view = button.dataset.view ?? "we";
    for (const other of document.querySelectorAll<HTMLButtonElement>(".stage-view button")) {
      other.setAttribute("aria-pressed", String(other === button));
    }
  });
}

// ── Account (D-78) ──────────────────────────────────────────────────────────────

const accountButton = byId<HTMLButtonElement>("account-button");
const accountMenu = byId("account-menu");

function partOfDay(hour: number): string {
  return hour < 11 ? "Good morning" : hour < 15 ? "Good afternoon" : hour < 19 ? "Good evening" : "Working late";
}

function renderAccount() {
  const now = new Date();
  byId("greeting-date").textContent = new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long" }).format(now);
  const first = account?.name.split(/\s+/)[0];
  byId("greeting").textContent = first ? `${partOfDay(now.getHours())}, ${first}.` : `${partOfDay(now.getHours())}.`;
  byId("account").hidden = account === null;
  byId("account-card").hidden = account === null;
  if (!account) return;
  byId("account-initial").textContent = account.name.charAt(0).toUpperCase();
  byId("account-name").textContent = account.name;
  byId("account-email").textContent = account.email;
  byId("settings-name").textContent = account.name;
  byId("settings-email").textContent = account.email;
}

function setMenu(open: boolean) {
  accountMenu.hidden = !open;
  accountButton.setAttribute("aria-expanded", String(open));
}
accountButton.addEventListener("click", (event) => {
  event.stopPropagation();
  setMenu(accountMenu.hidden === true);
});
document.addEventListener("click", (event) => {
  if (!accountMenu.hidden && !accountMenu.contains(event.target as Node)) setMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !accountMenu.hidden) {
    setMenu(false);
    accountButton.focus();
  }
});

async function leave() {
  await signOut().catch((err) => console.error(err));
  location.replace("./");
}
for (const id of ["sign-out", "sign-out-2"]) byId(id).addEventListener("click", () => void leave());

// No baseline, or one older than a working day: the calibration screen opens by itself (D-78). A test link is led
// by its own card (plans/P08).
function maybeAskToCalibrate() {
  if (TEST_CODE || calibScreen.open || welcomeScreen.open) return;
  if (!baseline) {
    showCalibScreen("intro");
    return;
  }
  if (baselineIsStale(baseline)) {
    calibStale.hidden = false;
    calibStale.textContent =
      `Your last calibration was ${ageText(baseline.createdAt)}. Light and seating change through the day, so a ` +
      "fresh one keeps readings accurate. Cancel to keep using the old one.";
    showCalibScreen("intro");
  }
}

// ── Start ───────────────────────────────────────────────────────────────────────

// The camera dock badge and the hero both say why nothing is being monitored.
function cameraFailed(message: string) {
  cameraProblem = message;
  setFaceStatus("error", message);
  renderStatus();
}

async function main() {
  if (NEEDS_ACCOUNT) {
    account = await currentAccount().catch(() => null);
    if (!account) {
      location.replace(`auth.html?next=${encodeURIComponent(`app.html${location.search}${location.hash}`)}#signin`);
      return;
    }
  }
  document.body.dataset.gate = "open";
  renderAccount();
  if (store) {
    baselineStore = account ? accountStore(store, account) : store;
    baseline = loadBaseline(baselineStore);
  }
  onPage(router.page);
  byId("debug").hidden = !DEBUG;
  renderFeatures();
  renderStatus();
  renderToday();
  renderCalibrationIdle();
  renderPower();
  renderAutoSend();
  renderKssReminder();
  renderDevMode();
  if (DEMO) answer.replaceChildren(demoCallout(DEMO_NOTE.saran));
  renderPipButton();
  void watchBattery();
  // The history shows even when the camera or the model fails below.
  void panel.open(historyDbName(account)).then(() => {
    selfReport.restoreKssClock(userTest?.started ?? null);
    insights = mountInsights(byId("insights-root"), { load: () => panel.allRecords(), evalIntervalMs: EVAL_INTERVAL_MS });
    insights.setVisible(router.page === "insights");
  });
  setInterval(() => void panel.refresh(), DASHBOARD_REFRESH_MS);
  userTest?.render();
  // KSS reminders (when on) and the test card's clock.
  setInterval(() => {
    const now = Date.now();
    selfReport.tick(now);
    userTest?.render(now);
  }, KSS_CHECK_MS);
  if (NO_CAMERA) {
    cameraFailed("Camera not started (?kamera=0).");
    return;
  }

  // First visit: the welcome screen says what stays on this laptop before the browser asks for the
  // camera; getUserMedia runs only after "Nyalakan kamera" (P17 C5).
  if (needsWelcome({ noCamera: NO_CAMERA, done: store !== null && welcomeDone(store), calibrated: baseline !== null })) {
    cameraOff = true;
    setFaceStatus("loading", "Camera is off");
    byId("welcome-next").textContent =
      `Next: a calibration of ${calibLength()}, then a state every ${EVAL_INTERVAL_MS / 1000} s.`;
    renderStatus();
    renderCalibrationIdle();
    welcomeScreen.showModal();
    await afterClick([welcomeGo, heroCamera], async () => {
      if (store) saveWelcomeDone(store);
      if (welcomeScreen.open) welcomeScreen.close();
      cameraOff = false;
      setFaceStatus("loading", "Loading camera and model…");
      renderStatus();
      renderCalibrationIdle();
    });
  }

  const [camera, model] = await Promise.allSettled([startCamera(), createDetectors()]);
  if (camera.status === "rejected") {
    console.error(camera.reason);
    cameraFailed(cameraErrorMessage(camera.reason));
    return;
  }
  if (model.status === "rejected") {
    console.error(model.reason);
    cameraFailed(
      "The face model didn't load. Reload the page; if it still fails, try the latest Chrome or Edge." +
        // The WASM files are copied when the dev server starts; only a developer can act on that.
        (import.meta.env.DEV ? " (Developer: restart npm run dev.)" : ""),
    );
    return;
  }

  bodyDetection = model.value.segmenter !== null;
  delegateOutput.textContent = `${model.value.delegate} · body ${bodyDetection ? "CPU" : "off"}`;
  resetWindow(performance.now());
  detecting = true;
  renderCalibrationIdle();
  renderFeatures();
  renderStatus();
  runDetection(model.value);
  maybeAskToCalibrate();
}

void main();
