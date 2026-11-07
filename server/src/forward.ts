// Ask Equi stays on the developer's laptop (NOTES D-96, D-98): Bob Shell wants 4 GB of RAM of its own, more
// than the VPS that runs the server and Langflow has to spare. The VPS server hands /api/tanya to the laptop
// through a reverse SSH tunnel (on the laptop: `npm --prefix server run ask-tunnel`), which ends at the laptop
// server's tunnel door (PUBLIC_PORT) and is let in by the same PROXY_SECRET. When the laptop is off, Ask says
// "offline" and advice keeps working. Pure: url, secret and fetch are injected, so the web package's tests can
// run it without config.ts.

export type AskForward = {
  url: string; // where the tunnel ends on the VPS, e.g. http://127.0.0.1:18788
  secret: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

// Bob's own limit on the laptop is 90 s and the Vercel Function waits 110 s (web/api/proxy.ts).
export const ASK_TIMEOUT_MS = 105_000;
export const ASK_HEALTH_TIMEOUT_MS = 2_500;
export const ASK_OFFLINE = "Ask Equi (IBM Bob) runs on the developer's laptop, which is offline right now. Advice still works.";

export type Forwarded = { status: number; body: unknown };

const headers = (secret: string, client: string) => ({
  "content-type": "application/json",
  "x-equilibre-proxy": secret,
  "x-equilibre-client": client,
});

export async function forwardTanya(body: unknown, client: string, f: AskForward): Promise<Forwarded> {
  let res: Response;
  try {
    res = await (f.fetcher ?? fetch)(`${f.url}/api/tanya`, {
      method: "POST",
      headers: headers(f.secret, client),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(f.timeoutMs ?? ASK_TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      return { status: 504, body: { error: "Ask Equi on the developer's laptop did not answer in time." } };
    }
    return { status: 503, body: { error: ASK_OFFLINE, offline: "bob" } };
  }
  // The laptop server always answers JSON; anything else (a closed tunnel, a proxy page) means it is not there.
  try {
    return { status: res.status, body: JSON.parse(await res.text()) as unknown };
  } catch {
    return { status: 503, body: { error: ASK_OFFLINE, offline: "bob" } };
  }
}

// Whether Ask can answer right now: the laptop's tunnel door is open and its server has a Bob key. No LLM call.
export async function askUp(f: AskForward): Promise<boolean> {
  try {
    const res = await (f.fetcher ?? fetch)(`${f.url}/api/health`, {
      headers: headers(f.secret, "health"),
      signal: AbortSignal.timeout(ASK_HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { bob?: unknown };
    return body.bob === true;
  } catch {
    return false;
  }
}
