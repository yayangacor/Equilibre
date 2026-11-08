import { describe, expect, it } from "vitest";
import { FALLBACK_MAX_TOKENS, FALLBACK_MODEL, LLM_NODE_ID, type Tweaks } from "../../server/src/analyze.ts";
import { LangflowError } from "../../server/src/reply.ts";
import {
  JAWABAN_LIMITS,
  parseRencana,
  parseRencanaReply,
  rencana,
  RENCANA_LIMITS,
  type RencanaInput,
} from "../../server/src/rencana.ts";
import fixturesRaw from "./taskMatcher.fixtures.json?raw";

// /api/rencana on the server (plan P20 W2.4): the request whitelist (NOTES D-90), the flow run with the fallback
// model, and the check of the LLM's JSON. No Langflow and no LLM: the flow runner is a fake.

const FIXTURES = (JSON.parse(fixturesRaw) as { kasus: { nama: string; masukan: RencanaInput }[] }).kasus;
// Rendah ringan at 14:10 with five tasks; the Task Matcher picks t2 (taskMatcher.fixtures.json).
const LOW = FIXTURES.find((f) => f.masukan.fase === "rendah ringan" && f.masukan.tugas.length === 5)!.masukan;

const answer = {
  langkah: [
    { jenis: "jalan", menit: 5, tugas_id: null, teks: "Jalan kaki 5 menit dulu." },
    { jenis: "tugas", menit: 25, tugas_id: "t2", teks: "Kerjakan t2 selama 25 menit." },
  ],
  tugas_id: "t2",
  alasan: "Energi sedang turun: t2 adalah tugas aktif, lebih cocok daripada t3 yang monoton.",
  sumber: ["niosh-kewaspadaan-kerja.md"],
  model: "written by the model",
};
const reply = (patch: Record<string, unknown> = {}) => JSON.stringify({ ...answer, ...patch });

