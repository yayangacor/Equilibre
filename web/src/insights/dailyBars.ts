import type { Label } from "../rules.ts";
import { STATE_NAME, STATE_TOKEN } from "../stateCopy.ts";
import { el, srTable, svgEl, Tooltip, type TipLine } from "./dom.ts";
import { dateOf, dayLabel, formatDuration, plural, weekdayOf, type DayTotal } from "./model.ts";

// "Day by day": judged minutes at the screen per state and day, stacked from Normal at the base to Asleep on
// top, with a row of break dots under the axis. Away stays out of the bars (it is time away, not a state at
// the screen) and is named in the tooltip. Drawn again only when its width changes.

const STACK: readonly Label[] = ["normal", "lelah ringan", "lelah", "tertidur"];
const M = { left: 52, right: 8, top: 12 };
const PLOT_H = 180;
const AXIS_H = 34; // day labels
const DOTS_H = 22; // break row
const GAP = 2; // surface gap between stacked segments
const BAR_MAX = 24;
const STEPS = [15, 30, 60, 120, 180, 240, 360, 480, 720];

const tickLabel = (min: number) => (min === 0 ? "0" : min < 60 ? `${min} min` : `${min / 60} h`);

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export type DailyBarsView = { root: HTMLElement; update(days: readonly DayTotal[]): void; destroy(): void };

