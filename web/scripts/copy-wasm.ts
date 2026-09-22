// Copies the MediaPipe WASM runtime from node_modules into public/ so the app runs
// offline, and so the WASM always matches the installed @mediapipe/tasks-vision
// version (NOTES G-01). Runs automatically before `dev` and `build`; the copy is
// gitignored (±35 MB of binaries that npm install already provides).
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../node_modules/@mediapipe/tasks-vision/wasm", import.meta.url));
const to = fileURLToPath(new URL("../public/mediapipe/wasm", import.meta.url));

rmSync(to, { recursive: true, force: true }); // no leftovers from an older version
cpSync(from, to, { recursive: true });
console.log("MediaPipe WASM disalin ke public/mediapipe/wasm");
