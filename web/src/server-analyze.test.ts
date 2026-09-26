import { describe, expect, it } from "vitest";
import { analyze, FALLBACK_MODEL, LLM_NODE_ID, type Tweaks } from "../../server/src/analyze.ts";
import { KNOWLEDGE_NODE_ID, toFlowInput } from "../../server/src/features.ts";
import { LangflowError } from "../../server/src/reply.ts";

const input = toFlowInput({ label: "tertidur", perclos: 0.8 })!;
const reply = JSON.stringify({ rekomendasi: "Bangun dan bergerak.", alasan: "Mata sering tertutup.", sumber: ["niosh"] });

// A fake flow runner: answers from the list in order and records each call's tweaks.
function runner(...answers: (string | Error)[]) {
  const calls: Tweaks[] = [];
  const run = async (_input: string, tweaks: Tweaks) => {
    calls.push(tweaks);
    const next = answers.shift();
    if (next === undefined) throw new Error("unexpected extra call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { run, calls };
}

describe("analyze: primary model, fallback on failure (D-11, 26 Sep)", () => {
  it("uses only the primary model when it answers (one LLM call)", async () => {
    const { run, calls } = runner(reply);
    const out = await analyze(input, run);
    expect(out.cadangan).toBe(false);
    expect(out.result).toMatchObject({ rekomendasi: "Bangun dan bergerak.", status: "perlu jeda aktif", durasi_jeda_menit: 10 });
    // Negative control: no second call, and the LLM node is not tweaked.
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty(LLM_NODE_ID);
    expect(calls[0]).toHaveProperty(KNOWLEDGE_NODE_ID);
  });

  it("switches the LLM node to the fallback model after an LLM error", async () => {
    const { run, calls } = runner(new LangflowError("Langflow mengembalikan error (HTTP 500).", 502, true), reply);
    const out = await analyze(input, run);
    expect(out.cadangan).toBe(true);
    expect(out.result).toMatchObject({ status: "perlu jeda aktif" });
    expect(calls).toHaveLength(2);
    expect(calls[1][LLM_NODE_ID]).toEqual({ model: [FALLBACK_MODEL] });
    expect(calls[1][KNOWLEDGE_NODE_ID]).toEqual(calls[0][KNOWLEDGE_NODE_ID]); // same knowledge base query
  });

  it("falls back when the primary reply is empty or not JSON", async () => {
    const empty = runner(new LangflowError("Jawaban Langflow kosong atau formatnya tidak dikenali.", 502, true), reply);
    expect((await analyze(input, empty.run)).cadangan).toBe(true);
    const prose = runner("Maaf, saya tidak bisa.", reply);
    const out = await analyze(input, prose.run);
    expect(out.cadangan).toBe(true);
    expect(prose.calls).toHaveLength(2);
  });

  it("does not retry a wrong key, a missing flow or Langflow being down (negative control)", async () => {
    for (const err of [
      new LangflowError("Langflow menolak API key. Cek LANGFLOW_API_KEY di .env.", 502),
      new LangflowError("Flow tidak ditemukan di Langflow. Cek LANGFLOW_FLOW_ID di .env.", 502),
      new LangflowError("Tidak bisa menghubungi Langflow di http://127.0.0.1:7860. Pastikan Langflow sudah jalan.", 502),
    ]) {
      const { run, calls } = runner(err, reply);
      await expect(analyze(input, run)).rejects.toBe(err);
      expect(calls).toHaveLength(1);
    }
  });

  it("calls at most twice, and reports the fallback's own failure", async () => {
    const second = new LangflowError("Langflow mengembalikan error (HTTP 500).", 502, true);
    const { run, calls } = runner(new LangflowError("Langflow mengembalikan error (HTTP 500).", 502, true), second);
    await expect(analyze(input, run)).rejects.toBe(second);
    expect(calls).toHaveLength(2);
  });
});
