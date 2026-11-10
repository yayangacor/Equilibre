import { describe, expect, it } from "vitest";
import { SOURCES, toAnswerView, toSource } from "./answer.ts";

// File names only; the notes themselves are not loaded.
const notes = Object.keys(import.meta.glob("../../knowledge/*.md"))
  .map((path) => path.split("/").pop()!)
  .filter((name) => name !== "README.md");

const reply = (result: unknown, cadangan = false) => ({ text: JSON.stringify(result), result, cadangan });

describe("SOURCES matches the knowledge base", () => {
  it("has a title for every note and a note for every title", () => {
    expect(notes.length).toBeGreaterThanOrEqual(9);
    expect(Object.keys(SOURCES).sort()).toEqual([...notes].sort());
  });
});

describe("toSource", () => {
  it("maps a cited file name to its title, with or without .md, in any case", () => {
    const title = SOURCES["niosh-kewaspadaan-kerja.md"];
    expect(toSource("niosh-kewaspadaan-kerja.md")).toEqual({ text: title, known: true });
    expect(toSource(" NIOSH-kewaspadaan-kerja ")).toEqual({ text: title, known: true });
  });

  it("marks a source outside the knowledge base (negative control)", () => {
    expect(toSource("mayo-clinic-2024.md")).toEqual({ text: "mayo-clinic-2024.md (not in the knowledge base)", known: false });
    expect(toSource("NIOSH").known).toBe(false);
  });
});

describe("toAnswerView", () => {
  it("shows status, recommendation, reason, break length and titled sources", () => {
    const view = toAnswerView(
      reply({
        rekomendasi: "Bangun dan bergerak sebentar.",
        alasan: "Mata sering tertutup.",
        sumber: ["niosh-kewaspadaan-kerja.md", "rekaan.md"],
        status: "perlu jeda aktif",
        durasi_jeda_menit: 10,
      }),
    );
    expect(view).toEqual({
      kind: "fields",
      rows: [
        ["Status", "perlu jeda aktif"],
        ["Recommendation", "Bangun dan bergerak sebentar."],
        ["Why", "Mata sering tertutup."],
        ["Break length", "10 min"],
      ],
      sumber: [
        { text: SOURCES["niosh-kewaspadaan-kerja.md"], known: true },
        { text: "rekaan.md (not in the knowledge base)", known: false },
      ],
      cadangan: false,
      model: null,
    });
  });

  it("has no break length for baik (0) and long rest (null)", () => {
    for (const durasi_jeda_menit of [0, null]) {
      const view = toAnswerView(reply({ rekomendasi: "x", status: "baik", durasi_jeda_menit }));
      expect(view.kind === "fields" && view.rows.map(([name]) => name)).toEqual(["Status", "Recommendation"]);
    }
  });

  // The prompt says not to make up signs when tanda is empty; the Gemini fallback then left alasan "" (session 20).
  it("leaves out an empty or blank reason, and keeps a written one (negative control)", () => {
    for (const alasan of ["", "  "]) {
      const view = toAnswerView(reply({ status: "perlu jeda aktif", rekomendasi: "x", alasan }));
      expect(view.kind === "fields" && view.rows.map(([name]) => name)).toEqual(["Status", "Recommendation"]);
    }
    const kept = toAnswerView(reply({ rekomendasi: "x", alasan: "Your eyes are closed more often." }));
    expect(kept.kind === "fields" && kept.rows).toEqual([["Recommendation", "x"], ["Why", "Your eyes are closed more often."]]);
  });

  it("still shows fields the prompt did not ask for, and an empty source list", () => {
    const view = toAnswerView(reply({ rekomendasi: "x", catatan: "tambahan", sumber: [] }));
    expect(view).toMatchObject({ kind: "fields", rows: [["Recommendation", "x"], ["catatan", "tambahan"]], sumber: [] });
  });

  it("falls back to the raw text when the reply is not JSON, and passes cadangan on", () => {
    expect(toAnswerView({ text: "bukan json", result: null, cadangan: true })).toEqual({
      kind: "text",
      text: "bukan json",
      cadangan: true,
      model: null,
    });
    expect(toAnswerView(reply({ rekomendasi: "x" }, true)).cadangan).toBe(true);
    // Older servers do not send cadangan.
    expect(toAnswerView({ text: "{}", result: {} }).cadangan).toBe(false);
  });

  it("passes the answering model on, trimmed, and ignores an empty or missing one (plan P20 W0.5)", () => {
    const withModel = { text: "{}", result: {}, model: " IBM watsonx · Mistral Small 3.1 (Tokyo) " };
    expect(toAnswerView(withModel).model).toBe("IBM watsonx · Mistral Small 3.1 (Tokyo)");
    expect(toAnswerView({ text: "x", result: null, model: "Gemini 2.5 Flash" }).model).toBe("Gemini 2.5 Flash");
    expect(toAnswerView({ text: "{}", result: {}, model: "  " }).model).toBeNull();
    expect(toAnswerView({ text: "{}", result: {}, model: null }).model).toBeNull();
    expect(toAnswerView({ text: "{}", result: {} }).model).toBeNull(); // older server
  });
});
