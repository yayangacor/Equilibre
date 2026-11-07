import { describe, expect, it } from "vitest";
import { BODY_MAX, handle, OFFLINE, routeOf, type Env } from "../api/proxy.ts";
import { DailyLimits, PUBLIC_LIMITS, secretMatches, wibDay } from "../../server/src/limits.ts";
import { NO_BACKEND, onlineNote, probeBackend, toBackend } from "./demo.ts";
import vercelJson from "../vercel.json?raw";

// Online demo through a tunnel to the developer's laptop (NOTES D-80): the Vercel Function, the
// server's limits and secret, and what the page offers after /api/health.

const SECRET = "s".repeat(40);
const ENV: Env = { BACKEND_URL: "https://equilibre.example.ngrok-free.app/", BACKEND_SECRET: SECRET };
const T0 = Date.UTC(2026, 10, 1, 3, 0, 0); // 1 Nov 10:00 WIB

type Call = { url: string; init: RequestInit };
function backend(reply: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const jsonReply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const req = (path: string, init?: RequestInit) =>
  new Request(`https://equilibre-orcin.vercel.app${path}`, { headers: { "x-forwarded-for": "203.0.113.9" }, ...init });

describe("Vercel Function proxy", () => {
  it("reads the route from the rewrite's query or the path, and nothing else", () => {
    expect(routeOf(new URL("https://x/api/proxy?route=analyze"))).toBe("analyze");
    expect(routeOf(new URL("https://x/api/tanya"))).toBe("tanya");
    // Negative control: unknown names and prototype keys are not routes.
    expect(routeOf(new URL("https://x/api/proxy?route=toString"))).toBeNull();
    expect(routeOf(new URL("https://x/api/proxy"))).toBeNull();
  });

  it("forwards a POST with the secret, a hashed visitor id and the ngrok header, and passes the answer back", async () => {
    const { fetcher, calls } = backend(() => jsonReply({ text: "ok" }));
    const res = await handle(req("/api/proxy?route=analyze", { method: "POST", body: '{"label":"tertidur"}' }), ENV, fetcher);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "ok" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://equilibre.example.ngrok-free.app/api/analyze");
    expect(calls[0].init.body).toBe('{"label":"tertidur"}');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["x-equilibre-proxy"]).toBe(SECRET);
    expect(headers["ngrok-skip-browser-warning"]).toBe("1");
    // The laptop gets a hash, never the IP itself.
    expect(headers["x-equilibre-client"]).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(headers)).not.toContain("203.0.113.9");
  });

  it("forwards a plan request (/api/rencana) like an advice, and vercel.json rewrites it here", async () => {
    expect(routeOf(new URL("https://x/api/proxy?route=rencana"))).toBe("rencana");
    const rewrites = (JSON.parse(vercelJson) as { rewrites: { source: string; destination: string }[] }).rewrites;
    expect(rewrites).toContainEqual({ source: "/api/rencana", destination: "/api/proxy?route=rencana" });
    const { fetcher, calls } = backend(() => jsonReply({ tugas_id: "t2" }));
    const res = await handle(req("/api/rencana", { method: "POST", body: '{"fase":"biasa"}' }), ENV, fetcher);
    expect(res.status).toBe(200);
    expect(calls[0].url).toBe("https://equilibre.example.ngrok-free.app/api/rencana");
    expect((await handle(req("/api/rencana"), ENV, fetcher)).status).toBe(405);
  });

  it("gives the same visitor the same id and another visitor another id", async () => {
    const ids: string[] = [];
    const { fetcher, calls } = backend(() => jsonReply({ ok: true }));
    for (const ip of ["203.0.113.9", "203.0.113.9", "198.51.100.7"]) {
      await handle(new Request("https://x/api/health", { headers: { "x-forwarded-for": ip } }), ENV, fetcher);
      ids.push((calls.at(-1)!.init.headers as Record<string, string>)["x-equilibre-client"]);
    }
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("answers offline without calling anything when the backend is not set or not https", async () => {
    for (const env of [{}, { BACKEND_URL: ENV.BACKEND_URL }, { BACKEND_URL: "http://plain.example", BACKEND_SECRET: SECRET }]) {
      const { fetcher, calls } = backend(() => jsonReply({ ok: true }));
      const res = await handle(req("/api/health"), env, fetcher);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: OFFLINE, offline: true });
      expect(calls).toHaveLength(0);
    }
  });

  it("turns the tunnel's own HTML page, a network failure and a wrong secret into offline", async () => {
    const html = backend(() => new Response("<html>ERR_NGROK_3200</html>", { status: 404, headers: { "content-type": "text/html" } }));
    const down = backend(() => Promise.reject(new TypeError("fetch failed")));
    const forbidden = backend(() => jsonReply({ error: "Forbidden." }, 403));
    for (const { fetcher } of [html, down, forbidden]) {
      const res = await handle(req("/api/health"), ENV, fetcher);
      expect(res.status).toBe(503);
      expect((await res.json()).offline).toBe(true);
    }
  });

  it("passes the server's own errors and Retry-After through unchanged (positive control for the above)", async () => {
    const limited = backend(() => jsonReply({ error: "Today's limit…" }, 429, { "retry-after": "60" }));
    const res = await handle(req("/api/proxy?route=tanya", { method: "POST", body: "{}" }), ENV, limited.fetcher);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toEqual({ error: "Today's limit…" });
  });

  it("refuses wrong methods, unknown routes and oversized bodies before calling the laptop", async () => {
    const { fetcher, calls } = backend(() => jsonReply({}));
    expect((await handle(req("/api/analyze"), ENV, fetcher)).status).toBe(405);
    expect((await handle(req("/api/health", { method: "POST", body: "{}" }), ENV, fetcher)).status).toBe(405);
    expect((await handle(req("/api/proxy?route=admin"), ENV, fetcher)).status).toBe(404);
    const big = "x".repeat(BODY_MAX + 1);
    expect((await handle(req("/api/analyze", { method: "POST", body: big }), ENV, fetcher)).status).toBe(413);
    expect(calls).toHaveLength(0);
  });
});

