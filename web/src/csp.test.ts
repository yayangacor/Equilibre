import { describe, expect, it } from "vitest";
import appHtml from "../app.html?raw";
import authHtml from "../auth.html?raw";
import indexHtml from "../index.html?raw";
import { UJI_URL } from "./userTest.ts";

// Each page's Content-Security-Policy decides what it may connect to (NOTES D-01, G-90, D-77): its own origin (assets,
// models, /api), the Apps Script receiver of the user test (it answers through a redirect to googleusercontent), and
// Supabase Auth for the account (D-78), and the Google Tasks import (plan P20 W2.1): the Google Identity Services
// endpoints under accounts.google.com/gsi/, the Tasks API, and the one endpoint Disconnect needs:
// google.accounts.oauth2.revoke() is an XMLHttpRequest POST to https://oauth2.googleapis.com/revoke (read in the GIS
// client, 8 Nov), which connect-src governs. Every page carries the same policy.
const POLICY = [
  "'self'",
  "https://script.google.com",
  "https://script.googleusercontent.com",
  "https://*.supabase.co",
  "https://accounts.google.com/gsi/",
  "https://tasks.googleapis.com",
  "https://oauth2.googleapis.com/revoke",
];

const PAGE = "https://equilibre.example";

function policyOf(html: string) {
  const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
  const directives = new Map(
    (meta?.[1] ?? "")
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((words) => words[0] !== "")
      .map(([name, ...sources]) => [name, sources] as const),
  );
  const connectSrc = directives.get("connect-src") ?? [];
  // Exact origins, one "https://*.host" wildcard (subdomains only, over https), a source ending in "/" that allows
  // only paths under it, and a source with any other path that allows exactly that path (CSP path matching).
  const allows = (url: string) => {
    const { origin, protocol, host, pathname } = new URL(url, PAGE);
    return connectSrc.some((source) => {
      if (source === "'self'") return origin === PAGE;
      if (source.startsWith("https://*.")) return protocol === "https:" && host.endsWith(source.slice("https://*".length));
      const at = new URL(source);
      if (at.pathname.endsWith("/") && at.pathname !== "/") return origin === at.origin && pathname.startsWith(at.pathname);
      if (at.pathname !== "/") return origin === at.origin && pathname === at.pathname;
      return origin === source;
    });
  };
  return { meta, connectSrc, allows };
}

describe.each([
  ["index.html", indexHtml],
  ["auth.html", authHtml],
  ["app.html", appHtml],
])("Content-Security-Policy in %s", (_name, html) => {
  const { meta, connectSrc, allows } = policyOf(html);

  it("lets the page connect only to its own origin, the Apps Script hosts and Supabase", () => {
    expect(meta).not.toBeNull();
    expect(connectSrc).toEqual(POLICY);
    expect(allows("/api/analyze")).toBe(true);
    expect(allows("/models/face_landmarker.task")).toBe(true);
    expect(allows("https://abcdefghijkl.supabase.co/auth/v1/token?grant_type=password")).toBe(true);
  });

  it("covers the user-test receiver and the host it redirects to", () => {
    expect(allows(UJI_URL)).toBe(true);
    expect(allows("https://script.googleusercontent.com/macros/echo?user_content_key=x")).toBe(true);
  });

  it("covers the Google Tasks import: the Identity Services endpoints and the Tasks API only", () => {
    expect(allows("https://accounts.google.com/gsi/status?client_id=x")).toBe(true);
    expect(allows("https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20")).toBe(true);
    expect(allows("https://accounts.google.com/o/oauth2/v2/auth")).toBe(false);
    expect(allows("https://accounts.google.com/")).toBe(false);
    expect(allows("https://www.googleapis.com/tasks/v1/users/@me/lists")).toBe(false);
    expect(allows("https://tasks.googleapis.com.evil.example/")).toBe(false);
  });

  it("lets Disconnect revoke the Google grant, and nothing else on oauth2.googleapis.com (review A, 8 Nov)", () => {
    expect(allows("https://oauth2.googleapis.com/revoke")).toBe(true);
    expect(allows("https://oauth2.googleapis.com/token")).toBe(false);
    expect(allows("https://oauth2.googleapis.com/revoke/x")).toBe(false);
    expect(allows("https://oauth2.googleapis.com/")).toBe(false);
  });

  it("blocks MediaPipe's usage metrics and any other host (negative control)", () => {
    expect(allows("https://odml.pa.googleapis.com/v1/log")).toBe(false);
    expect(allows("https://example.com/")).toBe(false);
    expect(allows("https://script.google.com.evil.example/exec")).toBe(false);
    expect(allows("https://supabase.co.evil.example/")).toBe(false);
    expect(allows("http://abcdefghijkl.supabase.co/")).toBe(false);
  });

  it("comes before any script, so it applies from the first request", () => {
    const at = html.search(/<meta\s+http-equiv="Content-Security-Policy"/);
    expect(at).toBeGreaterThan(-1);
    const firstScript = html.indexOf("<script");
    expect(firstScript === -1 || at < firstScript).toBe(true);
  });
});
