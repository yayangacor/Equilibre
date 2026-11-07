import type { FaceLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";

// One detection frame reduced to the handful of numbers the fatigue pipeline uses.
// Pure (no DOM) so the same code can extract features from UTA-RLDD videos on 24 Sep.
export type FrameSignal = {
  t: number; // ms, same clock as detectForVideo (performance.now())
  face: boolean;
  // Every number below is NaN when face is false.
  earLeft: number; // subject's left eye
  earRight: number; // subject's right eye
  ear: number; // mean of both eyes
  jawOpen: number; // blendshape 0–1
  pitchDeg: number; // head elevation: negative = looking down (absolute, compare against the baseline)
  blinkLeft: number; // blendshape eyeBlinkLeft, backup signal
  blinkRight: number; // blendshape eyeBlinkRight, backup signal
  lookDown: number; // mean of eyeLookDownLeft/Right: gaze down (logged for tuning, not used by the rules yet)
  // Signal quality (quality.ts). NaN when no face, and in session CSVs from before 7 Nov (unknown, not bad).
  yawDeg: number; // head turned left or right of the camera axis
  rollDeg: number; // head tilted sideways
  eyeDistPx: number; // distance between the two eye centres in video pixels: how large the face is in the picture
};

// Landmark indices in EAR order p1..p6 (Soukupová & Čech, 2016):
// p1/p4 = eye corners, p2/p3 = upper lid, p6/p5 = lower lid (p2↔p6 and p3↔p5 face each other).
export const RIGHT_EYE = [33, 160, 158, 133, 153, 144] as const;
export const LEFT_EYE = [362, 385, 387, 263, 373, 380] as const;

type Point = { x: number; y: number };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// Landmarks are normalized 0–1 per axis, so they are scaled to pixels first;
// otherwise a 4:3 frame would squash the vertical distances.
export function eyeAspectRatio(
  landmarks: readonly NormalizedLandmark[],
  indices: readonly number[],
  width: number,
  height: number,
): number {
  const [p1, p2, p3, p4, p5, p6] = indices.map((i) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height }));
  const horizontal = dist(p1, p4);
  return horizontal === 0 ? NaN : (dist(p2, p6) + dist(p3, p5)) / (2 * horizontal);
}

export type MatrixLayout = "column-major" | "row-major";

// MediaPipe does not document the order of Matrix.data. A pose matrix always has
// the bottom row [0 0 0 1] and a large translation (the face sits tens of cm in
// front of the camera), so the translation's position gives the layout away.
export function matrixLayout(data: readonly number[]): MatrixLayout {
  const bottomRowIfColumnMajor = Math.abs(data[3]) + Math.abs(data[7]) + Math.abs(data[11]);
  const bottomRowIfRowMajor = Math.abs(data[12]) + Math.abs(data[13]) + Math.abs(data[14]);
  return bottomRowIfColumnMajor <= bottomRowIfRowMajor ? "column-major" : "row-major";
}

// Elevation of the face's forward axis (canonical +Z) in camera space, in degrees.
// Unlike an Euler decomposition this barely moves when the head turns or tilts
// sideways, which is what "head drooping" needs. Camera space is right-handed with
// Y up (MediaPipe face geometry), so looking down gives a negative angle.
// ⚠️ Sign verified empirically by nodding (see PLAN-2026-09-22 Langkah 1).
export function pitchFromMatrix(data: readonly number[]): number {
  const at = (row: number, col: number) =>
    matrixLayout(data) === "column-major" ? data[col * 4 + row] : data[row * 4 + col];
  const fx = at(0, 2);
  const fy = at(1, 2);
  const fz = at(2, 2);
  const norm = Math.hypot(fx, fy, fz);
  if (norm === 0) return NaN;
  return (Math.asin(Math.max(-1, Math.min(1, fy / norm))) * 180) / Math.PI;
}

// Turn of the forward axis (canonical +Z) about the camera's vertical axis, and tilt of the face's
// sideways axis (canonical +X) in the image plane, in degrees. Both 0 when facing the camera upright;
// only their size is used (quality.ts), so the sign convention does not matter.
export function yawRollFromMatrix(data: readonly number[]): { yawDeg: number; rollDeg: number } {
  const at = (row: number, col: number) =>
    matrixLayout(data) === "column-major" ? data[col * 4 + row] : data[row * 4 + col];
  const deg = (rad: number) => (rad * 180) / Math.PI;
  const forward = Math.hypot(at(0, 2), at(2, 2));
  const side = Math.hypot(at(0, 0), at(1, 0));
  return {
    yawDeg: forward === 0 ? NaN : deg(Math.atan2(at(0, 2), at(2, 2))),
    rollDeg: side === 0 ? NaN : deg(Math.atan2(at(1, 0), at(0, 0))),
  };
}

// Distance between the eye centres (midpoints of each eye's corners), in pixels of the video frame.
export function eyeDistance(landmarks: readonly NormalizedLandmark[], width: number, height: number): number {
  const centre = (indices: readonly number[]) => ({
    x: ((landmarks[indices[0]].x + landmarks[indices[3]].x) / 2) * width,
    y: ((landmarks[indices[0]].y + landmarks[indices[3]].y) / 2) * height,
  });
  return dist(centre(LEFT_EYE), centre(RIGHT_EYE));
}

export function toFrameSignal(result: FaceLandmarkerResult, videoWidth: number, videoHeight: number, t: number): FrameSignal {
  const landmarks = result.faceLandmarks[0];
  if (!landmarks) {
    return {
      t,
      face: false,
      earLeft: NaN,
      earRight: NaN,
      ear: NaN,
      jawOpen: NaN,
      pitchDeg: NaN,
      blinkLeft: NaN,
      blinkRight: NaN,
      lookDown: NaN,
      yawDeg: NaN,
      rollDeg: NaN,
      eyeDistPx: NaN,
    };
  }

  const categories = result.faceBlendshapes[0]?.categories ?? [];
  const blendshape = (name: string) => categories.find((c) => c.categoryName === name)?.score ?? NaN;
  const earLeft = eyeAspectRatio(landmarks, LEFT_EYE, videoWidth, videoHeight);
  const earRight = eyeAspectRatio(landmarks, RIGHT_EYE, videoWidth, videoHeight);
  const matrix = result.facialTransformationMatrixes[0];
  const pose = matrix ? yawRollFromMatrix(matrix.data) : { yawDeg: NaN, rollDeg: NaN };

  return {
    t,
    face: true,
    earLeft,
    earRight,
    ear: (earLeft + earRight) / 2,
    jawOpen: blendshape("jawOpen"),
    pitchDeg: matrix ? pitchFromMatrix(matrix.data) : NaN,
    blinkLeft: blendshape("eyeBlinkLeft"),
    blinkRight: blendshape("eyeBlinkRight"),
    lookDown: (blendshape("eyeLookDownLeft") + blendshape("eyeLookDownRight")) / 2,
    ...pose,
    eyeDistPx: eyeDistance(landmarks, videoWidth, videoHeight),
  };
}
