import { parseCode } from "./userTest.ts";

// Hosted demo build (`npm run build:demo`): only the browser part is deployed and no backend sits behind it,
// so the two features that need the backend, Langflow and IBM Bob say so instead of failing. Detection,
// history, Insight and the companion run entirely in the browser and are the same as in a local run.
export const DEMO = import.meta.env.MODE === "demo";

// A tester's link (?kode=, plans/P08) leaves out the link to the repository.
const SHOW_REPO_LINK = parseCode(new URLSearchParams(location.search).get("kode")) === null;

export const REPO_URL = "https://github.com/yayangacor/Equilibre";

export const DEMO_NOTE = {
  saran:
    "Di demo online, saran tidak diminta: saran disusun flow Langflow dengan LLM watsonx lewat backend yang berjalan " +
    "di laptop pengembang.",
  autoSend: "Tidak tersedia di demo online: saran butuh backend dan Langflow yang berjalan lokal.",
  tanya: "Di demo online, Tanya Equilibre tidak aktif: IBM Bob dan flow Langflow berjalan di laptop pengembang.",
} as const;

// The note as a callout, with a link to the README that explains the feature and how to run it.
export function demoCallout(text: string): HTMLElement {
  const note = document.createElement("p");
  note.className = "callout info";
  if (!SHOW_REPO_LINK) {
    note.textContent = text;
    return note;
  }
  const link = document.createElement("a");
  link.href = REPO_URL;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "README repo";
  note.append(`${text} Cara kerja dan cara menjalankannya ada di `, link, ".");
  return note;
}
