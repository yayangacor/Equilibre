import type { Baseline, KeyValueStore } from "./calibration.ts";
import { downloadFile, fileStamp } from "./download.ts";
import {
  calibrated,
  canFinishEarly,
  checkFeedback,
  checkIntake,
  COMMENT_MAX,
  consent,
  DELETE_BY,
  EARLY_FINISH_MINUTES,
  elapsedMinutes,
  FEEDBACK_QUESTIONS,
  finish,
  freshState,
  INTAKE_QUESTIONS,
  loadTestState,
  markSent,
  phase,
  saveTestState,
  SEND_ATTEMPTS,
  sendWithRetry,
  SLEEP_HOURS,
  TEST_MINUTES,
  toSubmission,
  UJI_URL,
  withSubmissionId,
  type Device,
  type FeedbackKey,
  type IntakeKey,
  type Phase,
  type Submission,
  type TestFeedback,
  type TestRecords,
  type TestState,
} from "./userTest.ts";

// The "Uji coba" card at the top of the dashboard, shown only with ?kode= (plans/P08, NOTES D-57).
// It walks a tester through consent, calibration, TEST_MINUTES of normal work and the feedback form,
// then sends one submission. The card is rebuilt only when the phase changes, so answers being typed
// survive the periodic refresh. Text goes in via textContent.

export type UserTestDeps = {
  store: KeyValueStore | null;
  code: string;
  isCalibrating: () => boolean;
  startCalibration: () => void; // must run inside the click, for the calibration beep
  openCompanion: (() => void) | null; // null: Picture-in-Picture not available
  records: () => Promise<TestRecords | null>;
  device: (from: number, to: number) => Device;
  baseline: () => Baseline | null;
  beep: () => void;
  onStarted: (t: number) => void; // the KSS reminders restart with the test clock
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", text, className);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function list(items: string[]): HTMLUListElement {
  const ul = el("ul");
  ul.append(...items.map((text) => el("li", text)));
  return ul;
}

// One radio group as a row of pill-shaped choices.
function radioGroup(name: string, legend: string, choices: readonly { nilai: string | number; teks: string }[]) {
  const set = el("fieldset");
  set.append(el("legend", legend));
  const row = el("div", "", "choice-row");
  for (const c of choices) {
    const label = el("label", "", "radio");
    const input = el("input");
    input.type = "radio";
    input.name = name;
    input.value = String(c.nilai);
    label.append(input, c.teks);
    row.append(label);
  }
  set.append(row);
  return set;
}

const checkedValue = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value;

export class UserTestPanel {
  private readonly deps: UserTestDeps;
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private state: TestState;
  private shown: Phase | null = null;
  private lastSubmission: Submission | null = null;
  // Updated in place between rebuilds
  private timer: HTMLElement | null = null;
  private progress: HTMLElement | null = null;
  private earlyButton: HTMLButtonElement | null = null;
  private calibButton: HTMLButtonElement | null = null;

  constructor(deps: UserTestDeps) {
    this.deps = deps;
    this.state = deps.store ? loadTestState(deps.store, deps.code) : freshState(deps.code);
    this.root = document.getElementById("uji-card")!;
    this.body = document.getElementById("uji-body")!;
    document.getElementById("uji-code")!.textContent = deps.code;
    this.root.hidden = false;
    document.getElementById("flow-uji")!.hidden = false; // the Privasi page lists the extra destination
  }

  running(now = Date.now()): boolean {
    return phase(this.state, now) === "berjalan";
  }

  get started(): number | null {
    return this.state.mulai;
  }

  // Called when a calibration finishes.
  calibrated(t: number) {
    const next = calibrated(this.state, t);
    if (next === this.state) return;
    this.setState(next);
    this.deps.onStarted(t);
    this.render(t);
  }

