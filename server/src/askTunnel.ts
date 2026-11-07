// Ask Equi from the online demo while the server and Langflow run on the VPS (NOTES D-98): a reverse SSH tunnel
// from this laptop, so the VPS's 127.0.0.1:<ASK_TUNNEL_PORT> reaches this laptop's tunnel door (PUBLIC_PORT, opened
// by `npm start` when PROXY_SECRET is set). The VPS's .env sets ASK_FORWARD_URL=http://127.0.0.1:<ASK_TUNNEL_PORT>
// and the same PROXY_SECRET. Only the SSH alias is used (VPS_SSH_HOST, ~/.ssh/config); nothing secret is printed.
// Usage (from equilibre/, with the server running):  npm --prefix server run ask-tunnel   (Ctrl+C closes it)
import { spawn } from "node:child_process";
import { config } from "./config.ts";
import { PROXY_SECRET_MIN } from "./limits.ts";

if (config.proxySecret.length < PROXY_SECRET_MIN) {
  console.error(`PROXY_SECRET di .env kosong atau kurang dari ${PROXY_SECRET_MIN} karakter: pintu tunnel laptop tidak dibuka.`);
  process.exit(1);
}

// The door must be up and refuse requests without the secret, as for the ngrok tunnel (tunnel.ts).
const door = await fetch(`http://127.0.0.1:${config.publicPort}/api/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
if (!door) {
  console.error(`Belum ada server di port ${config.publicPort}. Jalankan dulu: npm --prefix server start`);
  process.exit(1);
}
if (door.status !== 403) {
  console.error(`Port ${config.publicPort} menjawab ${door.status} tanpa rahasia (seharusnya 403). Cek PUBLIC_PORT.`);
  process.exit(1);
}

const remote = `127.0.0.1:${config.askTunnelPort}:127.0.0.1:${config.publicPort}`;
console.log(`Tunnel Ask: ${config.vpsSshHost} 127.0.0.1:${config.askTunnelPort} → laptop 127.0.0.1:${config.publicPort} (Ctrl+C untuk menutup)`);
const child = spawn(
  "ssh",
  ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3", "-R", remote, config.vpsSshHost],
  { stdio: ["ignore", "inherit", "inherit"], windowsHide: true },
);
child.on("error", (err) => {
  console.error(`ssh tidak bisa dijalankan: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
