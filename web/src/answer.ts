// What the answer panel shows for a /api/analyze reply. Status and break length come from the
// server (NOTES D-28); the LLM only writes rekomendasi, alasan and sumber. No DOM: main.ts renders.

// Knowledge base notes (equilibre/knowledge/, plan P05 step 1) by the file name the flow cites
// (prompt rule 5). answer.test.ts checks that every note has an entry and every entry a note.
export const SOURCES: Readonly<Record<string, string>> = {
  "aao-20-20-20.md": "American Academy of Ophthalmology: the 20-20-20 rule",
  "abe-2023-perclos.md": "Abe (2023), SLEEP Advances: PERCLOS and sleepiness",
  "albulescu-2022-micro-break.md": "Albulescu et al. (2022), PLOS ONE: micro-breaks",
  "allen-2016-ventilasi.md": "Allen et al. (2016), Environmental Health Perspectives: office ventilation",
  "eu-432-2012-air-minum.md": "Regulation (EU) No 432/2012: drinking water",
  "kemenkes-healing119.md": "Indonesian Ministry of Health: the Healing119.id service",
  "niosh-kewaspadaan-kerja.md": "NIOSH (2015): staying alert during long work hours",
  "permenkes-48-2016-k3-perkantoran.md": "Health Ministry Regulation No. 48/2016: office health and safety",
  "who-2022-mental-health-at-work.md": "WHO (2022): mental health at work",
};

export type AnalyzeResponse = { text: string; result: unknown; cadangan?: boolean };

export type Source = { text: string; known: boolean };
export type AnswerView =
  | { kind: "text"; text: string; cadangan: boolean } // the reply was not JSON
  | { kind: "fields"; rows: [string, string][]; sumber: Source[] | null; cadangan: boolean };

const SHOWN = ["status", "rekomendasi", "alasan", "durasi_jeda_menit", "sumber"];

// A cited name is matched without case and with or without ".md". Anything else is shown as
// written and marked, so a source the LLM made up is visible as such.
export function toSource(cited: unknown): Source {
  const raw = String(cited).trim();
  const key = raw.toLowerCase().endsWith(".md") ? raw.toLowerCase() : `${raw.toLowerCase()}.md`;
  const title = SOURCES[key];
  return title ? { text: title, known: true } : { text: `${raw} (not in the knowledge base)`, known: false };
}

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

export function toAnswerView(reply: AnalyzeResponse): AnswerView {
  const cadangan = reply.cadangan === true;
  const r = reply.result;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return { kind: "text", text: reply.text, cadangan };
  const result = r as Record<string, unknown>;

  const rows: [string, string][] = [];
  if (result.status !== undefined) rows.push(["Status", asText(result.status)]);
  if (result.rekomendasi !== undefined) rows.push(["Recommendation", asText(result.rekomendasi)]);
  if (result.alasan !== undefined) rows.push(["Why", asText(result.alasan)]);
  // 0 ("baik") and null (long rest: stop, no fixed length) have no break length to show.
  if (typeof result.durasi_jeda_menit === "number" && result.durasi_jeda_menit > 0) {
    rows.push(["Break length", `${result.durasi_jeda_menit} min`]);
  }
  // Fields the prompt did not ask for are still shown rather than hidden.
  for (const [key, value] of Object.entries(result)) if (!SHOWN.includes(key)) rows.push([key, asText(value)]);

  const sumber = Array.isArray(result.sumber) ? result.sumber.map(toSource) : result.sumber === undefined ? null : [toSource(result.sumber)];
  return { kind: "fields", rows, sumber, cadangan };
}
