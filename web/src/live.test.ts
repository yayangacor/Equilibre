import { describe, expect, it } from "vitest";
import type { WindowFeatures } from "./features.ts";
import { eyeState, liveTiles, yawning } from "./live.ts";
import { BASELINE, frame, noFace } from "./test-helpers.ts";

const FEATURES: WindowFeatures = {
  perclos: 0.124,
  kedip_per_menit: 17.5,
  durasi_kedip_ms: 210,
  mata_tertutup_lama: 0,
  menguap: 1,
  pct_kepala_menunduk: 0.3,
  pct_wajah_hilang: 0,
  pct_mata_terbuka: 0.9,
  pct_mata_tertutup: 0.05,
  pct_tubuh_ada: 1,
  pct_tubuh_utuh: 1,
  pct_tubuh_diam: 0.5,
  gerak_tubuh: 0.01,
  n_frame: 600,
  durasi_jendela_detik: 60,
};

describe("eyeState", () => {
  it("uses the personal blink midpoint once calibrated (0.20 for BASELINE)", () => {
    expect(eyeState(frame(0, { ear: 0.21 }), BASELINE)).toBe("terbuka");
    expect(eyeState(frame(0, { ear: 0.19 }), BASELINE)).toBe("tertutup");
  });

  it("falls back to the eyeBlink blendshapes before calibration, not to EAR", () => {
    expect(eyeState(frame(0, { ear: 0.05, blinkLeft: 0.2, blinkRight: 0.2 }), null)).toBe("terbuka");
    expect(eyeState(frame(0, { ear: 0.3, blinkLeft: 0.6, blinkRight: 0.5 }), null)).toBe("tertutup");
  });

  it("says the eye is not seen without a face", () => {
    expect(eyeState(noFace(0), BASELINE)).toBe("tidak terlihat");
  });
});

describe("yawning", () => {
  it("is a wide-open mouth on this frame, never without a face", () => {
    expect(yawning(frame(0, { jawOpen: 0.5 }))).toBe(true);
    expect(yawning(frame(0, { jawOpen: 0.49 }))).toBe(false);
    expect(yawning(noFace(0))).toBe(false);
  });
});

describe("liveTiles", () => {
  it("shows the window numbers, each with an icon and a short line", () => {
    const tiles = liveTiles(frame(0, { ear: 0.281 }), FEATURES, BASELINE, "normal", 60);
    const byKey = Object.fromEntries(tiles.map((t) => [t.key, t]));
    expect(tiles.map((t) => t.key)).toEqual(["mata", "kedip", "perclos", "menguap", "menunduk", "label"]);
    expect(byKey.mata.value).toBe("Open");
    expect(byKey.mata.eye).toBe("terbuka");
    expect(byKey.mata.sub).toBe("EAR 0.281");
    expect(byKey.mata.hint).toContain("Closed below 0.200");
    expect(byKey.kedip.value).toBe("17.5");
    expect(byKey.kedip.sub).toBe("Normal 15");
    expect(byKey.perclos.value).toBe("12%");
    expect(byKey.perclos.sub).toBe("Last 60 s");
    expect(byKey.menguap.value).toBe("1");
    expect(byKey.menunduk.value).toBe("30%");
    expect(byKey.menunduk.hint).toContain("15°");
    expect(new Set(tiles.map((t) => t.icon)).size).toBe(tiles.length);
    expect(byKey.label.value).toBe("Normal");
  });

  it("waits for a calibration instead of showing zeros", () => {
    const tiles = liveTiles(frame(0), null, null, null, 60);
    for (const t of tiles.filter((x) => x.key !== "mata")) expect(t.value).toBe("–");
    expect(tiles.find((t) => t.key === "perclos")!.sub).toBe("After calibration");
    expect(tiles.find((t) => t.key === "mata")!.sub).toBe("EAR 0.300");
  });

  it("keeps a null blink rate as a dash, not 0", () => {
    const tiles = liveTiles(noFace(0), { ...FEATURES, kedip_per_menit: null, perclos: null }, BASELINE, null, 60);
    expect(tiles.find((t) => t.key === "kedip")!.value).toBe("–");
    expect(tiles.find((t) => t.key === "perclos")!.value).toBe("–");
    expect(tiles.find((t) => t.key === "mata")!.value).toBe("Not seen");
  });
});
