import { GREETING } from "./companion.ts";
import type { Label } from "./rules.ts";
import { STATE_TOKEN } from "./stateCopy.ts";

// Picture-in-Picture window (NOTES D-78): a small always-on-top readout with the state, its reason, and
// Pause / Recalibrate, so Equilibre stays visible while the user works in another window. While it is open its
// timers also drive the detection loop (pipWindow), since a hidden tab is throttled to ±1 fps (G-03, G-56).
// Document Picture-in-Picture is Chromium only; elsewhere the button is off. Texts go in via textContent; the
// window gets its own small stylesheet in the Readout's paper and ink.

type DocumentPiP = {
  requestWindow(options: { width: number; height: number; preferInitialWindowPlacement?: boolean }): Promise<Window>;
};
const documentPiP = (): DocumentPiP | null =>
  (window as Window & { documentPictureInPicture?: DocumentPiP }).documentPictureInPicture ?? null;

// The requested inner size; Chrome raises the width to its minimum.
const SIZE = { width: 300, height: 220 };

export type CompanionView = {
  state: Label | null; // colors the dot; null = no state yet (loading, calibrating, paused)
  label: string; // "Normal", "Calibrating · 3:12", "Paused", …
  note: string; // one short line: the reason, or what to do
  paused: boolean;
};

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
:root { --paper: #f3f2ed; --raised: #faf9f6; --ink: #121518; --ink-2: #474d54; --ink-3: #6b7178; --rule: #d8d6ce;
  --normal: #1f9d8a; --mild: #e0a526; --tired: #e5483b; --asleep: #6b5bd2; --away: #9aa1a9;
  font-family: "IBM Plex Sans", system-ui, "Segoe UI", sans-serif; color: var(--ink); background: var(--paper);
  color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; display: flex; flex-direction: column; padding: 12px 14px; gap: 8px;
  overflow: hidden; user-select: none; }
.head { display: flex; justify-content: space-between; align-items: center; }
.brand { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; letter-spacing: -0.01em; }
.brand img { height: 15px; width: auto; }
.mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 10px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.state { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule); }
.dot { flex: none; width: 14px; height: 14px; border-radius: 50%; background: var(--away); transition: background .4s; }
[data-state="normal"] .dot { background: var(--normal); }
[data-state="mild"] .dot { background: var(--mild); }
[data-state="tired"] .dot { background: var(--tired); }
[data-state="asleep"] .dot { background: var(--asleep); }
[data-state="none"] .dot { background: transparent; border: 1.5px solid var(--ink-3); }
[data-paused="1"] .dot { background: transparent; border: 1.5px dashed var(--ink-3); }
.label { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; }
.note { margin: 0; font-size: 12px; color: var(--ink-2); line-height: 1.35; min-height: 2.7em; }
.nudge { margin: 0; padding: 8px 10px; border-left: 3px solid var(--ink); background: var(--raised); font-size: 12px;
  line-height: 1.35; }
.nudge[hidden] { display: none; }
.nudge button { margin-left: 6px; }
.actions { display: flex; gap: 8px; margin-top: auto; }
button { font: inherit; font-size: 12px; font-weight: 600; height: 32px; padding: 0 12px; border-radius: 4px;
  border: 1px solid var(--ink); background: var(--paper); color: var(--ink); cursor: pointer; }
button.primary { background: var(--ink); color: var(--paper); }
button:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
button.link { height: auto; padding: 0; border: 0; background: none; font-weight: 400; color: var(--ink-2);
  text-decoration: underline; }
