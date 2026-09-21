import { FaceLandmarker, FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";
import { maskToGrid, type BodyGrid } from "./body.ts";

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>; // not exported by the package

// Must match the exact @mediapipe/tasks-vision version pinned in package.json.
// TODO before demo: serve the WASM from public/ so the app works offline.
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const FACE_MODEL_URL = "/models/face_landmarker.task";
// Selfie segmenter (float16, ±250 KB): person vs background, for body presence.
const BODY_MODEL_URL = "/models/selfie_segmenter.tflite";

export type Delegate = "GPU" | "CPU";

export type Detectors = { landmarker: FaceLandmarker; delegate: Delegate; segmenter: ImageSegmenter | null };

export async function createDetectors(): Promise<Detectors> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const [face, segmenter] = await Promise.all([createFaceLandmarker(fileset), createBodySegmenter(fileset)]);
  return { ...face, segmenter };
}

async function createFaceLandmarker(fileset: WasmFileset): Promise<{ landmarker: FaceLandmarker; delegate: Delegate }> {
  const create = (delegate: Delegate) =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });

  try {
    return { landmarker: await create("GPU"), delegate: "GPU" };
  } catch (err) {
    console.warn("GPU delegate gagal, pindah ke CPU:", err);
    return { landmarker: await create("CPU"), delegate: "CPU" };
  }
}

// CPU on purpose: the model is tiny and runs only ±2×/second, and a CPU mask is a
// plain Float32Array (a GPU mask would need a texture readback every time).
// Optional: without it the app still works, it just cannot detect "tertidur".
async function createBodySegmenter(fileset: WasmFileset): Promise<ImageSegmenter | null> {
  try {
    return await ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: BODY_MODEL_URL, delegate: "CPU" },
      runningMode: "VIDEO",
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  } catch (err) {
    console.warn("Model segmentasi tubuh gagal dimuat, deteksi tertidur nonaktif:", err);
    return null;
  }
}

// The person mask reduced to a coarse grid; the full mask is released right away.
export function segmentBody(segmenter: ImageSegmenter, video: HTMLVideoElement, t: number): BodyGrid | null {
  const result = segmenter.segmentForVideo(video, t);
  try {
    // The selfie model has a single "person" mask; if a model also returns a
    // background mask first, the person is still the last one.
    const mask = result.confidenceMasks?.at(-1);
    return mask ? maskToGrid(mask.getAsFloat32Array(), mask.width, mask.height) : null;
  } finally {
    result.close();
  }
}
