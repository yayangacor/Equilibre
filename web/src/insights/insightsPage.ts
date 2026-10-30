import gsap from "gsap";
import type { DayData } from "../history.ts";
import { createBubbles } from "./bubbles.ts";
import { createDailyBars } from "./dailyBars.ts";
import { el, reducedMotion } from "./dom.ts";
import { createEssay } from "./essay.ts";
import { createHeatmap } from "./heatmap.ts";
import "./insights.css";
import {
  blockSizeFor,
  buildBlocks,
  buildDaily,
  buildHeatmap,
  essayFacts,
  essaySteps,
  RANGES,
  sliceRange,
  summaryLine,
  totalsOf,
  type RangeKey,
} from "./model.ts";

// The Insights page (NOTES D-78): header with the range, a personal essay beside a sticky bubble graphic, the
// hour × day heatmap and the daily stacked bars. Everything is computed on this device from the local history
// (history.ts); nothing here is sent anywhere. The camera detector runs in the same tab, so nothing animates
// while the page is hidden or off-screen, and motion is one-shot (GSAP opacity/transform on a few elements).

export type InsightsSource = { load: () => Promise<DayData | null>; evalIntervalMs: number; now?: () => number };

export function mountInsights(root: HTMLElement, source: InsightsSource): { refresh(): Promise<void>; setVisible(visible: boolean): void } {
  const now = source.now ?? Date.now;
  let range: RangeKey = "7d";
  let data: DayData | null = null;
  let loaded = false;
  let visible = true;
  let pending = false; // a render was skipped while the page was hidden
  let token = 0;

  root.classList.add("ins");

  // ── Header ──
  const head = el("header", "ins-head");
  const row = el("div", "ins-head-row");
  const title = el("h1", "ins-title", "Your ");
  title.append(el("span", "serif-accent", "pattern"));
  const seg = el("div", "ins-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Range");
  const rangeButtons = RANGES.map((r) => {
    const b = el("button", undefined, r.label);
    b.type = "button";
    b.dataset.range = r.key;
    b.setAttribute("aria-pressed", String(r.key === range));
    b.addEventListener("click", () => {
      if (range === r.key) return;
      range = r.key;
      for (const x of rangeButtons) x.setAttribute("aria-pressed", String(x.dataset.range === range));
      render(true);
    });
    return b;
  });
  seg.append(...rangeButtons);
  row.append(title, seg);
  const summary = el("p", "ins-summary mono");
  summary.setAttribute("aria-live", "polite");
  head.append(el("p", "eyebrow", "Insights"), row, summary);

  // ── Empty state ──
  const empty = el("div", "ins-empty");
  empty.append(
    el("p", "ins-empty-title", "No pattern yet."),
    el("p", "ins-empty-text", "Insights appear after your first hour of monitoring. Everything here is computed on this device."),
  );
  empty.hidden = true;

  // ── Body ──
  const body = el("div", "ins-body");
  body.hidden = true;
  const story = el("section", "ins-story");
  story.setAttribute("aria-label", "Your pattern, step by step");
  const graphic = el("div", "ins-graphic");
  const bubbles = createBubbles();
  graphic.append(bubbles.root);
  const essayCol = el("div", "ins-essay");
  const essay = createEssay((step) => bubbles.setMode(step.mode, step.highlight));
  essayCol.append(essay.root);
  story.append(graphic, essayCol);
  const heatmap = createHeatmap();
  const daily = createDailyBars();
  body.append(story, heatmap.root, daily.root);

  root.replaceChildren(head, empty, body);

  function reveal(targets: Element[]) {
    if (!visible || document.hidden || reducedMotion()) return;
    gsap.fromTo(targets, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.45, stagger: 0.06, ease: "power3.out", clearProps: "opacity,transform" });
  }

  function render(animate: boolean) {
    if (!loaded) return;
    if (!visible) {
      pending = true;
      return;
    }
    pending = false;
    const slice = sliceRange(data, range, now(), source.evalIntervalMs);
    const totals = totalsOf(slice);
    if (totals.judged <= 0) {
      empty.hidden = false;
      body.hidden = true;
      summary.textContent = "";
      if (animate) reveal([empty]);
      return;
    }
    empty.hidden = true;
    body.hidden = false;
    summary.textContent = summaryLine(totals);
    const size = blockSizeFor(slice.judged);
    bubbles.setData(buildBlocks(slice.judged, slice.each, size), size);
    essay.update(essaySteps(essayFacts(slice, size)));
    heatmap.update(buildHeatmap(slice));
    daily.update(buildDaily(slice));
    const first = essay.root.firstElementChild;
    if (animate) reveal(first ? [summary, graphic, first] : [summary, graphic]);
  }

  async function refresh() {
    const mine = ++token;
    let next: DayData | null = null;
    try {
      next = await source.load();
    } catch (err) {
      console.warn("Insights: the history could not be read.", err);
    }
    if (mine !== token) return; // a newer refresh is on its way
    data = next;
    loaded = true;
    render(true);
  }

  void refresh();

  return {
    refresh,
    setVisible(v: boolean) {
      if (v === visible) return;
      visible = v;
      bubbles.setVisible(v);
      if (v && pending) render(false);
    },
  };
}
