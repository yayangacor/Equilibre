// Hosted demo build (`npm run build:demo`): only the browser part is deployed and no backend sits behind it,
// so the two features that need the backend, Langflow and IBM Bob say so instead of failing. Detection,
// history, Insight and the companion run entirely in the browser and are the same as in a local run.
export const DEMO = import.meta.env.MODE === "demo";

export const REPO_URL = "https://github.com/yayangacor/Equilibre";

export const DEMO_NOTE = {
  saran:
    "The online demo does not request advice: advice is written by a Langflow flow with an LLM, through a backend " +
    "that runs on the developer's laptop.",
  autoSend: "Not available in the online demo: advice needs the backend and Langflow running locally.",
  tanya: "Ask Equilibre is off in the online demo: IBM Bob and the Langflow flow run on the developer's laptop.",
} as const;

// The note as a callout, with a link to the README that explains the feature and how to run it. A
// tester's link (?kode=) shows it too: hiding it there (D-60) was reversed by the user (D-64).
export function demoCallout(text: string): HTMLElement {
  const note = document.createElement("p");
  note.className = "callout info";
  const link = document.createElement("a");
  link.href = REPO_URL;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "repository README";
  note.append(`${text} How it works and how to run it: see the `, link, ".");
  return note;
}
