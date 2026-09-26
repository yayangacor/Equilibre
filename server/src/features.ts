export const LABELS = ["normal", "lelah ringan", "lelah", "tertidur", "tidak di depan layar"] as const;

export type Label = (typeof LABELS)[number];

// Names of the app's rules that fired (NOTES D-41), same list as web/src/rules.ts. Only these
// names pass, so the field cannot carry free text off the device.
export const TANDA = [
  "mata_sering_tertutup",
  "kedipan_lambat",
  "menguap",
  "mata_terpejam_lama",
  "kedipan_sering",
  "tertidur_mata_terpejam",
  "tertidur_mata_tak_terlihat",
] as const;
export type Tanda = (typeof TANDA)[number];

export type FatigueFeatures = {
  label: Label;
  skor?: number;
  tanda?: Tanda[];
  perclos?: number;
  kedip_per_menit?: number;
  durasi_kedip_ms?: number;
  mata_tertutup_lama?: number;
  menguap?: number;
  pct_kepala_menunduk?: number;
  pct_wajah_hilang?: number;
  menit_sejak_jeda?: number;
  menit_lelah_60?: number; // minutes labelled "lelah" or "tertidur" in the last hour
};

// A long rest (stop working, maybe take leave) is advised from this many
// "lelah"/"tertidur" minutes in the last hour. Decided here, not by the LLM, so the
// advice is consistent. Same value as ADVICE.longRestMinutes in web/src/rules.ts
// (web/src/payload.test.ts checks).
export const LONG_REST_MINUTES = 15;

// Allowed aggregate numbers and their valid ranges. Anything outside this list
// (landmarks, images, free text) is rejected, so raw face data can never be
// forwarded to Langflow.
const NUMERIC_FIELDS = {
  skor: [0, 1],
  perclos: [0, 1],
  kedip_per_menit: [0, 200],
  durasi_kedip_ms: [0, 5000],
  mata_tertutup_lama: [0, 1000],
  menguap: [0, 1000],
  pct_kepala_menunduk: [0, 1],
  pct_wajah_hilang: [0, 1],
  menit_sejak_jeda: [0, 24 * 60],
  menit_lelah_60: [0, 60],
} as const satisfies Record<string, readonly [number, number]>;

type ParseResult = { ok: true; value: FatigueFeatures } | { ok: false; error: string };

export function parseFeatures(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Body harus berupa objek JSON." };
  }
  const input = body as Record<string, unknown>;

  const unknownKeys = Object.keys(input).filter((key) => key !== "label" && key !== "tanda" && !(key in NUMERIC_FIELDS));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Field tidak dikenal: ${unknownKeys.join(", ")}.` };
  }

  if (!LABELS.includes(input.label as Label)) {
    return { ok: false, error: `label harus salah satu dari: ${LABELS.join(", ")}.` };
  }
  const value: FatigueFeatures = { label: input.label as Label };

  if (input.tanda !== undefined) {
    const tanda = input.tanda;
    if (
      !Array.isArray(tanda) ||
      !tanda.every((t) => TANDA.includes(t as Tanda)) ||
      new Set(tanda).size !== tanda.length
    ) {
      return { ok: false, error: `tanda harus berupa daftar tanpa duplikat dari: ${TANDA.join(", ")}.` };
    }
    value.tanda = tanda as Tanda[];
  }

  for (const [key, [min, max]] of Object.entries(NUMERIC_FIELDS)) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      return { ok: false, error: `${key} harus berupa angka antara ${min} dan ${max}.` };
    }
    value[key as keyof typeof NUMERIC_FIELDS] = v;
  }

  return { ok: true, value };
}

// The status of the answer and the break length, decided here so the same input always
// gets the same words (the LLM wrote "Perlu jeda", "Lelah" and "perlu jeda" for similar
// input). The LLM only writes rekomendasi, alasan and sumber around them. The long rest
// advice wins over any label, as in the app. "tidak di depan layar" is not sent at all.
// ⚠️ Break lengths: initial values inside the ≤10-minute micro-break range of Albulescu
// et al. (2022); "tertidur" gets an active break (wake up, stand, drink), user decision 22 Sep.
export const INTERVENTIONS = {
  normal: { status: "baik", durasi_jeda_menit: 0 },
  "lelah ringan": { status: "perlu jeda singkat", durasi_jeda_menit: 5 },
  lelah: { status: "perlu jeda", durasi_jeda_menit: 10 },
  tertidur: { status: "perlu jeda aktif", durasi_jeda_menit: 10 },
} as const;
export const LONG_REST = { status: "perlu istirahat panjang", durasi_jeda_menit: null } as const;

type Intervention = (typeof INTERVENTIONS)[keyof typeof INTERVENTIONS] | typeof LONG_REST;
export type Status = Intervention["status"];

// RAG (NOTES D-39): the flow's Knowledge node searches the knowledge base with a fixed
// query per status instead of the JSON payload, so retrieval is predictable and nothing
// beyond the status leaves the server. Sent as a tweak to the node with this id.
export const KNOWLEDGE_NODE_ID = "Knowledge-panduan";
// One chunk per note (knowledge base equilibre_panduan_v2, chunk 2400): the top 3 notes hold
// what each status needs, e.g. NIOSH + drinking water for "perlu jeda aktif" (checked 26 Sep).
export const PANDUAN_TOP_K = 3;
export const PANDUAN_QUERIES: Record<Status, string> = {
  baik: "istirahat mata saat bekerja lama di depan layar komputer",
  "perlu jeda singkat": "jeda singkat untuk mengurangi lelah saat bekerja di depan komputer",
  "perlu jeda": "istirahat dan peregangan saat lelah bekerja di depan komputer",
  "perlu jeda aktif": "cara tetap waspada saat mengantuk: bergerak, cahaya terang, minum air, udara segar",
  "perlu istirahat panjang": "kelelahan berulang saat bekerja: berhenti, istirahat yang cukup, cuti, kesehatan pekerja",
};

export function panduanTweaks(status: Status) {
  return { [KNOWLEDGE_NODE_ID]: { search_query: PANDUAN_QUERIES[status], top_k: PANDUAN_TOP_K } };
}

// What the Langflow flow receives: the validated numbers plus what was derived from
// them. null: this label is not sent to Langflow.
export type FlowInput = FatigueFeatures & Intervention & { saran_istirahat_panjang?: boolean };

export function toFlowInput(f: FatigueFeatures): FlowInput | null {
  if (f.label === "tidak di depan layar") return null;
  if (f.menit_lelah_60 === undefined) return { ...f, ...INTERVENTIONS[f.label] };
  const longRest = f.menit_lelah_60 >= LONG_REST_MINUTES;
  return { ...f, saran_istirahat_panjang: longRest, ...(longRest ? LONG_REST : INTERVENTIONS[f.label]) };
}
