// Page navigation (plan P14): five pages in one document, picked by the URL hash (#insight …),
// so the query string keeps its dev switches (?debug=1, ?riwayat=uji) and every page stays in the
// DOM. The camera dock lives outside the pages, so the detector keeps reading the video on all of them.

export const PAGES = ["sekarang", "insight", "tanya", "privasi", "teknis"] as const;
export type Page = (typeof PAGES)[number];

export const isPage = (name: string): name is Page => (PAGES as readonly string[]).includes(name);

export class Router {
  private current: Page = "sekarang";
  private readonly listeners: ((page: Page) => void)[] = [];

  constructor() {
    window.addEventListener("hashchange", () => this.resolve(true));
    this.resolve(false);
  }

  get page(): Page {
    return this.current;
  }

  onChange(listener: (page: Page) => void) {
    this.listeners.push(listener);
  }

  // A page name opens that page; the id of an element inside a page (#saran) opens its page and
  // scrolls to it; anything else opens "sekarang".
  private resolve(moveFocus: boolean) {
    const name = location.hash.slice(1);
    if (isPage(name)) {
      this.show(name, null, moveFocus);
      return;
    }
    const target = name ? document.getElementById(name) : null;
    const page = target?.closest<HTMLElement>(".page")?.dataset.page;
    this.show(page && isPage(page) ? page : "sekarang", target, moveFocus);
  }

  private show(page: Page, target: HTMLElement | null, moveFocus: boolean) {
    this.current = page;
    document.body.dataset.page = page;
    for (const section of document.querySelectorAll<HTMLElement>(".page")) section.hidden = section.dataset.page !== page;
    for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-page-link]")) {
      if (link.dataset.pageLink === page) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (target) {
      target.scrollIntoView({ block: "start" });
    } else if (moveFocus) {
      window.scrollTo({ top: 0 });
      // Moves screen readers and the keyboard to the new page's heading.
      document.querySelector<HTMLElement>(`.page[data-page="${page}"] h1`)?.focus({ preventScroll: true });
    }
    for (const listener of this.listeners) listener(page);
  }
}
