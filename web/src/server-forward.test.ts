import { describe, expect, it } from "vitest";
import { ASK_OFFLINE, askUp, forwardTanya } from "../../server/src/forward.ts";

const SECRET = "s".repeat(32);
const URL_ = "http://127.0.0.1:18788";

function recording(answer: () => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("Ask forwarded to the laptop (NOTES D-98)", () => {
  it("passes the question on with the secret and the visitor id, and returns the laptop's answer as it is", async () => {
    const { fetcher, calls } = recording(async () => new Response(JSON.stringify({ jawaban: "Walk first." }), { status: 200 }));
    const out = await forwardTanya({ pertanyaan: "Why a walk?" }, "abc123", { url: URL_, secret: SECRET, fetcher });
    expect(out).toEqual({ status: 200, body: { jawaban: "Walk first." } });
    expect(calls[0].url).toBe(`${URL_}/api/tanya`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({ "x-equilibre-proxy": SECRET, "x-equilibre-client": "abc123" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ pertanyaan: "Why a walk?" });
  });

  it("keeps the laptop's own errors (Bob busy, limits)", async () => {
    const { fetcher } = recording(async () => new Response(JSON.stringify({ error: "Bob is still answering" }), { status: 429 }));
    expect(await forwardTanya({}, "x", { url: URL_, secret: SECRET, fetcher })).toEqual({
      status: 429,
      body: { error: "Bob is still answering" },
    });
  });

  it("says Bob is offline when the tunnel is closed or answers something that is not the server", async () => {
    const closed = recording(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await forwardTanya({}, "x", { url: URL_, secret: SECRET, fetcher: closed.fetcher })).toEqual({
      status: 503,
      body: { error: ASK_OFFLINE, offline: "bob" },
    });
    const page = recording(async () => new Response("<html>tunnel</html>", { status: 502 }));
    expect((await forwardTanya({}, "x", { url: URL_, secret: SECRET, fetcher: page.fetcher })).status).toBe(503);
  });

  it("gives up after its timeout instead of holding the visitor", async () => {
    const slow = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const out = await forwardTanya({}, "x", { url: URL_, secret: SECRET, fetcher: slow, timeoutMs: 20 });
    expect(out.status).toBe(504);
  });

  it("reports Ask up only when the laptop answers health with a Bob key", async () => {
    const up = recording(async () => new Response(JSON.stringify({ ok: true, langflow: true, bob: true }), { status: 200 }));
    expect(await askUp({ url: URL_, secret: SECRET, fetcher: up.fetcher })).toBe(true);
    expect(up.calls[0].url).toBe(`${URL_}/api/health`);
    const noKey = recording(async () => new Response(JSON.stringify({ ok: true, bob: false }), { status: 200 }));
    expect(await askUp({ url: URL_, secret: SECRET, fetcher: noKey.fetcher })).toBe(false);
    const refused = recording(async () => new Response("{}", { status: 403 }));
    expect(await askUp({ url: URL_, secret: SECRET, fetcher: refused.fetcher })).toBe(false);
    const off = recording(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await askUp({ url: URL_, secret: SECRET, fetcher: off.fetcher })).toBe(false);
  });
});
