// UTA-RLDD videos → session-log CSVs, through the app's own detectors and pipeline modules
// (plan P04, NOTES D-14). This side decodes each video with ffmpeg into 10 fps JPEG frames
// (rotation tag applied, long side 640 px like the app's 640×480 camera) and serves them to
// extract.html, which runs them through MediaPipe and posts back the CSV. Run with Node's
// built-in type stripping, next to `npm run dev`:
//   node scripts/extract-rldd.ts <dataset dir> <out dir> [--only=01/0,02/10] [--detik=N] [--port=8790]
// then open http://localhost:5173/extract.html?driver=http://127.0.0.1:<port>.
// <dataset dir> holds one folder per participant with 0/5/10 videos (.mov/.MOV/.mp4).
// Existing CSVs in <out dir> are skipped, so an interrupted run resumes. The CSVs have no
// baseline yet (no deliberate eye closure in the videos: plan P04 langkah 2).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { basename, join } from "node:path";

const FPS = 10;
const LONG_SIDE = 640;

const [datasetDir, outDir, ...flags] = process.argv.slice(2);
if (!datasetDir || !outDir) {
  console.error("Pemakaian: node scripts/extract-rldd.ts <folder dataset> <folder keluaran> [--only=01/0,02/10] [--detik=N] [--port=8790]");
  process.exit(1);
}
const flag = (name: string) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = flag("only")?.split(",");
const seconds = flag("detik") === undefined ? null : Number(flag("detik"));
const port = Number(flag("port") ?? 8790);

type Job = { id: string; name: string; participant: string; kelas: string; path: string; out: string; tmp: string };

const suffix = seconds === null ? "" : `_${seconds}s`;
const jobs: Job[] = readdirSync(datasetDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
  .flatMap((participant) =>
    readdirSync(join(datasetDir, participant))
      .map((file) => ({ file, kelas: file.match(/^(0|5|10)\.(mov|mp4)$/i)?.[1] }))
      .filter((v): v is { file: string; kelas: string } => v.kelas !== undefined)
      .sort((a, b) => Number(a.kelas) - Number(b.kelas))
      .map(({ file, kelas }) => {
        const name = `${participant}_${kelas}${suffix}`;
        return {
          id: String(Math.random()).slice(2, 10),
          name,
          participant,
          kelas,
          path: join(datasetDir, participant, file),
          out: join(outDir, `${name}.csv`),
          tmp: join(outDir, ".tmp", name),
        };
      }),
  )
  .filter((j) => !only || only.includes(`${j.participant}/${j.kelas}`))
  .filter((j) => !existsSync(j.out));
mkdirSync(outDir, { recursive: true });
console.log(`${jobs.length} video di antrean (${basename(datasetDir)} → ${outDir})${seconds === null ? "" : `, ${seconds} detik pertama saja`}`);

type Probe = { comments: string[] };

function probe(path: string): Probe {
  const run = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate:stream_side_data=rotation:format=duration", "-of", "json", path],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`ffprobe gagal untuk ${path}: ${run.stderr}`);
  const info = JSON.parse(run.stdout);
  const stream = info.streams?.[0] ?? {};
  const [num, den] = String(stream.avg_frame_rate ?? "0/1").split("/").map(Number);
  const rotation = stream.side_data_list?.find((s: { rotation?: number }) => s.rotation !== undefined)?.rotation ?? 0;
  return {
    comments: [
      `fps_asli=${(num / den).toFixed(2)} durasi_asli=${Number(info.format?.duration).toFixed(1)} ukuran_asli=${stream.width}x${stream.height} rotasi=${rotation}`,
    ],
  };
}

// Decodes one video into <tmp>/000001.jpg… at FPS. ffmpeg applies the rotation tag itself.
function decode(job: Job): Promise<number> {
  rmSync(job.tmp, { recursive: true, force: true });
  mkdirSync(job.tmp, { recursive: true });
  const scale = `scale='if(gt(iw,ih),${LONG_SIDE},-2)':'if(gt(iw,ih),-2,${LONG_SIDE})'`;
  const args = ["-v", "error", "-i", job.path, ...(seconds === null ? [] : ["-t", String(seconds)])];
  args.push("-vf", `fps=${FPS},${scale}`, "-q:v", "2", join(job.tmp, "%06d.jpg"));
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    ff.on("error", reject);
    ff.on("close", (code) =>
      code === 0 ? resolve(readdirSync(job.tmp).filter((f) => f.endsWith(".jpg")).length) : reject(new Error(`ffmpeg ${code}: ${err}`)),
    );
  });
}

