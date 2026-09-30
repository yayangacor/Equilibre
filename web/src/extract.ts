// Dev-only page (extract.html, not part of the build): runs UTA-RLDD video frames served by
// scripts/extract-rldd.ts through the same detectors and pipeline modules as the live app
// (plan P04, NOTES D-14) and posts back a session-log CSV that scripts/replay.ts can read.
// No frame is drawn on the page; as in the app, only per-frame numbers leave it.
import { toBodySample, type BodyGrid, type BodySample } from "./body.ts";
import { createDetectors, segmentBody } from "./face.ts";
import { framesToCsv } from "./sessionLog.ts";
import { toFrameSignal, type FrameSignal } from "./signals.ts";

const FRAME_MS = 100; // the frames come at 10 fps, the app's detect_interval_ms
const BODY_EVERY = 5; // the app segments the body every 500 ms (BODY_INTERVAL_MS)
// Detector clock gap between two videos, so the landmarker's face tracking never carries over.
const JOB_GAP_MS = 10_000;
// "waktu" in the CSV then reads as the time into the video (local midnight + t).
const TIME_ORIGIN = new Date(2026, 0, 1).getTime();

type Job = { id: string; name: string; frames: number; comments: string[] };

const status = document.querySelector<HTMLElement>("#status")!;
const driver = new URLSearchParams(location.search).get("driver") ?? "http://127.0.0.1:8790";

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function run() {
  const { landmarker, delegate, segmenter } = await createDetectors();
  let clock = 0;
  for (;;) {
    const next = (await (await fetchOk(`${driver}/job`)).json()) as Job | { selesai: true };
    if ("selesai" in next) {
      status.textContent = "Selesai: tidak ada video lagi di antrean.";
      return;
    }
    const job = next;
    const frames: FrameSignal[] = [];
    const bodies: BodySample[] = [];
    let grid: BodyGrid | null = null;
    let size = "";
    for (let k = 0; k < job.frames; k++) {
      const image = await createImageBitmap(await (await fetchOk(`${driver}/frame/${job.id}/${k}`)).blob());
      try {
        const t = k * FRAME_MS;
        const now = clock + t + 1; // MediaPipe needs strictly increasing timestamps across videos
        // Same order as the app's tick: face first, then the body on every fifth frame.
        const result = landmarker.detectForVideo(image, now);
        if (segmenter && k % BODY_EVERY === 0) {
          const nextGrid = segmentBody(segmenter, image, now);
          if (nextGrid) {
            bodies.push(toBodySample(nextGrid, grid, t));
            grid = nextGrid;
          }
        }
        frames.push(toFrameSignal(result, image.width, image.height, t));
        size = `${image.width}x${image.height}`;
      } finally {
        image.close();
      }
      if (k % 200 === 0) status.textContent = `${job.name}: frame ${k} dari ${job.frames}…`;
    }
    clock += job.frames * FRAME_MS + JOB_GAP_MS;
    const csv = framesToCsv(frames, bodies, TIME_ORIGIN, [
      `Equilibre log sesi (ekstraktor UTA-RLDD), halaman dibuka ${new Date(TIME_ORIGIN).toISOString()}`,
      `window_ms=60000 eval_interval_ms=10000 detect_interval_ms=${FRAME_MS} body_interval_ms=${FRAME_MS * BODY_EVERY}`,
      ...job.comments,
      `delegate=${delegate} segmentasi_tubuh=${segmenter ? "ya" : "tidak"} ukuran_frame=${size}`,
    ]);
    // text/plain keeps the POST a simple CORS request (no preflight).
    await fetchOk(`${driver}/result/${job.id}`, { method: "POST", body: csv, headers: { "Content-Type": "text/plain" } });
  }
}

run().catch((err) => {
  status.textContent = `Gagal: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
