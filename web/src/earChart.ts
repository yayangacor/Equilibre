import { blinkThreshold, perclosThreshold, type Baseline } from "./calibration.ts";

// Live Eye Aspect Ratio chart on the "Teknis" page (plan P14), after the EAR plot of the UTA-RLDD
// demo: the last WINDOW_MS of the averaged EAR, with the personal thresholds the pipeline uses
// (calibration.ts) as labeled reference lines. Canvas, since it redraws several times a second.
// Frames without a face break the line.

const WINDOW_MS = 20_000;

type Sample = { t: number; ear: number | null };

export class EarChart {
  private samples: Sample[] = [];
  private readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, legend: HTMLElement) {
    this.canvas = canvas;
    const item = (key: string, text: string) => {
      const li = document.createElement("li");
      const swatch = document.createElement("span");
      swatch.className = key;
      const label = document.createElement("span");
      label.textContent = text;
      li.append(swatch, label);
      return li;
    };
    legend.replaceChildren(item("line-key", "EAR rata-rata kedua mata"), item("dash-key", "Batas pribadi dari kalibrasi"));
  }

  push(t: number, ear: number | null) {
    this.samples.push({ t, ear: ear !== null && Number.isFinite(ear) ? ear : null });
    const cut = t - WINDOW_MS;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop].t < cut) drop++;
    if (drop > 0) this.samples.splice(0, drop);
  }

  draw(baseline: Baseline | null) {
    const { canvas, samples } = this;
    const css = getComputedStyle(canvas);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const color = (name: string) => css.getPropertyValue(name).trim();
    const left = 40;
    const right = 132; // room for the reference labels
    const top = 8;
    const bottom = 20;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const maxY = Math.max(0.4, (baseline?.earOpen ?? 0.3) * 1.35);
    const y = (v: number) => top + plotH - (Math.min(v, maxY) / maxY) * plotH;
    const now = samples.at(-1)?.t ?? 0;
    const x = (t: number) => left + plotW - ((now - t) / WINDOW_MS) * plotW;

    ctx.font = `11px ${css.fontFamily}`;
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (const v of [0, 0.1, 0.2, 0.3, 0.4, 0.5].filter((v) => v <= maxY)) {
      ctx.strokeStyle = v === 0 ? color("--outline") : color("--chart-grid");
      ctx.beginPath();
      ctx.moveTo(left, Math.round(y(v)) + 0.5);
      ctx.lineTo(left + plotW, Math.round(y(v)) + 0.5);
      ctx.stroke();
      ctx.fillStyle = color("--on-surface-variant");
      ctx.textAlign = "right";
      ctx.fillText(v.toFixed(1), left - 8, y(v));
    }
    ctx.textAlign = "left";
    ctx.fillText("−20 dtk", left, height - 8);
    ctx.textAlign = "right";
    ctx.fillText("sekarang", left + plotW, height - 8);

    if (baseline) {
      const refs: [number, string][] = [
        [baseline.earOpen, "terbuka (baseline)"],
        [blinkThreshold(baseline), "batas kedip"],
        [perclosThreshold(baseline), "batas tertutup"],
      ];
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = color("--on-surface-variant");
      ctx.textAlign = "left";
      for (const [v, name] of refs) {
        ctx.beginPath();
        ctx.moveTo(left, y(v));
        ctx.lineTo(left + plotW, y(v));
        ctx.stroke();
        ctx.fillStyle = color("--on-surface-variant");
        ctx.fillText(`${name} ${v.toFixed(2)}`, left + plotW + 8, y(v));
      }
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = color("--chart-line");
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    let drawing = false;
    for (const s of samples) {
      if (s.ear === null) {
        drawing = false;
        continue;
      }
      if (drawing) ctx.lineTo(x(s.t), y(s.ear));
      else ctx.moveTo(x(s.t), y(s.ear));
      drawing = true;
    }
    ctx.stroke();
  }
}