// A fake flow runner: answers from the list in order and records each call.
function runner(...answers: (string | Error)[]) {
  const calls: { input: string; tweaks: Tweaks }[] = [];
  const run = async (input: string, tweaks: Tweaks) => {
    calls.push({ input, tweaks });
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected extra call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { run, calls };
}

const errorOf = (body: unknown) => {
  const out = parseRencana(body);
  return out.ok ? null : out.error;
};

describe("parseRencana: what the app may send", () => {
  it("accepts every Task Matcher fixture input unchanged", () => {
    for (const f of FIXTURES) expect(parseRencana(f.masukan)).toEqual({ ok: true, value: f.masukan });
  });

  it("refuses an extra key at the top and inside a task", () => {
    expect(errorOf({ ...LOW, judul: "Q3 report" })).toContain("Unknown fields: judul");
    expect(errorOf({ ...LOW, label: "lelah ringan" })).toContain("Unknown fields: label");
    const titled = { ...LOW, tugas: LOW.tugas.map((t, i) => (i === 1 ? { ...t, title: "Write the Q3 report" } : t)) };
    expect(errorOf(titled)).toContain("Unknown fields in tugas[1]: title");
  });

  it("refuses any string that could carry a title, and a missing key", () => {
    const withTask = (patch: Record<string, unknown>) => ({ ...LOW, tugas: [{ ...LOW.tugas[0], ...patch }, ...LOW.tugas.slice(1)] });
    expect(errorOf(withTask({ id: "Write the Q3 report" }))).toContain('tugas[0].id must be "t1"');
    expect(errorOf(withTask({ id: "MTIzNDU2Nzg5" }))).toContain('tugas[0].id must be "t1"'); // a Google task id
    expect(errorOf(withTask({ id: "t2" }))).toContain('tugas[0].id must be "t1"');
    expect(errorOf(withTask({ sifat: "Write the Q3 report" }))).toContain("tugas[0].sifat");
    expect(errorOf(withTask({ beban: "berat, for Dina" }))).toContain("tugas[0].beban");
    expect(errorOf(withTask({ hari_ke_tenggat: "2026-11-09" }))).toContain("hari_ke_tenggat");
    expect(errorOf({ ...LOW, fase: "Write the Q3 report" })).toContain("fase must be one of");
    expect(errorOf({ ...LOW, jam_rawan: "ya" })).toContain("jam_rawan");
    expect(errorOf({ ...LOW, menit_sejak_jeda: "30" })).toContain("menit_sejak_jeda");
    const { posisi: _posisi, ...noPosition } = LOW.tugas[0];
    expect(errorOf({ ...LOW, tugas: [noPosition] })).toContain("Missing fields in tugas[0]: posisi");
    const { jam_rawan: _jam, ...noFlag } = LOW;
    expect(errorOf(noFlag)).toContain("Missing fields: jam_rawan");
  });

  it("refuses oversized lists, tasks out of order and numbers out of range", () => {
    const many = Array.from({ length: RENCANA_LIMITS.tugasMax + 1 }, (_, i) => ({
      id: `t${i + 1}`,
      sifat: "aktif",
      beban: "ringan",
      hari_ke_tenggat: null,
      posisi: i,
    }));
    expect(errorOf({ ...LOW, tugas: many })).toContain(`at most ${RENCANA_LIMITS.tugasMax}`);
    // Positive control: one fewer is accepted.
    expect(errorOf({ ...LOW, tugas: many.slice(0, RENCANA_LIMITS.tugasMax) })).toBeNull();
    expect(errorOf({ ...LOW, tugas: [...LOW.tugas].reverse() })).toContain("tugas[0].posisi must be 0");
    const withDays = (hari: unknown) => ({ ...LOW, tugas: [{ ...LOW.tugas[0], hari_ke_tenggat: hari }] });
    expect(errorOf(withDays(RENCANA_LIMITS.hariMax + 1))).toContain("hari_ke_tenggat");
    expect(errorOf(withDays(1.5))).toContain("hari_ke_tenggat");
    expect(errorOf(withDays(-RENCANA_LIMITS.hariMax))).toBeNull();
    expect(errorOf({ ...LOW, menit_sejak_jeda: -1 })).toContain("menit_sejak_jeda");
    expect(errorOf({ ...LOW, menit_sejak_jeda: RENCANA_LIMITS.menitSejakJedaMax + 1 })).toContain("menit_sejak_jeda");
    expect(errorOf([LOW])).toContain("JSON object");
    expect(errorOf({ ...LOW, tugas: { t1: LOW.tugas[0] } })).toContain("tugas must be a list");
  });
});

describe("parseRencanaReply: what the LLM must answer", () => {
  const check = (patch: Record<string, unknown>, input: RencanaInput = LOW) => parseRencanaReply(reply(patch), input);
  const errorFor = (patch: Record<string, unknown>, input?: RencanaInput) => {
    const out = check(patch, input);
    return out.ok ? null : out.error;
  };

  it("keeps the steps, the chosen task, the reason and the sources, and drops the model the LLM wrote", () => {
    const out = check({});
    expect(out).toEqual({
      ok: true,
      value: { langkah: answer.langkah, tugas_id: "t2", alasan: answer.alasan, sumber: answer.sumber },
    });
    // In ```json fences, as LLMs sometimes write it.
    expect(parseRencanaReply("```json\n" + reply() + "\n```", LOW).ok).toBe(true);
    expect(errorFor({ sumber: undefined })).toBeNull();
  });

  it("refuses a reply that is not JSON", () => {
    expect(parseRencanaReply("Sure! Here is your plan: walk, then t2.", LOW)).toEqual({ ok: false, error: "the reply is not a JSON object" });
  });

  it("refuses a task that was not sent, in tugas_id, in a step or as a marker in a sentence", () => {
    expect(errorFor({ tugas_id: "t9" })).toContain("tugas_id must be null or one of the tasks sent");
    const steps = (id: unknown) => [answer.langkah[0], { ...answer.langkah[1], tugas_id: id }];
    expect(errorFor({ langkah: steps("t9") })).toContain("langkah[1].tugas_id");
    expect(errorFor({ langkah: steps("t4") })).toContain('only a "tugas" step names a task');
    expect(errorFor({ alasan: "Kerjakan t9 lebih dulu." })).toContain("names t9");
    expect(errorFor({ alasan: "Mulai dari T7." })).toContain("names T7");
    // Positive control: markers of tasks that were sent pass, also glued to a suffix.
    expect(errorFor({ alasan: "t2nya aktif, (t3) monoton, t5 belum dinilai." })).toBeNull();
  });

  it("refuses a step that names another task than the chosen one (the card would show two titles)", () => {
    const withTexts = (walk: string, work: string) => [
      { ...answer.langkah[0], teks: walk },
      { ...answer.langkah[1], teks: work },
    ];
    expect(errorFor({ langkah: withTexts("Jalan kaki 5 menit dulu.", "Kerjakan t3 sekarang.") })).toContain(
      "langkah[1].teks names t3; a step may name only the chosen task",
    );
    expect(errorFor({ langkah: withTexts("Jalan dulu, lalu T4.", "Kerjakan t2.") })).toContain("langkah[0].teks names T4");
    // Positive control: the chosen task in any step, in either case, and no marker at all.
    expect(errorFor({ langkah: withTexts("Jalan 5 menit, lalu T2.", "Kerjakan t2 selama 25 menit.") })).toBeNull();
    expect(errorFor({ langkah: withTexts("Jalan kaki 5 menit.", "Mulai tugasnya sekarang.") })).toBeNull();
  });

  it("names a task exactly when the rules give one (NOTES D-84)", () => {
    const veryLow: RencanaInput = { ...LOW, fase: "rendah berat" };
    const pause = { langkah: [{ jenis: "jeda", menit: 10, tugas_id: null, teks: "Jeda aktif 10 menit." }], alasan: "Energi sangat rendah." };
    expect(errorFor({ ...pause, tugas_id: null }, veryLow)).toBeNull();
    expect(errorFor({ ...pause, tugas_id: "t2" }, veryLow)).toContain("names a task where it must not");
    expect(errorFor({ tugas_id: null })).toContain("names no task");
    expect(errorFor({ ...pause, tugas_id: null }, { ...LOW, tugas: [] })).toBeNull();
    const walkWithTask = [{ ...answer.langkah[0], tugas_id: "t2" }, answer.langkah[1]];
    expect(errorFor({ langkah: walkWithTask })).toContain('only a "tugas" step names a task');
  });

  it("caps lengths and refuses control characters", () => {
    expect(errorFor({ alasan: "x".repeat(JAWABAN_LIMITS.alasanMax + 1) })).toContain("alasan must be text");
    expect(errorFor({ alasan: "x".repeat(JAWABAN_LIMITS.alasanMax) })).toBeNull();
    expect(errorFor({ alasan: "" })).toContain("alasan must be text");
    expect(errorFor({ alasan: "Jalan dulu\u0007." })).toContain("unsupported characters");
    const longStep = [{ ...answer.langkah[0], teks: "x".repeat(JAWABAN_LIMITS.teksMax + 1) }, answer.langkah[1]];
    expect(errorFor({ langkah: longStep })).toContain("langkah[0].teks");
    const tooMany = Array.from({ length: JAWABAN_LIMITS.langkahMax + 1 }, () => answer.langkah[0]);
    expect(errorFor({ langkah: tooMany })).toContain("at most");
    expect(errorFor({ langkah: [{ ...answer.langkah[0], menit: 90 }, answer.langkah[1]] })).toContain("menit");
    expect(errorFor({ sumber: "niosh.md" })).toContain("sumber must be a list");
    expect(errorFor({ sumber: Array(JAWABAN_LIMITS.sumberMax + 1).fill("niosh.md") })).toContain("sumber must be a list");
  });
});

describe("rencana: one flow run, the fallback model after a failure", () => {
  it("uses only the primary model when its reply passes (one LLM call), and sends the checked input only", async () => {
    const { run, calls } = runner(reply());
    const out = await rencana(LOW, run);
    expect(out.cadangan).toBe(false);
    expect(out.jawaban.tugas_id).toBe("t2");
    expect(calls).toHaveLength(1);
    expect(calls[0].tweaks).toEqual({});
    expect(JSON.parse(calls[0].input)).toEqual(LOW);
  });

  it("switches the LLM node to the fallback model after a reply that is not JSON", async () => {
    const { run, calls } = runner("Here is your plan.", reply());
    const out = await rencana(LOW, run);
    expect(out.cadangan).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].tweaks).toEqual({ [LLM_NODE_ID]: { model: [FALLBACK_MODEL], max_tokens: FALLBACK_MAX_TOKENS } });
    expect(calls[1].input).toBe(calls[0].input);
  });

  it("switches after a reply that names an unknown task, and gives up with 502 when the fallback does too", async () => {
    const fixed = runner(reply({ tugas_id: "t9" }), reply());
    expect((await rencana(LOW, fixed.run)).cadangan).toBe(true);
    const bad = runner(reply({ tugas_id: "t9" }), reply({ tugas_id: "t9" }));
    const err = await rencana(LOW, bad.run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LangflowError);
    expect((err as LangflowError).status).toBe(502);
    expect((err as LangflowError).message).toContain("could not be used");
    expect(bad.calls).toHaveLength(2);
  });

  it("switches after a retryable Langflow error, and not after a wrong key or a missing flow (negative control)", async () => {
    const retry = runner(new LangflowError("Langflow returned an error (HTTP 500).", 502, true), reply());
    expect((await rencana(LOW, retry.run)).cadangan).toBe(true);
    for (const err of [
      new LangflowError("Langflow rejected the API key. Check LANGFLOW_API_KEY in .env.", 502),
      new LangflowError("Langflow has no flow with this ID. Check LANGFLOW_FLOW_ID in .env.", 502),
    ]) {
      const { run, calls } = runner(err, reply());
      await expect(rencana(LOW, run)).rejects.toBe(err);
      expect(calls).toHaveLength(1);
    }
  });
});