type Prepared = { job: Job; frames: number; comments: string[]; decodeMs: number };

async function prepare(job: Job): Promise<Prepared> {
  const t0 = Date.now();
  const { comments } = probe(job.path);
  const frames = await decode(job);
  return {
    job,
    frames,
    decodeMs: Date.now() - t0,
    comments: [
      `sumber=${basename(datasetDir)}/${job.participant}/${basename(job.path)} partisipan=${job.participant} kelas=${job.kelas}`,
      ...comments,
      `ekstraktor=scripts/extract-rldd.ts fps=${FPS} sisi_panjang=${LONG_SIDE}${seconds === null ? "" : ` detik_diambil=${seconds}`}`,
    ],
  };
}

// Decoding runs ahead of the page; a failure surfaces when /job awaits it, not as an unhandled rejection.
function prepareAhead(job: Job): Promise<Prepared> {
  const p = prepare(job);
  p.catch(() => {});
  return p;
}

let queue = 0;
let upcoming: Promise<Prepared> | null = jobs.length > 0 ? prepareAhead(jobs[0]) : null;
const active = new Map<string, Prepared & { startedAt: number }>();
const done: string[] = [];

function send(res: ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const parts = (req.url ?? "").split("?")[0].split("/").filter(Boolean);
    if (req.method === "OPTIONS") return send(res, 204, "");
    if (req.method === "GET" && parts[0] === "job") {
      // A reloaded page asks again while its video is unfinished: hand that one out again from the
      // start instead of skipping it (30 Sep: a reload mid-video lost 02_5 before this).
      const unfinished = [...active.values()][0];
      if (unfinished) {
        unfinished.startedAt = Date.now();
        console.log(`↻ ${unfinished.job.name}: diulang dari awal (halaman meminta tugas baru sebelum selesai)`);
        const { id, name } = unfinished.job;
        return send(res, 200, JSON.stringify({ id, name, frames: unfinished.frames, comments: unfinished.comments }), "application/json");
      }
      if (!upcoming) return send(res, 200, JSON.stringify({ selesai: true }), "application/json");
      const prepared = await upcoming;
      queue++;
      upcoming = queue < jobs.length ? prepareAhead(jobs[queue]) : null; // decode the next one meanwhile
      active.set(prepared.job.id, { ...prepared, startedAt: Date.now() });
      console.log(`▶ ${prepared.job.name}: ${prepared.frames} frame (dekode ${(prepared.decodeMs / 1000).toFixed(0)} dtk)`);
      const { id, name } = prepared.job;
      return send(res, 200, JSON.stringify({ id, name, frames: prepared.frames, comments: prepared.comments }), "application/json");
    }
    if (req.method === "GET" && parts[0] === "frame") {
      const job = active.get(parts[1]);
      const k = Number(parts[2]);
      if (!job || !Number.isInteger(k) || k < 0 || k >= job.frames) return send(res, 404, "tidak ada");
      return send(res, 200, readFileSync(join(job.job.tmp, `${String(k + 1).padStart(6, "0")}.jpg`)), "image/jpeg");
    }
    if (req.method === "POST" && parts[0] === "result") {
      const job = active.get(parts[1]);
      if (!job) return send(res, 404, "tidak ada");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      writeFileSync(job.job.out, Buffer.concat(chunks));
      rmSync(job.job.tmp, { recursive: true, force: true });
      active.delete(job.job.id);
      done.push(job.job.name);
      const wall = (Date.now() - job.startedAt) / 1000;
      const video = job.frames / FPS;
      console.log(`✓ ${job.job.name}: ${video.toFixed(0)} dtk video dalam ${wall.toFixed(0)} dtk (${(video / wall).toFixed(1)}× waktu nyata) → ${job.job.out}`);
      send(res, 200, "ok");
      if (done.length === jobs.length) {
        console.log(`Selesai: ${done.length} CSV.`);
        rmSync(join(outDir, ".tmp"), { recursive: true, force: true });
        server.close();
      }
      return;
    }
    send(res, 404, "tidak ada");
  } catch (err) {
    console.error(err);
    send(res, 500, String(err));
  }
});

if (jobs.length === 0) console.log("Tidak ada yang perlu diekstrak.");
else server.listen(port, "127.0.0.1", () => console.log(`Menunggu extract.html di http://127.0.0.1:${port}`));
