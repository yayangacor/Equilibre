import { describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS, DEMO_DAYS_BACK, demoHistory, parseDemo, seedStamp } from "./demoAccount.ts";
import { dayKey } from "./history.ts";
import { LABELS, RULES, TANDA } from "./rules.ts";

const WEDNESDAY_2PM = new Date(2026, 9, 28, 14, 0).getTime();
const SUNDAY_2PM = new Date(2026, 10, 1, 14, 0).getTime();
const FATIGUE = ["lelah ringan", "lelah", "tertidur"];
const KNOWLEDGE = [
  "aao-20-20-20.md",
  "albulescu-2022-micro-break.md",
  "niosh-kewaspadaan-kerja.md",
  "permenkes-48-2016-k3-perkantoran.md",
];

describe("demo account", () => {
  it("only knows rina", () => {
    expect(parseDemo("rina")).toBe("rina");
    expect(parseDemo("budi")).toBeNull();
    expect(parseDemo(null)).toBeNull();
    expect(DEMO_ACCOUNTS.rina.name.split(" ")[0]).toBe("Rina");
  });

  it("gives the same days for the same moment and reseeds on a new day", () => {
    const a = demoHistory("rina", WEDNESDAY_2PM);
    const b = demoHistory("rina", WEDNESDAY_2PM);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(seedStamp(WEDNESDAY_2PM)).not.toBe(seedStamp(WEDNESDAY_2PM + 24 * 3_600_000));
  });

  it("files every record under its own day and nothing after now", () => {
    const h = demoHistory("rina", SUNDAY_2PM);
    for (const store of [h.evaluasi, h.jeda, h.rekomendasi, h.kss, h.koreksi_label]) {
      for (const r of store as { t?: number; mulai?: number; hari: string }[]) {
        const t = r.t ?? r.mulai!;
        expect(dayKey(t)).toBe(r.hari);
        expect(t).toBeLessThanOrEqual(SUNDAY_2PM);
      }
    }
  });

  it("has working days only, plus today even on a Sunday", () => {
    const h = demoHistory("rina", SUNDAY_2PM);
    const days = [...new Set(h.evaluasi.map((r) => r.hari))];
    const weekend = days.filter((d) => {
      const [y, m, day] = d.split("-").map(Number);
      return [0, 6].includes(new Date(y, m - 1, day).getDay());
    });
    expect(weekend).toEqual([dayKey(SUNDAY_2PM)]);
    expect(days.length).toBeGreaterThanOrEqual(10);
    expect(days.length).toBeLessThanOrEqual(DEMO_DAYS_BACK);
    expect(h.evaluasi.length).toBeLessThan(40_000);
  });

  it("writes windows the rules would label the same way", () => {
    const h = demoHistory("rina", WEDNESDAY_2PM);
    for (const r of h.evaluasi) {
      expect(LABELS).toContain(r.label);
      for (const t of r.tanda ?? []) expect(TANDA).toContain(t);
      if (r.label === "normal") {
        expect(r.tanda).toEqual([]);
        expect(r.perclos!).toBeLessThan(RULES.perclosMild);
        expect(r.durasi_kedip_ms!).toBeLessThan(470);
      }
      if (r.label === "lelah ringan") expect(r.tanda).toHaveLength(1);
      if (r.label === "lelah") expect(r.poin).toBeGreaterThanOrEqual(RULES.tiredPoints);
      if (r.tanda?.includes("kedipan_lambat")) expect(r.durasi_kedip_ms!).toBeGreaterThanOrEqual(470);
      if (r.tanda?.includes("mata_sering_tertutup")) expect(r.perclos!).toBeGreaterThanOrEqual(RULES.perclosMild);
      expect(r.menit_lelah_60).toBeGreaterThanOrEqual(0);
      expect(r.menit_lelah_60).toBeLessThanOrEqual(60);
      if (!r.dinilai) expect(r.sebab_ditahan).toBe("fps");
    }
  });

  it("tells Rina's story: afternoons heavier than mornings, office days heavier than home days", () => {
    const h = demoHistory("rina", WEDNESDAY_2PM);
    const past = h.evaluasi.filter((r) => r.hari !== dayKey(WEDNESDAY_2PM) && r.dinilai && r.label !== "tidak di depan layar");
    const share = (rs: typeof past) => rs.filter((r) => FATIGUE.includes(r.label)).length / rs.length;
    const hour = (r: (typeof past)[number]) => new Date(r.t).getHours();
    expect(share(past.filter((r) => hour(r) >= 13))).toBeGreaterThan(3 * share(past.filter((r) => hour(r) < 12)));
    const weekday = (r: (typeof past)[number]) => new Date(r.t).getDay();
    const office = past.filter((r) => [2, 3, 4].includes(weekday(r)));
    const home = past.filter((r) => [1, 5].includes(weekday(r)));
    expect(share(office)).toBeGreaterThan(share(home));
    // Insights names the worst part of the day; it must be the afternoon, not a thin evening slice.
    expect(past.filter((r) => hour(r) >= 17)).toEqual([]);
  });

  it("records the lunch break and other breaks of 2 minutes or more", () => {
    const h = demoHistory("rina", WEDNESDAY_2PM);
    for (const b of h.jeda) expect(b.menit).toBeGreaterThanOrEqual(2);
    const lunchDays = new Set(h.jeda.filter((b) => new Date(b.mulai).getHours() === 12 && b.menit >= 55).map((b) => b.hari));
    expect(lunchDays.size).toBe(new Set(h.evaluasi.map((r) => r.hari)).size);
  });

  it("keeps advice in the shape the server sends, with sources from the knowledge base", () => {
    const h = demoHistory("rina", WEDNESDAY_2PM);
    expect(h.rekomendasi.length).toBeGreaterThan(5);
    for (const r of h.rekomendasi) {
      expect(["perlu jeda singkat", "perlu jeda"]).toContain(r.status);
      expect(JSON.parse(r.teks)).toEqual(r.hasil);
      for (const s of r.hasil!.sumber as string[]) expect(KNOWLEDGE).toContain(s);
      expect([null, "sudah dilakukan", "tidak relevan"]).toContain(r.feedback);
    }
    expect(h.kss.every((k) => k.kss >= 1 && k.kss <= 9)).toBe(true);
    expect(h.koreksi_label).toHaveLength(1);
  });
});
