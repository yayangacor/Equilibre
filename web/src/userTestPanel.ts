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

// The "Uji coba" card at the top of the Sekarang page, shown only with ?kode= (plans/P08, NOTES D-57).
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
      this.calibButton.textContent = busy ? "Kalibrasi berjalan…" : "Mulai kalibrasi";
    }
    if (p === "berjalan") {
      const minutes = elapsedMinutes(this.state, now);
      if (this.timer) this.timer.textContent = `${Math.floor(minutes)} dari ${TEST_MINUTES} menit`;
      if (this.progress) this.progress.style.width = `${(minutes / TEST_MINUTES) * 100}%`;
      if (this.earlyButton) this.earlyButton.disabled = !canFinishEarly(this.state, now);
    }
  }

  // ── Views ─────────────────────────────────────────────────────────────────────

  private consentView(): HTMLElement[] {
    const intro = el(
      "p",
      `Terima kasih sudah membantu. Uji ini ±${TEST_MINUTES + 5} menit di laptopmu sendiri, boleh berhenti setelah menit ${EARLY_FINISH_MINUTES}.`,
      "lead",
    );
    const todo = list([
      "Kalibrasi ±5 menit, lalu bekerja seperti biasa di laptop ini.",
      "Tiap 15 menit ada bunyi: isi \"Cek kantuk\" (skala 1–9) di halaman ini.",
      this.deps.openCompanion
        ? "Jendela kecil berisi beruang (pendamping) muncul saat kalibrasi dimulai. Biarkan terbuka sampai selesai: tanpa " +
          "jendela itu, pemantauan berhenti saat kamu pindah ke aplikasi lain."
        : "Browser ini tidak punya jendela pendamping, jadi pemantauan berhenti saat tab ini tidak terlihat. Kalau bisa, pakai Chrome.",
      "Di akhir, jawab 5 pertanyaan singkat lalu tekan Kirim.",
    ]);
    const sent = el(
      "p",
      "Label dan angka ringkasan tiap 10 detik (mis. lama kedip, persen mata tertutup), isian Cek kantuk, koreksi label, jeda, " +
        "angka kalibrasi, jenis browser dan sistem operasi, isian di bawah, jawaban feedback, dan kode uji.",
    );
    const never = el("p", "Video, foto, titik wajah, nama, dan email. Video tetap diproses di browsermu saja.");
    const rights = el(
      "p",
      `Data uji hanya untuk mengukur ketepatan Equilibre dan dihapus paling lambat ${DELETE_BY}. Kamu boleh berhenti kapan saja ` +
        "dengan menutup halaman; tidak ada yang terkirim sebelum kamu menekan Kirim. Untuk menghapus data yang sudah terkirim, " +
        "hubungi orang yang memberimu link dan sebut kodemu.",
      "fine",
    );

    const form = el("div", "", "uji-form");
    form.append(el("p", "Tentang kondisimu (boleh dikosongkan)", "choices-label"));
    for (const q of INTAKE_QUESTIONS) form.append(radioGroup(`isian-${q.key}`, q.teks, q.pilihan));
    const sleepSet = el("fieldset");
    const sleepLabel = el("label", "Jam tidur semalam ");
    // Text, not type=number: a number input drops "6,5" (decimal comma) in many locales; checkIntake parses both.
    const sleepInput = el("input");
    sleepInput.type = "text";
    sleepInput.inputMode = "decimal";
    sleepInput.maxLength = 4;
    sleepInput.placeholder = "mis. 6,5";
    sleepInput.title = `${SLEEP_HOURS.min}–${SLEEP_HOURS.max} jam`;
    sleepLabel.append(sleepInput, " jam");
    sleepSet.append(sleepLabel);
    form.append(sleepSet);

    const agree = el("label", "", "check");
    const box = el("input");
    box.type = "checkbox";
    agree.append(box, "Aku sudah membaca dan setuju ikut uji ini.");
    const start = button("Setuju, lanjut ke kalibrasi", "btn primary", () => {
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
      el("h3", "Yang kamu lakukan"),
      todo,
      el("h3", "Yang dikirim, setelah kamu menekan Kirim di akhir"),
      sent,
      el("h3", "Yang tidak pernah dikirim"),
      never,
      rights,
      form,
      agree,
      actions,
    ];
  }

  private calibrationView(): HTMLElement[] {
    this.calibButton = button("Mulai kalibrasi", "btn primary", () => {
      if (!this.deps.isCalibrating()) this.deps.startCalibration();
      this.update("kalibrasi", Date.now());
    });
    const actions = el("div", "", "row");
    actions.append(this.calibButton);
    return [
      el("p", "Langkah 1 dari 3 · Kalibrasi ±5 menit", "step"),
      el(
        "p",
        "Duduk seperti biasa dengan wajah terlihat kamera. Tekan tombol lalu ikuti aba-aba: mata terbuka, pejamkan ±3 detik sampai " +
          "bunyi beep panjang, lalu bekerja biasa ±5 menit. Biarkan tab ini terlihat selama kalibrasi. Waktu uji mulai dihitung " +
          "setelah kalibrasi selesai." +
          (this.deps.openCompanion ? " Jendela kecil berisi beruang ikut muncul saat kamu menekan tombol: biarkan terbuka." : ""),
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
      actions.append(button("Buka pendamping", "btn tonal", () => open()));
    }
    this.earlyButton = button("Selesai lebih awal", "btn outline", () => {
      this.setState(finish(this.state, Date.now()));
      this.render();
    });
    actions.append(this.earlyButton);
    return [
      el("p", "Langkah 2 dari 3 · Bekerja seperti biasa", "step"),
      this.timer,
      bar,
      list([
        "Isi \"Cek kantuk\" di bawah saat ada bunyi (tiap 15 menit).",
        this.deps.openCompanion
          ? "Biarkan jendela beruang (pendamping) terbuka saat pindah ke aplikasi lain. Tertutup? Tekan \"Buka pendamping\"."
          : "Biarkan tab ini terlihat: tanpa jendela pendamping, pemantauan berhenti saat tab ini tertutup jendela lain.",
        "Label terasa salah? Buka \"Kenapa Equilibre menilai begini?\" lalu \"Label ini tidak sesuai?\".",
      ]),
      actions,
      el("p", `"Selesai lebih awal" aktif mulai menit ${EARLY_FINISH_MINUTES}.`, "helper"),
    ];
  }

  private feedbackView(): HTMLElement[] {
    const minutes = Math.round(elapsedMinutes(this.state, this.state.selesai ?? Date.now()));
    const form = el("div", "", "uji-form");
    for (const q of FEEDBACK_QUESTIONS) form.append(radioGroup(`fb-${q.key}`, q.teks, q.pilihan));
    const commentSet = el("fieldset");
    const commentLabel = el("label", `Komentar atau saran (opsional, maks. ${COMMENT_MAX} karakter)`);
    const comment = el("textarea");
    comment.maxLength = COMMENT_MAX;
    comment.rows = 3;
    commentLabel.append(comment);
    commentSet.append(commentLabel);
    form.append(commentSet);

    const status = el("p", "", "helper");
    status.setAttribute("aria-live", "polite");
    const download = button("Unduh file hasil", "btn outline", () => this.download());
    download.hidden = true;
    const send = button("Kirim hasil", "btn primary", () => {
      const answers: Partial<Record<FeedbackKey, string | number>> = {};
      for (const q of FEEDBACK_QUESTIONS) {
        const raw = checkedValue(form, `fb-${q.key}`);
        answers[q.key] = raw === undefined ? undefined : typeof q.pilihan[0].nilai === "number" ? Number(raw) : raw;
      }
      const feedback = checkFeedback(answers, comment.value);
      if (!feedback) {
        status.textContent = "Jawab kelima pertanyaan dulu (komentar boleh kosong).";
        return;
      }
      void this.send(feedback, { send, download, status });
    });
    const actions = el("div", "", "row");
    actions.append(send, download);
    return [
      el("p", "Langkah 3 dari 3 · Ceritakan pengalamanmu", "step"),
      el("p", `Uji tercatat ${minutes} menit. Jawab 5 pertanyaan lalu kirim.`, "helper"),
      form,
      actions,
      status,
    ];
  }

  private sentView(): HTMLElement[] {
    const sent = this.state.terkirim!;
    const counts = this.lastSubmission
      ? ` · ${this.lastSubmission.evaluasi.length} evaluasi, ${this.lastSubmission.kss.length} isian Cek kantuk`
      : "";
    const parts: HTMLElement[] = [
      el("p", "Terima kasih! Hasil ujimu sudah terkirim.", "step"),
      el("p", `Nomor kiriman ${sent.id.slice(0, 8)}${counts}. Kamu boleh menutup halaman ini.`, "helper"),
      el(
        "p",
        `Mau datamu dihapus? Hubungi orang yang memberimu link dan sebut kode ${this.state.kode}. Riwayat uji di browser ini ` +
          "bisa dihapus lewat Privasi → Hapus semua riwayat.",
        "fine",
      ),
    ];
    if (this.lastSubmission) {
      const actions = el("div", "", "row");
      actions.append(button("Unduh salinan hasil", "btn outline", () => this.download()));
      parts.push(actions);
    }
    return parts;
  }

  // ── Sending ───────────────────────────────────────────────────────────────────

  private async send(feedback: TestFeedback, ui: { send: HTMLButtonElement; download: HTMLButtonElement; status: HTMLElement }) {
    const { mulai, selesai } = this.state;
    if (mulai === null || selesai === null) return;
    ui.send.disabled = true;
    ui.status.textContent = "Menyiapkan hasil…";
    const records = await this.deps.records();
    if (!records) {
      ui.status.textContent = "Riwayat uji tidak bisa dibaca di browser ini, jadi tidak ada yang bisa dikirim.";
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
        "Pengiriman otomatis belum disiapkan. Unduh file hasil, lalu kirim ke orang yang memberimu link.";
      ui.download.hidden = false;
      ui.send.disabled = false;
      return;
    }
    const result = await sendWithRetry(UJI_URL, sub, {
      onAttempt: (n) => {
        ui.status.textContent = n === 1 ? "Mengirim…" : `Belum ada konfirmasi, mencoba lagi (${n} dari ${SEND_ATTEMPTS})…`;
      },
    });
    if (result.ok) {
      this.setState(markSent(this.state, result.id, Date.now(), result.duplikat));
      this.render();
      return;
    }
    ui.status.textContent = `Gagal mengirim: ${result.error} Coba lagi, atau unduh file hasil lalu kirim ke orang yang memberimu link.`;
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
