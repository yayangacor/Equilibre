import { describe, expect, it } from "vitest";
import {
  armsShown,
  blockCells,
  blockSize,
  bodyShape,
  boxOf,
  cubicBezier,
  faceBox,
  gridCentre,
  inBody,
  personBlocks,
  ringAt,
  ringLight,
  SCAN,
  SCAN_TOTAL_MS,
  scanProgress,
  seedOf,
  silhouetteBlocks,
} from "./scanEffect.ts";

describe("scanProgress", () => {
  it("shows the plain camera first, then sweeps in 1 s, then the boxes 0.5 s later", () => {
    expect(scanProgress(0)).toEqual({ sweep: 0, settle: 0, boxes: 0 });
    expect(scanProgress(SCAN.delayMs + SCAN.sweepMs / 2).sweep).toBeCloseTo(0.5);
    const swept = SCAN.delayMs + SCAN.sweepMs;
    expect(scanProgress(swept)).toEqual({ sweep: 1, settle: 0, boxes: 0 });
    expect(scanProgress(swept + SCAN.boxesAfterMs - 1).boxes).toBe(0); // negative control: not before 0.5 s
    expect(scanProgress(swept + SCAN.boxesAfterMs + SCAN.boxesInMs).boxes).toBe(1);
    expect(scanProgress(60_000)).toEqual({ sweep: 1, settle: 1, boxes: 1 });
  });

  it("ends the opening after every part has finished", () => {
    expect(scanProgress(SCAN_TOTAL_MS)).toEqual({ sweep: 1, settle: 1, boxes: 1 });
  });

  it("settles the blocks from coarse to fine", () => {
    expect(blockSize(0)).toBe(SCAN.coarsePixel);
    expect(blockSize(1)).toBe(SCAN.pixel);
    expect(blockSize(0.5)).toBeLessThan(SCAN.coarsePixel);
    expect(blockSize(0.5)).toBeGreaterThan(SCAN.pixel);
  });
});

describe("boxOf", () => {
  it("frames the chosen landmarks in canvas pixels with padding", () => {
    const points = [
      { x: 0.4, y: 0.5 },
      { x: 0.5, y: 0.45 },
      { x: 0.6, y: 0.5 },
    ];
    const box = boxOf(points, [0, 1, 2], 100, 100, 0)!;
    expect(box.x).toBeCloseTo(40);
    expect(box.y).toBeCloseTo(45);
    expect(box.w).toBeCloseTo(20);
    expect(box.h).toBeCloseTo(5);
    const padded = boxOf(points, [0, 1, 2], 100, 100, 0.5)!;
    expect(padded.x).toBeCloseTo(30);
    expect(padded.w).toBeCloseTo(40);
  });

  it("returns null without landmarks", () => {
    expect(boxOf([], [33, 133], 640, 480)).toBeNull();
  });
});

describe("bodyShape and inBody", () => {
  // A face in the middle of a 640×480 frame: x 0.42–0.58, y 0.2–0.5 (as the 30 Oct screenshot: seated, centred).
  const face = [
    { x: 0.42, y: 0.35 },
    { x: 0.58, y: 0.35 },
    { x: 0.5, y: 0.2 },
    { x: 0.5, y: 0.5 },
  ];
  const s = bodyShape(face, 640, 480)!;

  it("covers the head, the hair above the forehead, the neck and the torso down to the frame's bottom", () => {
    expect(inBody(s, 320, 168)).toBe(true); // face centre
    expect(inBody(s, 320, 80)).toBe(true); // hair above the forehead
    expect(inBody(s, 320, 250)).toBe(true); // neck
    expect(inBody(s, 320 + 1.2 * 102, 330)).toBe(true); // a shoulder
    expect(inBody(s, 320, 470)).toBe(true); // chest at the bottom edge
  });

  it("leaves the background beside the head and the frame's corners out (negative control)", () => {
    expect(inBody(s, 40, 470)).toBe(false); // bottom-left corner: the chairs in the screenshot
    expect(inBody(s, 600, 470)).toBe(false);
    expect(inBody(s, 150, 168)).toBe(false); // beside the head
    expect(inBody(s, 490, 168)).toBe(false);
    expect(inBody(s, 10, 10)).toBe(false);
  });

  it("needs a face", () => {
    expect(bodyShape([], 640, 480)).toBeNull();
    expect(bodyShape([{ x: 0.5, y: 0.5 }], 640, 480)).toBeNull(); // no size
  });
});

