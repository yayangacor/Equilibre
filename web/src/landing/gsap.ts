// GSAP with ScrollTrigger, registered once for the landing page.
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/** matchMedia conditions every landing animation is built under. */
export const CONDITIONS = {
  motion: "(prefers-reduced-motion: no-preference)",
  reduce: "(prefers-reduced-motion: reduce)",
  // Pin the "What you see" scene only where both panels and the header fit on one screen.
  pinnable: "(min-width: 960px) and (min-height: 700px)",
};

export type Conditions = { motion?: boolean; reduce?: boolean; pinnable?: boolean };

export const prefersReducedMotion = (): boolean => window.matchMedia(CONDITIONS.reduce).matches;

export { gsap, ScrollTrigger };
