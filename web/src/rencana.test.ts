import { describe, expect, it } from "vitest";
import * as server from "../../server/src/rencana.ts";
import type { ImportedTask } from "./googleTasks.ts";
import { PHASES } from "./phase.ts";
import {
  MARKER,
  NOT_FOLLOWED,
  offlinePlan,
  REASON_TEXT,
  RENCANA_FIELDS,
  RENCANA_LIMITS,
  requestPlan,
  toRencanaRequest,
  TUGAS_FIELDS,
  withTitles,
} from "./rencana.ts";
import fixturesRaw from "./taskMatcher.fixtures.json?raw";
import { REASON_CODES, STEP_KINDS, type MatchInput } from "./taskMatcher.ts";
import { BEBAN, emptyTagMemory, NOT_ASSESSED, SIFAT } from "./taskTagger.ts";

// The browser side of "Plan my next hour" (plan P20 W2.4): what leaves the laptop (NOTES D-90), the titles put back
// in on the laptop, and the offline plan from the local Task Matcher. The server is a fake fetcher.

const TODAY = "2026-11-10";
const task = (id: string, title: string, listTitle: string, due: string | null, order: number): ImportedTask => ({
  id,
  listId: `list-${listTitle}`,
  listTitle,
  title,
  due,
  parent: null,
  order,
});
// Tagged as taskMatcher.fixtures.json's first five-task set: monotone-light, active-heavy in 2 days, monotone-heavy
// today, active-light tomorrow, not assessed.
const TASKS: ImportedTask[] = [
  task("MTA0ODU3NjU2Nzg5", "Reply to Dina's email", "Client Falcon", null, 0),
  task("MTA0ODU3NjU2Nzkw", "Write Q3 budget report", "Client Falcon", "2026-11-12", 1),
  task("MTA0ODU3NjU2Nzkx", "Reconcile October invoices", "Admin", "2026-11-10", 2),
  task("MTA0ODU3NjU2Nzky", "Call the vendor", "Admin", "2026-11-11", 3),
  task("MTA0ODU3NjU2Nzkz", "Lunch with Bima", "Admin", null, 4),
];
const LOW_1410 = { fase: "rendah ringan", jam_rawan: true, reason: "mildly-tired" } as const;

const FIXTURES = (JSON.parse(fixturesRaw) as { kasus: { nama: string; masukan: MatchInput }[] }).kasus;
const FIXTURE_LOW = FIXTURES.find((f) => f.nama.startsWith("rendah ringan 14.10"))!.masukan;

const request = (phase: { fase: (typeof PHASES)[number]; jam_rawan: boolean } = LOW_1410, menit: number | null = 45) =>
  toRencanaRequest(phase, menit, TASKS, TODAY, emptyTagMemory());

