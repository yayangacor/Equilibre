import { CHART_LABELS, type DaySummary, type Feedback, type HourSummary, type RecommendationRecord } from "./history.ts";
import { LABELS } from "./rules.ts";

// The "Riwayat" panel: one day's numbers, an hourly stacked column chart and the same
// numbers as a table. Text from data only goes in through textContent. Segment colors
// are CSS custom properties (--chart-*, style.css) checked as adjacent stacked fills in
// both color schemes with the dataviz palette validator (plans/P06, step 3).

const SVG_NS = "http://www.w3.org/2000/svg";
const one = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const minutes = (x: number) => `${one.format(x)} menit`;
const two = (n: number) => String(n).padStart(2, "0");
const hourSpan = (jam: number) => `${two(jam)}.00–${two((jam + 1) % 24)}.00`;

const PLOT_H = 140;
const MARGIN = { top: 10, right: 8, bottom: 24, left: 46 }; // left: room for "60 mnt"
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4; // rounded data end, square at the baseline

export type DashboardView = {
  days: readonly string[]; // days with history, oldest first
  day: string; // the day shown
  today: string;
  summary: DaySummary | null; // null: history not available
  rekomendasi: readonly RecommendationRecord[]; // that day's, oldest first
  problem: string | null;
};

export type DashboardElements = {
  select: HTMLSelectElement;
  note: HTMLElement;
  stats: HTMLElement;
  figure: HTMLElement;
  legend: HTMLElement;
  chart: HTMLElement; // wrapper the SVG is drawn into; holds the tooltip too
  tip: HTMLElement;
  table: HTMLTableElement;
  recsBlock: HTMLElement;
  recs: HTMLElement;
};

export const FEEDBACKS: readonly { value: Feedback; text: string }[] = [
  { value: "sudah dilakukan", text: "Sudah dilakukan" },
  { value: "tidak relevan", text: "Tidak relevan" },
];

// The recommendation sentence of a reply; the raw text when the reply was not JSON.
export function recommendationText(r: RecommendationRecord): string {
  const value = r.hasil?.rekomendasi;
  const text = typeof value === "string" ? value : Array.isArray(value) ? value.map(String).join(" ") : r.teks;
  return text.length > 220 ? `${text.slice(0, 219)}…` : text;
}

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

function dayName(day: string, today: string): string {
  if (day === today) return "Hari ini";
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long" });
}

function describeHour(h: HourSummary): string {
  const parts = [...LABELS.map((l) => `${l} ${minutes(h.menit[l])}`), `tidak dinilai ${minutes(h.ditahan)}`];
  return `Jam ${hourSpan(h.jam)}: ${parts.join(", ")}`;
}

export class Dashboard {
  private readonly ui: DashboardElements;
  private readonly onFeedback: (id: number, feedback: Feedback) => void;
  private hours: readonly HourSummary[] = [];

  constructor(ui: DashboardElements, onPickDay: (day: string) => void, onFeedback: (id: number, feedback: Feedback) => void) {
    this.ui = ui;
    this.onFeedback = onFeedback;
    ui.select.addEventListener("change", () => onPickDay(ui.select.value));
    ui.legend.replaceChildren(
      ...[...CHART_LABELS].reverse().map((label) => {
        const item = html("li");
        const swatch = html("span", "", "swatch");
        swatch.dataset.label = label;
        item.append(swatch, html("span", label));
        return item;
      }),
    );
    new ResizeObserver(() => this.drawChart()).observe(ui.chart);
  }

