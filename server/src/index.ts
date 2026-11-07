import express, { type ErrorRequestHandler } from "express";
import { config } from "./config.ts";
import { analyze } from "./analyze.ts";
import { runBob } from "./bob.ts";
import { parseFeatures, toFlowInput } from "./features.ts";
import { assertLangflowUp, langflowUp, runFlow } from "./langflow.ts";
import { askUp, forwardTanya } from "./forward.ts";
import { DailyLimits, PROXY_SECRET_MIN, secretMatches, type PublicRoute } from "./limits.ts";
import { FALLBACK_LABEL, readPrimaryModel } from "./model.ts";
import { parseRencana, rencana } from "./rencana.ts";
import { LangflowError } from "./reply.ts";
import { parseTanya, tanya } from "./tanya.ts";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/analyze", async (req, res) => {
  const parsed = parseFeatures(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const input = toFlowInput(parsed.value);
  if (!input) {
    res.status(422).json({ error: `The label "${parsed.value.label}" is not sent to Langflow.` });
    return;
  }
  if (!config.langflowApiKey || !config.langflowFlowId) {
    res.status(503).json({ error: "The server is not configured: set LANGFLOW_API_KEY and LANGFLOW_FLOW_ID in .env." });
    return;
  }

  try {
    const flowId = config.langflowFlowId;
    const out = await analyze(input, (inputValue, tweaks) => runFlow(flowId, inputValue, tweaks));
    // Which model answered, for the advice card (plan P20 W0.5): the fallback is fixed, the primary
    // one is read from the flow (no LLM call).
    const model = out.cadangan
      ? FALLBACK_LABEL
      : await readPrimaryModel({ url: config.langflowUrl, apiKey: config.langflowApiKey, flowId });
    res.json({ ...out, model });
  } catch (err) {
    if (err instanceof LangflowError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// "Plan my next hour" (plan P20 W2.4): the energy phase and the abstract tasks t1..tn only (rencana.ts, NOTES D-90).
// The flow's Task Matcher picks the task, the LLM explains it; the app falls back to its own Task Matcher on any error.
app.post("/api/rencana", async (req, res) => {
  const parsed = parseRencana(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (!config.langflowApiKey || !config.langflowRencanaFlowId) {
    res.status(503).json({ error: "The server is not configured: set LANGFLOW_API_KEY and LANGFLOW_RENCANA_FLOW_ID in .env." });
    return;
  }

  try {
    const flowId = config.langflowRencanaFlowId;
    const out = await rencana(parsed.value, (inputValue, tweaks) => runFlow(flowId, inputValue, tweaks));
    const model = out.cadangan
      ? FALLBACK_LABEL
      : await readPrimaryModel({ url: config.langflowUrl, apiKey: config.langflowApiKey, flowId });
    res.json({ ...out.jawaban, model, cadangan: out.cadangan });
  } catch (err) {
    if (err instanceof LangflowError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// "Tanya Equilibre" (jalur B): one Bob run at a time, since each one is an agent with an LLM
// behind it (cost, NOTES D-19) and takes tens of seconds.
let bobBusy = false;

app.post("/api/tanya", async (req, res) => {
  const parsed = parseTanya(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  // On the VPS: Bob runs on the laptop (NOTES D-98), which checks the key, Langflow and its own busy flag. The body
  // goes on as it came (checked above): the laptop validates it again with the same whitelist.
  if (config.askForwardUrl) {
    const out = await forwardTanya(req.body, req.get("x-equilibre-client") || "local", {
      url: config.askForwardUrl,
      secret: config.proxySecret,
    });
    res.status(out.status).json(out.body);
    return;
  }
  if (!config.bobApiKey) {
    res.status(503).json({ error: "The server is not configured: set BOB_API_KEY in .env." });
    return;
  }
  if (bobBusy) {
    res.status(429).json({ error: "Bob is still answering another question. Try again in a moment." });
    return;
  }
  bobBusy = true;
  try {
    await assertLangflowUp();
    res.json(await tanya(parsed.value, runBob));
  } catch (err) {
    if (err instanceof LangflowError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  } finally {
    bobBusy = false;
  }
});

// Also catches express.json() failures: malformed JSON (400) and oversized body (413).
const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = typeof err?.status === "number" ? err.status : 500;
  if (status >= 500) console.error(err);
  const message =
    status === 400 ? "Body bukan JSON yang valid." : status === 413 ? "Body terlalu besar." : "Terjadi kesalahan di server.";
  res.status(status).json({ error: message });
};
app.use(onError);

// Online demo (NOTES D-80): the tunnel (ngrok) forwards to this second app, never to `app`'s own port.
// Only the Vercel Function knows the secret; it also sends a hashed id per visitor for the per-minute
// gap. Health tells the demo page what it can offer right now, without any LLM call.
const limits = new DailyLimits();
const publicApp = express();
publicApp.disable("x-powered-by");
publicApp.use((req, res, next) => {
  if (secretMatches(req.get("x-equilibre-proxy"), config.proxySecret)) {
    next();
    return;
  }
  res.status(403).json({ error: "Forbidden." });
});
publicApp.get("/api/health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const bob = config.askForwardUrl
    ? await askUp({ url: config.askForwardUrl, secret: config.proxySecret })
    : Boolean(config.bobApiKey);
  res.json({ ok: true, langflow: await langflowUp(), bob, sisa: limits.remaining() });
});
// A plan (/api/rencana) is a Langflow run with an LLM like an advice, so it counts against the advice budget: the same
// daily cap and per-minute gap, and the total of LLM calls a day stays the one agreed in NOTES D-80.
publicApp.post(["/api/analyze", "/api/tanya", "/api/rencana"], (req, res, next) => {
  const route: PublicRoute = req.path === "/api/tanya" ? "tanya" : "analyze";
  if (route === "tanya" && bobBusy) {
    // Checked here as well so a busy Bob does not use up a visitor's turn.
    res.status(429).json({ error: "Bob is still answering another question. Try again in a moment." });
    return;
  }
  const verdict = limits.take(route, req.get("x-equilibre-client") || "unknown");
  if (!verdict.ok) {
    res.set("Retry-After", String(verdict.retryAfterS));
    res.status(429).json({ error: verdict.error });
    return;
  }
  next();
});
publicApp.use(app);

// Bind to localhost only: this process holds the Langflow and Bob API keys and drives Bob.
// Express 5 passes listen errors (e.g. EADDRINUSE) to this callback instead of throwing.
function listen(server: express.Express, port: number, what: string) {
  server.listen(port, "127.0.0.1", (err?: Error) => {
    if (err) {
      console.error(`Gagal menjalankan ${what} di port ${port}: ${err.message}`);
      process.exit(1);
    }
    console.log(`${what}: http://localhost:${port}`);
  });
}

listen(app, config.port, "Equilibre server");
if (config.proxySecret.length >= PROXY_SECRET_MIN) {
  listen(publicApp, config.publicPort, "Pintu demo online (untuk tunnel)");
} else if (config.proxySecret) {
  console.error(`PROXY_SECRET kurang dari ${PROXY_SECRET_MIN} karakter: pintu demo online tidak dibuka.`);
}
