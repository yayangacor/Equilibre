import type { BreakRecord, DaySummary } from "./history.ts";
import { AT_SCREEN, formatDuration, LEVEL_LABELS, type LevelPoint } from "./insight.ts";
import { LABELS, type Label } from "./rules.ts";
import { capitalize } from "./statusCopy.ts";

// Charts of the Insight and Sekarang pages (plan P14), after the UTA-RLDD demo the user pointed
// at: time per label as bars, and the fatigue level over the day as a line. Colors come from the
// label tokens in style.css (--chart, validated with the dataviz validator); text stays in text
// colors and every label also carries its shape. Data text goes in through textContent only.

const SVG_NS = "http://www.w3.org/2000/svg";

function html<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

const clockOf = (t: number) => new Date(t).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

// A shape + name pair, the label's identity wherever it appears (legend, bars, tooltip).
export function labelKey(label: Label, text: string = capitalize(label), className = "lb-name"): HTMLElement {
  const node = html("span", "", className);
  node.dataset.label = label;
  node.append(html("span", "", "shape"), html("span", text));
  return node;
}

// ── Time per label: one horizontal bar per label, value at the tip ─────────────

export function renderLabelBars(container: HTMLElement, note: HTMLElement, s: DaySummary) {
  const max = Math.max(...LABELS.map((l) => s.menit[l]));
  container.replaceChildren(
    ...LABELS.map((label) => {
      const minutes = s.menit[label];
      const row = html("div", "", "lb-row");
      row.dataset.label = label;
      const track = html("div", "", "lb-track");
      const bar = html("span", "", "lb-bar");
      bar.dataset.label = label;
      // Room is kept at the tip for the value, so the longest bar never pushes it out.
      bar.style.width = max > 0 ? `calc((100% - 8.5rem) * ${minutes / max})` : "0";
      if (minutes === 0) bar.style.minWidth = "0";
      // Minutes only: the share of the time at the screen is in the tiles, against its own total.
      track.append(bar, html("span", formatDuration(minutes), "lb-value"));
      row.append(labelKey(label), track);
      row.title = `${capitalize(label)}: ${formatDuration(minutes)}`;
      return row;
    }),
  );
  const notJudged = s.ditahan.fps + s.ditahan.mata + s.ditahan.lain;
  note.textContent =
    notJudged === 0
      ? ""
      : `Tidak dinilai ${formatDuration(notJudged)}: tab tidak terlihat ${formatDuration(s.ditahan.fps)}, ` +
        `mata tidak terlihat ${formatDuration(s.ditahan.mata)}. Label terakhir ditahan selama itu.`;
}

// ── Today strip (Sekarang): the day so far as one stacked bar ──────────────────

export function renderTodayStrip(strip: HTMLElement, legend: HTMLElement, s: DaySummary | null) {
  const parts = s ? AT_SCREEN.map((label) => ({ label, minutes: s.menit[label] })).filter((p) => p.minutes > 0) : [];
  strip.replaceChildren(
    ...parts.map(({ label, minutes }) => {
      const segment = html("span");
      segment.dataset.label = label;
      segment.style.flexGrow = String(minutes);
      return segment;
    }),
  );
  legend.replaceChildren(
    ...parts.map(({ label, minutes }) => {
      const item = html("li");
      item.dataset.label = label;
      item.append(html("span", "", "shape"), html("span", `${capitalize(label)} ${formatDuration(minutes)}`));
      return item;
    }),
  );
  strip.setAttribute(
    "aria-label",
    parts.length === 0
      ? "Belum ada waktu di depan layar yang dinilai hari ini."
      : `Hari ini di depan layar: ${parts.map((p) => `${p.label} ${formatDuration(p.minutes)}`).join(", ")}.`,
  );
}

// ── Fatigue level over the day: a line with breaks marked ──────────────────────

const PLOT_H = 168;
const MARGIN = { top: 12, right: 16, bottom: 26, left: 96 }; // left: room for "Lelah ringan"

export type TrendData = { points: readonly LevelPoint[]; bucket: number; breaks: readonly BreakRecord[] };

