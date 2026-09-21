export const LABELS = ["normal", "lelah ringan", "lelah", "tertidur", "tidak di depan layar"] as const;

export type Label = (typeof LABELS)[number];

export type FatigueFeatures = {
  label: Label;
  skor?: number;
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

  const unknownKeys = Object.keys(input).filter((key) => key !== "label" && !(key in NUMERIC_FIELDS));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Field tidak dikenal: ${unknownKeys.join(", ")}.` };
  }

  if (!LABELS.includes(input.label as Label)) {
    return { ok: false, error: `label harus salah satu dari: ${LABELS.join(", ")}.` };
  }
  const value: FatigueFeatures = { label: input.label as Label };

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

// What the Langflow flow receives: the validated numbers plus the long-rest flag
// derived from them.
export function toFlowInput(f: FatigueFeatures): FatigueFeatures & { saran_istirahat_panjang?: boolean } {
  if (f.menit_lelah_60 === undefined) return f;
  return { ...f, saran_istirahat_panjang: f.menit_lelah_60 >= LONG_REST_MINUTES };
}
