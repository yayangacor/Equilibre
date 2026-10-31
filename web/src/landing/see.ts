// "What you see vs. what we see": scrolling lifts 478 points off the edges of the camera picture, flies them to the
// right panel where they settle as MediaPipe's face mesh and its lines join up, then the tracking boxes and the kept
// numbers appear. Scrubbed by ScrollTrigger (pinned on large screens); with reduced motion it shows the end state at once.
import { posePoints, sharedFace, seeded } from "./faceModel.ts";
import { CONTOUR_ALPHA, MESH_ALPHA, clamp01, drawFace, easeInOutCubic, fitCanvas, formatReading, palette, project, smooth, type Fitted } from "./draw.ts";
import { CONDITIONS, gsap, type Conditions } from "./gsap.ts";

const FLIGHT_START = 0.12;
const FLIGHT_SPAN = 0.66;
/** Width the picture is scaled to before its edges are found. */
const SAMPLE_WIDTH = 240;

/** Picks `n` points on the strongest edges of a grayscale image (w × h, 0..255), spread apart, in 0..1 coordinates.
 * A picture with too few edges is topped up with spread random points, so there are always `n`. */
export function edgePoints(gray: ArrayLike<number>, w: number, h: number, n: number, seed = 5): [number, number][] {
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
      const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
      mag[i] = Math.hypot(gx, gy);
    }
  }
  // Candidates: the strongest 15% of pixels, above a floor so a flat picture has none, in a seeded random order.
  const floor = Math.max(60, Float32Array.from(mag).sort()[Math.floor(mag.length * 0.85)]);
  const rand = seeded(seed);
  const cand: number[] = [];
  for (let i = 0; i < mag.length; i++) if (mag[i] >= floor) cand.push(i);
  for (let k = cand.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [cand[k], cand[j]] = [cand[j], cand[k]];
  }

  // Greedy spread: take a candidate unless a taken point is closer than the gap; shrink the gap until n are taken.
  const out: [number, number][] = [];
  const free = (x: number, y: number, gap: number, grid: Map<number, [number, number][]>) => {
    const gx = Math.floor(x / gap);
    const gy = Math.floor(y / gap);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const [px, py] of grid.get((gx + dx) * 4096 + gy + dy) ?? []) if ((px - x) ** 2 + (py - y) ** 2 < gap * gap) return false;
      }
    }
    return true;
  };
  const taken = new Uint8Array(cand.length);
  for (let gap = Math.sqrt((w * h) / n); out.length < n && gap >= 0.75; gap *= 0.8) {
    const grid = new Map<number, [number, number][]>();
    const put = (p: [number, number]) => {
      const key = Math.floor(p[0] / gap) * 4096 + Math.floor(p[1] / gap);
      grid.set(key, [...(grid.get(key) ?? []), p]);
    };
    out.forEach(put);
    for (let k = 0; k < cand.length && out.length < n; k++) {
      if (taken[k]) continue;
      const p: [number, number] = [cand[k] % w, Math.floor(cand[k] / w)];
      if (!free(p[0], p[1], gap, grid)) continue;
      taken[k] = 1;
      out.push(p);
      put(p);
    }
  }
  while (out.length < n) out.push([rand() * (w - 1), rand() * (h - 1)]);
  return out.map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]);
}

/** Grayscale pixels of the picture, scaled down to SAMPLE_WIDTH. */
function grayOf(img: HTMLImageElement): { gray: Float32Array; w: number; h: number } | null {
  const w = SAMPLE_WIDTH;
  const h = Math.max(1, Math.round((w * img.naturalHeight) / img.naturalWidth));
  const ctx = Object.assign(document.createElement("canvas"), { width: w, height: h }).getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
  return { gray, w, h };
}

