// The four "How it works" mini visuals: a baseline band forming, points flowing into a face mesh, a state chip
// changing every cycle, and advice cards with their sources sliding in. Loops run only while the visual is on screen.
import { posePoints, seeded, sharedFace } from "./faceModel.ts";
import { CONTOUR_ALPHA, MESH_ALPHA, clamp01, drawFace, fitCanvas, formatReading, palette, project, type Fitted } from "./draw.ts";
import { CONDITIONS, gsap, ScrollTrigger, type Conditions } from "./gsap.ts";

/** A calibration trace: eyes closed for a moment (low EAR), then a normal level with a few blinks. */
export function calibrationPath(): string {
  const rand = seeded(3);
  const parts = ["M10,122", "L56,122", "C64,122 62,62 70,62"];
  const blinks = new Set([104, 160, 206]);
  for (let x = 74; x <= 230; x += 4) {
    const y = blinks.has(x) ? 108 : 62 + (rand() - 0.5) * 9;
    parts.push(`L${x},${y.toFixed(1)}`);
  }
  return parts.join(" ");
}

const STATES = [
  { key: "normal", label: "Normal" },
  { key: "mild", label: "Mildly tired" },
  { key: "tired", label: "Tired" },
  { key: "asleep", label: "Asleep" },
  { key: "away", label: "Away" },
] as const;

// Tips the advice flow can give, each with the source it cites (knowledge/ in the repo).
const NUDGES = [
  { tip: "Take a brisk walk or climb a few flights of stairs.", source: "NIOSH" },
  { tip: "Move somewhere brighter. Daylight is the brightest light.", source: "NIOSH" },
  { tip: "Every 20 minutes, look 6 m away for 20 seconds.", source: "American Academy of Ophthalmology" },
];

/** Plays `loop` only while `el` is in view. */
function whileVisible(el: Element, loop: gsap.core.Timeline | gsap.core.Tween): void {
  ScrollTrigger.create({
    trigger: el,
    start: "top bottom",
    end: "bottom top",
    onToggle: (self) => (self.isActive ? loop.play() : loop.pause()),
  });
}

