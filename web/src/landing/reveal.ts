// Section reveals in the Museum of Motion pattern: a rule draws across (0.7 s), labels rise, then headings settle.
// Each group plays once when its top crosses 85% of the viewport. Focus inside a group finishes it at once, so the
// keyboard never lands on something invisible. Reduced motion: nothing is hidden or moved.
import { gsap, ScrollTrigger, type Conditions } from "./gsap.ts";

function once(group: Element, tl: gsap.core.Timeline): void {
  ScrollTrigger.create({ trigger: group, start: "top 85%", once: true, onEnter: () => void tl.play() });
  group.addEventListener("focusin", () => tl.progress(1));
}

function sectionHeads(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>(".sec-head").forEach((head) => {
    const rule = head.querySelector(".sec-rule");
    const eyebrow = head.querySelector(".eyebrow");
    const title = head.querySelector("h2");
    const tl = gsap.timeline({ paused: true });
    if (rule) tl.fromTo(rule, { scaleX: 0 }, { scaleX: 1, transformOrigin: "0% 50%", duration: 0.7, ease: "power3.out", immediateRender: true }, 0);
    if (eyebrow) tl.fromTo(eyebrow, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.45, ease: "power3.out", immediateRender: true }, 0.1);
    if (title) tl.fromTo(title, { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 1.0, ease: "expo.out", immediateRender: true }, 0.18);
    once(head, tl);
  });
}

/** Ruled rows (comparison table, steps, privacy ledger): each row's rule draws, then its content rises. */
function ruledRows(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[data-rows]").forEach((group) => {
    const rows = [...group.querySelectorAll<HTMLElement>("[data-row]")];
    if (!rows.length) return;
    const tl = gsap.timeline({ paused: true });
    tl.fromTo(rows, { "--draw": 0 }, { "--draw": 1, duration: 0.7, ease: "power3.out", stagger: 0.09, immediateRender: true }, 0).fromTo(
      rows.flatMap((row) => [...row.children]),
      { opacity: 0, y: 12 },
      { opacity: 1, y: 0, duration: 0.6, ease: "power3.out", stagger: 0.04, immediateRender: true },
      0.12,
    );
    once(group, tl);
  });
}

function singles(root: ParentNode): void {
  const items = [...root.querySelectorAll<HTMLElement>("[data-reveal]")];
  if (!items.length) return;
  gsap.set(items, { opacity: 0, y: 16 });
  ScrollTrigger.batch(items, {
    start: "top 88%",
    once: true,
    onEnter: (batch) => void gsap.to(batch, { opacity: 1, y: 0, duration: 0.8, ease: "power3.out", stagger: 0.08 }),
  });
  items.forEach((el) => el.addEventListener("focusin", () => gsap.set(el, { opacity: 1, y: 0 })));
}

export function initReveals(root: ParentNode, mm: gsap.MatchMedia): void {
  mm.add({ motion: "(prefers-reduced-motion: no-preference)" }, (context) => {
    const { motion } = context.conditions as Conditions;
    if (!motion) return;
    sectionHeads(root);
    ruledRows(root);
    singles(root);
  });
}