describe("personBlocks (the scan follows the body mask)", () => {
  // A 12×9 mask on a 120×90 canvas (10 px cells): a person in the middle (head rows 1–3, torso rows 4–8) and a
  // chair in the bottom-left corner that the model also marks, not touching the person.
  const rows = [
    "............",
    ".....##.....",
    "....####....",
    ".....##.....",
    "...######...",
    "..########..",
    "#.########..",
    "#.########..",
    "##########..",
  ];
  const view = {
    cols: 12,
    rows: 9,
    cells: Float32Array.from(rows.join("").split(""), (ch) => (ch === "#" ? 0.9 : 0.05)),
  };
  const face = { x: 45, y: 12, w: 30, h: 26 }; // over the head cells
  const on = (b: NonNullable<ReturnType<typeof personBlocks>>, c: number, r: number) => b.on[r * b.cols + c] === 1;

  it("keeps the person connected to the face, down to the torso", () => {
    const b = personBlocks(view, 1, face, 120, 90)!;
    expect(on(b, 5, 1)).toBe(true); // head
    expect(on(b, 5, 8)).toBe(true); // torso at the bottom
  });

  it("keeps a blob joined to the body and drops one apart from it", () => {
    const b = personBlocks(view, 1, face, 120, 90)!;
    expect(on(b, 0, 8)).toBe(true); // joined through row 8
    const apart = { ...view, cells: view.cells.slice() };
    apart.cells[8 * 12 + 1] = 0.05; // cut the join
    const c = personBlocks(apart, 1, face, 120, 90)!;
    expect(on(c, 0, 6)).toBe(false); // negative control: a separate chair is not pixelated
    expect(on(c, 5, 6)).toBe(true);
  });

  it("gives null when no person block overlaps the face (the mask beside the body, G-95)", () => {
    expect(personBlocks(view, 1, { x: 100, y: 5, w: 15, h: 10 }, 120, 90)).toBeNull();
  });

  it("merges cells into coarser blocks while the line passes", () => {
    const b = personBlocks(view, 3, face, 120, 90)!;
    expect([b.cols, b.rows, b.bw, b.bh]).toEqual([4, 3, 30, 30]);
    expect(blockCells(0)).toBe(3);
    expect(blockCells(0.5)).toBe(2);
    expect(blockCells(1)).toBe(1);
  });

  it("reports where the mask and the face are for Debug", () => {
    const centre = gridCentre(view)!;
    expect(centre.x).toBeGreaterThan(0.35);
    expect(centre.x).toBeLessThan(0.6);
    expect(centre.y).toBeGreaterThan(0.5);
    expect(gridCentre({ cols: 2, rows: 1, cells: new Float32Array(2) })).toBeNull();
    expect(faceBox([{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.6 }], 1, 1)).toEqual({ x: 0.2, y: 0.3, w: 0.2, h: 0.3 });
  });
});

describe("silhouetteBlocks (the fallback in the same blocks as the mask)", () => {
  const face = [
    { x: 0.42, y: 0.35 },
    { x: 0.58, y: 0.35 },
    { x: 0.5, y: 0.2 },
    { x: 0.5, y: 0.5 },
  ];
  const s = bodyShape(face, 640, 480)!;
  const b = silhouetteBlocks(s, 14, 640, 480);
  const at = (x: number, y: number) => b.on[Math.floor(y / b.bh) * b.cols + Math.floor(x / b.bw)] === 1;

  it("tiles the frame and marks the person", () => {
    expect(b.cols * b.bw).toBeCloseTo(640);
    expect(b.rows * b.bh).toBeCloseTo(480);
    expect(at(320, 168)).toBe(true); // face centre
    expect(at(320, 470)).toBe(true); // chest at the bottom edge
  });

  it("leaves the corners and beside the head out (negative control)", () => {
    expect(at(10, 10)).toBe(false);
    expect(at(40, 470)).toBe(false);
    expect(at(150, 168)).toBe(false);
  });
});

