// Hero readout: MediaPipe's face mesh drawn as a wireframe, with three annotated readouts and an EAR trace.
// The eyes blink every 3–5 s (about 15 a minute) and the EAR readout and trace dip with them, computed from the
// drawn lid points; the head turns a little from side to side. Nothing here touches the camera.
import { OPEN_EAR, earReading, posePoints, seeded, sharedFace } from "./faceModel.ts";
import { CONTOUR_ALPHA, MESH_ALPHA, clamp01, drawFace, fitCanvas, formatReading, palette, project, type Fitted } from "./draw.ts";
import { prefersReducedMotion } from "./gsap.ts";

const BLINK_MS = 280;
const TRACE_SAMPLES = 240; // 12 s at 20 Hz
const TRACE_MAX = 0.36;
const BAND = [0.26, 0.32] as const;

type ReadoutName = "ear" | "blinks" | "jaw";

/** 0 → 1 → 0 over one blink: lids close fast, hold briefly, open a little slower. */
function blinkCurve(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  if (u < 0.35) return (u / 0.35) ** 2;
  if (u < 0.5) return 1;
  const v = (u - 0.5) / 0.5;
  return 1 - v * (2 - v);
}

export function initHero(root: HTMLElement): void {
  const stage = root.querySelector<HTMLElement>(".hero-stage");
  const canvas = root.querySelector<HTMLCanvasElement>(".hero-canvas");
  if (!stage || !canvas) return;
  const readouts = new Map<ReadoutName, HTMLElement>();
  for (const name of ["ear", "blinks", "jaw"] as const) {
    const el = stage.querySelector<HTMLElement>(`[data-ro="${name}"]`);
    if (el) readouts.set(name, el);
  }
  const value = (name: ReadoutName) => readouts.get(name)?.querySelector<HTMLElement>(".ro-v") ?? null;
  const earValue = value("ear");
  const blinksValue = value("blinks");
  const jawValue = value("jaw");

  const face = sharedFace();
  const n = face.points.length;
  const pos = new Float32Array(n * 2);
  const px = new Float32Array(n * 2);
  const colors = palette();
  const rand = seeded(15);
  const reduced = prefersReducedMotion();
  const introDelay = face.points.map((p) => (Math.hypot(p.x, p.y * 0.85) / 1.1) * 0.6);
  // Leader-line anchors: outer corner of the viewer's left eye, outer upper lid of the right eye, right mouth corner.
  const anchorOf: Record<ReadoutName, number> = {
    ear: face.eyeL.loop[0],
    blinks: face.eyeR.ear[2],
    jaw: face.mouthCorners[1],
  };

  let fitted: Fitted | null = null;
  const attach = new Map<ReadoutName, { x: number; y: number; left: boolean }>();
  const measure = () => {
    fitted = fitCanvas(canvas);
    // Layout offsets, not client rects: the readouts may still be mid intro-animation (translated).
    for (const [name, el] of readouts) {
      const left = el.offsetLeft + el.offsetWidth / 2 < canvas.offsetWidth / 2;
      attach.set(name, { x: left ? el.offsetLeft + el.offsetWidth : el.offsetLeft, y: el.offsetTop + el.offsetHeight / 2, left });
    }
  };

  const trace = new Float32Array(TRACE_SAMPLES).map(() => OPEN_EAR + (rand() - 0.5) * 0.008);
  let head = 0;
  let lastSample = 0;
  let lastEarText = 0;
  let lastJawText = 0;
  let nextBlinksText = 4000;
  let blinksPerMin = 15;
  let blinkStart = -1e6;
  let nextBlink = 1600;
  const t0 = performance.now();

  const draw = (t: number) => {
    if (!fitted) return;
    const { ctx, w, h } = fitted;
    if (!reduced && t >= nextBlink) {
      blinkStart = t;
      nextBlink = t + 3000 + rand() * 2000;
    }
    const blink = reduced ? 0 : blinkCurve((t - blinkStart) / BLINK_MS);
    const jaw = reduced ? 0.06 : 0.06 + 0.012 * Math.sin(t / 5200);
    posePoints(face.points, { blink, jaw, yaw: reduced ? 0 : 0.12 * Math.sin(t / 5600) }, pos);
    const s = Math.min(w * (w > 460 ? 0.28 : 0.25), (h * 0.72) / 2.3);
    const still = reduced ? 0 : 1;
    project(pos, { cx: w / 2 + 3 * Math.sin(t / 4300) * still, cy: h * 0.41 + 2 * Math.sin(t / 3700) * still, s, rot: 0.012 * Math.sin(t / 3100) * still }, px);
    const ear = (earReading(face, pos, face.eyeL) + earReading(face, pos, face.eyeR)) / 2;

    if (t - lastSample >= 50) {
      lastSample = t;
      trace[head] = ear + (blink > 0 ? 0 : (rand() - 0.5) * 0.008);
      head = (head + 1) % TRACE_SAMPLES;
    }
    if (earValue && t - lastEarText >= 120) {
      lastEarText = t;
      earValue.textContent = formatReading(blink > 0 ? ear : ear + (rand() - 0.5) * 0.006, 2);
    }
    if (jawValue && t - lastJawText >= 900) {
      lastJawText = t;
      jawValue.textContent = formatReading(jaw, 2);
    }
    if (blinksValue && t >= nextBlinksText) {
      nextBlinksText = t + 4000 + rand() * 3000;
      blinksPerMin = Math.max(14, Math.min(16, blinksPerMin + (rand() < 0.5 ? -1 : 1)));
      blinksValue.textContent = `${blinksPerMin}/min`;
    }

    ctx.clearRect(0, 0, w, h);
    const intro = reduced ? 10 : t / 1000;

    // EAR trace with the shaded baseline band (the "your normal" range).
    const top = h * 0.83;
    const bottom = h * 0.95;
    const left = 16;
    const right = w - 16;
    const yOf = (v: number) => bottom - (v / TRACE_MAX) * (bottom - top);
    const traceIn = clamp01((intro - 0.6) / 0.8);
    ctx.globalAlpha = traceIn;
    ctx.fillStyle = colors.normalTint;
    ctx.fillRect(left, yOf(BAND[1]), right - left, yOf(BAND[0]) - yOf(BAND[1]));
    ctx.strokeStyle = colors.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, bottom + 0.5);
    ctx.lineTo(right, bottom + 0.5);
    ctx.stroke();
    ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillStyle = colors.ink3;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillText("EAR", left, top - 8);
    ctx.textAlign = "right";
    ctx.fillText("BASELINE", right, top - 8);
    ctx.fillStyle = colors.normalTint;
    ctx.fillRect(right - ctx.measureText("BASELINE").width - 16, top - 16, 10, 8);
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    const visible = Math.round(TRACE_SAMPLES * traceIn);
    for (let k = 0; k < visible; k++) {
      const v = trace[(head + TRACE_SAMPLES - visible + k) % TRACE_SAMPLES];
      const x = left + ((right - left) * (k + TRACE_SAMPLES - visible)) / (TRACE_SAMPLES - 1);
      if (k === 0) ctx.moveTo(x, yOf(v));
      else ctx.lineTo(x, yOf(v));
    }
    ctx.stroke();
    if (visible > 0) {
      ctx.fillStyle = colors.ink;
      ctx.beginPath();
      ctx.arc(right, yOf(trace[(head + TRACE_SAMPLES - 1) % TRACE_SAMPLES]), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // The face, weaving itself from the centre outwards on load.
    drawFace(ctx, face, px, {
      ink: colors.ink,
      reveal: (i) => clamp01((intro - introDelay[i]) / 0.35),
      mesh: MESH_ALPHA,
      contour: CONTOUR_ALPHA,
      dot: Math.max(0.9, s / 120),
    });

    // Leader lines from each landmark to its readout.
    const lines = clamp01((intro - 0.9) / 0.5);
    if (lines > 0) {
      ctx.globalAlpha = lines;
      ctx.strokeStyle = colors.ink;
      ctx.fillStyle = colors.ink;
      ctx.lineWidth = 1;
      for (const [name, a] of attach) {
        const i = anchorOf[name];
        const ax = px[2 * i];
        const ay = px[2 * i + 1];
        const ex = a.x + (a.left ? 16 : -16);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(ex, a.y);
        ctx.lineTo(ax, ay);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ax, ay, 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ax, ay, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  };

  let running = false;
  let visible = true;
  let raf = 0;
  const loop = (now: number) => {
    draw(now - t0);
    raf = requestAnimationFrame(loop);
  };
  const update = () => {
    const should = !reduced && visible && document.visibilityState === "visible";
    if (should && !running) raf = requestAnimationFrame(loop);
    if (!should && running) cancelAnimationFrame(raf);
    running = should;
  };

  new ResizeObserver(() => {
    measure();
    draw(reduced ? 0 : performance.now() - t0);
  }).observe(stage);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    update();
  }).observe(stage);
  document.addEventListener("visibilitychange", update);
  void document.fonts.ready.then(() => {
    measure();
    draw(reduced ? 0 : performance.now() - t0);
  });
  measure();
  update();
}
