// Hosted demo build (`npm run build:demo`): the browser part is deployed on Vercel. Detection, history,
// Insight and the companion run entirely in the browser and are the same as in a local run. Advice
// (Langflow + LLM) and Ask Equilibre (IBM Bob) need the backend, which runs on the developer's laptop:
// a Vercel Function forwards /api to it through a tunnel while the laptop is on (NOTES D-80), so the
// page asks /api/health first and offers each feature only when it can answer right now.
export const DEMO = import.meta.env.MODE === "demo";

export const REPO_URL = "https://github.com/yayangacor/Equilibre";

export const DEMO_NOTE = {
  checking: "Checking whether the developer's laptop, which runs Langflow and IBM Bob for this demo, is online…",
  saran:
    "Advice is written by a Langflow flow with an LLM, through a backend on the developer's laptop. The laptop is " +
    "offline right now, so the online demo cannot request advice.",
  autoSend: "Not available in the online demo: each advice is an LLM call from a shared daily limit, so it is requested by hand.",
  tanya:
    "Ask Equilibre runs IBM Bob and the Langflow flows on the developer's laptop, which is offline right now or has " +
    "no Bob key.",
} as const;

// What the backend can answer right now. A local run always offers both and lets a failure say why.
export type Backend = {
  saran: boolean;
  tanya: boolean;
  sisa: { analyze: number; tanya: number } | null; // requests left today in the online demo
};
export const LOCAL_BACKEND: Backend = { saran: true, tanya: true, sisa: null };
export const NO_BACKEND: Backend = { saran: false, tanya: false, sisa: null };

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null);

export function toBackend(body: unknown): Backend {
  if (typeof body !== "object" || body === null) return NO_BACKEND;
  const b = body as Record<string, unknown>;
  if (b.ok !== true || b.langflow !== true) return NO_BACKEND;
  const s = (typeof b.sisa === "object" && b.sisa !== null ? b.sisa : {}) as Record<string, unknown>;
  const analyze = count(s.analyze);
  const tanya = count(s.tanya);
  return {
    saran: true,
    tanya: b.bob === true,
    sisa: analyze === null || tanya === null ? null : { analyze, tanya },
  };
}

// One GET /api/health through the Vercel Function; no LLM call behind it.
export async function probeBackend(fetcher: typeof fetch = fetch): Promise<Backend> {
  try {
    const res = await fetcher("/api/health", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return NO_BACKEND;
    return toBackend(await res.json());
  } catch {
    return NO_BACKEND;
  }
}

export function onlineNote(sisa: Backend["sisa"]): string {
  const left = sisa ? ` ${sisa.analyze} advice requests left today for all visitors.` : "";
  return `Langflow is online for this demo, on the developer's laptop.${left}`;
}

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
