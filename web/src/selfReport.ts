import { feedbackButtons } from "./dashboard.ts";
import {
  cameraJustCountedBreak,
  correctionChoices,
  dayKey,
  MANUAL_BREAK_MINUTES,
  toKssRecord,
  toLabelCorrection,
  toManualBreakRecord,
  type Feedback,
} from "./history.ts";
import type { HistoryPanel } from "./historyPanel.ts";
import { KSS_SCALE, kssDue } from "./kss.ts";
import type { Evaluation, Label } from "./rules.ts";

// What the user tells Equilibre back, all kept on the device (NOTES D-06, D-36):
// feedback on a recommendation, a correction of the shown label, a KSS rating (with a
// reminder every 15 minutes in test mode, ?uji=1), and a break the camera missed (D-42).
// Text goes in via textContent.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = text;
  node.addEventListener("click", onClick);
  return node;
}

const clock = (t: number) => new Date(t).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });

export type SelfReportDeps = {
  panel: HistoryPanel;
  session: number;
  shown: () => Evaluation | null; // the label on screen right now
  testMode: boolean;
  beep: () => void;
  lastCameraBreak: () => number | null; // wall clock end of the last break the camera counted
  breakTaken: () => void; // restarts menit_sejak_jeda
};

export class SelfReport {
  private readonly deps: SelfReportDeps;
  // Label correction (Status panel)
  private readonly correctionBox = byId("correction");
  private readonly correctButton = byId<HTMLButtonElement>("correct-label");
  private readonly choices = byId("correction-choices");
  private readonly options = byId("correction-options");
  private readonly correctionNote = byId("correction-note");
  private correctionFor: Label | null = null;
  // KSS
  private readonly kssPanel = byId("kss-panel");
  private readonly kssPrompt = byId("kss-prompt");
  private readonly kssNote = byId("kss-note");
  private lastKss = Date.now(); // the reminder clock: last rating, or page load
  private kssDueNow = false;
  // Feedback on the answer in the Langflow panel
  private readonly feedbackBox = byId("feedback");
  private recommendationId: number | null = null;
  // Break marked by hand (Status panel)
  private readonly breakButton = byId<HTMLButtonElement>("break-done");
  private readonly breakChoices = byId("break-choices");
  private readonly breakNote = byId("break-note");

  constructor(deps: SelfReportDeps) {
    this.deps = deps;
    this.correctButton.addEventListener("click", () => this.openChoices());
    byId("correction-cancel").addEventListener("click", () => this.closeChoices());
    this.breakButton.addEventListener("click", () => this.showBreakChoices(true));
    byId("break-cancel").addEventListener("click", () => this.showBreakChoices(false));
    byId("break-options").replaceChildren(
      ...MANUAL_BREAK_MINUTES.map((m) => button(`±${m} menit`, "btn outline small", () => void this.markBreak(m))),
    );
    byId("kss-scale").replaceChildren(
      ...KSS_SCALE.map((step) => {
        const option = button("", "kss-option", () => void this.rate(step.nilai));
        const number = document.createElement("span");
        number.className = "kss-n";
        number.textContent = String(step.nilai);
        const text = document.createElement("span");
        text.textContent = step.teks;
        option.append(number, text);
        option.title = step.asli; // the original English label
        return option;
      }),
    );
    deps.panel.onFeedback = (id, feedback) => {
      if (id === this.recommendationId) this.showRecommendation(id, feedback);
    };
    deps.panel.onCleared = () => this.showRecommendation(null);
  }

  // A reload keeps the 15-minute rhythm of the day's ratings.
  async restoreKssClock() {
    const today = await this.deps.panel.byDay("kss", dayKey(Date.now()));
    const last = Math.max(...today.map((k) => k.t));
    if (Number.isFinite(last)) this.lastKss = last;
  }

  // ── Label correction ──────────────────────────────────────────────────────────

  // Called whenever the Status panel renders; null while calibrating or before a label.
  renderCorrection(shown: Evaluation | null) {
    this.correctionBox.hidden = shown === null;
    if (shown?.label !== this.correctionFor) this.closeChoices();
  }

