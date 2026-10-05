import { Dashboard } from "./dashboard.ts";
import { downloadFile, fileStamp } from "./download.ts";
import { dayKey, oldestKeptDay, summarizeDay, toExport, type DayData, type DaySummary, type Feedback } from "./history.ts";
import { openHistory, type HistoryDb, type StoreName, type Stores } from "./historyDb.ts";

// The local history as the page uses it: opening it (days past the retention go, NOTES
// D-38), writing records without ever blocking the monitoring, the "Insight" page (dashboard.ts),
// today's numbers for the "Sekarang" page (onToday), and the export and delete buttons.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const CLEAR_CONFIRM_MS = 5_000;

export class HistoryPanel {
  // Called after a feedback was stored, so other views of the same recommendation follow.
  onFeedback: (id: number, feedback: Feedback) => void = () => {};
  onCleared: () => void = () => {};
  // Today's summary after every refresh, whichever day the Insight page shows (null: no history).
  onToday: (summary: DaySummary | null) => void = () => {};

  private db: HistoryDb | null = null;
  private problem: string | null = null;
  private shownDay: string | null = null; // null: today, and it follows midnight
  private clearArmedUntil = 0;
  private readonly evalIntervalMs: number;
  private readonly dashboard: Dashboard;
  private readonly actionNote = byId("history-action-note");
  private readonly clearButton = byId<HTMLButtonElement>("clear-history");

  constructor(evalIntervalMs: number) {
    this.evalIntervalMs = evalIntervalMs;
    this.dashboard = new Dashboard(
      {
        select: byId<HTMLSelectElement>("day-select"),
        note: byId("history-note"),
        body: byId("insight-body"),
        lead: byId("insight-lead"),
        tiles: byId("insight-tiles"),
        labelBars: byId("label-bars"),
        labelBarsNote: byId("label-bars-note"),
        trendWrap: byId("trend-wrap"),
        trendTip: byId("trend-tip"),
        trendLegend: byId("trend-legend"),
        trendSub: byId("trend-sub"),
        stats: byId("day-stats"),
        legend: byId("chart-legend"),
        chart: byId("chart-wrap"),
        tip: byId("chart-tip"),
        table: byId<HTMLTableElement>("chart-table"),
        recsBlock: byId("day-recs-block"),
        recs: byId("day-recs"),
      },
      (day) => {
        this.shownDay = day === dayKey(Date.now()) ? null : day;
        void this.refresh();
      },
      (id, feedback) => void this.feedback(id, feedback),
    );
    byId("export-history").addEventListener("click", () => void this.exportFile());
    this.clearButton.addEventListener("click", () => void this.clear());
  }

  async open(name: string) {
    try {
      this.db = await openHistory(name);
      await this.db.deleteBefore(oldestKeptDay(Date.now()));
    } catch (err) {
      this.failed(err);
    }
    await this.refresh();
  }