export function initSee(section: HTMLElement, mm: gsap.MatchMedia): void {
  const scene = section.querySelector<HTMLElement>(".see-scene");
  const grid = section.querySelector<HTMLElement>(".see-grid");
  const canvas = section.querySelector<HTMLCanvasElement>(".see-canvas");
  const img = section.querySelector<HTMLImageElement>(".cam-img");
  const stage = section.querySelector<HTMLElement>(".mesh-stage");
  if (!scene || !grid || !canvas || !img || !stage) return;
  const tracks = [...stage.querySelectorAll<HTMLElement>(".track")];
  const kept = [...section.querySelectorAll<HTMLElement>(".kept > div")];
  const counters = [...section.querySelectorAll<HTMLElement>("[data-count]")];

  const face = sharedFace();
  const n = face.points.length;
  const colors = palette();
  const neutral = posePoints(face.points, { blink: 0, jaw: 0.05 }, new Float32Array(n * 2));
  const target = new Float32Array(n * 2);
  const source = new Float32Array(n * 2);
  const c0 = new Float32Array(n * 2);
  const c1 = new Float32Array(n * 2);
  const delay = new Float32Array(n);
  const dur = new Float32Array(n);
  const land = new Float32Array(n);
  const now = new Float32Array(n * 2);
  let fitted: Fitted | null = null;
  let dot = 1.3;
  let progress = 0;
  let staticEnd = false;
  // Points on the picture's edges, in picture coordinates (0..1); until it has loaded, spread over the frame.
  let samples = edgePoints(new Float32Array(16 * 9), 16, 9, n);
  const sampleImage = () => {
    const pixels = img.naturalWidth ? grayOf(img) : null;
    if (pixels) samples = edgePoints(pixels.gray, pixels.w, pixels.h, n);
    layout();
  };

  const layout = () => {
    fitted = fitCanvas(canvas);
    if (!fitted) return;
    const c = canvas.getBoundingClientRect();
    const st = stage.getBoundingClientRect();
    const s = Math.min(st.width / 1.9, st.height / 2.45);
    dot = Math.max(0.9, s / 110);
    const view = { cx: st.left - c.left + st.width / 2, cy: st.top - c.top + st.height * 0.53, s };
    project(neutral, view, target);

    // The picture fills its frame like object-fit: cover, centred.
    const box = img.getBoundingClientRect();
    const natW = img.naturalWidth || 16;
    const natH = img.naturalHeight || 9;
    const scale = Math.max(box.width / natW, box.height / natH);
    const ox = box.left - c.left + (box.width - natW * scale) / 2;
    const oy = box.top - c.top + (box.height - natH * scale) / 2;
    const src = samples.map(([u, v]) => [
      Math.min(Math.max(ox + u * natW * scale, box.left - c.left), box.right - c.left),
      Math.min(Math.max(oy + v * natH * scale, box.top - c.top), box.bottom - c.top),
    ] as const);
    const xs = src.map((p) => p[0]);
    const minX = Math.min(...xs);
    const spanX = Math.max(1, Math.max(...xs) - minX);
    // Pair top-to-bottom so the top of the picture lands on the forehead and the desk on the chin.
    const srcOrder = src.map((_, i) => i).sort((a, b) => src[a][1] - src[b][1] || src[a][0] - src[b][0]);
    const tgtOrder = face.points.map((_, i) => i).sort((a, b) => target[2 * a + 1] - target[2 * b + 1] || target[2 * a] - target[2 * b]);
    const rand = seeded(7);
    tgtOrder.forEach((i, k) => {
      const [sx, sy] = src[srcOrder[k]];
      const tx = target[2 * i];
      const ty = target[2 * i + 1];
      source[2 * i] = sx;
      source[2 * i + 1] = sy;
      const dx = tx - sx;
      const dy = ty - sy;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const bend0 = (rand() - 0.5) * 0.55 * len;
      const bend1 = (rand() - 0.5) * 0.3 * len;
      c0[2 * i] = sx + ux * 0.25 * len - uy * bend0;
      c0[2 * i + 1] = sy + uy * 0.25 * len + ux * bend0;
      c1[2 * i] = tx - ux * 0.25 * len - uy * bend1;
      c1[2 * i + 1] = ty - uy * 0.25 * len + ux * bend1;
      delay[i] = 0.42 * ((sx - minX) / spanX) + 0.08 * rand();
      dur[i] = 0.42 + 0.08 * rand();
    });

    // Tracking boxes around both eyes and the mouth, in stage coordinates.
    const boxOf = (indices: readonly number[], pad: number) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const i of indices) {
        x0 = Math.min(x0, target[2 * i]);
        x1 = Math.max(x1, target[2 * i]);
        y0 = Math.min(y0, target[2 * i + 1]);
        y1 = Math.max(y1, target[2 * i + 1]);
      }
      const ox = st.left - c.left;
      const oy = st.top - c.top;
      return { left: x0 - pad - ox, top: y0 - pad - oy, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad };
    };
    const boxes: Record<string, ReturnType<typeof boxOf>> = {
      eyeL: boxOf([...face.eyeL.loop, ...face.eyeL.iris], s * 0.05),
      eyeR: boxOf([...face.eyeR.loop, ...face.eyeR.iris], s * 0.05),
      mouth: boxOf(face.mouth, s * 0.06),
    };
    for (const el of tracks) {
      const b = boxes[el.dataset.track ?? ""];
      if (!b) continue;
      el.style.left = `${b.left}px`;
      el.style.top = `${b.top}px`;
      el.style.width = `${b.width}px`;
      el.style.height = `${b.height}px`;
    }
    render();
  };

  const render = () => {
    if (!fitted) return;
    const { ctx, w, h } = fitted;
    ctx.clearRect(0, 0, w, h);
    const p = staticEnd ? 1 : progress;
    const shown = staticEnd ? 1 : smooth(0.03, 0.12, p);
    if (shown <= 0) return;
    const flight = (p - FLIGHT_START) / FLIGHT_SPAN;
    for (let i = 0; i < n; i++) land[i] = staticEnd ? 1 : easeInOutCubic(clamp01((flight - delay[i]) / dur[i]));
    // The mesh lines join two points once both have landed.
    drawFace(ctx, face, target, { ink: colors.ink, reveal: (i) => smooth(0.85, 1, land[i]), mesh: MESH_ALPHA, contour: CONTOUR_ALPHA, dots: 0, dot });
    ctx.fillStyle = colors.ink;
    for (let i = 0; i < n; i++) {
      const t = land[i];
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      now[2 * i] = a * source[2 * i] + b * c0[2 * i] + c * c1[2 * i] + d * target[2 * i];
      now[2 * i + 1] = a * source[2 * i + 1] + b * c0[2 * i + 1] + c * c1[2 * i + 1] + d * target[2 * i + 1];
      const fill = face.points[i].kind === "fill";
      // Landed surface points fade to the mesh's lighter weight; points in flight stay solid.
      ctx.globalAlpha = shown * (fill ? 0.95 - 0.45 * t : 0.95 - 0.05 * t);
      ctx.beginPath();
      ctx.arc(now[2 * i], now[2 * i + 1], fill ? dot * (1.2 - 0.45 * t) : dot * (1.2 - 0.2 * t), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const setCounter = (el: HTMLElement, f: number) => {
    const to = Number(el.dataset.count);
    el.textContent = formatReading(to * f, Number(el.dataset.decimals ?? 0), el.dataset.suffix ?? "");
  };

  new ResizeObserver(layout).observe(grid);
  if (img.complete) sampleImage();
  else img.addEventListener("load", sampleImage, { once: true });

  mm.add({ motion: CONDITIONS.motion, reduce: CONDITIONS.reduce, pinnable: CONDITIONS.pinnable }, (context) => {
    const { motion, pinnable } = context.conditions as Conditions;
    if (!motion) {
      staticEnd = true;
      counters.forEach((el) => setCounter(el, 1));
      layout();
      return () => {
        staticEnd = false;
      };
    }
    const proxy = { p: 0 };
    const count = { f: 0 };
    const tl = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: pinnable
        ? { trigger: scene, start: "top top", end: "+=160%", pin: true, scrub: 0.6, invalidateOnRefresh: true }
        : // Unpinned (phones, short screens): finish while both panels are still in view.
          { trigger: grid, start: "top 85%", end: "bottom 80%", scrub: 0.6, invalidateOnRefresh: true },
    });
    tl.to(proxy, { p: 1, duration: 1, onUpdate: () => ((progress = proxy.p), render()) }, 0)
      .fromTo(img, { opacity: 1 }, { opacity: 0.2, duration: 0.14 }, 0.04)
      .fromTo(tracks, { opacity: 0, scale: 1.3 }, { opacity: 1, scale: 1, duration: 0.06, stagger: 0.02, ease: "power3.out" }, 0.8)
      .fromTo(kept, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.06, stagger: 0.03, ease: "power3.out" }, 0.84)
      .fromTo(count, { f: 0 }, { f: 1, duration: 0.1, ease: "power2.out", onUpdate: () => counters.forEach((el) => setCounter(el, count.f)) }, 0.83)
      .to({}, { duration: 0.06 }, 0.94);
    layout();
    return () => {
      progress = 0;
    };
  });
}
