import express, { type ErrorRequestHandler } from "express";
import { config } from "./config.ts";
import { parseFeatures, toFlowInput } from "./features.ts";
import { LangflowError, parseJsonReply, runFlow } from "./langflow.ts";

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
  if (!config.langflowApiKey || !config.langflowFlowId) {
    res.status(503).json({ error: "Server belum dikonfigurasi: isi LANGFLOW_API_KEY dan LANGFLOW_FLOW_ID di .env." });
    return;
  }

  try {
    const text = await runFlow(config.langflowFlowId, JSON.stringify(toFlowInput(parsed.value)));
    res.json({ text, result: parseJsonReply(text) });
  } catch (err) {
    if (err instanceof LangflowError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
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

// Bind to localhost only: this process holds the Langflow API key (and will drive Bob later).
// Express 5 passes listen errors (e.g. EADDRINUSE) to this callback instead of throwing.
app.listen(config.port, "127.0.0.1", (err?: Error) => {
  if (err) {
    console.error(`Gagal menjalankan server di port ${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Equilibre server: http://localhost:${config.port}`);
});
