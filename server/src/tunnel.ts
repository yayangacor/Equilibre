// Online demo (NOTES D-80): opens the ngrok tunnel from the fixed domain in .env (NGROK_DOMAIN) to the
// server's second listener (PUBLIC_PORT, opened by `npm start` when PROXY_SECRET is set). Vercel's
// BACKEND_URL is https://<NGROK_DOMAIN>. Nothing secret is printed.
// Usage (from equilibre/):
//   npm --prefix server run tunnel                     opens the tunnel (Ctrl+C closes it)
//   npm --prefix server run tunnel -- --salin-rahasia  copies PROXY_SECRET to the clipboard for Vercel
import { spawn, spawnSync } from "node:child_process";
import { config } from "./config.ts";
import { PROXY_SECRET_MIN } from "./limits.ts";

const domain = (process.env.NGROK_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");

if (config.proxySecret.length < PROXY_SECRET_MIN) {
  console.error(`PROXY_SECRET di .env kosong atau kurang dari ${PROXY_SECRET_MIN} karakter.`);
  process.exit(1);
}

if (process.argv.includes("--salin-rahasia")) {
  const copied = spawnSync("clip", { input: config.proxySecret, windowsHide: true });
  if (copied.status !== 0) {
    console.error("Gagal menyalin ke clipboard (perintah clip).");
    process.exit(1);
  }
  console.log("PROXY_SECRET disalin ke clipboard. Tempel di Vercel → Settings → Environment Variables → BACKEND_SECRET.");
  process.exit(0);
}

if (!domain) {
  console.error("NGROK_DOMAIN di .env kosong: klaim domain gratis di dashboard.ngrok.com → Domains, lalu isi tanpa https://.");
  process.exit(1);
}

// Without the server's second listener the tunnel only serves ngrok's error page; say so instead.
const health = await fetch(`http://127.0.0.1:${config.publicPort}/api/health`, { signal: AbortSignal.timeout(3000) }).catch(
  () => null,
);
if (!health) {
  console.warn(`Peringatan: belum ada server di port ${config.publicPort}. Jalankan dulu: npm --prefix server start`);
} else if (health.status !== 403) {
  console.warn(`Peringatan: port ${config.publicPort} menjawab ${health.status} tanpa rahasia (seharusnya 403). Cek PUBLIC_PORT.`);
}

console.log(`Tunnel: https://${domain} → http://127.0.0.1:${config.publicPort} (Ctrl+C untuk menutup)`);
const child = spawn("ngrok", ["http", `127.0.0.1:${config.publicPort}`, "--url", `https://${domain}`, "--log", "stdout"], {
  stdio: ["ignore", "inherit", "inherit"],
  windowsHide: true,
});
child.on("error", (err) => {
  console.error(`ngrok tidak bisa dijalankan: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
