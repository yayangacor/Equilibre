import type { DaySummary } from "./history.ts";
import type { Label } from "./rules.ts";
import { PERTANYAAN_MAX, PERTANYAAN_MIN, toTanyaBody, toTanyaView, type TanyaResponse } from "./tanya.ts";

// "Tanya Equilibre" panel (plan P07): a question → POST /api/tanya → IBM Bob answers through the
// Langflow flows over MCP. Every text from the answer goes in via textContent.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

export type TanyaDeps = {
  context: () => { label: Label | null; menitLelah60: number | null }; // the shown label right now
  todaySummary: () => Promise<DaySummary | null>;
};

export class TanyaPanel {
  private readonly deps: TanyaDeps;
  private readonly input = byId<HTMLTextAreaElement>("tanya-input");
  private readonly button = byId<HTMLButtonElement>("tanya-send");
  private readonly status = byId("tanya-status");
  private readonly answer = byId("tanya-answer");
  private asking = false;

  constructor(deps: TanyaDeps) {
    this.deps = deps;
    this.input.maxLength = PERTANYAAN_MAX;
    this.button.addEventListener("click", () => void this.ask());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.ask();
      }
    });
  }

  private async ask() {
    const pertanyaan = this.input.value.trim();
    if (this.asking) return;
    if (pertanyaan.length < PERTANYAAN_MIN) {
      this.status.textContent = `Tulis pertanyaan minimal ${PERTANYAAN_MIN} karakter.`;
      return;
    }
    const { label, menitLelah60 } = this.deps.context();
    const body = toTanyaBody(pertanyaan, label, menitLelah60, await this.deps.todaySummary());
    this.asking = true;
    this.button.disabled = true;
    this.status.textContent = "Bob sedang mencari jawaban lewat flow Langflow… biasanya 15–40 detik.";
    this.answer.replaceChildren();
    try {
      const res = await fetch("/api/tanya", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const reply = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(reply.error ?? `Backend tidak menjawab (HTTP ${res.status}). Pastikan server sudah jalan.`);
      this.render(reply as TanyaResponse);
      this.status.textContent = "";
    } catch (err) {
      this.status.textContent = "";
      this.answer.replaceChildren(el("p", err instanceof TypeError ? "Tidak bisa menghubungi backend." : (err as Error).message, "error"));
    } finally {
      this.asking = false;
      this.button.disabled = false;
    }
  }

  private render(reply: TanyaResponse) {
    const view = toTanyaView(reply);
    const parts: HTMLElement[] = [el("p", view.jawaban)];
    if (view.sumber.length > 0) {
      const items = document.createElement("ul");
      items.className = "sources";
      items.append(...view.sumber.map((s) => el("li", s.text, s.known ? undefined : "error")));
      parts.push(el("p", "Sumber:", "note"), items);
    }
    parts.push(...view.catatan.map((c) => el("p", c, "note")));
    this.answer.replaceChildren(...parts);
  }
}