  render(now = Date.now()) {
    let p = phase(this.state, now);
    if (p === "feedback" && this.state.selesai === null) {
      this.setState(finish(this.state, now));
      if (this.shown === "berjalan") this.deps.beep();
    }
    p = phase(this.state, now);
    if (p !== this.shown) {
      this.shown = p;
      this.build(p);
    }
    this.update(p, now);
  }

  private setState(next: TestState) {
    this.state = next;
    if (this.deps.store) saveTestState(this.deps.store, next);
  }

  private build(p: Phase) {
    this.timer = this.progress = this.earlyButton = this.calibButton = null;
    this.root.dataset.phase = p;
    const parts =
      p === "persetujuan"
        ? this.consentView()
        : p === "kalibrasi"
          ? this.calibrationView()
          : p === "berjalan"
            ? this.runningView()
            : p === "feedback"
              ? this.feedbackView()
              : this.sentView();
    this.body.replaceChildren(...parts);
  }

  private update(p: Phase, now: number) {
    if (p === "kalibrasi" && this.calibButton) {
      const busy = this.deps.isCalibrating();
      this.calibButton.disabled = busy;
      this.calibButton.textContent = busy ? "Calibration in progress…" : "Start calibration";
    }
    if (p === "berjalan") {
      const minutes = elapsedMinutes(this.state, now);
      if (this.timer) this.timer.textContent = `${Math.floor(minutes)} of ${TEST_MINUTES} min`;
      if (this.progress) this.progress.style.width = `${(minutes / TEST_MINUTES) * 100}%`;
      if (this.earlyButton) this.earlyButton.disabled = !canFinishEarly(this.state, now);
    }
  }

  // ── Views ─────────────────────────────────────────────────────────────────────

  private consentView(): HTMLElement[] {
    const intro = el(
      "p",
      `Thank you for helping. This test takes ±${TEST_MINUTES + 5} min on your own laptop; you may stop after minute ${EARLY_FINISH_MINUTES}.`,
      "lead",
    );
    const todo = list([
      "Calibrate for ±5 min, then work as usual on this laptop.",
      "Every 15 min you hear a sound: fill in the sleepiness check (KSS, scale 1–9) on this page.",
      this.deps.openCompanion
        ? "A small Picture-in-Picture window opens when calibration starts. Keep it open until the end: without " +
          "it, monitoring stops when you switch to another app."
        : "This browser has no Picture-in-Picture window, so monitoring stops when this tab is not visible. Use Chrome if you can.",
      "At the end, answer 5 short questions, then press Send.",
    ]);
    const sent = el(
      "p",
      "The state and summary numbers every 10 s (e.g. blink length, percent of time with eyes closed), your sleepiness checks (KSS), " +
        "state corrections, breaks, calibration numbers, browser and operating system, the answers below, your feedback, and the test code.",
    );
    const never = el("p", "Video, photos, face landmarks, your name and your email. Video is processed only in your browser.");
    const rights = el(
      "p",
      "Test data is used to measure how accurate Equilibre is and, without names, as evidence of user testing for the competition; it is deleted " +
        `by ${DELETE_BY} at the latest. You can stop at any time ` +
        "by closing the page; nothing is sent before you press Send. To delete data already sent, " +
        "contact the person who gave you the link and mention your code.",
      "fine",
    );

    const form = el("div", "", "uji-form");
    form.append(el("p", "About you today (optional)", "choices-label"));
    for (const q of INTAKE_QUESTIONS) form.append(radioGroup(`isian-${q.key}`, q.teks, q.pilihan));
    const sleepSet = el("fieldset");
    const sleepLabel = el("label", "Hours of sleep last night ");
    // Text, not type=number: a number input drops "6,5" (decimal comma) in many locales; checkIntake parses both.
    const sleepInput = el("input");
    sleepInput.type = "text";
    sleepInput.inputMode = "decimal";
    sleepInput.maxLength = 4;
    sleepInput.placeholder = "e.g. 6.5";
    sleepInput.title = `${SLEEP_HOURS.min}–${SLEEP_HOURS.max} h`;
    sleepLabel.append(sleepInput, " h");
    sleepSet.append(sleepLabel);
    form.append(sleepSet);

    const agree = el("label", "", "check");
    const box = el("input");
    box.type = "checkbox";
    agree.append(box, "I have read this and agree to take part in the test.");
    const start = button("Agree and continue to calibration", "btn primary", () => {
      const answers: Partial<Record<IntakeKey, string>> = {};
      for (const q of INTAKE_QUESTIONS) answers[q.key] = checkedValue(form, `isian-${q.key}`);
      this.setState(consent(this.state, checkIntake(answers, sleepInput.value), Date.now()));
      this.render();
    });
    start.disabled = true;
    box.addEventListener("change", () => (start.disabled = !box.checked));
    const actions = el("div", "", "row");
    actions.append(start);

    return [
      intro,
      el("h3", "What you do"),
      todo,
      el("h3", "What is sent, after you press Send at the end"),
      sent,
      el("h3", "What is never sent"),
      never,
      rights,
      form,
      agree,
      actions,
    ];
  }