`;

export type PipCompanionDeps = {
  debug: boolean;
  onChange: (open: boolean) => void; // the PiP window opened or closed
  onSnooze: () => void; // "Snooze 30 min"
  onPause: () => void; // pause or resume monitoring
  onRecalibrate: () => void; // bring the app forward with the calibration screen
};

export class PipCompanion {
  private readonly deps: PipCompanionDeps;
  private win: Window | null = null;
  private parts: {
    body: HTMLElement;
    label: HTMLElement;
    note: HTMLElement;
    nudge: HTMLElement;
    nudgeText: HTMLElement;
    pause: HTMLButtonElement;
    fps: HTMLElement;
  } | null = null;
  private nudgeTimer = 0;
  private view: CompanionView = { state: null, label: "Loading…", note: "", paused: false };
  // outerWidth of a window that opened too wide (G-71), until it is narrowed or resized by the user
  private oversized: number | null = null;

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
    for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, this.fit, true);
  }

  get isOpen(): boolean {
    return this.win !== null;
  }

  // The open PiP window, whose timers also drive the detection loop (main.ts, runDetection).
  get pipWindow(): Window | null {
    return this.win;
  }

  // Must run inside a click handler: requestWindow needs a user gesture.
  // Without preferInitialWindowPlacement Chrome reopens at the size the window had when it was closed.
  async open(): Promise<void> {
    const api = documentPiP();
    if (!api || this.win) return;
    const win = await api.requestWindow({ ...SIZE, preferInitialWindowPlacement: true });
    this.win = win;
    // On a 100% monitor next to a 200% primary display, Chrome opens the window at twice its minimum
    // width but places it as if it were narrow (G-71). resizeTo needs a user activation and requestWindow
    // has just used this one up: the next click or key press in either window narrows it.
    this.oversized = win.innerWidth > SIZE.width * 1.5 ? win.outerWidth : null;
    for (const type of ["pointerdown", "keydown"]) win.addEventListener(type, this.fit, true);
    this.build(win.document);
    win.addEventListener("pagehide", () => this.closed(), { once: true });
    this.render(this.view);
    this.deps.onChange(true);
  }

  close(): void {
    this.win?.close();
  }

  // Narrows a window that opened too wide, unless the user has resized it since.
  private readonly fit = () => {
    const win = this.win;
    if (!win || this.oversized === null) return;
    if (win.outerWidth !== this.oversized) {
      this.oversized = null;
      return;
    }
    try {
      win.resizeTo(SIZE.width + win.outerWidth - win.innerWidth, win.outerHeight);
      this.oversized = null;
    } catch {
      // No user activation (e.g. Escape): the next click or key press tries again.
    }
  };

  render(view: CompanionView): void {
    this.view = view;
    const p = this.parts;
    if (!p) return;
    p.body.dataset.state = view.state ? STATE_TOKEN[view.state] : "none";
    p.body.dataset.paused = view.paused ? "1" : "0";
    p.label.textContent = view.label;
    p.note.textContent = view.note;
    p.pause.textContent = view.paused ? "Resume" : "Pause";
    p.pause.classList.toggle("primary", view.paused);
  }

  // A nudge under the state; it hides by itself after GREETING.showMs.
  say(text: string): void {
    const p = this.parts;
    if (!p || !this.win) return;
    p.nudgeText.textContent = text;
    p.nudge.hidden = false;
    this.win.clearTimeout(this.nudgeTimer);
    this.nudgeTimer = this.win.setTimeout(() => (p.nudge.hidden = true), GREETING.showMs);
  }

  setFps(text: string): void {
    if (this.parts) this.parts.fps.textContent = this.deps.debug ? `${text} fps` : "On-device";
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
    const button = (text: string, className: string | undefined, onClick: () => void) => {
      const b = make("button", className, text);
      b.type = "button";
      b.addEventListener("click", onClick);
      return b;
    };

    const head = make("div", "head");
    const fps = make("span", "mono", "On-device");
    const brand = make("span", "brand", "Equilibre");
    const mark = make("img");
    mark.src = new URL("/logo-mark.svg", location.href).href; // absolute: the PiP document has no URL of its own
    mark.alt = "";
    brand.prepend(mark);
    head.append(brand, fps);

    const state = make("div", "state");
    const dot = make("span", "dot");
    dot.setAttribute("aria-hidden", "true");
    const label = make("p", "label");
    label.setAttribute("aria-live", "polite");
    state.append(dot, label);

    const note = make("p", "note");

    const nudge = make("p", "nudge");
    nudge.hidden = true;
    nudge.setAttribute("role", "status");
    const nudgeText = make("span");
    nudge.append(
      nudgeText,
      button("Snooze 30 min", "link", () => {
        nudge.hidden = true;
        this.deps.onSnooze();
      }),
    );

    const pause = button("Pause", undefined, () => this.deps.onPause());
    const actions = make("div", "actions");
    actions.append(pause, button("Recalibrate", undefined, () => this.deps.onRecalibrate()));

    doc.body.append(head, state, note, nudge, actions);
    this.parts = { body: doc.body, label, note, nudge, nudgeText, pause, fps };
  }
}
