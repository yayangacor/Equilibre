import express, { type ErrorRequestHandler } from "express";
import { config } from "./config.ts";
import { analyze } from "./analyze.ts";
import { runBob } from "./bob.ts";
import { parseFeatures, toFlowInput } from "./features.ts";
import { runFlow } from "./langflow.ts";
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
    res.status(422).json({ error: `Label "${parsed.value.label}" tidak dikirim ke Langflow.` });
    return;
  }
  if (!config.langflowApiKey || !config.langflowFlowId) {
    res.status(503).json({ error: "Server belum dikonfigurasi: isi LANGFLOW_API_KEY dan LANGFLOW_FLOW_ID di .env." });
    return;
  }

  try {
    const flowId = config.langflowFlowId;
    res.json(await analyze(input, (inputValue, tweaks) => runFlow(flowId, inputValue, tweaks)));
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
  if (!config.bobApiKey) {
    res.status(503).json({ error: "Server belum dikonfigurasi: isi BOB_API_KEY di .env." });
    return;
  }
  if (bobBusy) {
    res.status(429).json({ error: "Bob masih menjawab pertanyaan sebelumnya. Coba lagi sebentar lagi." });
    return;
  }
  bobBusy = true;
  try {
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

// Bind to localhost only: this process holds the Langflow and Bob API keys and drives Bob.
// Express 5 passes listen errors (e.g. EADDRINUSE) to this callback instead of throwing.
app.listen(config.port, "127.0.0.1", (err?: Error) => {
  if (err) {
    console.error(`Gagal menjalankan server di port ${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Equilibre server: http://localhost:${config.port}`);
});
