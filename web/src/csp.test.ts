import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import { UJI_URL } from "./userTest.ts";

// The page's Content-Security-Policy decides what it may connect to (NOTES D-01, G-90): its own origin (assets,
// models, /api) and the Apps Script receiver of the user test, which answers through a redirect to googleusercontent.
const meta = indexHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/);
const directives = new Map(
  (meta?.[1] ?? "")
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .filter((words) => words[0] !== "")
    .map(([name, ...sources]) => [name, sources] as const),
);
const connectSrc = directives.get("connect-src") ?? [];

// Exact origins are all this policy uses, so matching a URL means matching its origin.
const PAGE = "https://equilibre.example";
const allows = (url: string) => {
  const origin = new URL(url, PAGE).origin;
  return connectSrc.some((source) => (source === "'self'" ? origin === PAGE : origin === source));
};

describe("Content-Security-Policy in index.html", () => {
  it("lets the page connect only to its own origin and the Apps Script hosts", () => {
    expect(meta).not.toBeNull();
    expect(connectSrc).toEqual(["'self'", "https://script.google.com", "https://script.googleusercontent.com"]);
    expect(allows("/api/analyze")).toBe(true);
    expect(allows("/models/face_landmarker.task")).toBe(true);
  });

  it("covers the user-test receiver and the host it redirects to", () => {
    expect(allows(UJI_URL)).toBe(true);
    expect(allows("https://script.googleusercontent.com/macros/echo?user_content_key=x")).toBe(true);
  });

  it("blocks MediaPipe's usage metrics and any other host (negative control)", () => {
    expect(allows("https://odml.pa.googleapis.com/v1/log")).toBe(false);
    expect(allows("https://example.com/")).toBe(false);
    expect(allows("https://script.google.com.evil.example/exec")).toBe(false);
  });

  it("comes before any script, so it applies from the first request", () => {
    const at = indexHtml.search(/<meta\s+http-equiv="Content-Security-Policy"/);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(indexHtml.indexOf("<script"));
  });
});