  render(view: DashboardView) {
    const { ui } = this;
    const days = view.days.includes(view.today) ? [...view.days] : [...view.days, view.today];
    ui.select.replaceChildren(
      ...days
        .sort()
        .reverse()
        .map((day) => {
          const option = html("option", dayName(day, view.today));
          option.value = day;
          return option;
        }),
    );
    ui.select.value = view.day;

    const s = view.summary;
    const judged = s ? LABELS.reduce((sum, l) => sum + s.menit[l], 0) : 0;
    const notJudged = s ? s.ditahan.fps + s.ditahan.mata + s.ditahan.lain : 0;
    const empty = !s || judged + notJudged === 0;
    ui.note.hidden = !view.problem && !empty;
    ui.note.textContent =
      view.problem ??
      (view.day === view.today
        ? "Belum ada riwayat hari ini. Riwayat tercatat tiap 10 detik setelah kalibrasi, dan hanya disimpan di perangkat ini."
        : "Tidak ada riwayat untuk hari ini.");
    ui.stats.hidden = empty;
    ui.figure.hidden = empty;
    this.renderRecommendations(view.rekomendasi);
    this.hours = s && !empty ? s.perJam : [];
    if (!s || empty) {
      this.drawChart();
      return;
    }

    const rows: [string, string][] = [
      ["Dipantau", `${minutes(judged + notJudged)} · ${s.sesi} sesi`],
      ...LABELS.map((l): [string, string] => [l, minutes(s.menit[l])]),
      [
        "Tidak dinilai",
        notJudged === 0
          ? minutes(0)
          : `${minutes(notJudged)} (tab tidak terlihat ${one.format(s.ditahan.fps)}, mata tidak terlihat ${one.format(s.ditahan.mata)})`,
      ],
      ["Jeda ≥ 2 menit", s.jeda.jumlah === 0 ? "belum ada" : `${s.jeda.jumlah}× · ${minutes(s.jeda.menit)}`],
      [
        "Rekomendasi",
        s.rekomendasi.jumlah === 0
          ? "belum ada"
          : `${s.rekomendasi.jumlah} (${s.rekomendasi.otomatis} otomatis) · sudah dilakukan ${s.rekomendasi.sudahDilakukan} · ` +
            `tidak relevan ${s.rekomendasi.tidakRelevan} · belum dinilai ${s.rekomendasi.belum}`,
      ],
      ["Koreksi label", String(s.koreksi)],
      ["KSS", s.kss.rataRata === null ? "belum ada" : `${s.kss.jumlah} isian · rata-rata ${one.format(s.kss.rataRata)}`],
    ];
    ui.stats.replaceChildren(
      ...rows.map(([name, value]) => {
        const row = html("div", "", "metric");
        const dd = html("dd");
        dd.append(html("span", value, "stat-value"));
        row.append(html("dt", name), dd);
        return row;
      }),
    );
    this.renderTable();
    this.drawChart();
  }

  // Newest first, each with its own feedback buttons (D-06): automatic ones may have
  // arrived while nobody looked at the Langflow panel.
  private renderRecommendations(recs: readonly RecommendationRecord[]) {
    const { recsBlock, recs: list } = this.ui;
    recsBlock.hidden = recs.length === 0;
    list.replaceChildren(
      ...[...recs].reverse().map((r) => {
        const item = html("li");
        const time = new Date(r.t).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
        item.append(
          html("p", `${time} · ${r.status ?? r.label}${r.pemicu === "otomatis" ? " · otomatis" : ""}`, "rec-head"),
          html("p", recommendationText(r), "rec-text"),
        );
        if (r.id !== undefined) item.append(feedbackButtons(r.feedback, (f) => this.onFeedback(r.id as number, f)));
        return item;
      }),
    );
  }

  private renderTable() {
    const head = html("tr");
    for (const name of ["Jam", ...LABELS, "tidak dinilai"]) head.append(html("th", name));
    const body = this.hours.map((h) => {
      const row = html("tr");
      row.append(html("td", hourSpan(h.jam)));
      for (const l of LABELS) row.append(html("td", one.format(h.menit[l])));
      row.append(html("td", one.format(h.ditahan)));
      return row;
    });
    const thead = html("thead");
    thead.append(head);
    const tbody = html("tbody");
    tbody.append(...body);
    this.ui.table.replaceChildren(thead, tbody);
  }

