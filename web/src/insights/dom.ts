import type { Label } from "../rules.ts";
import { STATE_TOKEN } from "../stateCopy.ts";
import type { Mark } from "./model.ts";

// Small DOM helpers shared by the Insights renderers. Data text always goes in through textContent.

export const SVG_NS = "http://www.w3.org/2000/svg";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// The token suffix a mark wears: a state's (--s-tired …) or ink for a number that is not a state.
export const markToken = (mark: Mark) => (mark === "ink" ? "ink" : STATE_TOKEN[mark as Label]);

// A real table for screen readers, kept out of sight.
export function srTable(caption: string, head: readonly string[], rows: readonly (readonly string[])[]): HTMLTableElement {
  const table = el("table", "ins-sr");
  table.append(el("caption", undefined, caption));
  const thead = el("thead");
  const hr = el("tr");
  for (const h of head) {
    const th = el("th", undefined, h);
    th.scope = "col";
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    row.forEach((cell, i) => {
      if (i === 0) {
        const th = el("th", undefined, cell);
        th.scope = "row";
        tr.append(th);
      } else tr.append(el("td", undefined, cell));
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

export type TipLine = { text: string; state?: Label; strong?: boolean };

// One mono tooltip per chart, placed inside a position:relative host and kept within it.
export class Tooltip {
  readonly node = el("div", "ins-tip");
  private readonly host: HTMLElement;

  constructor(host: HTMLElement) {
    this.host = host;
    this.node.setAttribute("aria-hidden", "true");
    this.node.hidden = true;
    host.append(this.node);
  }

  show(lines: readonly TipLine[], x: number, y: number) {
    this.node.replaceChildren(
      ...lines.map((line) => {
        const row = el("div", line.strong ? "ins-tip-title" : "ins-tip-row");
        if (line.state) {
          const dot = el("span", "ins-dot");
          dot.dataset.s = STATE_TOKEN[line.state];
          row.append(dot);
        }
        row.append(el("span", undefined, line.text));
        return row;
      }),
    );
    this.node.hidden = false;
    const w = this.node.offsetWidth;
    const h = this.node.offsetHeight;
    const maxX = this.host.clientWidth - w - 4;
    const left = x + 14 + w > this.host.clientWidth ? Math.max(4, x - w - 14) : x + 14;
    const top = Math.max(4, Math.min(y + 14, this.host.clientHeight - h - 4 > 4 ? this.host.clientHeight - h - 4 : y + 14));
    this.node.style.transform = `translate(${Math.round(Math.min(left, Math.max(4, maxX)))}px, ${Math.round(top)}px)`;
  }

  hide() {
    this.node.hidden = true;
  }
}

export const tipText = (lines: readonly TipLine[]) => lines.map((l) => l.text).join(". ");