  private calibrationView(): HTMLElement[] {
    this.calibButton = button("Start calibration", "btn primary", () => {
      if (!this.deps.isCalibrating()) this.deps.startCalibration();
      this.update("kalibrasi", Date.now());
    });
    const actions = el("div", "", "row");
    actions.append(this.calibButton);
    return [
      el("p", "Step 1 of 3 · Calibration, ±5 min", "step"),
      el(
        "p",
        "Sit as usual with your face visible to the camera. Press the button and follow the prompts: eyes open, close them for ±3 s until " +
          "the long beep, then work as usual for ±5 min. Keep this tab visible during calibration. The test clock starts " +
          "when calibration is done." +
          (this.deps.openCompanion ? " A small Picture-in-Picture window opens when you press the button: keep it open." : ""),
        "helper",
      ),
      actions,
    ];
  }

  private runningView(): HTMLElement[] {
    this.timer = el("p", "", "uji-timer");
    const bar = el("div", "", "bar progress");
    this.progress = el("span");
    bar.append(this.progress);
    const actions = el("div", "", "row");
    if (this.deps.openCompanion) {
      const open = this.deps.openCompanion;
      actions.append(button("Open Picture-in-Picture window", "btn tonal", () => open()));
    }
    this.earlyButton = button("Finish early", "btn outline", () => {
      this.setState(finish(this.state, Date.now()));
      this.render();
    });
    actions.append(this.earlyButton);
    return [
      el("p", "Step 2 of 3 · Work as usual", "step"),
      this.timer,
      bar,
      list([
        "Fill in the sleepiness check (KSS) below when you hear the sound (every 15 min).",
        this.deps.openCompanion
          ? "Keep the Picture-in-Picture window open when you switch to another app. Closed it? Press \"Open Picture-in-Picture window\"."
          : "Keep this tab visible: without a Picture-in-Picture window, monitoring stops when another window covers this tab.",
        "State feels wrong? Correct it from the state details on the Dashboard.",
      ]),
      actions,
      el("p", `"Finish early" is available from minute ${EARLY_FINISH_MINUTES}.`, "helper"),
    ];
  }

