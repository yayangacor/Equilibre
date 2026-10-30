// Landing page (NOTES D-78, plan P18 step 5): "The Readout", an instrument on paper. It never turns on the camera;
// every face on this page is generated from a seed.
import "../design/tokens.css";
import "./landing.css";
import { gsap, ScrollTrigger } from "./gsap.ts";
import { initHero } from "./hero.ts";
import { initReveals } from "./reveal.ts";
import { initSee } from "./see.ts";
import { applySession } from "./session.ts";
import { initSteps } from "./steps.ts";
import { initStrip } from "./strip.ts";

applySession(document);

const nav = document.querySelector<HTMLElement>(".nav");
if (nav) {
  const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

const mm = gsap.matchMedia();
const hero = document.querySelector<HTMLElement>(".hero");
if (hero) initHero(hero);
initReveals(document, mm);
initStrip(document.body, mm);
const how = document.querySelector<HTMLElement>("#how");
if (how) initSteps(how, mm);
const see = document.querySelector<HTMLElement>("#see");
if (see) initSee(see, mm);
// Plex loads after first paint and changes line heights; re-measure every trigger once it has.
void document.fonts.ready.then(() => ScrollTrigger.refresh());
