import { spawn } from "node:child_process";
import { config } from "./config.ts";
import { LangflowError } from "./reply.ts";
import { BOB_LIMITS, type RunBob } from "./tanya.ts";

// Runs `bob run` headless from the isolated bob-workspace/ (NOTES D-08) and returns its stdout.
// bob.js is started with node directly (G-14: bob.cmd splits arguments with spaces), and stdin is
// ignored: with a pipe left open Bob waits for input until the timeout (G-44).
export const runBob: RunBob = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [config.bobJs, ...args], {
      cwd: config.bobWorkspace,
      env: { ...process.env, BOB_API_KEY: config.bobApiKey },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new LangflowError(`Bob tidak menjawab dalam ${BOB_LIMITS.timeoutMs / 1000} detik.`, 504));
    }, BOB_LIMITS.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new LangflowError(`Bob tidak bisa dijalankan: ${err.message}`, 503));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      // stderr can quote the prompt, so only its last line goes to the log, never to the client.
      else {
        console.error(`[tanya] bob run exit ${code}: ${stderr.trim().split(/\r?\n/).at(-1) ?? ""}`);
        reject(new LangflowError(`Bob berhenti dengan kode ${code}.`, 502));
      }
    });
  });