// The subtitle names the bucket the line is averaged over (insight.ts bucketFor).
export const trendSubtitle = (bucket: number) =>
  `Rata-rata tingkat label per ${bucket === 60_000 ? "menit" : `${bucket / 60_000} menit`}. ` +
  "Garis terputus saat kamu tidak dipantau atau tidak di depan layar.";

export class TrendChart {
  private data: TrendData = { points: [], bucket: 60_000, breaks: [] };
  private readonly wrap: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly legend: HTMLElement;

  constructor(wrap: HTMLElement, tip: HTMLElement, legend: HTMLElement) {
    this.wrap = wrap;
    this.tip = tip;
    this.legend = legend;
    new ResizeObserver(() => this.draw()).observe(wrap);
  }

  render(data: TrendData) {
    this.data = data;
    const item = (key: string, text: string) => {
      const li = html("li");
      li.append(html("span", "", key), html("span", text));
      return li;
    };
    this.legend.replaceChildren(item("line-key", "Tingkat kelelahan"), ...(data.breaks.length > 0 ? [item("break-key", "Jeda")] : []));
    this.draw();
  }

  private draw() {
    const { wrap, tip } = this;
    wrap.querySelector("svg")?.remove();
    tip.hidden = true;
    const { points, bucket, breaks } = this.data;
    if (points.length === 0) return;

    const width = Math.max(280, wrap.clientWidth || 560);
    const height = MARGIN.top + PLOT_H + MARGIN.bottom;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t + bucket;
    const x = (t: number) => MARGIN.left + ((t - t0) / (t1 - t0)) * (width - MARGIN.left - MARGIN.right);
    const y = (level: number) => MARGIN.top + PLOT_H - (level / 3) * PLOT_H;
    const mid = (p: LevelPoint) => x(p.t + bucket / 2);

    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "chart-svg", tabindex: 0, role: "img" });
    root.setAttribute("aria-label", describe(points, bucket));

    // Breaks first, behind everything else.
    for (const b of breaks) {
      const from = Math.max(t0, b.mulai);
      const to = Math.min(t1, b.selesai);
      if (to <= from) continue;
      root.append(svg("rect", { x: x(from), y: MARGIN.top, width: Math.max(2, x(to) - x(from)), height: PLOT_H, rx: 3, class: "break-span" }));
    }

    LEVEL_LABELS.forEach((label, level) => {
      root.append(svg("line", { x1: MARGIN.left, x2: width - MARGIN.right, y1: y(level), y2: y(level), class: level === 0 ? "axis" : "grid" }));
      const tick = svg("text", { x: MARGIN.left - 10, y: y(level) + 4, "text-anchor": "end", class: "tick" });
      tick.textContent = capitalize(label);
      root.append(tick);
    });

    for (const t of timeTicks(t0, t1)) {
      const tick = svg("text", { x: x(t), y: height - 6, "text-anchor": "middle", class: "tick" });
      tick.textContent = clockOf(t);
      root.append(tick);
    }

    // One path per unbroken run; a lone point gets a dot so it does not vanish.
    let run: LevelPoint[] = [];
    const flush = () => {
      if (run.length === 1) root.append(svg("circle", { cx: mid(run[0]), cy: y(run[0].level as number), r: 4, class: "dot" }));
      if (run.length > 1) {
        const line = run.map((p, i) => `${i === 0 ? "M" : "L"}${mid(p).toFixed(1)},${y(p.level as number).toFixed(1)}`).join("");
        const area = `${line}L${mid(run[run.length - 1]).toFixed(1)},${y(0)}L${mid(run[0]).toFixed(1)},${y(0)}Z`;
        root.append(svg("path", { d: area, class: "trend-area" }), svg("path", { d: line, class: "trend-line" }));
      }
      run = [];
    };
    for (const p of points) {
      if (p.level === null) flush();
      else run.push(p);
    }
    flush();

    // Crosshair: snaps to the nearest bucket, on pointer and on arrow keys.
    const cross = svg("line", { y1: MARGIN.top, y2: MARGIN.top + PLOT_H, class: "crosshair", visibility: "hidden" });
    const marker = svg("circle", { r: 5, class: "dot", visibility: "hidden" });
    root.append(cross, marker);
    let index = -1;
    const show = (i: number) => {
      index = Math.max(0, Math.min(points.length - 1, i));
      const p = points[index];
      const cx = mid(p);
      cross.setAttribute("x1", String(cx));
      cross.setAttribute("x2", String(cx));
      cross.setAttribute("visibility", "visible");
      if (p.level === null) marker.setAttribute("visibility", "hidden");
      else {
        marker.setAttribute("cx", String(cx));
        marker.setAttribute("cy", String(y(p.level)));
        marker.setAttribute("visibility", "visible");
      }
      this.showTip(p, bucket, cx, width);
    };
    const hide = () => {
      cross.setAttribute("visibility", "hidden");
      marker.setAttribute("visibility", "hidden");
      tip.hidden = true;
    };
    const hit = svg("rect", { x: MARGIN.left, y: 0, width: width - MARGIN.left - MARGIN.right, height, fill: "transparent" });
    hit.addEventListener("pointermove", (e) => {
      const box = root.getBoundingClientRect();
      const px = e.clientX - box.left;
      let best = 0;
      points.forEach((p, i) => {
        if (Math.abs(mid(p) - px) < Math.abs(mid(points[best]) - px)) best = i;
      });
      show(best);
    });
    hit.addEventListener("pointerleave", hide);
    root.append(hit);
    root.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      show(index < 0 ? points.length - 1 : index + (e.key === "ArrowRight" ? 1 : -1));
    });
    root.addEventListener("blur", hide);
    wrap.prepend(root);
  }

  // Beside the crosshair, never over it: right of it when there is room, else left.
  private showTip(p: LevelPoint, bucket: number, cx: number, width: number) {
    const { tip } = this;
    const head = html("p", `${clockOf(p.t)}–${clockOf(p.t + bucket)}`, "tip-head");
    const row = html("div", "", "tip-row");
    const key = html("span", "", "tip-key");
    if (p.label) key.dataset.label = p.label;
    row.append(key, html("strong", p.label ? capitalize(p.label) : "Tidak dipantau"));
    const lines: HTMLElement[] = [head, row];
    if (p.level !== null && p.n > 1) {
      lines.push(html("p", `rata-rata tingkat ${p.level.toLocaleString("id-ID", { maximumFractionDigits: 1 })} dari 3`, "tip-head"));
    }
    tip.replaceChildren(...lines);
    tip.hidden = false;
    const tipW = tip.offsetWidth;
    tip.style.left = `${cx + 12 + tipW <= width ? cx + 12 : Math.max(0, cx - 12 - tipW)}px`;
  }
}

