export const LABELS = ["normal", "lelah ringan", "lelah", "tidak di depan layar"] as const;

export type Label = (typeof LABELS)[number];

export type FatigueFeatures = {
  label: Label;
  skor?: number;
  perclos?: number;
  kedip_per_menit?: number;
  menguap?: number;
  menit_sejak_jeda?: number;
};

// Allowed aggregate numbers and their valid ranges. Anything outside this list
// (landmarks, images, free text) is rejected, so raw face data can never be
// forwarded to Langflow.
const NUMERIC_FIELDS = {
  skor: [0, 1],
  perclos: [0, 1],
  kedip_per_menit: [0, 200],
  menguap: [0, 1000],
  menit_sejak_jeda: [0, 24 * 60],
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