  private feedbackView(): HTMLElement[] {
    const minutes = Math.round(elapsedMinutes(this.state, this.state.selesai ?? Date.now()));
    const form = el("div", "", "uji-form");
    for (const q of FEEDBACK_QUESTIONS) form.append(radioGroup(`fb-${q.key}`, q.teks, q.pilihan));
    const commentSet = el("fieldset");
    const commentLabel = el(
      "label",
      `What helped most, and what should be improved? (optional, max. ${COMMENT_MAX} characters)`,
    );
    const comment = el("textarea");
    comment.maxLength = COMMENT_MAX;
    comment.rows = 3;
    commentLabel.append(comment);
    commentSet.append(commentLabel);
    form.append(commentSet);

    const status = el("p", "", "helper");
    status.setAttribute("aria-live", "polite");
    const download = button("Download results file", "btn outline", () => this.download());
    download.hidden = true;
    const send = button("Send results", "btn primary", () => {
      const answers: Partial<Record<FeedbackKey, string | number>> = {};
      for (const q of FEEDBACK_QUESTIONS) {
        const raw = checkedValue(form, `fb-${q.key}`);
        answers[q.key] = raw === undefined ? undefined : typeof q.pilihan[0].nilai === "number" ? Number(raw) : raw;
      }
      const feedback = checkFeedback(answers, comment.value);
      if (!feedback) {
        status.textContent = `Please answer all ${FEEDBACK_QUESTIONS.length} questions first (the comment is optional).`;
        return;
      }
      void this.send(feedback, { send, download, status });
    });
    const actions = el("div", "", "row");
    actions.append(send, download);
    return [
      el("p", "Step 3 of 3 · Tell us how it went", "step"),
      el("p", `Test recorded: ${minutes} min. Answer ${FEEDBACK_QUESTIONS.length} questions, then send.`, "helper"),
      form,
      actions,
      status,
    ];
  }

  private sentView(): HTMLElement[] {
    const sent = this.state.terkirim!;
    const counts = this.lastSubmission
      ? ` · ${this.lastSubmission.evaluasi.length} readings, ${this.lastSubmission.kss.length} sleepiness checks (KSS)`
      : "";
    const parts: HTMLElement[] = [
      el("p", "Thank you! Your test results have been sent.", "step"),
      el("p", `Submission number ${sent.id.slice(0, 8)}${counts}. You can close this page now.`, "helper"),
      el(
        "p",
        `Want your data deleted? Contact the person who gave you the link and mention code ${this.state.kode}. The test history in this browser ` +
          "can be deleted on the Privacy page (delete all history).",
        "fine",
      ),
    ];
    if (this.lastSubmission) {
      const actions = el("div", "", "row");
      actions.append(button("Download a copy of the results", "btn outline", () => this.download()));
      parts.push(actions);
    }
    return parts;
  }

  // ── Sending ───────────────────────────────────────────────────────────────────

  private async send(feedback: TestFeedback, ui: { send: HTMLButtonElement; download: HTMLButtonElement; status: HTMLElement }) {
    const { mulai, selesai } = this.state;
    if (mulai === null || selesai === null) return;
    ui.send.disabled = true;
    ui.status.textContent = "Preparing results…";
    const records = await this.deps.records();
    if (!records) {
      ui.status.textContent = "The test history cannot be read in this browser, so there is nothing to send.";
      ui.send.disabled = false;
      return;
    }
    const now = Date.now();
    this.setState(withSubmissionId(this.state, () => crypto.randomUUID())); // saved before the first send
    const sub = toSubmission(this.state, feedback, records, {
      perangkat: this.deps.device(mulai, selesai),
      baseline: this.deps.baseline(),
      now,
    });
    this.lastSubmission = sub;
    if (!UJI_URL) {
      ui.status.textContent =
        "Automatic sending is not set up yet. Download the results file and send it to the person who gave you the link.";
      ui.download.hidden = false;
      ui.send.disabled = false;
      return;
    }
    const result = await sendWithRetry(UJI_URL, sub, {
      onAttempt: (n) => {
        ui.status.textContent = n === 1 ? "Sending…" : `No confirmation yet, trying again (${n} of ${SEND_ATTEMPTS})…`;
      },
    });
    if (result.ok) {
      this.setState(markSent(this.state, result.id, Date.now(), result.duplikat));
      this.render();
      return;
    }
    ui.status.textContent = `Sending failed: ${result.error} Try again, or download the results file and send it to the person who gave you the link.`;
    ui.download.hidden = false;
    ui.send.disabled = false;
  }

  private download() {
    if (!this.lastSubmission) return;
    downloadFile(
      JSON.stringify(this.lastSubmission),
      `equilibre-uji-${this.state.kode}-${fileStamp(new Date())}.json`,
      "application/json",
    );
  }
}