function calibrate(vis: HTMLElement, motion: boolean): void {
  const trace = vis.querySelector<SVGPathElement>(".cal-trace");
  const band = vis.querySelector<SVGRectElement>(".cal-band");
  const labels = vis.querySelectorAll<SVGTextElement>("text");
  if (!trace || !band) return;
  trace.setAttribute("d", calibrationPath());
  if (!motion) return;
  const tl = gsap.timeline({ paused: true });
  tl.fromTo(trace, { strokeDasharray: 1, strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1.6, ease: "power2.inOut" }, 0)
    .fromTo(band, { scaleY: 0, transformOrigin: "50% 50%" }, { scaleY: 1, duration: 0.9, ease: "expo.out" }, 1.0)
    .fromTo(labels, { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out", stagger: 0.25 }, 0.4);
  ScrollTrigger.create({ trigger: vis, start: "top 80%", once: true, onEnter: () => void tl.play() });
}

function watch(vis: HTMLElement, motion: boolean): void {
  const canvas = vis.querySelector<HTMLCanvasElement>("canvas");
  const counter = vis.querySelector<HTMLElement>("[data-points]");
  if (!canvas) return;
  const face = sharedFace();
  const n = face.points.length;
  const pos = posePoints(face.points, { blink: 0, jaw: 0.05 }, new Float32Array(n * 2));
  const px = new Float32Array(n * 2);
  const rand = seeded(11);
  const jitter = Array.from({ length: n }, () => [rand(), rand(), rand()] as const);
  const colors = palette();
  const state = { p: motion ? 0 : 1, scan: -1 };
  const land = new Float32Array(n);
  let fitted: Fitted | null = null;

  const draw = () => {
    if (!fitted) return;
    const { ctx, w, h } = fitted;
    const s = Math.min(w / 2.2, h / 2.5);
    project(pos, { cx: w * 0.5, cy: h * 0.5, s }, px);
    ctx.clearRect(0, 0, w, h);
    const minX = w * 0.5 - s * 0.8;
    for (let i = 0; i < n; i++) {
      const delay = 0.55 * clamp01((px[2 * i] - minX) / (s * 1.6)) + 0.1 * jitter[i][2];
      land[i] = clamp01((state.p - delay) / 0.35);
    }
    // The mesh lines join two points once both have arrived.
    drawFace(ctx, face, px, { ink: colors.ink, reveal: (i) => land[i] ** 3, mesh: MESH_ALPHA * 0.8, contour: CONTOUR_ALPHA, dots: 0, dot: 0.9 });
    const scanY = state.scan >= 0 ? (h * 0.5 - s * 1.1) + state.scan * s * 2.25 : -1e4;
    ctx.fillStyle = colors.ink;
    for (let i = 0; i < n; i++) {
      const [r1, r2] = jitter[i];
      const tx = px[2 * i];
      const ty = px[2 * i + 1];
      const t = land[i];
      const e = 1 - (1 - t) ** 3;
      const sx = -12 - r1 * 30;
      const sy = ty + (r2 - 0.5) * 50;
      const near = Math.max(0, 1 - Math.abs(ty - scanY) / 10);
      const fill = face.points[i].kind === "fill";
      ctx.globalAlpha = t <= 0 ? 0 : (fill ? 0.5 : 0.9) + 0.4 * near;
      ctx.beginPath();
      ctx.arc(sx + (tx - sx) * e, sy + (ty - sy) * e, (fill ? 0.7 : 0.9) + 0.9 * near, 0, Math.PI * 2);
      ctx.fill();
    }
    if (state.scan >= 0) {
      ctx.globalAlpha = 0.35;
      ctx.fillRect(w * 0.5 - s * 0.95, scanY, s * 1.9, 1);
    }
    ctx.globalAlpha = 1;
  };
  new ResizeObserver(() => {
    fitted = fitCanvas(canvas);
    draw();
  }).observe(canvas);
  if (!motion) return;

  const count = { v: 0 };
  const scan = gsap.fromTo(state, { scan: 0 }, { scan: 1, duration: 2.2, ease: "none", repeat: -1, repeatDelay: 0.6, paused: true, onUpdate: draw });
  const intro = gsap.timeline({ paused: true, onComplete: () => void scan.play() });
  intro
    .to(state, { p: 1, duration: 1.8, ease: "none", onUpdate: draw }, 0)
    .fromTo(count, { v: 0 }, { v: n, duration: 1.8, ease: "power2.out", onUpdate: () => counter && (counter.textContent = formatReading(count.v, 0)) }, 0);
  ScrollTrigger.create({ trigger: vis, start: "top 80%", once: true, onEnter: () => void intro.play() });
  ScrollTrigger.create({
    trigger: vis,
    start: "top bottom",
    end: "bottom top",
    onToggle: (self) => {
      if (!intro.progress() || intro.isActive()) return;
      if (self.isActive) scan.play();
      else scan.pause();
    },
  });
}

function pattern(vis: HTMLElement, motion: boolean): void {
  const chip = vis.querySelector<HTMLElement>(".chip");
  const text = chip?.querySelector<HTMLElement>(".chip-text");
  const segments = [...vis.querySelectorAll<HTMLElement>(".scale li")];
  const reason = vis.querySelector<HTMLElement>(".reason");
  const bar = vis.querySelector<HTMLElement>(".tick-bar span");
  if (!chip || !text || !reason || !bar || !motion) return;
  const set = (key: string, label: string) => {
    chip.dataset.state = key;
    text.textContent = label;
    segments.forEach((li) => li.classList.toggle("is-on", li.dataset.s === key));
  };
  const tl = gsap.timeline({ paused: true, repeat: -1 });
  for (const { key, label } of STATES) {
    tl.call(() => set(key, label))
      .fromTo(chip, { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: "power3.out" })
      .fromTo(reason, { opacity: 0, y: 4 }, { opacity: key === "tired" ? 1 : 0, y: 0, duration: 0.4, ease: "power3.out" }, "<")
      .fromTo(bar, { scaleX: 0 }, { scaleX: 1, duration: 2.2, ease: "none" }, "<");
  }
  set("normal", "Normal");
  gsap.set(reason, { opacity: 0 });
  whileVisible(vis, tl);
}

function nudge(vis: HTMLElement, motion: boolean): void {
  const card = vis.querySelector<HTMLElement>(".nudge");
  const text = vis.querySelector<HTMLElement>(".nudge-text");
  const source = vis.querySelector<HTMLElement>(".nudge-src span");
  if (!card || !text || !source || !motion) return;
  const tl = gsap.timeline({ paused: true, repeat: -1 });
  for (const { tip, source: from } of NUDGES) {
    tl.call(() => {
      text.textContent = tip;
      source.textContent = from;
    })
      .fromTo(card, { x: 28, opacity: 0 }, { x: 0, opacity: 1, duration: 0.7, ease: "power3.out" })
      .to(card, { x: -14, opacity: 0, duration: 0.35, ease: "power2.in" }, "+=2.2");
  }
  whileVisible(vis, tl);
}

export function initSteps(root: HTMLElement, mm: gsap.MatchMedia): void {
  const vis = (name: string) => root.querySelector<HTMLElement>(`[data-vis="${name}"]`);
  // "reduce" is listed so the handler also runs (static frames) when motion is reduced: matchMedia skips a
  // handler whose conditions all fail.
  mm.add({ motion: CONDITIONS.motion, reduce: CONDITIONS.reduce }, (context) => {
    const { motion = false } = context.conditions as Conditions;
    const steps: [string, (el: HTMLElement, motion: boolean) => void][] = [
      ["calibrate", calibrate],
      ["watch", watch],
      ["pattern", pattern],
      ["nudge", nudge],
    ];
    for (const [name, build] of steps) {
      const el = vis(name);
      if (el) build(el, motion);
    }
  });
}