  private failed(err: unknown) {
    if (this.problem === null) console.warn("Riwayat tidak bisa disimpan.", err);
    this.problem = `Riwayat tidak bisa disimpan di perangkat ini: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Fire and forget, for the monitoring loop.
  save<S extends StoreName>(store: S, record: Stores[S]) {
    this.db?.add(store, record).catch((err: unknown) => this.failed(err));
  }

  // For user actions: the new id, or null when it could not be stored.
  async add<S extends StoreName>(store: S, record: Stores[S]): Promise<number | null> {
    if (!this.db) return null;
    try {
      const id = await this.db.add(store, record);
      void this.refresh();
      return id;
    } catch (err) {
      this.failed(err);
      return null;
    }
  }

  async byDay<S extends StoreName>(store: S, day: string): Promise<Stores[S][]> {
    try {
      return this.db ? await this.db.byDay(store, day) : [];
    } catch (err) {
      this.failed(err);
      return [];
    }
  }

  async feedback(id: number, feedback: Feedback) {
    if (!this.db) return;
    try {
      const updated = await this.db.update("rekomendasi", id, { feedback, t_feedback: Date.now() });
      if (updated) this.onFeedback(id, feedback);
    } catch (err) {
      this.failed(err);
    }
    await this.refresh();
  }

  async refresh() {
    const today = dayKey(Date.now());
    const day = this.shownDay ?? today;
    const view = { days: [] as string[], day, today, summary: null, rekomendasi: [], evaluasi: [], jeda: [], problem: this.problem };
    if (!this.db) {
      this.dashboard.render({ ...view, problem: this.problem ?? "Riwayat belum siap." });
      this.onToday(null);
      return;
    }
    try {
      const db = this.db;
      const [days, data, todayData] = await Promise.all([
        db.days(),
        this.loadDay(db, day),
        day === today ? null : this.loadDay(db, today),
      ]);
      const summary = summarizeDay(data, this.evalIntervalMs);
      this.dashboard.render({ ...view, days, summary, rekomendasi: data.rekomendasi, evaluasi: data.evaluasi, jeda: data.jeda, problem: this.problem });
      this.onToday(todayData ? summarizeDay(todayData, this.evalIntervalMs) : summary);
    } catch (err) {
      this.failed(err);
      this.dashboard.render({ ...view, problem: this.problem });
      this.onToday(null);
    }
  }

  // Today's numbers for "Tanya Equilibre" (tanya.ts); null when the history is not available.
  async todaySummary(): Promise<DaySummary | null> {
    if (!this.db) return null;
    try {
      return summarizeDay(await this.loadDay(this.db, dayKey(Date.now())), this.evalIntervalMs);
    } catch (err) {
      this.failed(err);
      return null;
    }
  }

  private async loadDay(db: HistoryDb, day: string): Promise<DayData> {
    const [evaluasi, jeda, rekomendasi, koreksi_label, kss] = await Promise.all([
      db.byDay("evaluasi", day),
      db.byDay("jeda", day),
      db.byDay("rekomendasi", day),
      db.byDay("koreksi_label", day),
      db.byDay("kss", day),
    ]);
    return { evaluasi, jeda, rekomendasi, koreksi_label, kss };
  }

  // Every stored record, all days (export, user test submission). null: the history is not available.
  async allRecords(): Promise<DayData | null> {
    if (!this.db) return null;
    const db = this.db;
    const [evaluasi, jeda, rekomendasi, koreksi_label, kss] = await Promise.all([
      db.all("evaluasi"),
      db.all("jeda"),
      db.all("rekomendasi"),
      db.all("koreksi_label"),
      db.all("kss"),
    ]);
    return { evaluasi, jeda, rekomendasi, koreksi_label, kss };
  }

  private async exportFile() {
    const stores = await this.allRecords();
    if (!stores) {
      this.actionNote.textContent = this.problem ?? "Riwayat belum siap.";
      return;
    }
    const { evaluasi, jeda, rekomendasi, koreksi_label, kss } = stores;
    const file = toExport(stores, Date.now());
    downloadFile(JSON.stringify(file), `equilibre-riwayat-${fileStamp(new Date())}.json`, "application/json");
    this.actionNote.textContent =
      `Diunduh: ${evaluasi.length} evaluasi, ${jeda.length} jeda, ${rekomendasi.length} rekomendasi, ` +
      `${koreksi_label.length} koreksi, ${kss.length} KSS. File tetap di perangkat ini sampai kamu membagikannya.`;
  }

  // Two clicks within CLEAR_CONFIRM_MS, no browser dialog.
  private async clear() {
    const now = Date.now();
    if (now > this.clearArmedUntil) {
      this.clearArmedUntil = now + CLEAR_CONFIRM_MS;
      this.clearButton.textContent = "Klik lagi untuk menghapus";
      this.actionNote.textContent =
        "Semua riwayat di perangkat ini akan dihapus: evaluasi, jeda, rekomendasi, koreksi, dan KSS. Baseline kalibrasi tetap.";
      setTimeout(() => {
        if (Date.now() >= this.clearArmedUntil) this.disarm();
      }, CLEAR_CONFIRM_MS);
      return;
    }
    this.disarm();
    if (!this.db) return;
    try {
      await this.db.clear();
      this.actionNote.textContent = "Semua riwayat dihapus dari perangkat ini.";
      this.onCleared();
    } catch (err) {
      this.failed(err);
      this.actionNote.textContent = this.problem;
    }
    await this.refresh();
  }

  private disarm() {
    this.clearArmedUntil = 0;
    this.clearButton.textContent = "Hapus semua riwayat";
  }
}
