// Page navigation (NOTES D-78): four pages in one document, picked by the URL hash (#insights …), so the
// query string keeps its dev switches (?debug=1, ?riwayat=uji) and every page stays in the DOM. The camera box
// lives outside the pages, so the detector keeps reading the video on all of them.

export const PAGES = ["dashboard", "insights", "settings", "debug"] as const;
export type Page = (typeof PAGES)[number];

export const isPage = (name: string): name is Page => (PAGES as readonly string[]).includes(name);

// Names from before the redesign, still in shared links and older documents.
const OLD_NAMES = new Map<string, Page>([
  ["sekarang", "dashboard"],
  ["tanya", "dashboard"],
  ["insight", "insights"],
  ["privasi", "settings"],
  ["teknis", "debug"],
]);

export const pageFor = (name: string): Page | null => (isPage(name) ? name : (OLD_NAMES.get(name) ?? null));

export class Router {
  private current: Page = "dashboard";
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

  // A page name (or its old name) opens that page; the id of an element inside a page (#ask) opens
  // its page and scrolls to it; anything else opens the dashboard.
  private resolve(moveFocus: boolean) {
    const name = location.hash.slice(1);
    const named = pageFor(name);
    if (named) {
      this.show(named, null, moveFocus);
      return;
    }
    const target = name ? document.getElementById(name) : null;
    const page = target?.closest<HTMLElement>(".page")?.dataset.page;
    this.show(page && isPage(page) ? page : "dashboard", target, moveFocus);
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
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    } else if (moveFocus) {
      window.scrollTo({ top: 0 });
      // Moves screen readers and the keyboard to the new page's heading.
      document.querySelector<HTMLElement>(`.page[data-page="${page}"] h1`)?.focus({ preventScroll: true });
    }
    for (const listener of this.listeners) listener(page);
  }
}