type Call = { url: string; init: RequestInit };
function backend(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const jsonReply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// What the server sends back for the 14:10 request (server/src/rencana.ts checked it).
const serverPlan = {
  langkah: [
    { jenis: "jalan", menit: 5, tugas_id: null, teks: "Jalan kaki 5 menit dulu." },
    { jenis: "tugas", menit: 25, tugas_id: "t2", teks: "Kerjakan t2 selama 25 menit." },
  ],
  tugas_id: "t2",
  alasan: "Energi sedang turun: t2 adalah tugas aktif, lebih cocok daripada t3 yang monoton.",
  sumber: ["niosh-kewaspadaan-kerja.md"],
  model: "IBM watsonx · Mistral Small 3.1 (Tokyo)",
  cadangan: false,
};

describe("the request body: identical to the server's whitelist", () => {
  it("uses the server's field names, limits, enums and marker pattern", () => {
    expect(RENCANA_FIELDS).toEqual(server.RENCANA_FIELDS);
    expect(TUGAS_FIELDS).toEqual(server.TUGAS_FIELDS);
    expect(RENCANA_LIMITS).toEqual(server.RENCANA_LIMITS);
    expect([MARKER.source, MARKER.flags]).toEqual([server.MARKER.source, server.MARKER.flags]);
    expect(server.FASE).toEqual(PHASES);
    expect(server.SIFAT).toEqual([...SIFAT, NOT_ASSESSED]);
    expect(server.BEBAN).toEqual([...BEBAN, NOT_ASSESSED]);
    expect(server.LANGKAH_JENIS).toEqual(STEP_KINDS);
  });

  it("is built from the phase and the tagged tasks, passes the server's check unchanged, and is the Task Matcher's input", () => {
    const { body } = request();
    expect(server.parseRencana(body)).toEqual({ ok: true, value: body });
    expect(Object.keys(body)).toEqual([...RENCANA_FIELDS]);
    for (const t of body.tugas) expect(Object.keys(t)).toEqual([...TUGAS_FIELDS]);
    // These five tasks are tagged as the fixture's set, so the body is that fixture's input.
    expect(body).toEqual(FIXTURE_LOW);
  });

  it("never carries a task title, a list name or a Google task id (negative control)", () => {
    const req = request();
    const sent = JSON.stringify(req.body);
    const secrets = [...TASKS.flatMap((t) => [t.title, t.listTitle, t.id, t.listId]), "Dina", "Falcon", "Bima", "Q3"];
    for (const s of secrets) expect(sent).not.toContain(s);
    // Positive control: the same search finds them where they are, in the tasks and in the laptop's own title map.
    const local = JSON.stringify(TASKS);
    for (const s of secrets) expect(local).toContain(s);
    expect([...req.judul.values()]).toEqual(TASKS.map((t) => t.title));
  });

  it("sends the first tasks of the user's order only, and clamps far due dates and long stretches", () => {
    const many = Array.from({ length: RENCANA_LIMITS.tugasMax + 10 }, (_, i) =>
      task(`id${i}`, `Write part ${i}`, "Book", i === 0 ? "2029-01-01" : i === 1 ? "2023-01-01" : null, RENCANA_LIMITS.tugasMax + 9 - i),
    );
    const { body, judul } = toRencanaRequest({ fase: "biasa", jam_rawan: false }, 5000.4, many, TODAY, emptyTagMemory());
    expect(body.tugas).toHaveLength(RENCANA_LIMITS.tugasMax);
    expect(judul.get("t1")).toBe(`Write part ${RENCANA_LIMITS.tugasMax + 9}`); // order 0
    expect(judul.has(`t${RENCANA_LIMITS.tugasMax + 1}`)).toBe(false);
    const sentDays = body.tugas.map((t) => t.hari_ke_tenggat).filter((d) => d !== null);
    expect(server.parseRencana(body).ok).toBe(true);
    expect(body.menit_sejak_jeda).toBe(RENCANA_LIMITS.menitSejakJedaMax);
    // Tasks 0 and 1 (due far ahead / far back) are the last two by order, so they fell outside the first 50.
    expect(sentDays).toEqual([]);
    const two = toRencanaRequest({ fase: "biasa", jam_rawan: false }, 12.6, many.slice(0, 2), TODAY, emptyTagMemory());
    expect(two.body.tugas.map((t) => t.hari_ke_tenggat)).toEqual([-RENCANA_LIMITS.hariMax, RENCANA_LIMITS.hariMax]);
    expect(two.body.menit_sejak_jeda).toBe(13);
  });
});

describe("titles go back in on the laptop", () => {
  const judul = new Map([
    ["t2", "Write Q3 budget report"],
    ["t3", "Reconcile October invoices"],
  ]);

  it("swaps each marker of a task sent for its title, and leaves anything else", () => {
    expect(withTitles("Kerjakan t2 dulu, t3 nanti.", judul)).toBe("Kerjakan “Write Q3 budget report” dulu, “Reconcile October invoices” nanti.");
    expect(withTitles("T2nya aktif.", judul)).toBe("“Write Q3 budget report”nya aktif.");
    expect(withTitles("t9, at2 and t2000 stay.", judul)).toBe("t9, at2 and t2000 stay.");
  });
});

describe("requestPlan", () => {
  it("asks the server once and shows its sentences with the titles put in", async () => {
    const req = request();
    const { fetcher, calls } = backend(() => jsonReply(serverPlan));
    const plan = await requestPlan(req, fetcher);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/rencana");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual(req.body);
    expect(plan).toMatchObject({
      asal: "server",
      sebab: null,
      tugas_id: "t2",
      judul: "Write Q3 budget report",
      alasan: "Energi sedang turun: “Write Q3 budget report” adalah tugas aktif, lebih cocok daripada “Reconcile October invoices” yang monoton.",
      sumber: ["niosh-kewaspadaan-kerja.md"],
      model: "IBM watsonx · Mistral Small 3.1 (Tokyo)",
      cadangan: false,
      kode: ["JALAN_DULU", "AKTIF_SAAT_RAWAN", "HINDARI_MONOTON", "TENGGAT_DEKAT"],
    });
    expect(plan.langkah).toEqual([
      { jenis: "jalan", menit: 5, tugas_id: null, judul: null, teks: "Jalan kaki 5 menit dulu." },
      { jenis: "tugas", menit: 25, tugas_id: "t2", judul: "Write Q3 budget report", teks: "Kerjakan “Write Q3 budget report” selama 25 menit." },
    ]);
  });

  it("gives the offline plan of the local Task Matcher when the backend cannot be reached", async () => {
    const { fetcher } = backend(() => Promise.reject(new TypeError("fetch failed")));
    const plan = await requestPlan(request(), fetcher);
    expect(plan).toMatchObject({ asal: "offline", sebab: "Can't reach the backend.", tugas_id: "t2", judul: "Write Q3 budget report" });
    expect(plan.langkah.map((s) => s.teks)).toEqual(["Walk for 5 minutes.", "Work on “Write Q3 budget report” for 25 minutes."]);
    expect(plan.alasan).toBe(
      [REASON_TEXT.JALAN_DULU, REASON_TEXT.AKTIF_SAAT_RAWAN, REASON_TEXT.HINDARI_MONOTON, REASON_TEXT.TENGGAT_DEKAT].join(" "),
    );
    expect(plan).toMatchObject({ sumber: [], model: null, cadangan: false });
  });

  it("passes the server's own error on as the reason (not configured, offline demo, daily limit)", async () => {
    for (const [status, error] of [
      [503, "The server is not configured: set LANGFLOW_API_KEY and LANGFLOW_RENCANA_FLOW_ID in .env."],
      [503, "The developer's laptop, which runs Langflow and IBM Bob for this demo, is offline right now. Try again later."],
      [429, "The online demo allows one request a minute per visitor. Try again in 40 s."],
    ] as const) {
      const plan = await requestPlan(request(), backend(() => jsonReply({ error, offline: true }, status)).fetcher);
      expect(plan).toMatchObject({ asal: "offline", sebab: error, tugas_id: "t2" });
    }
    const html = await requestPlan(request(), backend(() => new Response("<html>502</html>", { status: 502 })).fetcher);
    expect(html).toMatchObject({ asal: "offline", sebab: "The backend answered HTTP 502." });
  });

  it("does not show a server plan that chose another task or other steps than the rules (the LLM never chooses)", async () => {
    const otherTask = {
      ...serverPlan,
      tugas_id: "t4",
      langkah: [serverPlan.langkah[0], { ...serverPlan.langkah[1], tugas_id: "t4", teks: "Kerjakan t4." }],
    };
    const noWalk = { ...serverPlan, langkah: [serverPlan.langkah[1]] };
    for (const body of [otherTask, noWalk]) {
      const plan = await requestPlan(request(), backend(() => jsonReply(body)).fetcher);
      expect(plan).toMatchObject({ asal: "offline", sebab: NOT_FOLLOWED, tugas_id: "t2" });
    }
    const unreadable = await requestPlan(request(), backend(() => jsonReply({ text: "Walk, then work." })).fetcher);
    expect(unreadable.asal).toBe("offline");
    // Positive control: the unchanged answer is shown as the server's.
    expect((await requestPlan(request(), backend(() => jsonReply(serverPlan)).fetcher)).asal).toBe("server");
  });
});

describe("offlinePlan", () => {
  it("very low energy: a break, no task and no title anywhere", () => {
    const plan = offlinePlan(request({ fase: "rendah berat", jam_rawan: true }), "Can't reach the backend.");
    expect(plan.tugas_id).toBeNull();
    expect(plan.judul).toBeNull();
    expect(plan.langkah).toEqual([
      {
        jenis: "jeda",
        menit: 10,
        tugas_id: null,
        judul: null,
        teks: "Take an active break: walk for 10 minutes, or nap for 10–20 minutes if you can.",
      },
    ]);
    for (const t of TASKS) expect(JSON.stringify(plan)).not.toContain(t.title);
  });

  it("has a sentence for every reason code", () => {
    expect(Object.keys(REASON_TEXT).sort()).toEqual([...REASON_CODES].sort());
  });
});
