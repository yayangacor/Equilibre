import "./style.css";
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { createFaceLandmarker } from "./face.ts";

const DETECT_INTERVAL_MS = 100; // ±10 fps: enough to catch blinks, easy on laptop batteries
const SHOWN_BLENDSHAPES = ["eyeBlinkLeft", "eyeBlinkRight", "jawOpen"] as const;
const SAMPLE_FEATURES = {
  label: "lelah",
  skor: 0.78,
  perclos: 0.18,
  kedip_per_menit: 9,
  menguap: 2,
  menit_sejak_jeda: 95,
};

type FaceState = "loading" | "found" | "missing" | "error";
type AnalyzeResponse = { text: string; result: unknown };

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = byId<HTMLVideoElement>("video");
const faceStatus = byId("face-status");
const fpsOutput = byId("fps");
const delegateOutput = byId("delegate");
const sendButton = byId<HTMLButtonElement>("send-sample");
const answer = byId("answer");

function el(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

const blendshapeRows = new Map(
  SHOWN_BLENDSHAPES.map((name) => {
    const bar = document.createElement("span");
    const value = el("output", "–");
    const track = document.createElement("div");
    track.className = "bar";
    track.append(bar);
    const dd = document.createElement("dd");
    dd.append(track, value);
    const row = document.createElement("div");
    row.className = "metric";
    row.append(el("dt", name), dd);
    byId("blendshapes").append(row);
    return [name, { bar, value }] as const;
  }),
);

function setFaceStatus(state: FaceState, text: string) {
  faceStatus.dataset.state = state;
  faceStatus.textContent = text;
}

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

function render(result: FaceLandmarkerResult) {
  const found = result.faceLandmarks.length > 0;
  setFaceStatus(found ? "found" : "missing", found ? "Wajah terdeteksi" : "Wajah tidak terdeteksi");

  const categories = result.faceBlendshapes[0]?.categories ?? [];
  for (const [name, row] of blendshapeRows) {
    const score = categories.find((c) => c.categoryName === name)?.score;
    row.value.textContent = score === undefined ? "–" : score.toFixed(2);
    row.bar.style.width = `${(score ?? 0) * 100}%`;
  }
}

function runDetection(landmarker: FaceLandmarker) {
  let lastVideoTime = -1;
  let frames = 0;
  let fpsWindowStart = performance.now();

  const tick = () => {
    const now = performance.now();
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      render(landmarker.detectForVideo(video, now));
      frames++;
    }
    if (now - fpsWindowStart >= 1000) {
      fpsOutput.textContent = ((frames * 1000) / (now - fpsWindowStart)).toFixed(1);
      frames = 0;
      fpsWindowStart = now;
    }
    setTimeout(tick, Math.max(0, DETECT_INTERVAL_MS - (performance.now() - now)));
  };
  tick();
}

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

async function sendSample() {
  sendButton.disabled = true;
  answer.replaceChildren(el("p", "Menunggu jawaban Langflow…", "muted"));
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SAMPLE_FEATURES),
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
    sendButton.disabled = false;
  }
}

async function main() {
  byId("sample").textContent = JSON.stringify(SAMPLE_FEATURES, null, 2);
  sendButton.addEventListener("click", sendSample);

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
  runDetection(model.value.landmarker);
}

void main();
