import { el, srTable, Tooltip, type TipLine } from "./dom.ts";
import { clock, dayLabel, formatDuration, formatShare, HEAT_LEGEND, type HeatCell, type Heatmap } from "./model.ts";

// "When tiredness shows up": hour of day × day, each cell the share of the screen time that read Mildly tired,
// Tired or Asleep, on a ramp from paper to Tired. A cell with no screen time is hatched, never 0%.
// A CSS grid of divs: no measuring, no animation.

export type HeatmapView = { root: HTMLElement; update(hm: Heatmap): void };

export function createHeatmap(): HeatmapView {
  const root = el("figure", "ins-fig");
  const head = el("div", "ins-fig-head");
  head.append(
    el("h2", "ins-fig-title", "When tiredness shows up"),
    el("p", "ins-fig-sub", "Share of screen time that read Mildly tired, Tired or Asleep, by hour"),
  );
  const stage = el("div", "ins-hm-stage");
  const grid = el("div", "ins-hm");
  grid.setAttribute("role", "img");
  stage.append(grid);
  const tip = new Tooltip(stage);
  const legend = el("ul", "ins-legend ins-hm-legend");
  HEAT_LEGEND.forEach((text, bin) => {
    const li = el("li");
    const sw = el("span", "ins-hm-swatch");
    sw.dataset.bin = String(bin);
    li.append(sw, el("span", undefined, text));
    legend.append(li);
  });
  const none = el("li");
  const hatch = el("span", "ins-hm-swatch");
  hatch.dataset.empty = "";
  none.append(hatch, el("span", undefined, "No screen time"));
  legend.append(none);
  const tableHost = el("div");
  root.append(head, stage, legend, tableHost);

  const cellOf = new WeakMap<Element, HeatCell>();

  const lines = (c: HeatCell): TipLine[] => {
    const out: TipLine[] = [{ text: `${dayLabel(c.day, "medium")} · ${clock(c.hour * 60)}–${clock((c.hour + 1) * 60)}`, strong: true }];
    if (c.share === null) out.push({ text: "No screen time" });
    else {
      out.push({ text: `${formatShare(c.share)} tired`, state: "lelah" });
      out.push({ text: `${formatDuration(c.fatigue)} of ${formatDuration(c.atScreen)} at the screen` });
    }
    if (c.away >= 0.5) out.push({ text: `Away ${formatDuration(c.away)}`, state: "tidak di depan layar" });
    return out;
  };

  grid.addEventListener("pointerover", (e) => {
    const target = (e.target as Element).closest(".ins-hm-cell");
    const c = target ? cellOf.get(target) : undefined;
    if (!c) {
      tip.hide();
      return;
    }
    const s = stage.getBoundingClientRect();
    const r = target!.getBoundingClientRect();
    tip.show(lines(c), r.left - s.left + r.width / 2, r.top - s.top + r.height / 2);
  });
  grid.addEventListener("pointerleave", () => tip.hide());

  return {
    root,
    update(hm) {
      tip.hide();
      grid.style.setProperty("--cols", String(hm.hours.length));
      grid.dataset.many = String(hm.hours.length > 12);
      const nodes: HTMLElement[] = [el("div", "ins-hm-corner")];
      hm.hours.forEach((h, i) => {
        const label = el("div", "ins-hm-hour", String(h).padStart(2, "0"));
        if (i % 2 === 1) label.classList.add("is-minor");
        nodes.push(label);
      });
      for (const row of hm.rows) {
        nodes.push(el("div", "ins-hm-day", dayLabel(row.day, "short")));
        for (const c of row.cells) {
          const cell = el("div", "ins-hm-cell");
          if (c.bin === null) cell.dataset.empty = "";
          else cell.dataset.bin = String(c.bin);
          cellOf.set(cell, c);
          nodes.push(cell);
        }
      }
      grid.replaceChildren(...nodes);

      const cells = hm.rows.flatMap((r) => r.cells).filter((c) => c.share !== null);
      const worst = cells.reduce<HeatCell | null>((a, c) => (a === null || (c.share ?? 0) > (a.share ?? 0) ? c : a), null);
      grid.setAttribute(
        "aria-label",
        `Heatmap of ${hm.rows.length} ${hm.rows.length === 1 ? "day" : "days"} by hour, ${clock(hm.hours[0] * 60)} to ${clock((hm.hours[hm.hours.length - 1] + 1) * 60)}.` +
          (worst && (worst.share ?? 0) > 0
            ? ` Highest tired share: ${formatShare(worst.share ?? 0)} on ${dayLabel(worst.day, "long")} at ${clock(worst.hour * 60)}.`
            : " No tired time in any hour.") +
          " A table with every hour follows.",
      );
      tableHost.replaceChildren(
        srTable(
          "Tired share of screen time by day and hour",
          ["Day", ...hm.hours.map((h) => clock(h * 60))],
          hm.rows.map((r) => [dayLabel(r.day, "long"), ...r.cells.map((c) => (c.share === null ? "no screen time" : formatShare(c.share)))]),
        ),
      );
    },
  };
}
