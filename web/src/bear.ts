import type { Mood } from "./companion.ts";

// The companion bear (plan P13, NOTES D-24), shared by the Picture-in-Picture window and the
// "Sekarang" page (plan P14): one picture, with upper lids drawn over its eyes so it can look
// open, drowsy or asleep, and "Z" letters that float up while asleep. Each document styles the
// .bear class itself (style.css, pipCompanion.ts STYLE); this module only builds the parts.

// Eye centres and radius (inside the outline) in the original 1082×1454 picture, measured from its
// pixels (27 Sep): outlines x 363–512 / 538–687, y 284–446.
export const ART = { width: 1082, height: 1454, eyes: [437, 612], eyeY: 365, eyeR: 66 } as const;
// How far down the upper lid comes, as a share of the eye height (0 = open, 1 = closed).
const LID: Record<Mood, number> = { normal: 0, menunggu: 0, pergi: 0, "lelah-ringan": 0.38, lelah: 0.62, tertidur: 1 };
const SVG_NS = "http://www.w3.org/2000/svg";

export type Bear = { root: HTMLElement; setMood: (mood: Mood) => void };

// idPrefix keeps the clip-path ids unique when two bears share a document.
export function createBear(doc: Document, alt: string, idPrefix = "eye"): Bear {
  const root = doc.createElement("div");
  root.className = "bear";
  const img = doc.createElement("img");
  img.src = new URL("/karakter/beruang.png", location.href).href;
  img.alt = alt;
  img.draggable = false;

  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${ART.width} ${ART.height}`);
  svg.setAttribute("aria-hidden", "true");
  const defs = doc.createElementNS(SVG_NS, "defs");
  svg.append(defs);
  const lids: SVGRectElement[] = [];
  const lidLines: SVGLineElement[] = [];
  const closedLines: SVGPathElement[] = [];
  ART.eyes.forEach((cx, i) => {
    const clip = doc.createElementNS(SVG_NS, "clipPath");
    clip.id = `${idPrefix}-${i}`;
    const circle = doc.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(ART.eyeY));
    circle.setAttribute("r", String(ART.eyeR));
    clip.append(circle);
    defs.append(clip);

    const lid = doc.createElementNS(SVG_NS, "rect");
    lid.setAttribute("x", String(cx - ART.eyeR));
    lid.setAttribute("y", String(ART.eyeY - ART.eyeR));
    lid.setAttribute("width", String(ART.eyeR * 2));
    lid.setAttribute("fill", "#fefefe");
    lid.setAttribute("clip-path", `url(#${idPrefix}-${i})`);
    const line = doc.createElementNS(SVG_NS, "line");
    line.setAttribute("stroke", "#1a1a1a");
    line.setAttribute("stroke-width", "9");
    line.setAttribute("stroke-linecap", "round");
    const closed = doc.createElementNS(SVG_NS, "path");
    closed.setAttribute("d", `M ${cx - 42} ${ART.eyeY + 4} Q ${cx} ${ART.eyeY + 34} ${cx + 42} ${ART.eyeY + 4}`);
    closed.setAttribute("fill", "none");
    closed.setAttribute("stroke", "#1a1a1a");
    closed.setAttribute("stroke-width", "9");
    closed.setAttribute("stroke-linecap", "round");
    svg.append(lid, line, closed);
    lids.push(lid);
    lidLines.push(line);
    closedLines.push(closed);
  });
  // To the right of the head (ears end near x 950, y 110); the svg may draw past its box.
  [
    [900, 360, 200],
    [990, 240, 160],
    [1060, 140, 120],
  ].forEach(([x, y, size]) => {
    const z = doc.createElementNS(SVG_NS, "text");
    z.setAttribute("class", "zzz");
    z.setAttribute("x", String(x));
    z.setAttribute("y", String(y));
    z.setAttribute("font-size", String(size));
    z.textContent = "Z";
    svg.append(z);
  });
  root.append(img, svg);

  const setMood = (mood: Mood) => {
    const share = LID[mood];
    const top = ART.eyeY - ART.eyeR;
    const edge = top + share * ART.eyeR * 2; // where the lid ends
    const half = Math.sqrt(Math.max(0, ART.eyeR ** 2 - (edge - ART.eyeY) ** 2)); // half chord at that height
    ART.eyes.forEach((cx, i) => {
      lids[i].setAttribute("height", String(share * ART.eyeR * 2));
      lids[i].style.display = share > 0 ? "" : "none";
      const line = lidLines[i];
      line.style.display = share > 0 && share < 1 ? "" : "none";
      line.setAttribute("x1", String(cx - half));
      line.setAttribute("x2", String(cx + half));
      line.setAttribute("y1", String(edge));
      line.setAttribute("y2", String(edge));
      closedLines[i].style.display = share >= 1 ? "" : "none";
    });
  };
  setMood("menunggu");
  return { root, setMood };
}
