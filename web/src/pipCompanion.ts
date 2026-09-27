import { GREETING, type Mood } from "./companion.ts";

// Picture-in-Picture companion (plan P13, NOTES D-24): a small always-on-top window with the
// character, so Equilibre stays visible while the user works in another window. While it is open
// its timers also drive the detection loop (pipWindow), since a hidden tab is throttled to ±1 fps
// (G-03). Document Picture-in-Picture is Chromium only; elsewhere the button is off.
// Texts go in via textContent; the window gets its own small stylesheet, not the app's.

type DocumentPiP = { requestWindow(options: { width: number; height: number }): Promise<Window> };
const documentPiP = (): DocumentPiP | null =>
  (window as Window & { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture ?? null;

export type CompanionView = {
  mood: Mood;
  label: string; // the badge text: the shown label, or "Kalibrasi…", "Belum dikalibrasi", …
  note: string; // one short line under the badge
};

// Eye centres and radius (inside the outline) in the original 1082×1454 picture, measured from its
// pixels (27 Sep): outlines x 363–512 / 538–687, y 284–446.
const ART = { width: 1082, height: 1454, eyes: [437, 612], eyeY: 365, eyeR: 66 } as const;
// How far down the upper lid comes, as a share of the eye height (0 = open, 1 = closed).
const LID: Record<Mood, number> = { normal: 0, menunggu: 0, pergi: 0, "lelah-ringan": 0.38, lelah: 0.62, tertidur: 1 };
const SVG_NS = "http://www.w3.org/2000/svg";

const STYLE = `
:root { --bg: #f6f7f5; --text: #1c2321; --muted: #5d6b66; --ok: #2f7d6d; --warn: #b7791f; --error: #c0392b;
  --sleep: #5b4bb7; --idle: #6b7773; --on-status: #fff; --bubble: #ffffff; --border: #dde3e0;
  font-family: system-ui, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
@media (prefers-color-scheme: dark) { :root { --bg: #121615; --text: #e6ece9; --muted: #9aa8a3; --ok: #5cc3ab;
  --warn: #e0a84a; --error: #ef7a6c; --sleep: #a597f0; --idle: #7d8a86; --on-status: #121615; --bubble: #1b211f;
  --border: #2c3532; } }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
  gap: 6px; padding: 8px; overflow: hidden; user-select: none; }
.stage { position: relative; flex: 1 1 auto; min-height: 0; width: 100%; display: flex; justify-content: center;
  align-items: flex-end; cursor: pointer; }
.bear { position: relative; height: 100%; max-height: 240px; aspect-ratio: ${ART.width} / ${ART.height};
  animation: bob 4s ease-in-out infinite; transform-origin: 50% 100%; transition: opacity .6s, transform .6s; }
.bear img, .bear svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.bear svg { overflow: visible; }
[data-mood="lelah-ringan"] .bear { transform: rotate(-2deg); }
[data-mood="lelah"] .bear { transform: rotate(-4deg); animation-duration: 6s; }
[data-mood="tertidur"] .bear { transform: rotate(-6deg); animation: breathe 5s ease-in-out infinite; }
[data-mood="pergi"] .bear { opacity: .35; animation: none; }
@keyframes bob { 0%, 100% { translate: 0 0; } 50% { translate: 0 -3px; } }
@keyframes breathe { 0%, 100% { scale: 1; } 50% { scale: 1.015 1.03; } }
.zzz { display: none; font-weight: 700; fill: var(--sleep); }
[data-mood="tertidur"] .zzz { display: inline; animation: float 3s ease-in-out infinite; }
[data-mood="tertidur"] .zzz:nth-of-type(2) { animation-delay: 1s; }
[data-mood="tertidur"] .zzz:nth-of-type(3) { animation-delay: 2s; }
@keyframes float { 0% { opacity: 0; translate: 0 40px; } 30% { opacity: 1; } 100% { opacity: 0; translate: 80px -160px; } }
@media (prefers-reduced-motion: reduce) { .bear, .zzz { animation: none !important; } }
.badge { padding: 2px 10px; border-radius: 999px; font-size: 13px; font-weight: 600; color: var(--on-status);
  background: var(--idle); }
.badge::first-letter { text-transform: uppercase; }
[data-mood="normal"] .badge { background: var(--ok); }
[data-mood="lelah-ringan"] .badge { background: var(--warn); }
[data-mood="lelah"] .badge { background: var(--error); }
[data-mood="tertidur"] .badge { background: var(--sleep); }
.note { margin: 0; font-size: 11px; color: var(--muted); text-align: center; line-height: 1.3; }
.bubble { flex: none; width: 100%; padding: 8px 10px; border-radius: 12px;
  background: var(--bubble); border: 1px solid var(--border); font-size: 12px; line-height: 1.35;
  box-shadow: 0 2px 8px rgb(0 0 0 / .12); }
.bubble[hidden] { display: none; }
.bubble p { margin: 0 0 6px; }
.bubble-actions { display: flex; gap: 8px; justify-content: flex-end; }
button { font: inherit; font-size: 11px; border: none; background: none; color: var(--muted); padding: 0;
  text-decoration: underline; cursor: pointer; }
.fps { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
`;

export type PipCompanionDeps = {
  debug: boolean;
  onChange: (open: boolean) => void; // the PiP window opened or closed
  onSnooze: () => void; // "Tunda sapaan 30 menit"
};

export class PipCompanion {
  private readonly deps: PipCompanionDeps;
  private win: Window | null = null;
  private parts: {
    body: HTMLElement;
    badge: HTMLElement;
    note: HTMLElement;
    bubble: HTMLElement;
    bubbleText: HTMLElement;
    fps: HTMLElement | null;
    lids: SVGRectElement[];
    lidLines: SVGLineElement[];
    closedLines: SVGPathElement[];
  } | null = null;
  private bubbleTimer = 0;
  private view: CompanionView = { mood: "menunggu", label: "Memuat…", note: "" };

  static supported(): boolean {
    return documentPiP() !== null;
  }

  constructor(deps: PipCompanionDeps) {
    this.deps = deps;
  }

  get isOpen(): boolean {
    return this.win !== null;
  }

  // The open PiP window, whose timers also drive the detection loop (main.ts, runDetection).
  get pipWindow(): Window | null {
    return this.win;
  }

  // Must run inside a click handler: requestWindow needs a user gesture.
  async open(): Promise<void> {
    const api = documentPiP();
    if (!api || this.win) return;
    const win = await api.requestWindow({ width: 220, height: 300 });
    this.win = win;
    this.build(win.document);
    win.addEventListener("pagehide", () => this.closed(), { once: true });
    this.render(this.view);
    this.deps.onChange(true);
  }

  close(): void {
    this.win?.close();
  }

  render(view: CompanionView): void {
    this.view = view;
    const p = this.parts;
    if (!p) return;
    p.body.dataset.mood = view.mood;
    p.badge.textContent = view.label;
    p.note.textContent = view.note;
    this.renderEyes(view.mood);
  }

  // A greeting in the bubble; it hides by itself after GREETING.showMs.
  say(text: string): void {
    const p = this.parts;
    if (!p || !this.win) return;
    p.bubbleText.textContent = text;
    p.bubble.hidden = false;
    this.win.clearTimeout(this.bubbleTimer);
    this.bubbleTimer = this.win.setTimeout(() => (p.bubble.hidden = true), GREETING.showMs);
  }

  setFps(text: string): void {
    if (this.parts?.fps) this.parts.fps.textContent = `deteksi ${text} fps`;
  }

  private closed() {
    this.win = null;
    this.parts = null;
    this.deps.onChange(false);
  }

  private build(doc: Document) {
    doc.title = "Equilibre";
    const style = doc.createElement("style");
    style.textContent = STYLE;
    doc.head.append(style);

    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const bubble = make("div", "bubble");
    bubble.hidden = true;
    bubble.setAttribute("role", "status");
    const bubbleText = make("p");
    const later = make("button", undefined, "Tunda sapaan 30 menit");
    later.type = "button";
    later.addEventListener("click", () => {
      bubble.hidden = true;
      this.deps.onSnooze();
    });
    const dismiss = make("button", undefined, "Tutup");
    dismiss.type = "button";
    dismiss.addEventListener("click", () => (bubble.hidden = true));
    const actions = make("div", "bubble-actions");
    actions.append(later, dismiss);
    bubble.append(bubbleText, actions);

    const stage = make("div", "stage");
    stage.title = "Kembali ke tab Equilibre";
    // A click on the character asks for the Equilibre tab; the browser may ignore it, and the
    // window's own "back to tab" button stays available either way.
    stage.addEventListener("click", () => window.focus());
    const bear = make("div", "bear");
    const img = make("img");
    img.src = new URL("/karakter/beruang.png", location.href).href;
    img.alt = "Beruang pendamping Equilibre";
    img.draggable = false;
    const { svg, lids, lidLines, closedLines } = this.eyeLayer(doc);
    bear.append(img, svg);
    stage.append(bear);

    // The bubble sits above the character (not over it), so the face stays visible while it talks.
    const badge = make("div", "badge");
    const note = make("p", "note");
    doc.body.append(bubble, stage, badge, note);
    const fps = this.deps.debug ? make("p", "fps", "deteksi – fps") : null;
    if (fps) doc.body.append(fps);

    this.parts = { body: doc.body, badge, note, bubble, bubbleText, fps, lids, lidLines, closedLines };
  }

  // Upper lids drawn over the picture's eyes (in its own 1082×1454 coordinates), so one picture can
  // look open, drowsy, or asleep; "Z" letters float up while asleep.
  private eyeLayer(doc: Document) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${ART.width} ${ART.height}`);
    svg.setAttribute("aria-hidden", "true");
    const defs = doc.createElementNS(SVG_NS, "defs");
    svg.append(defs);
    const lids: SVGRectElement[] = [];
    const lidLines: SVGLineElement[] = [];
    const closedLines: SVGPathElement[] = [];
    ART.eyes.forEach((cx, i) => {
      const clip = doc.createElementNS(SVG_NS, "clipPath");
      clip.id = `eye-${i}`;
      const circle = doc.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", String(cx));
      circle.setAttribute("cy", String(ART.eyeY));
      circle.setAttribute("r", String(ART.eyeR));
      clip.append(circle);
      defs.append(clip);

      const lid = doc.createElementNS(SVG_NS, "rect");
      lid.setAttribute("x", String(cx - ART.eyeR));
      lid.setAttribute("y", String(ART.eyeY - ART.eyeR));
      lid.setAttribute("width", String(ART.eyeR * 2));
      lid.setAttribute("fill", "#fefefe");
      lid.setAttribute("clip-path", `url(#eye-${i})`);
      const line = doc.createElementNS(SVG_NS, "line");
      line.setAttribute("stroke", "#1a1a1a");
      line.setAttribute("stroke-width", "9");
      line.setAttribute("stroke-linecap", "round");
      const closed = doc.createElementNS(SVG_NS, "path");
      closed.setAttribute("d", `M ${cx - 42} ${ART.eyeY + 4} Q ${cx} ${ART.eyeY + 34} ${cx + 42} ${ART.eyeY + 4}`);
      closed.setAttribute("fill", "none");
      closed.setAttribute("stroke", "#1a1a1a");
      closed.setAttribute("stroke-width", "9");
      closed.setAttribute("stroke-linecap", "round");
      svg.append(lid, line, closed);
      lids.push(lid);
      lidLines.push(line);
      closedLines.push(closed);
    });
    // To the right of the head (ears end near x 950, y 110); the svg may draw past its box.
    [
      [900, 360, 200],
      [990, 240, 160],
      [1060, 140, 120],
    ].forEach(([x, y, size]) => {
      const z = doc.createElementNS(SVG_NS, "text");
      z.setAttribute("class", "zzz");
      z.setAttribute("x", String(x));
      z.setAttribute("y", String(y));
      z.setAttribute("font-size", String(size));
      z.textContent = "Z";
      svg.append(z);
    });
    return { svg, lids, lidLines, closedLines };
  }

  private renderEyes(mood: Mood) {
    const p = this.parts;
    if (!p) return;
    const share = LID[mood];
    const top = ART.eyeY - ART.eyeR;
    const edge = top + share * ART.eyeR * 2; // where the lid ends
    const half = Math.sqrt(Math.max(0, ART.eyeR ** 2 - (edge - ART.eyeY) ** 2)); // half chord at that height
    ART.eyes.forEach((cx, i) => {
      p.lids[i].setAttribute("height", String(share * ART.eyeR * 2));
      p.lids[i].style.display = share > 0 ? "" : "none";
      const line = p.lidLines[i];
      line.style.display = share > 0 && share < 1 ? "" : "none";
      line.setAttribute("x1", String(cx - half));
      line.setAttribute("x2", String(cx + half));
      line.setAttribute("y1", String(edge));
      line.setAttribute("y2", String(edge));
      p.closedLines[i].style.display = share >= 1 ? "" : "none";
    });
  }
}