describe("cubicBezier", () => {
  it("is the identity for a straight curve and pins both ends", () => {
    const linear = cubicBezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    for (const t of [0.1, 0.37, 0.5, 0.82]) expect(linear(t)).toBeCloseTo(t, 5);
    const ease = cubicBezier(...SCAN.ringEase);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-0.5)).toBe(0);
    expect(ease(1.5)).toBe(1);
  });

  it("matches the CSS ease-out curve (0, 0, 0.58, 1)", () => {
    // From the Bernstein form: s = 0.5 gives x = 3·0.5·0.25·0.58 + 0.125 = 0.3425, y = 3·0.5·0.25 + 0.125 = 0.5.
    expect(cubicBezier(0, 0, 0.58, 1)(0.3425)).toBeCloseTo(0.5, 4);
  });
});

describe("the rings of crosses (stage B)", () => {
  const reach = 400;
  const at = (t: number) => ringAt(t * SCAN.pulseMs, reach)!;

  it("starts as a point at the top and spreads to the farthest block", () => {
    expect(at(0).radius).toBe(0);
    expect(at(0).half).toBeCloseTo(SCAN.ringStart * reach);
    expect(at(0.5).radius).toBeGreaterThan(0.5 * reach);
    expect(at(0.999).radius).toBeCloseTo(reach, 0);
    expect(at(0.999).half).toBeCloseTo(SCAN.ringEnd * reach, 0);
    let last = -1;
    for (let t = 0; t < 1; t += 0.01) {
      expect(at(t).radius).toBeGreaterThanOrEqual(last); // only ever outwards
      last = at(t).radius;
    }
  });

  it("slows towards the end (negative control: a straight curve would not)", () => {
    const early = at(0.4).radius - at(0.3).radius;
    const late = at(0.9).radius - at(0.8).radius;
    expect(late).toBeLessThan(early / 4);
  });

  it("fades in at once and out as it settles", () => {
    expect(at(0).alpha).toBe(0);
    expect(at(0.1).alpha).toBe(1);
    expect(at(0.5).alpha).toBe(1);
    expect(at(0.8).alpha).toBeGreaterThan(0);
    expect(at(0.8).alpha).toBeLessThan(1);
  });

  it("rests between rings, then starts again from the point", () => {
    expect(ringAt(SCAN.pulseMs + SCAN.pulseRestMs / 2, reach)).toBeNull();
    const next = ringAt(SCAN.pulseMs + SCAN.pulseRestMs, reach)!;
    expect(next.radius).toBe(0);
    expect(ringAt(3 * (SCAN.pulseMs + SCAN.pulseRestMs) + SCAN.pulseMs / 2, reach)!.radius).toBeCloseTo(at(0.5).radius);
  });

  it("lights crosses on its line and none half a ring away or further (negative control)", () => {
    expect(ringLight(0, 50)).toBe(1);
    expect(ringLight(25, 50)).toBeCloseTo(0.5);
    expect(ringLight(-25, 50)).toBeCloseTo(0.5);
    expect(ringLight(50, 50)).toBe(0);
    expect(ringLight(-80, 50)).toBe(0);
  });

  it("shows whole crosses in the lit middle and fragments towards the edges", () => {
    for (const seed of [0, 0.3, 0.99]) {
      expect(armsShown(1, seed)).toBe(4);
      expect(armsShown(0, seed)).toBe(0);
      expect(armsShown(0.5, seed)).toBeGreaterThanOrEqual(2);
      expect(armsShown(0.5, seed)).toBeLessThanOrEqual(3);
    }
    expect(armsShown(0.1, 0.2)).toBe(0);
    expect(armsShown(0.1, 0.9)).toBe(1);
  });

  it("gives each cross a fixed seed in 0–1, different between neighbours", () => {
    expect(seedOf(3, 7)).toBe(seedOf(3, 7));
    const seeds = [seedOf(0, 0), seedOf(1, 0), seedOf(0, 1), seedOf(5, 9), seedOf(47, 35)];
    for (const v of seeds) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(seeds.map((v) => v.toFixed(3))).size).toBe(seeds.length);
  });
});
