import { ART, createBear, type Bear } from "./bear.ts";
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

// The PiP window is its own document: the Plex faces are declared again with absolute URLs.
const fontFaces = () =>
  [
    [400, "Regular"],
    [600, "SemiBold"],
  ]
    .map(
      ([weight, name]) =>
        `@font-face { font-family: "IBM Plex Sans"; font-weight: ${weight}; font-display: swap;
  src: url("${new URL(`/fonts/IBMPlexSans-${name}-Latin1.woff2`, location.href).href}") format("woff2"); }`,
    )
    .join("\n");

const styleSheet = () => `
${fontFaces()}
:root { --bg: #f7f5f0; --text: #1b1f24; --muted: #545b66; --ok: #0b7f6e; --warn: #b26b00; --error: #b3402e;
  --sleep: #5b4bb7; --idle: #687587; --on-status: #fff; --bubble: #ffffff; --border: #e2ded5;
  font-family: "IBM Plex Sans", system-ui, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
@media (prefers-color-scheme: dark) { :root { --bg: #111418; --text: #e6e9ed; --muted: #a3abb6; --ok: #4fc1a9;
  --warn: #e5a646; --error: #f08b79; --sleep: #a99bf2; --idle: #94a0b0; --on-status: #111418; --bubble: #181c21;
  --border: #2c333b; } }
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
    bear: Bear;
  } | null = null;
  private bubbleTimer = 0;
  private view: CompanionView = { mood: "menunggu", label: "Memuat…", note: "" };

  static supported(): boolean {
    return documentPiP() !== null;
  }

  // Automatic picture-in-picture (Chrome 120+ desktop): while the page captures the camera, the
  // browser runs this handler when the user switches to another tab, and the window may open
  // without a click. The browser closes a window opened this way once the tab is visible again.
  // It does not fire when the user switches to another application, nor while a PiP window is open.
  // https://developer.chrome.com/blog/automatic-picture-in-picture
  static openOnTabSwitch(open: () => void): void {
    try {
      navigator.mediaSession.setActionHandler("enterpictureinpicture" as MediaSessionAction, open);
    } catch {
      // The action (or the Media Session API) is not supported: the button stays the only way in.
    }
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
    p.bear.setMood(view.mood);
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
    style.textContent = styleSheet();
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
    const bear = createBear(doc, "Beruang pendamping Equilibre");
    stage.append(bear.root);

    // The bubble sits above the character (not over it), so the face stays visible while it talks.
    const badge = make("div", "badge");
    const note = make("p", "note");
    doc.body.append(bubble, stage, badge, note);
    const fps = this.deps.debug ? make("p", "fps", "deteksi – fps") : null;
    if (fps) doc.body.append(fps);

    this.parts = { body: doc.body, badge, note, bubble, bubbleText, fps, bear };
  }
}