export function createDailyBars(): DailyBarsView {
  const root = el("figure", "ins-fig");
  const head = el("div", "ins-fig-head");
  head.append(el("h2", "ins-fig-title", "Day by day"), el("p", "ins-fig-sub", "Screen time per state, with the breaks you took"));
  const stage = el("div", "ins-db-stage");
  const svg = svgEl("svg", { class: "ins-db-svg", role: "img" });
  stage.append(svg);
  const tip = new Tooltip(stage);
  const legend = el("ul", "ins-legend");
  for (const l of STACK) {
    const li = el("li");
    const sw = el("span", "ins-sq");
    sw.dataset.s = STATE_TOKEN[l];
    li.append(sw, el("span", undefined, STATE_NAME[l]));
    legend.append(li);
  }
  const brk = el("li");
  brk.append(el("span", "ins-dot ins-dot-ink"), el("span", undefined, "Break"));
  legend.append(brk);
  const tableHost = el("div");
  root.append(head, stage, legend, tableHost);

  let days: readonly DayTotal[] = [];
  let width = 0;

  const lines = (d: DayTotal): TipLine[] => {
    const out: TipLine[] = [{ text: dayLabel(d.day, "long"), strong: true }];
    if (d.judged < 0.5) out.push({ text: "No readings" });
    else out.push({ text: `${formatDuration(d.atScreen)} at the screen` });
    for (const l of [...STACK].reverse()) if (d.minutes[l] >= 0.5) out.push({ text: `${STATE_NAME[l]} ${formatDuration(d.minutes[l])}`, state: l });
    if (d.minutes["tidak di depan layar"] >= 0.5)
      out.push({ text: `Away ${formatDuration(d.minutes["tidak di depan layar"])}`, state: "tidak di depan layar" });
    out.push({ text: d.breaks === 0 ? "No breaks" : `${plural(d.breaks, "break", "breaks")}, ${formatDuration(d.breakMinutes)}` });
    return out;
  };

  function draw() {
    tip.hide();
    if (width < 120 || days.length === 0) {
      svg.replaceChildren();
      return;
    }
    const n = days.length;
    const H = M.top + PLOT_H + AXIS_H + DOTS_H;
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(H));
    svg.setAttribute("viewBox", `0 0 ${width} ${H}`);
    const plotW = width - M.left - M.right;
    const base = M.top + PLOT_H;
    const max = Math.max(1, ...days.map((d) => d.atScreen));
    const step = STEPS.find((s) => max / s <= 4) ?? STEPS[STEPS.length - 1];
    const yMax = Math.ceil(max / step) * step;
    const y = (min: number) => (min / yMax) * PLOT_H;
    const band = plotW / n;
    const bw = Math.max(3, Math.min(BAR_MAX, band * 0.6));
    const nodes: SVGElement[] = [];

    for (let v = 0; v <= yMax + 1e-6; v += step) {
      const yy = base - y(v);
      nodes.push(svgEl("line", { class: v === 0 ? "ins-axis" : "ins-grid", x1: M.left, x2: width - M.right, y1: yy, y2: yy }));
      const t = svgEl("text", { class: "ins-tick", x: M.left - 8, y: yy + 3.5, "text-anchor": "end" });
      t.textContent = tickLabel(v);
      nodes.push(t);
    }
    const breaksLabel = svgEl("text", { class: "ins-tick ins-tick-cap", x: M.left - 8, y: base + AXIS_H + 13, "text-anchor": "end" });
    breaksLabel.textContent = "BREAKS";
    nodes.push(breaksLabel);

    const labelEvery = n <= 10 ? 1 : Math.ceil(26 / band);
    days.forEach((d, i) => {
      const cx = M.left + band * (i + 0.5);
      const x = cx - bw / 2;
      const segs = STACK.filter((l) => y(d.minutes[l]) >= 0.5);
      let cursor = base;
      segs.forEach((l, j) => {
        const h = y(d.minutes[l]);
        const top = cursor - h;
        const drawn = j === 0 ? h : h - GAP;
        cursor = top;
        if (drawn < 0.5) return;
        const attrs = { class: "ins-db-seg", "data-s": STATE_TOKEN[l] };
        nodes.push(
          j === segs.length - 1
            ? svgEl("path", { ...attrs, d: roundedTop(x, top, bw, drawn, 4) })
            : svgEl("rect", { ...attrs, x, y: top, width: bw, height: drawn }),
        );
      });

      if (i % labelEvery === 0 || i === n - 1) {
        if (n <= 10) {
          const wd = svgEl("text", { class: "ins-tick", x: cx, y: base + 15, "text-anchor": "middle" });
          wd.textContent = weekdayOf(d.day);
          const dt = svgEl("text", { class: "ins-tick ins-tick-strong", x: cx, y: base + 28, "text-anchor": "middle" });
          dt.textContent = String(dateOf(d.day));
          nodes.push(wd, dt);
        } else {
          const dt = svgEl("text", { class: "ins-tick", x: cx, y: base + 18, "text-anchor": "middle" });
          dt.textContent = String(dateOf(d.day));
          nodes.push(dt);
        }
      }

      const dotY = base + AXIS_H + 9;
      const fit = Math.max(1, Math.floor((band - 4) / 8));
      if (d.breaks > 0 && d.breaks <= fit) {
        for (let k = 0; k < d.breaks; k++)
          nodes.push(svgEl("circle", { class: "ins-db-dot", cx: cx + (k - (d.breaks - 1) / 2) * 8, cy: dotY, r: 3 }));
      } else if (d.breaks > fit) {
        nodes.push(svgEl("circle", { class: "ins-db-dot", cx: cx - 5, cy: dotY, r: 3 }));
        const c = svgEl("text", { class: "ins-tick", x: cx, y: dotY + 3.5 });
        c.textContent = String(d.breaks);
        nodes.push(c);
      }

      const hit = svgEl("rect", { class: "ins-db-hit", x: M.left + band * i, y: M.top, width: band, height: PLOT_H + AXIS_H + DOTS_H });
      hit.addEventListener("pointerenter", () => tip.show(lines(d), cx, M.top + 20));
      nodes.push(hit);
    });
    svg.replaceChildren(...nodes);
  }

  svg.addEventListener("pointerleave", () => tip.hide());
  const ro = new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (w === width) return;
    width = w;
    draw();
  });
  ro.observe(stage);

  return {
    root,
    update(next) {
      days = next;
      draw();
      const total = (l: Label) => next.reduce((s, d) => s + d.minutes[l], 0);
      svg.setAttribute(
        "aria-label",
        `Stacked bars for ${plural(next.length, "day", "days")}: ` +
          STACK.map((l) => `${STATE_NAME[l]} ${formatDuration(total(l))}`).join(", ") +
          `; ${plural(next.reduce((s, d) => s + d.breaks, 0), "break", "breaks")}. A table follows.`,
      );
      tableHost.replaceChildren(
        srTable(
          "Screen time per state and breaks, by day",
          ["Day", ...STACK.map((l) => STATE_NAME[l]), "Away", "Breaks"],
          next.map((d) => [
            dayLabel(d.day, "long"),
            ...STACK.map((l) => formatDuration(d.minutes[l])),
            formatDuration(d.minutes["tidak di depan layar"]),
            String(d.breaks),
          ]),
        ),
      );
    },
    destroy() {
      ro.disconnect();
    },
  };
}
