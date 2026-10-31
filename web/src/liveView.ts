import { FaceLandmarker, type NormalizedLandmark } from "@mediapipe/tasks-vision";
import { EarChart } from "./earChart.ts";
import { icon } from "./icons.ts";
import type { EyeState, LiveTile } from "./live.ts";

// Live view on the Insight page (NOTES D-63): the plain camera beside the camera with the face mesh
// drawn over it, the tiles from live.ts, and the live EAR chart.

type Connection = (typeof FaceLandmarker.FACE_LANDMARKS_TESSELATION)[number];

// Fixed colors: they sit on the camera picture, not on a themed surface.
const MESH = "rgb(255 255 255 / 0.28)";
const OUTLINE = "rgb(255 255 255 / 0.75)";
const EYE: Record<EyeState, string> = { terbuka: "#3ddc97", tertutup: "#ff5a5f", "tidak terlihat": "#ffffff" };
const IRIS = "#4dd2ff";
const MOUTH_YAWN = "#ffc233";

// The face mesh in video pixels; the context maps them onto the canvas (overlayFit.ts), which has the video's CSS
// box and mirroring.
export function drawFaceMesh(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  width: number,
  height: number,
  eye: EyeState,
  mouthOpen: boolean,
) {
  const stroke = (connections: readonly Connection[], color: string, lineWidth: number) => {
    ctx.beginPath();
    for (const { start, end } of connections) {
      const a = landmarks[start];
      const b = landmarks[end];
      if (!a || !b) continue;
      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b.x * width, b.y * height);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  };
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  stroke(FaceLandmarker.FACE_LANDMARKS_TESSELATION, MESH, 0.7);
  stroke(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, OUTLINE, 1.6);
  stroke([...FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW], OUTLINE, 1.6);
  stroke(FaceLandmarker.FACE_LANDMARKS_LIPS, mouthOpen ? MOUTH_YAWN : OUTLINE, mouthOpen ? 2.6 : 1.6);
  stroke([...FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, ...FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS], IRIS, 1.4);
  stroke([...FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE], EYE[eye], 2.6);
}

export class LiveView {
  readonly chart: EarChart;
  private readonly tiles = new Map<string, { box: HTMLElement; value: HTMLElement; sub: HTMLElement }>();
  private readonly tileBox: HTMLElement;
  private readonly raw: HTMLVideoElement;

  constructor(ui: { tiles: HTMLElement; chart: HTMLCanvasElement; legend: HTMLElement; raw: HTMLVideoElement }) {
    this.chart = new EarChart(ui.chart, ui.legend);
    this.tileBox = ui.tiles;
    this.raw = ui.raw;
  }

  // The plain view plays the same camera stream; detached when the page is left, so it does not decode for nothing.
  attach(stream: MediaProvider | null) {
    if (this.raw.srcObject === stream) return;
    this.raw.srcObject = stream;
    if (stream) void this.raw.play().catch(() => {});
  }

  render(tiles: LiveTile[]) {
    for (const t of tiles) {
      let tile = this.tiles.get(t.key);
      if (!tile) {
        const box = document.createElement("div");
        box.className = "tile";
        box.dataset.tile = t.key;
        const label = document.createElement("p");
        label.className = "tile-label";
        label.append(icon(t.icon), t.label);
        const value = document.createElement("p");
        value.className = "tile-value";
        const sub = document.createElement("p");
        sub.className = "tile-sub";
        box.append(label, value, sub);
        this.tileBox.append(box);
        tile = { box, value, sub };
        this.tiles.set(t.key, tile);
      }
      tile.box.title = t.hint; // the baseline's numbers arrive after calibration
      tile.value.textContent = t.value;
      tile.sub.textContent = t.sub;
      if (t.eye) tile.value.dataset.eye = t.eye; // the eye state key the CSS matches, not the shown text
    }
  }
}