// Whole hours on long days, quarter or half hours on short ones.
function timeTicks(t0: number, t1: number): number[] {
  const span = t1 - t0;
  const step = span <= 90 * 60_000 ? 15 * 60_000 : span <= 3 * 3_600_000 ? 30 * 60_000 : span <= 8 * 3_600_000 ? 3_600_000 : 2 * 3_600_000;
  const offset = new Date(t0).getTimezoneOffset() * 60_000; // ticks on local clock times
  const first = Math.ceil((t0 - offset) / step) * step + offset;
  const ticks: number[] = [];
  for (let t = first; t <= t1; t += step) ticks.push(t);
  return ticks;
}

// The chart in words, for screen readers (Apple HIG: summarize the main message).
function describe(points: readonly LevelPoint[], bucket: number): string {
  const judged = points.filter((p) => p.level !== null);
  if (judged.length === 0) return "Tingkat kelelahan: belum ada data.";
  const peak = judged.reduce((a, b) => ((b.level as number) > (a.level as number) ? b : a));
  return (
    `Tingkat kelelahan dari ${clockOf(points[0].t)} sampai ${clockOf(points[points.length - 1].t + bucket)}, ` +
    `tertinggi ${peak.label ?? ""} sekitar pukul ${clockOf(peak.t)}. Gunakan panah kiri dan kanan untuk membaca tiap titik.`
  );
}