describe("server: tunnel secret", () => {
  it("matches only the exact secret, and never a short one", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(SECRET + "x", SECRET)).toBe(false);
    expect(secretMatches(undefined, SECRET)).toBe(false);
    expect(secretMatches("", SECRET)).toBe(false);
    // A short PROXY_SECRET never opens the door, even when the header equals it.
    expect(secretMatches("short", "short")).toBe(false);
  });
});

describe("server: daily limits for the online demo", () => {
  it("counts a day in Jakarta time", () => {
    expect(wibDay(Date.UTC(2026, 9, 31, 16, 59))).toBe("2026-10-31"); // 23:59 WIB
    expect(wibDay(Date.UTC(2026, 9, 31, 17, 0))).toBe("2026-11-01"); // 00:00 WIB
  });

  it("allows one request a minute per visitor and route", () => {
    const limits = new DailyLimits();
    expect(limits.take("analyze", "a", T0).ok).toBe(true);
    const again = limits.take("analyze", "a", T0 + 30_000);
    expect(again).toMatchObject({ ok: false, retryAfterS: 30 });
    // Another visitor and another route are not held up by visitor a.
    expect(limits.take("analyze", "b", T0 + 30_000).ok).toBe(true);
    expect(limits.take("tanya", "a", T0 + 30_000).ok).toBe(true);
    expect(limits.take("analyze", "a", T0 + 60_000).ok).toBe(true);
  });

  it("stops at the daily cap for everyone, does not count refusals, and starts again at midnight WIB", () => {
    const limits = new DailyLimits({ analyze: 3, tanya: 1 }, 60_000);
    for (const c of ["a", "b", "c"]) expect(limits.take("analyze", c, T0).ok).toBe(true);
    const full = limits.take("analyze", "d", T0);
    expect(full.ok).toBe(false);
    if (!full.ok) {
      expect(full.error).toContain("limit of 3 advice requests");
      expect(full.retryAfterS).toBe(14 * 3600); // 10:00 → 24:00 WIB
    }
    expect(limits.remaining(T0)).toEqual({ analyze: 0, tanya: 1 });
    const nextDay = T0 + 14 * 3_600_000;
    expect(limits.remaining(nextDay)).toEqual({ analyze: 3, tanya: 1 });
    expect(limits.take("analyze", "a", nextDay).ok).toBe(true);
  });

  it("uses the agreed defaults", () => {
    expect(PUBLIC_LIMITS).toEqual({ perDay: { analyze: 40, tanya: 15 }, clientGapMs: 60_000 });
  });
});

describe("page: what the online demo offers after /api/health", () => {
  it("offers advice when Langflow is up, and Ask only with a Bob key too", () => {
    expect(toBackend({ ok: true, langflow: true, bob: true, sisa: { analyze: 37, tanya: 15 } })).toEqual({
      saran: true,
      tanya: true,
      sisa: { analyze: 37, tanya: 15 },
    });
    expect(toBackend({ ok: true, langflow: true, bob: false, sisa: { analyze: 37, tanya: 15 } }).tanya).toBe(false);
  });

  it("offers nothing when Langflow is down or the answer is the proxy's offline note", () => {
    expect(toBackend({ ok: true, langflow: false, bob: true })).toEqual(NO_BACKEND);
    expect(toBackend({ error: OFFLINE, offline: true })).toEqual(NO_BACKEND);
    expect(toBackend(null)).toEqual(NO_BACKEND);
  });

  it("probes once and falls back to nothing on an error status or a failed request", async () => {
    const ok = backend(() => jsonReply({ ok: true, langflow: true, bob: false, sisa: { analyze: 40, tanya: 15 } }));
    expect((await probeBackend(ok.fetcher)).saran).toBe(true);
    expect(ok.calls.map((c) => c.url)).toEqual(["/api/health"]);
    expect(await probeBackend(backend(() => jsonReply({ error: OFFLINE }, 503)).fetcher)).toEqual(NO_BACKEND);
    expect(await probeBackend(backend(() => Promise.reject(new TypeError("x"))).fetcher)).toEqual(NO_BACKEND);
  });

  it("says how many advice requests are left", () => {
    expect(onlineNote({ analyze: 12, tanya: 3 })).toContain("12 advice requests left today");
    expect(onlineNote(null)).not.toContain("left today");
  });
});
