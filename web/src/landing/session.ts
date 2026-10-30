// A visitor who already signed in has a Supabase session in localStorage ("sb-<project>-auth-token"). For them the
// landing page's "Get started" buttons open the dashboard instead of the sign-up form. Nothing is read from the token.

export const SESSION_KEY = /^sb-.*-auth-token$/;

export function hasSession(keys: Iterable<string>): boolean {
  for (const key of keys) if (SESSION_KEY.test(key)) return true;
  return false;
}

function storageKeys(): string[] {
  try {
    const store = window.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch {
    // Storage blocked (private mode, site data off): treat as signed out.
    return [];
  }
}

export function applySession(root: ParentNode = document): void {
  if (!hasSession(storageKeys())) return;
  root.querySelectorAll<HTMLAnchorElement>("a[data-cta]").forEach((link) => {
    link.href = "app.html";
    const label = link.querySelector("[data-cta-label]");
    if (label) label.textContent = "Open dashboard";
  });
  root.querySelectorAll<HTMLElement>("[data-signed-out]").forEach((el) => {
    el.hidden = true;
  });
}
