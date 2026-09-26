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
    expect(toSource("mayo-clinic-2024.md")).toEqual({ text: "mayo-clinic-2024.md (tidak ada di knowledge base)", known: false });
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
        ["Rekomendasi", "Bangun dan bergerak sebentar."],
        ["Alasan", "Mata sering tertutup."],
        ["Lama jeda", "10 menit"],
      ],
      sumber: [
        { text: SOURCES["niosh-kewaspadaan-kerja.md"], known: true },
        { text: "rekaan.md (tidak ada di knowledge base)", known: false },
      ],
      cadangan: false,
    });
  });

  it("has no break length for baik (0) and long rest (null)", () => {
    for (const durasi_jeda_menit of [0, null]) {
      const view = toAnswerView(reply({ rekomendasi: "x", status: "baik", durasi_jeda_menit }));
      expect(view.kind === "fields" && view.rows.map(([name]) => name)).toEqual(["Status", "Rekomendasi"]);
    }
  });

  it("still shows fields the prompt did not ask for, and an empty source list", () => {
    const view = toAnswerView(reply({ rekomendasi: "x", catatan: "tambahan", sumber: [] }));
    expect(view).toMatchObject({ kind: "fields", rows: [["Rekomendasi", "x"], ["catatan", "tambahan"]], sumber: [] });
  });

  it("falls back to the raw text when the reply is not JSON, and passes cadangan on", () => {
    expect(toAnswerView({ text: "bukan json", result: null, cadangan: true })).toEqual({ kind: "text", text: "bukan json", cadangan: true });
    expect(toAnswerView(reply({ rekomendasi: "x" }, true)).cadangan).toBe(true);
    // Older servers do not send cadangan.
    expect(toAnswerView({ text: "{}", result: {} }).cadangan).toBe(false);
  });
});