  private openChoices() {
    const shown = this.deps.shown();
    if (!shown) return;
    this.correctionFor = shown.label;
    this.options.replaceChildren(...correctionChoices(shown.label).map((l) => button(l, "btn outline small", () => void this.correct(l))));
    this.choices.hidden = false;
    this.correctButton.hidden = true;
    this.correctionNote.textContent = "";
  }

  private closeChoices() {
    this.correctionFor = null;
    this.choices.hidden = true;
    this.correctButton.hidden = false;
  }

  private async correct(koreksi: Label) {
    const shown = this.deps.shown();
    this.closeChoices();
    if (!shown) return;
    const id = await this.deps.panel.add("koreksi_label", toLabelCorrection(shown, koreksi, { t: Date.now(), sesi: this.deps.session }));
    this.correctionNote.textContent =
      id === null
        ? "Koreksi tidak bisa disimpan: riwayat tidak tersedia di perangkat ini."
        : `Tercatat: menurutmu "${koreksi}", bukan "${shown.label}". Disimpan di perangkat ini untuk evaluasi, tidak mengubah label.`;
  }

  // ── Break marked by hand ──────────────────────────────────────────────────────

  private showBreakChoices(open: boolean) {
    this.breakChoices.hidden = !open;
    this.breakButton.hidden = open;
  }

  private async markBreak(menit: number) {
    this.showBreakChoices(false);
    const t = Date.now();
    const last = this.deps.lastCameraBreak();
    if (last !== null && cameraJustCountedBreak(last, t)) {
      this.breakNote.textContent = `Jeda ini sudah terhitung otomatis, selesai pukul ${clock(last)}. Tidak dicatat dua kali.`;
      return;
    }
    this.deps.breakTaken();
    const id = await this.deps.panel.add("jeda", toManualBreakRecord(menit, t, this.deps.session));
    this.breakNote.textContent =
      (id === null
        ? "Jeda dihitung untuk sesi ini, tapi tidak bisa disimpan: riwayat tidak tersedia di perangkat ini."
        : `Jeda ±${menit} menit tercatat pukul ${clock(t)}.`) + " Menit sejak jeda mulai lagi dari nol.";
  }

  // ── KSS ───────────────────────────────────────────────────────────────────────

  // Test mode only: flags the panel once the rating is due, and beeps once.
  tick(now: number) {
    if (!this.deps.testMode || this.kssDueNow || !kssDue(this.lastKss, now)) return;
    this.kssDueNow = true;
    this.kssPanel.dataset.due = "1";
    this.kssPrompt.textContent = "Waktunya mengisi KSS (tiap 15 menit): seberapa mengantuk kamu dalam 5 menit terakhir?";
    this.deps.beep();
  }

  private async rate(kss: number) {
    const t = Date.now();
    const id = await this.deps.panel.add(
      "kss",
      toKssRecord(kss, { t, sesi: this.deps.session, labelTampil: this.deps.shown()?.label ?? null, pengingat: this.kssDueNow }),
    );
    if (id === null) {
      this.kssNote.textContent = "KSS tidak bisa disimpan: riwayat tidak tersedia di perangkat ini.";
      return;
    }
    this.lastKss = t;
    this.kssDueNow = false;
    delete this.kssPanel.dataset.due;
    this.kssPrompt.textContent = "Seberapa mengantuk kamu dalam 5 menit terakhir? Pilih satu.";
    this.kssNote.textContent = `KSS ${kss} tersimpan pukul ${clock(t)}.${this.deps.testMode ? " Pengingat berikutnya 15 menit lagi." : ""}`;
  }

  // ── Feedback on the answer in the Langflow panel ──────────────────────────────

  // id: the stored recommendation; null hides the buttons (nothing stored, or cleared).
  showRecommendation(id: number | null, feedback: Feedback | null = null) {
    this.recommendationId = id;
    this.feedbackBox.hidden = id === null;
    this.feedbackBox.querySelector(".feedback-row")?.remove();
    if (id !== null) this.feedbackBox.append(feedbackButtons(feedback, (f) => void this.deps.panel.feedback(id, f)));
  }
}
