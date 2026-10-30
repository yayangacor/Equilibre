import { forceCollide, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import gsap from "gsap";
import { LABELS, type Label } from "../rules.ts";
import { STATE_NAME, STATE_TOKEN } from "../stateCopy.ts";
import { el, reducedMotion, srTable, svgEl, tipText, Tooltip, type TipLine } from "./dom.ts";
import {
  clock,
  clusterCells,
  clusterKey,
  dayLabel,
  formatDuration,
  GROUP_MODES,
  groupBlocks,
  TANDA_NAME,
  type Block,
  type Cluster,
  type GroupMode,
} from "./model.ts";

// The sticky graphic of the essay: a clustered force layout (datavizproject "clustered force layout").
// One bubble per block of judged time, area ∝ judged minutes, color = the block's dominant state.
// Layouts are solved once per group mode with d3-force ticks run synchronously (no simulation timer),
// then circles move to them in one rAF tween that ends. Nothing runs while the page or the graphic is
// out of sight: the camera detector shares this tab.

type Node = SimulationNodeDatum & { i: number; r: number; tx: number; ty: number };

type ClusterGeom = Cluster & { cx: number; cy: number; R: number; top: number; narrow: boolean };
type Layout = { pos: Float64Array; clusters: ClusterGeom[] };

const LABEL_H = 34; // room above a cluster for its two label lines
const PAD = 6;
const DENSITY = 0.6; // share of a cluster circle the bubbles fill once collided
const MAX_R = 30; // a full block never draws bigger than this
const MIN_R = 1.5;
const TICKS = 160;
const DURATION = 900;
const STAGGER = 260;
const HIT = 8; // px around a bubble that still hovers it

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export type BubbleChart = {
  root: HTMLElement;
  setData(blocks: readonly Block[], blockSize: number): void;
  setMode(mode: GroupMode, highlight?: string | null): void;
  setVisible(visible: boolean): void;
  destroy(): void;
};

export function createBubbles(): BubbleChart {
  const root = el("div", "ins-bub");
  const modes = el("div", "ins-chips");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Group the bubbles");
  const stage = el("div", "ins-bub-stage");
  const svg = svgEl("svg", { class: "ins-bub-svg", role: "img", tabindex: 0 });
  const gRings = svgEl("g");
  const gNodes = svgEl("g", { class: "ins-bub-nodes" });
  const gLabels = svgEl("g");
  const focusRing = svgEl("circle", { class: "ins-bub-focus", r: 0 });
  focusRing.style.display = "none";
  svg.append(gRings, gNodes, gLabels, focusRing);
  stage.append(svg);
  const tip = new Tooltip(stage);
  const legend = el("ul", "ins-legend");
  const live = el("div", "ins-sr");
  live.setAttribute("aria-live", "polite");
  const tableHost = el("div");
  root.append(modes, stage, legend, tableHost, live);

  const buttons = new Map<GroupMode, HTMLButtonElement>();
  for (const m of GROUP_MODES) {
    const b = el("button", "ins-chip", m.label);
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => setMode(m.key, null));
    buttons.set(m.key, b);
    modes.append(b);
  }

  let blocks: readonly Block[] = [];
  let blockSize = 15;
  let circles: SVGCircleElement[] = [];
  let radius = new Float64Array(0);
  let pos: Float64Array | null = null; // what is on screen now
  let W = 0;
  let H = 0;
  let mode: GroupMode = "all";
  let highlight: string | null = null;
  let shown: GroupMode | null = null; // the mode whose layout is drawn
  const layouts = new Map<GroupMode, Layout>();
  let anim = 0;
  let animTarget: Float64Array | null = null;
  let visible = true;
  let onScreen = true;
  let active = -1; // keyboard
  let resizeTimer = 0;

  const canAnimate = () => visible && onScreen && !document.hidden && !reducedMotion();

  // ── Geometry ──
  function scaleK(): number {
    let k = MAX_R / Math.sqrt(blockSize);
    for (const m of GROUP_MODES) {
      const clusters = groupBlocks(blocks, m.key);
      const cells = clusterCells(clusters.length, W, H);
      clusters.forEach((c, i) => {
        const cellR = Math.max(8, Math.min(cells[i].w, cells[i].h - LABEL_H) / 2 - PAD);
        k = Math.min(k, cellR / Math.sqrt(c.total / DENSITY));
      });
    }
    return k;
  }

  function solve(m: GroupMode, start: Float64Array | null): Layout {
    const clusters = groupBlocks(blocks, m);
    const cells = clusterCells(clusters.length, W, H);
    const centers = new Map<string, { cx: number; cy: number; cellTop: number; w: number }>();
    clusters.forEach((c, i) => {
      const cell = cells[i];
      centers.set(c.key, { cx: cell.x + cell.w / 2, cy: cell.y + LABEL_H + (cell.h - LABEL_H) / 2, cellTop: cell.y, w: cell.w });
    });
    const seen = new Map<string, number>();
    const nodes: Node[] = blocks.map((b, i) => {
      const c = centers.get(clusterKey(b, m))!;
      const j = seen.get(clusterKey(b, m)) ?? 0;
      seen.set(clusterKey(b, m), j + 1);
      // Start from where the bubble is, or on a sunflower spiral around its center (deterministic).
      const a = j * 2.39996;
      const d = 3 * Math.sqrt(j + 0.5);
      return {
        i,
        r: radius[i],
        tx: c.cx,
        ty: c.cy,
        x: start ? start[2 * i] : c.cx + d * Math.cos(a),
        y: start ? start[2 * i + 1] : c.cy + d * Math.sin(a),
      };
    });
    forceSimulation<Node>(nodes)
      .force("x", forceX<Node>((d) => d.tx).strength(0.14))
      .force("y", forceY<Node>((d) => d.ty).strength(0.14))
      .force("collide", forceCollide<Node>((d) => d.r + 1).iterations(2))
      .alphaDecay(1 - Math.pow(0.001, 1 / TICKS))
      .stop()
      .tick(TICKS);
    const out = new Float64Array(blocks.length * 2);
    const reach = new Map<string, number>();
    for (const n of nodes) {
      const x = Math.min(W - n.r, Math.max(n.r, n.x ?? n.tx));
      const y = Math.min(H - n.r, Math.max(n.r, n.y ?? n.ty));
      out[2 * n.i] = x;
      out[2 * n.i + 1] = y;
      const key = clusterKey(blocks[n.i], m);
      const c = centers.get(key)!;
      reach.set(key, Math.max(reach.get(key) ?? 0, Math.hypot(x - c.cx, y - c.cy) + n.r));
    }
    return {
      pos: out,
      clusters: clusters.map((c) => {
        const center = centers.get(c.key)!;
        const R = (reach.get(c.key) ?? 0) + 5;
        return { ...c, cx: center.cx, cy: center.cy, R, top: Math.max(center.cellTop + LABEL_H, center.cy - R), narrow: center.w < 104 };
      }),
    };
  }

  // Every mode starts from the "All" layout, so a mode looks the same whichever way the reader got there.
  function layoutFor(m: GroupMode): Layout {
    let l = layouts.get(m);
    if (l) return l;
    const base = m === "all" ? null : layoutFor("all").pos;
    l = solve(m, base);
    layouts.set(m, l);
    return l;
  }

  // ── Drawing ──
  function applyPositions(p: Float64Array) {
    for (let i = 0; i < circles.length; i++) {
      circles[i].setAttribute("cx", p[2 * i].toFixed(1));
      circles[i].setAttribute("cy", p[2 * i + 1].toFixed(1));
    }
    pos = p.slice();
    if (active >= 0) placeFocus();
  }

  function stopAnim() {
    if (anim) cancelAnimationFrame(anim);
    anim = 0;
    if (animTarget) applyPositions(animTarget);
    animTarget = null;
  }

  function moveTo(target: Float64Array) {
    stopAnim();
    if (!pos || !canAnimate()) {
      applyPositions(target);
      return;
    }
    const from = pos.slice();
    const n = circles.length;
    const delay = Float64Array.from({ length: n }, (_, i) => (((i * 7919) % 97) / 97) * STAGGER);
    const t0 = performance.now();
    animTarget = target;
    const frame = (now: number) => {
      if (!canAnimate()) {
        stopAnim();
        return;
      }
      const t = now - t0;
      let done = true;
      const cur = pos!;
      for (let i = 0; i < n; i++) {
        const p = Math.min(1, Math.max(0, (t - delay[i]) / DURATION));
        if (p < 1) done = false;
        const e = easeInOut(p);
        const x = from[2 * i] + (target[2 * i] - from[2 * i]) * e;
        const y = from[2 * i + 1] + (target[2 * i + 1] - from[2 * i + 1]) * e;
        cur[2 * i] = x;
        cur[2 * i + 1] = y;
        circles[i].setAttribute("cx", x.toFixed(1));
        circles[i].setAttribute("cy", y.toFixed(1));
      }
      if (done) {
        anim = 0;
        animTarget = null;
        if (active >= 0) placeFocus();
      } else anim = requestAnimationFrame(frame);
    };
    anim = requestAnimationFrame(frame);
  }

  function drawAnnotations(l: Layout, animate: boolean) {
    const oldRings = [...gRings.children];
    const oldLabels = [...gLabels.children];
    const rings = svgEl("g", { class: "ins-bub-annot" });
    const labels = svgEl("g", { class: "ins-bub-annot" });
    for (const c of l.clusters) {
      const ring = svgEl("circle", { class: "ins-bub-ring", cx: c.cx.toFixed(1), cy: c.cy.toFixed(1), r: c.R.toFixed(1) });
      ring.dataset.key = c.key;
      rings.append(ring);
      const name = svgEl("text", { class: "ins-bub-name", x: c.cx.toFixed(1), y: (c.top - 18).toFixed(1), "text-anchor": "middle" });
      name.textContent = c.label;
      name.dataset.key = c.key;
      const total = svgEl("text", { class: "ins-bub-total", x: c.cx.toFixed(1), y: (c.top - 5).toFixed(1), "text-anchor": "middle" });
      total.textContent = c.narrow ? formatDuration(c.total).replace(" min", "m").replace(" h ", "h ") : formatDuration(c.total);
      total.dataset.key = c.key;
      labels.append(name, total);
    }
    gRings.append(rings);
    gLabels.append(labels);
    if (animate) {
      gsap.to([...oldRings, ...oldLabels], { opacity: 0, duration: 0.2, ease: "power1.out", onComplete: () => [...oldRings, ...oldLabels].forEach((n) => n.remove()) });
      gsap.fromTo([rings, labels], { opacity: 0 }, { opacity: 1, duration: 0.4, delay: 0.55, ease: "power2.out" });
    } else [...oldRings, ...oldLabels].forEach((n) => n.remove());
  }

  function applyHighlight() {
    blocks.forEach((b, i) => circles[i]?.classList.toggle("is-dim", highlight !== null && clusterKey(b, mode) !== highlight));
    for (const node of [...gRings.querySelectorAll<SVGElement>("[data-key]"), ...gLabels.querySelectorAll<SVGElement>("[data-key]")]) {
      node.classList.toggle("is-dim", highlight !== null && node.dataset.key !== highlight);
      node.classList.toggle("is-hl", highlight !== null && node.dataset.key === highlight);
    }
  }

  function describe(l: Layout) {
    const label = GROUP_MODES.find((m) => m.key === mode)!.label;
    svg.setAttribute(
      "aria-label",
      `${blocks.length} bubbles of up to ${blockSize} minutes of judged time, ${label === "All" ? "in one group" : label.toLowerCase()}: ` +
        l.clusters.map((c) => `${c.label} ${formatDuration(c.total)}`).join(", ") +
        ". A table with the same numbers follows.",
    );
    tableHost.replaceChildren(
      srTable(
        `Judged time, ${label === "All" ? "all together" : label.toLowerCase()}`,
        ["Group", "Total", ...LABELS.map((s) => STATE_NAME[s])],
        l.clusters.map((c) => [c.label, formatDuration(c.total), ...LABELS.map((s) => formatDuration(c.minutes[s]))]),
      ),
    );
  }

  function render(animate: boolean) {
    if (W < 40 || H < 40 || blocks.length === 0) return;
    const l = layoutFor(mode);
    const changed = shown !== mode;
    if (changed || !pos) {
      if (animate) moveTo(l.pos);
      else {
        stopAnim();
        applyPositions(l.pos);
      }
      drawAnnotations(l, animate && canAnimate());
      describe(l);
      shown = mode;
    }
    applyHighlight();
    for (const [key, b] of buttons) b.setAttribute("aria-pressed", String(key === mode));
  }

  function rebuild() {
    stopAnim();
    layouts.clear();
    shown = null;
    pos = null;
    if (W < 40 || H < 40 || blocks.length === 0) return;
    const k = scaleK();
    radius = Float64Array.from(blocks, (b) => Math.max(MIN_R, k * Math.sqrt(b.total)));
    circles.forEach((c, i) => c.setAttribute("r", radius[i].toFixed(2)));
    render(false);
    // The other modes are solved when the browser is idle, so a scroll step never waits on them.
    const idle = (cb: () => void) => ("requestIdleCallback" in window ? window.requestIdleCallback(cb, { timeout: 1500 }) : setTimeout(cb, 200));
    for (const m of GROUP_MODES) idle(() => W > 0 && blocks.length > 0 && layoutFor(m.key));
  }

  // ── Interaction ──
  function linesFor(b: Block): TipLine[] {
    const lines: TipLine[] = [
      { text: `${dayLabel(b.day, "medium")} · ${clock(b.startMin)}–${clock(b.startMin + b.size)}`, strong: true },
      { text: STATE_NAME[b.state], state: b.state },
      { text: `Read ${formatDuration(b.total)} of ${b.size} min` },
    ];
    const mix = LABELS.filter((l: Label) => b.minutes[l] >= 0.5);
    if (mix.length > 1) lines.push({ text: mix.map((l) => `${STATE_NAME[l]} ${formatDuration(b.minutes[l])}`).join(" · ") });
    if (b.signs.length > 0) lines.push({ text: `Signs: ${b.signs.map((s) => TANDA_NAME[s.tanda]).join(", ")}` });
    return lines;
  }

  function nearest(x: number, y: number): number {
    if (!pos) return -1;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < circles.length; i++) {
      const d = Math.hypot(pos[2 * i] - x, pos[2 * i + 1] - y) - radius[i];
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return bestD <= HIT ? best : -1;
  }

  function placeFocus() {
    if (!pos || active < 0) return;
    focusRing.setAttribute("cx", pos[2 * active].toFixed(1));
    focusRing.setAttribute("cy", pos[2 * active + 1].toFixed(1));
    focusRing.setAttribute("r", (radius[active] + 3).toFixed(1));
  }

  function showBlock(i: number, x: number, y: number, announce: boolean) {
    if (i < 0) {
      tip.hide();
      focusRing.style.display = "none";
      return;
    }
    active = i;
    placeFocus();
    focusRing.style.display = "";
    const lines = linesFor(blocks[i]);
    tip.show(lines, x, y);
    if (announce) live.textContent = tipText(lines);
  }

  svg.addEventListener("pointermove", (e) => {
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const i = nearest(x, y);
    if (i < 0) {
      active = -1;
      showBlock(-1, 0, 0, false);
    } else showBlock(i, x, y, false);
  });
  svg.addEventListener("pointerleave", () => {
    active = -1;
    showBlock(-1, 0, 0, false);
  });
  svg.addEventListener("keydown", (e) => {
    if (!pos || blocks.length === 0) return;
    const n = blocks.length;
    let next = active;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = active < 0 ? 0 : (active + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = active < 0 ? n - 1 : (active - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") next = -1;
    else return;
    e.preventDefault();
    if (next < 0) {
      active = -1;
      showBlock(-1, 0, 0, false);
    } else showBlock(next, pos[2 * next], pos[2 * next + 1], true);
  });
  svg.addEventListener("blur", () => {
    active = -1;
    showBlock(-1, 0, 0, false);
  });

  const ro = new ResizeObserver((entries) => {
    const box = entries[0].contentRect;
    const w = Math.round(box.width);
    const h = Math.round(box.height);
    if (w === W && h === H) return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      W = w;
      H = h;
      svg.setAttribute("width", String(W));
      svg.setAttribute("height", String(H));
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      rebuild();
    }, pos ? 150 : 0);
  });
  ro.observe(stage);

  const io = new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    if (!onScreen) stopAnim();
  });
  io.observe(stage);

  function setMode(m: GroupMode, hl: string | null = null) {
    mode = m;
    highlight = hl;
    render(true);
    if (W < 40) for (const [key, b] of buttons) b.setAttribute("aria-pressed", String(key === mode));
  }

  return {
    root,
    setData(next, size) {
      blocks = next;
      blockSize = size;
      active = -1;
      tip.hide();
      focusRing.style.display = "none";
      circles = blocks.map((b) => {
        const c = svgEl("circle", { class: "ins-bub-dot" });
        c.dataset.s = STATE_TOKEN[b.state];
        return c;
      });
      gNodes.replaceChildren(...circles);
      const present = LABELS.filter((l) => blocks.some((b) => b.state === l));
      legend.replaceChildren(
        ...present.map((l) => {
          const li = el("li");
          const dot = el("span", "ins-dot");
          dot.dataset.s = STATE_TOKEN[l];
          li.append(dot, el("span", undefined, STATE_NAME[l]));
          return li;
        }),
      );
      rebuild();
      if (canAnimate() && W >= 40) gsap.fromTo(gNodes, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "power1.out" });
    },
    setMode,
    setVisible(v) {
      visible = v;
      if (!v) {
        stopAnim();
        tip.hide();
      }
    },
    destroy() {
      stopAnim();
      ro.disconnect();
      io.disconnect();
      clearTimeout(resizeTimer);
    },
  };
}
