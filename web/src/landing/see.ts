// "What you see vs. what we see": scrolling dissolves the line drawing in the camera frame into 478 points that fly
// to the right panel and settle as the face mesh, then the tracking boxes and the kept numbers appear.
// Scrubbed by ScrollTrigger (pinned on large screens); with reduced motion it shows the end state at once.
import { posePoints, sharedFace, seeded } from "./faceModel.ts";
import { clamp01, drawFace, easeInOutCubic, fitCanvas, formatReading, palette, project, smooth, type Fitted } from "./draw.ts";
import { CONDITIONS, gsap, type Conditions } from "./gsap.ts";

const FLIGHT_START = 0.12;
const FLIGHT_SPAN = 0.66;

/** Splits `total` samples across lengths in proportion (largest remainder), at least one each. */
export function allocate(lengths: readonly number[], total: number): number[] {
  const sum = lengths.reduce((a, b) => a + b, 0) || 1;
  const raw = lengths.map((l) => (l / sum) * total);
  const counts = raw.map((r) => Math.max(1, Math.floor(r)));
  let left = total - counts.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [i, r - Math.floor(r)] as const).sort((a, b) => b[1] - a[1]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) counts[order[k][0]]++;
  for (let k = 0; left < 0; k = (k + 1) % order.length) {
    const i = order[order.length - 1 - k][0];
    if (counts[i] > 1) {
      counts[i]--;
      left++;
    }
  }
  return counts;
}

export function initSee(section: HTMLElement, mm: gsap.MatchMedia): void {
  const scene = section.querySelector<HTMLElement>(".see-scene");
  const grid = section.querySelector<HTMLElement>(".see-grid");
  const canvas = section.querySelector<HTMLCanvasElement>(".see-canvas");
  const svg = section.querySelector<SVGSVGElement>(".figure-svg");
  const stage = section.querySelector<HTMLElement>(".mesh-stage");
  if (!scene || !grid || !canvas || !svg || !stage) return;
  const tracks = [...stage.querySelectorAll<HTMLElement>(".track")];
  const kept = [...section.querySelectorAll<HTMLElement>(".kept > div")];
  const counters = [...section.querySelectorAll<HTMLElement>("[data-count]")];
  const shapes = [...svg.querySelectorAll<SVGGeometryElement>("[data-sample]")];

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
  const now = new Float32Array(n * 2);
  let fitted: Fitted | null = null;
  let dot = 1.3;
  let progress = 0;
  let staticEnd = false;

  // Sample the drawing once, in its own units; mapped to the canvas on every layout.
  const lengths = shapes.map((el) => el.getTotalLength());
  const counts = allocate(lengths, n);
  const samples: { el: SVGGeometryElement; at: DOMPoint }[] = [];
  shapes.forEach((el, k) => {
    for (let j = 0; j < counts[k]; j++) samples.push({ el, at: el.getPointAtLength(((j + 0.5) / counts[k]) * lengths[k]) });
  });

  const layout = () => {
    fitted = fitCanvas(canvas);
    if (!fitted) return;
    const c = canvas.getBoundingClientRect();
    const st = stage.getBoundingClientRect();
    const s = Math.min(st.width / 1.9, st.height / 2.45);
    dot = Math.max(1, s / 105);
    const view = { cx: st.left - c.left + st.width / 2, cy: st.top - c.top + st.height * 0.53, s };
    project(neutral, view, target);

    const src = samples.map(({ el, at }) => {
      const m = el.getScreenCTM();
      const p = m ? at.matrixTransform(m) : at;
      return [p.x - c.left, p.y - c.top] as const;
    });
    const xs = src.map((p) => p[0]);
    const minX = Math.min(...xs);
    const spanX = Math.max(1, Math.max(...xs) - minX);
    // Pair top-to-bottom so the head lands on the forehead and the shoulders on the chin.
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
    const box = (indices: readonly number[], pad: number) => {
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
    const boxes: Record<string, ReturnType<typeof box>> = {
      eyeL: box([...face.eyeL.loop, ...face.eyeL.iris], s * 0.05),
      eyeR: box([...face.eyeR.loop, ...face.eyeR.iris], s * 0.05),
      mouth: box(face.mouth, s * 0.06),
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
    const settled = smooth(0.78, 0.9, p);
    if (settled > 0) drawFace(ctx, face, target, { ink: colors.ink, mesh: 0.1 * settled, contour: 0.38 * settled, pointAlpha: () => 0 });
    const shown = staticEnd ? 1 : smooth(0.03, 0.12, p);
    if (shown <= 0) return;
    const flight = (p - FLIGHT_START) / FLIGHT_SPAN;
    ctx.fillStyle = colors.ink;
    for (let i = 0; i < n; i++) {
      const t = easeInOutCubic(clamp01((flight - delay[i]) / dur[i]));
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      now[2 * i] = a * source[2 * i] + b * c0[2 * i] + c * c1[2 * i] + d * target[2 * i];
      now[2 * i + 1] = a * source[2 * i + 1] + b * c0[2 * i + 1] + c * c1[2 * i + 1] + d * target[2 * i + 1];
      const fill = face.points[i].kind === "fill";
      // Settled fill points fade to the mesh's lighter weight; points in flight stay solid.
      ctx.globalAlpha = shown * (fill ? 0.95 - 0.45 * t : 0.95);
      ctx.beginPath();
      ctx.arc(now[2 * i], now[2 * i + 1], fill ? dot * (1.1 - 0.25 * t) : dot * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const setCounter = (el: HTMLElement, f: number) => {
    const to = Number(el.dataset.count);
    el.textContent = formatReading(to * f, Number(el.dataset.decimals ?? 0), el.dataset.suffix ?? "");
  };

  new ResizeObserver(layout).observe(grid);

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
      .fromTo(svg, { opacity: 1 }, { opacity: 0.12, duration: 0.12 }, 0.04)
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