  // Drawn at the wrapper's real width, so text stays at its CSS size.
  private drawChart() {
    const { chart, tip } = this.ui;
    chart.querySelector("svg")?.remove();
    tip.hidden = true;
    const hours = this.hours;
    if (hours.length === 0) return;

    const width = Math.max(240, chart.clientWidth || 480);
    const height = MARGIN.top + PLOT_H + MARGIN.bottom;
    const band = (width - MARGIN.left - MARGIN.right) / hours.length;
    const barW = Math.max(4, Math.min(24, band * 0.6));
    const totals = hours.map((h) => CHART_LABELS.reduce((sum, l) => sum + h.menit[l], 0));
    const maxY = Math.max(60, ...totals); // an hour has 60 minutes; two open tabs can exceed it
    const y = (m: number) => MARGIN.top + PLOT_H - (m / maxY) * PLOT_H;

    const root = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "chart-svg", role: "group" });
    root.setAttribute("aria-label", "Menit per jam menurut label. Rinciannya ada di tabel di bawah grafik.");
    for (const tick of [0, 30, 60]) {
      root.append(svg("line", { x1: MARGIN.left, x2: width - MARGIN.right, y1: y(tick), y2: y(tick), class: tick === 0 ? "axis" : "grid" }));
      const label = svg("text", { x: MARGIN.left - 6, y: y(tick) + 4, "text-anchor": "end", class: "tick" });
      label.textContent = tick === 60 ? "60 mnt" : String(tick);
      root.append(label);
    }

    const every = band >= 26 ? 1 : band >= 13 ? 2 : 3; // hour labels that fit
    hours.forEach((h, i) => {
      const x0 = MARGIN.left + band * i;
      const cx = x0 + band / 2;
      const column = svg("g", { class: "col" });
      column.append(svg("rect", { x: x0 + 1, y: MARGIN.top, width: Math.max(0, band - 2), height: PLOT_H, class: "band" }));

      const segments = CHART_LABELS.map((label) => ({ label, value: h.menit[label] })).filter((s) => s.value > 0);
      let below = 0;
      segments.forEach(({ label, value }, k) => {
        const bottom = y(below) - (k > 0 ? GAP / 2 : 0);
        const top = y(below + value) + (k < segments.length - 1 ? GAP / 2 : 0);
        below += value;
        const segH = bottom - top;
        if (segH < 0.5) return; // thinner than a pixel: the tooltip and the table still carry it
        const x = cx - barW / 2;
        const mark =
          k === segments.length - 1
            ? svg("path", { d: roundedTop(x, top, barW, segH, Math.min(RADIUS, segH, barW / 2)), class: "seg" })
            : svg("rect", { x, y: top, width: barW, height: segH, class: "seg" });
        mark.setAttribute("data-label", label);
        column.append(mark);
      });

      if (i % every === 0) {
        const label = svg("text", { x: cx, y: height - 8, "text-anchor": "middle", class: "tick" });
        label.textContent = two(h.jam);
        column.append(label);
      }
      // The whole hour band is the hit target, on top of the marks.
      const hit = svg("rect", { x: x0, y: 0, width: band, height, class: "hit", tabindex: 0, role: "img" });
      hit.setAttribute("aria-label", describeHour(h));
      const show = () => this.showTip(h, cx, barW, width);
      hit.addEventListener("pointerenter", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("pointerleave", () => (tip.hidden = true));
      hit.addEventListener("blur", () => (tip.hidden = true));
      column.append(hit);
      root.append(column);
    });
    chart.prepend(root);
  }

  // Beside the column, never over it: right of it when there is room, else left.
  private showTip(h: HourSummary, cx: number, barW: number, width: number) {
    const { tip } = this.ui;
    const row = (key: string, value: number, name: string) => {
      const line = html("div", "", "tip-row");
      const swatch = html("span", "", "tip-key");
      swatch.dataset.label = key;
      line.append(swatch, html("strong", minutes(value)), html("span", name));
      return line;
    };
    tip.replaceChildren(
      html("p", hourSpan(h.jam), "tip-head"),
      ...[...CHART_LABELS].reverse().map((l) => row(l, h.menit[l], l)),
      row("tidak di depan layar", h.menit["tidak di depan layar"], "tidak di depan layar"),
      row("ditahan", h.ditahan, "tidak dinilai"),
    );
    tip.hidden = false;
    const tipW = tip.offsetWidth;
    const right = cx + barW / 2 + 8;
    tip.style.left = `${right + tipW <= width ? right : Math.max(0, cx - barW / 2 - 8 - tipW)}px`;
  }
}

// Two toggle buttons; the chosen one is pressed. Choosing the other one changes the answer.
export function feedbackButtons(current: Feedback | null, choose: (f: Feedback) => void): HTMLElement {
  const row = html("div", "", "feedback-row");
  for (const { value, text } of FEEDBACKS) {
    const button = html("button", text, "secondary small");
    button.type = "button";
    button.setAttribute("aria-pressed", String(current === value));
    button.addEventListener("click", () => choose(value));
    row.append(button);
  }
  return row;
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`;
}
