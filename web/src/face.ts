import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Must match the exact @mediapipe/tasks-vision version pinned in package.json.
// TODO before demo: serve the WASM from public/ so the app works offline.
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "/models/face_landmarker.task";

export type Delegate = "GPU" | "CPU";

export async function createFaceLandmarker(): Promise<{ landmarker: FaceLandmarker; delegate: Delegate }> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const create = (delegate: Delegate) =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
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
