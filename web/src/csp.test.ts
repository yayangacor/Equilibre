import { describe, expect, it } from "vitest";
import appHtml from "../app.html?raw";
import authHtml from "../auth.html?raw";
import indexHtml from "../index.html?raw";
import { UJI_URL } from "./userTest.ts";

// Each page's Content-Security-Policy decides what it may connect to (NOTES D-01, G-90, D-77): its own origin (assets,
// models, /api), the Apps Script receiver of the user test (it answers through a redirect to googleusercontent), and
// Supabase Auth for the account (D-78). Every page carries the same policy.
const POLICY = ["'self'", "https://script.google.com", "https://script.googleusercontent.com", "https://*.supabase.co"];

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
  // Exact origins plus one "https://*.host" wildcard: a wildcard matches subdomains only, over https.
  const allows = (url: string) => {
    const { origin, protocol, host } = new URL(url, PAGE);
    return connectSrc.some((source) => {
      if (source === "'self'") return origin === PAGE;
      if (source.startsWith("https://*.")) return protocol === "https:" && host.endsWith(source.slice("https://*".length));
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
