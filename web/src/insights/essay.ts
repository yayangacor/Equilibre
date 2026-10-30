import { el, markToken } from "./dom.ts";
import type { EssayStep } from "./model.ts";

// The personal essay, Pudding style: short steps in a narrow column beside a sticky graphic. A step becomes
// active when it crosses a line at 65% of the viewport (one IntersectionObserver, no scroll handler), and the
// graphic regroups to that step's chart state. Text comes from model.ts templates; numbers are set in mono and
// underlined in their state's color.

const TRIGGER = "-65% 0px -34% 0px";

export type EssayView = { root: HTMLElement; update(steps: readonly EssayStep[]): void; destroy(): void };

export function createEssay(onStep: (step: EssayStep, index: number) => void): EssayView {
  const root = el("ol", "ins-steps");
  let steps: readonly EssayStep[] = [];
  let items: HTMLElement[] = [];
  let current = -1;

  const activate = (i: number) => {
    if (i === current || !steps[i]) return;
    current = i;
    items.forEach((item, j) => item.classList.toggle("is-active", j === i));
    onStep(steps[i], i);
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) activate(items.indexOf(e.target as HTMLElement));
    },
    { rootMargin: TRIGGER, threshold: 0 },
  );

  return {
    root,
    update(next) {
      io.disconnect();
      steps = next;
      current = -1;
      items = next.map((step, i) => {
        const li = el("li", "ins-step");
        li.dataset.step = step.id;
        li.append(el("p", "ins-step-count", `${String(i + 1).padStart(2, "0")} / ${String(next.length).padStart(2, "0")}`));
        const p = el("p", "ins-step-text");
        for (const span of step.spans) {
          if (typeof span === "string") p.append(span);
          else {
            const num = el("span", "ins-num", span.text);
            num.dataset.s = markToken(span.mark);
            p.append(num);
          }
        }
        li.append(p);
        // A click also shows the step's chart, for readers who do not scroll through.
        li.addEventListener("click", () => activate(i));
        return li;
      });
      root.replaceChildren(...items);
      for (const item of items) io.observe(item);
      activate(0);
    },
    destroy() {
      io.disconnect();
    },
  };
}
