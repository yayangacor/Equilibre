// Vercel Function behind /api/health, /api/analyze, /api/tanya and /api/rencana of the online demo (NOTES D-80;
// vercel.json rewrites the four paths here). It forwards to the Equilibre server on the developer's
// laptop through a tunnel (BACKEND_URL), adding the secret only it and the server know (BACKEND_SECRET)
// and a hashed visitor id for the server's per-minute limit. Langflow, IBM Bob and every key stay on the
// laptop. When the laptop is off, the tunnel answers with its own page (ngrok: HTML), which becomes the
// same JSON "offline" answer as having no backend set.

export type Env = { BACKEND_URL?: string; BACKEND_SECRET?: string };

export const ROUTES = {
  health: { method: "GET", timeoutMs: 8_000 },
  // Two Langflow runs at most (primary, then fallback), 30 s each on the server.
  analyze: { method: "POST", timeoutMs: 75_000 },
  // Bob's own limit is 90 s.
  tanya: { method: "POST", timeoutMs: 110_000 },
  // "Plan my next hour" (plan P20 W2.4): like analyze, two Langflow runs at most.
  rencana: { method: "POST", timeoutMs: 75_000 },
} as const;
export type RouteName = keyof typeof ROUTES;

export const BODY_MAX = 16_384; // as express.json() on the server
export const OFFLINE =
  "The developer's laptop, which runs Langflow and IBM Bob for this demo, is offline right now. Try again later.";

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

// The visitor's IP, hashed with the secret: enough to tell visitors apart, nothing the laptop can log as an IP.
async function visitorId(request: Request, secret: string): Promise<string> {
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || request.headers.get("x-real-ip") || "";
  const data = new TextEncoder().encode(`${secret}:${ip}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function routeOf(url: URL): RouteName | null {
  const name = url.searchParams.get("route") ?? url.pathname.split("/").filter(Boolean).pop() ?? "";
  return Object.hasOwn(ROUTES, name) ? (name as RouteName) : null;
}

export async function handle(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const name = routeOf(new URL(request.url));
  if (!name) return json({ error: "Not found." }, 404);
  const route = ROUTES[name];
  if (request.method !== route.method) return json({ error: "Method not allowed." }, 405);

  const backend = (env.BACKEND_URL ?? "").trim().replace(/\/+$/, "");
  const secret = env.BACKEND_SECRET ?? "";
  if (!/^https:\/\//.test(backend) || !secret) return json({ error: OFFLINE, offline: true }, 503);

  let body: string | undefined;
  if (route.method === "POST") {
    body = await request.text();
    if (body.length > BODY_MAX) return json({ error: "Body too large." }, 413);
  }

  let res: Response;
  try {
    res = await fetcher(`${backend}/api/${name}`, {
      method: route.method,
      headers: {
        "content-type": "application/json",
        "x-equilibre-proxy": secret,
        "x-equilibre-client": await visitorId(request, secret),
        // ngrok's free plan puts a warning page in front of browser-like requests unless this is sent.
        "ngrok-skip-browser-warning": "1",
        "user-agent": "equilibre-demo-proxy",
      },
      body,
      signal: AbortSignal.timeout(route.timeoutMs),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      return json({ error: `The developer's laptop did not answer within ${route.timeoutMs / 1000} s.` }, 504);
    }
    return json({ error: OFFLINE, offline: true }, 503);
  }

  // The Equilibre server always answers JSON; anything else is the tunnel's own page (laptop or server off).
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    return json({ error: OFFLINE, offline: true }, 503);
  }
  // 403 = the secrets differ between Vercel and the laptop: a setup fault, not the visitor's.
  if (res.status === 403) return json({ error: OFFLINE, offline: true }, 503);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(await res.text(), { status: res.status, headers });
}

// Read through globalThis so the file needs no Node type declarations to compile.
const runtimeEnv = () =>
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

export default {
  fetch(request: Request): Promise<Response> {
    const env = runtimeEnv();
    return handle(request, { BACKEND_URL: env.BACKEND_URL, BACKEND_SECRET: env.BACKEND_SECRET });
  },
};
