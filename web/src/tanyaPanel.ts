import { DEMO, DEMO_NOTE, demoCallout } from "./demo.ts";
import type { DaySummary } from "./history.ts";
import { icon } from "./icons.ts";
import type { Label } from "./rules.ts";
import { PERTANYAAN_MAX, PERTANYAAN_MIN, toTanyaBody, toTanyaView, type TanyaResponse } from "./tanya.ts";

// "Ask Equilibre" (plan P07): suggestions as a list above one field (D-78): a question → POST
// /api/tanya → IBM Bob answers through the Langflow flows over MCP. Each question is still answered
// on its own (no multi-turn, NOTES D-08); the thread only keeps this page load's questions in view.
// Every text from the answer goes in via textContent.

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el(tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

// One per flow Bob can pick (ringkasan_harian, cari_panduan), so a first try shows both.
export const SUGGESTIONS = ["How am I doing today?", "What is the 20-20-20 rule?"] as const;

export type TanyaDeps = {
  context: () => { label: Label | null; menitLelah60: number | null }; // the shown label right now
  todaySummary: () => Promise<DaySummary | null>;
};

export class TanyaPanel {
  private readonly deps: TanyaDeps;
  private readonly input = byId<HTMLTextAreaElement>("tanya-input");
  private readonly button = byId<HTMLButtonElement>("tanya-send");
  private readonly status = byId("tanya-status");
  private readonly thread = byId("tanya-thread");
  private readonly chips: HTMLButtonElement[];
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
    this.chips = SUGGESTIONS.map((text) => {
      const chip = el("button", text, "ask-item") as HTMLButtonElement;
      chip.type = "button";
      chip.prepend(icon("subdirectory_arrow_right"));
      chip.addEventListener("click", () => {
        this.input.value = text;
        void this.ask();
      });
      return chip;
    });
    byId("tanya-chips").replaceChildren(...this.chips);
    if (DEMO) {
      this.setBusy(true); // nothing to answer with: the demo build has no backend
      this.input.disabled = true;
      this.input.placeholder = "Not available in the online demo";
      this.thread.before(demoCallout(DEMO_NOTE.tanya));
    }
  }

  private setBusy(busy: boolean) {
    this.asking = busy;
    this.button.disabled = busy;
    for (const chip of this.chips) chip.disabled = busy;
  }

  private async ask() {
    const pertanyaan = this.input.value.trim();
    if (this.asking) return;
    if (pertanyaan.length < PERTANYAAN_MIN) {
      this.status.textContent = `Type at least ${PERTANYAAN_MIN} characters.`;
      return;
    }
    const { label, menitLelah60 } = this.deps.context();
    const body = toTanyaBody(pertanyaan, label, menitLelah60, await this.deps.todaySummary());
    this.setBusy(true);
    this.status.textContent = "";
    this.input.value = "";
    this.thread.append(this.bubble("me", [el("p", pertanyaan)]));
    const pending = this.bubble("bob pending", [el("p", "Bob is finding an answer through the Langflow flows")]);
    const dots = el("span", "", "typing");
    dots.append(el("span", ""), el("span", ""), el("span", ""));
    pending.querySelector("p")!.append(dots);
    this.thread.append(pending);
    pending.scrollIntoView({ block: "nearest" });
    try {
      const res = await fetch("/api/tanya", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const reply = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(reply.error ?? `The backend did not answer (HTTP ${res.status}). Check that the server is running.`);
      pending.replaceWith(this.answer(reply as TanyaResponse));
    } catch (err) {
      const message = err instanceof TypeError ? "Cannot reach the backend." : (err as Error).message;
      pending.replaceWith(this.bubble("bob failed", [el("p", message)]));
      this.input.value = pertanyaan; // nothing lost: the question can be sent again
    } finally {
      this.setBusy(false);
      this.thread.lastElementChild?.scrollIntoView({ block: "nearest" });
    }
  }

  private bubble(kind: string, parts: HTMLElement[]): HTMLElement {
    const item = el("li", "", `bubble ${kind}`);
    item.append(...parts);
    return item;
  }

  private answer(reply: TanyaResponse): HTMLElement {
    const view = toTanyaView(reply);
    const parts: HTMLElement[] = [el("p", view.jawaban)];
    if (view.sumber.length > 0) {
      const items = el("ul", "", "sources");
      items.append(...view.sumber.map((s) => el("li", s.text, s.known ? undefined : "error")));
      parts.push(items);
    }
    parts.push(...view.catatan.map((c) => el("p", c, "note")));
    return this.bubble("bob", parts);
  }
}
