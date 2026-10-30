// "A timer" vs "Equilibre" strip: the timer rings at fixed points; the body signal wanders inside its baseline band,
// then drifts out of it, and that is where Equilibre speaks up. Illustrative shape, no data.
import { seeded } from "./faceModel.ts";
import { gsap, ScrollTrigger, type Conditions } from "./gsap.ts";

const BAND_BOTTOM = 38;

/** The signal row's y (0..60, down = more tired) at x (0..1). */
export function signalAt(x: number, noise: number): number {
  const drift = Math.max(0, (x - 0.55) / 0.45);
  return 28 + drift * drift * 30 + noise * (1 - 0.4 * drift);
}

export function initStrip(root: HTMLElement, mm: gsap.MatchMedia): void {
  const strip = root.querySelector<HTMLElement>(".strip");
  const path = strip?.querySelector<SVGPathElement>(".strip-trace");
  if (!strip || !path) return;
  const rand = seeded(25);
  const pts: [number, number][] = [];
  for (let k = 0; k <= 100; k++) {
    const x = k / 100;
    pts.push([x * 1000, signalAt(x, (rand() - 0.5) * 9)]);
  }
  path.setAttribute("d", pts.map(([x, y], k) => `${k ? "L" : "M"}${x.toFixed(0)},${y.toFixed(1)}`).join(" "));
  // Markers where the signal leaves the band (mildly tired) and later, further out (tired).
  const exit = pts.find(([x, y]) => x > 550 && y > BAND_BOTTOM + 2) ?? pts[72];
  const later = pts[92];
  const place = (el: HTMLElement | null, [x, y]: [number, number]) => {
    if (!el) return;
    el.style.left = `${x / 10}%`;
    el.style.top = `${(y / 60) * 100}%`;
  };
  place(strip.querySelector<HTMLElement>("[data-mark='mild']"), exit);
  place(strip.querySelector<HTMLElement>("[data-mark='tired']"), later);
  const note = strip.querySelector<HTMLElement>(".strip-note");
  if (note) note.style.left = `${exit[0] / 10}%`;

  mm.add({ motion: "(prefers-reduced-motion: no-preference)" }, (context) => {
    const { motion } = context.conditions as Conditions;
    if (!motion) return;
    const plots = strip.querySelectorAll<HTMLElement>(".strip-plot svg");
    const marks = strip.querySelectorAll<HTMLElement>(".strip-mark, .strip-note, .strip-ring");
    const tl = gsap.timeline({ paused: true });
    tl.fromTo(plots, { clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0% 0 0)", duration: 1.4, ease: "power2.inOut", stagger: 0.25 }, 0)
      .fromTo(marks, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.5, ease: "power3.out", stagger: 0.08 }, 1.1);
    ScrollTrigger.create({ trigger: strip, start: "top 80%", once: true, onEnter: () => void tl.play() });
  });
}
