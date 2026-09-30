# Equilibre

Equilibre adalah web app pendamping kerja yang membantu pekerja di depan komputer mengenali tanda kelelahan sebelum berubah menjadi stres dan burnout. MediaPipe Face Landmarker berjalan langsung di browser untuk membaca indikator mata dan wajah (kedip, PERCLOS, menguap, posisi kepala), dan MediaPipe Image Segmenter (model selfie) mendeteksi apakah tubuh masih di depan kamera saat wajah tidak terlihat. **Video dan data wajah tidak pernah keluar dari perangkat.** Yang dikirim ke server hanya label, angka ringkasan, dan nama aturan yang terpenuhi (misalnya `menguap` atau `kedipan_lambat`), supaya alasan rekomendasi tidak ditebak dari angka; fitur "Tanya Equilibre" menambahkan teks pertanyaan pengguna. Flow Langflow menyusun rekomendasi relief berbasis bukti dalam Bahasa Indonesia, dan IBM Bob menjadi agen percakapan "Tanya Equilibre" yang memanggil flow Langflow lewat MCP.

> Status: tahap awal pengembangan (IBM × Hacktiv8 National Hackathon 2026).

## Struktur

| Folder | Isi |
|---|---|
| `web/` | Frontend Vite + TypeScript + `@mediapipe/tasks-vision` |
| `server/` | Backend perantara Node.js + Express. Menyimpan API key Langflow supaya tidak pernah sampai ke browser |
| `langflow-flows/` | Ekspor JSON flow Langflow `analisis_status`, `cari_panduan`, dan `ringkasan_harian` (tanpa API key), prompt ketiganya, 20 skenario uji + pengeceknya (`node langflow-flows/cek-skenario.mts`), runner uji LLM (`node langflow-flows/uji-llm.mts --model=mistral`, memanggil LLM hanya dengan `--jalankan`) dan hasilnya di `hasil-uji/`, serta `node langflow-flows/cek-flow.mjs [--pulihkan]` untuk memastikan edge flow di Langflow sama dengan ekspor (membuka flow di UI Langflow bisa memutus edge Knowledge), `node langflow-flows/pasang-prompt.mjs <flow> [--cek]` untuk memasang `prompt-<flow>.txt` ke flow live, dan `node langflow-flows/pesan-flow.mjs <flow> [n]` untuk membaca teks masuk/keluar flow terakhir (tanpa memanggil LLM) |
| `knowledge/` | Knowledge base RAG: parafrase 9 sumber (WHO, NIOSH, Permenkes 48/2016, Kemenkes, PLOS ONE, SLEEP Advances, AAO, Environ Health Perspect, Regulation (EU) 432/2012) dengan sitasi dan lisensi; daftarnya di `knowledge/README.md` |

## Menjalankan (development)

Prasyarat: Node.js 20+, Langflow berjalan di `http://127.0.0.1:7860`.

```bash
cp .env.example .env          # isi LANGFLOW_API_KEY, LANGFLOW_FLOW_ID, dan BOB_API_KEY (Tanya Equilibre)

cd server && npm install && npm run dev     # http://localhost:8787
cd web && npm install && npm run dev        # http://localhost:5173
```

Parameter URL untuk pengembangan dan uji coba:

| Parameter | Fungsi |
|---|---|
| `?calib=30&window=20&tidur=1` | kalibrasi 30 detik, jendela fitur 20 detik, `tertidur` setelah 1 menit (untuk demo) |
| `?debug=1` | overlay titik mata dan mask tubuh |
| `?uji=1` | mode uji pengguna: pengingat isian KSS tiap 15 menit |
| `?riwayat=<nama>` | riwayat disimpan di database terpisah, tidak mencampuri riwayat asli |
| `?kamera=0` | halaman tanpa kamera dan model (pemeriksaan otomatis, tangkapan layar riwayat) |

## Tanya Equilibre (IBM Bob + Langflow lewat MCP)

Panel "Tanya Equilibre" mengirim pertanyaan ke `POST /api/tanya`. Backend menjalankan IBM Bob Shell secara headless
(`bob run --format json`) dari folder kerja terpisah (`../bob-workspace/`, berisi konfigurasi MCP ke Langflow). Bob memilih
satu dari dua tool Langflow: `cari_panduan` (tanya-jawab dari knowledge base) atau `ringkasan_harian` (merangkum angka riwayat
hari ini), lalu jawabannya ditampilkan di app beserta sumbernya. `analisis_status` tidak dibuka untuk Bob, karena statusnya
diputuskan server, bukan LLM.

- **Yang dikirim:** teks pertanyaan (3–300 karakter), label terakhir, `menit_lelah_60`, dan angka hari ini (menit per label,
  jumlah jeda, rata-rata KSS). Field lain ditolak server.
- **Pengaman:** hanya tool group `mcp` yang aktif (baca/tulis file, terminal, browser dimatikan), pertanyaan dibungkus sebagai
  data di dalam penanda tetap, `--max-turns 4`, `--max-cost 0.05`, batas waktu 90 detik, satu pertanyaan sekaligus.
- **Jawaban hanya dari flow:** backend mengecek Langflow hidup sebelum menjalankan Bob, dan menolak jawaban Bob yang tidak
  memanggil tool sama sekali (`stats.tool_calls` < 1) atau menulis panggilan tool sebagai teks: tanpa Langflow, Bob mengarang
  saran sendiri. Prompt Bob memintanya menyalin keluaran flow apa adanya. Jawaban "belum membahas hal itu" tidak pernah
  membawa sumber, dan kalimat "belum ada riwayat" dibuang kalau app mengirim angka hari ini.
- **Batas topik:** `cari_panduan` hanya menjawab keluhan yang tertulis di catatan knowledge base; keluhan lain (misalnya pusing
  atau mual) dijawab "Maaf, panduan Equilibre belum membahas hal itu." tanpa sumber.
- **Prasyarat:** Bob Shell 2.0.4 terpasang global lewat npm (atau atur `BOB_JS`), `BOB_API_KEY` di `.env`, dan server MCP
  `equilibre-langflow` di `bob-workspace/.bob/mcp.json` dengan `alwaysAllow: ["cari_panduan", "ringkasan_harian"]` dan
  `disabledTools: ["analisis_status"]`.

## Riwayat dan umpan balik

Riwayat disimpan di IndexedDB browser, **hanya di perangkat**, selama 30 hari: label tiap 10 detik beserta angka
ringkasannya, jeda (wajah dan tubuh tidak terlihat kamera ≥ 2 menit, atau ditandai sendiri lewat tombol "Saya sudah
jeda" kalau jedanya tidak terhitung), rekomendasi Langflow dan umpan baliknya ("sudah dilakukan" / "tidak
relevan"), koreksi label dari pengguna, dan isian Karolinska Sleepiness Scale. Panel "Riwayat" menampilkan satu hari
per tampilan dengan grafik menit per jam, dan bisa diunduh sebagai JSON atau dihapus seluruhnya.
`cd web && npm run replay -- <log.csv> --ringkasan --kirim-otomatis` memutar ulang log sesi dan mencetak ringkasan
harian serta kapan kirim otomatis (toggle di panel Langflow, bawaan mati) akan memanggil Langflow.

## Atribusi dataset

Classifier kelelahan Equilibre dilatih dengan **UTA Real-Life Drowsiness Dataset (UTA-RLDD)**, digunakan dengan izin dari pembuatnya:

> Ghoddoosian, R., Galib, M., & Athitsos, V. (2019). *A Realistic Dataset and Baseline Temporal Model for Early Drowsiness Detection*. IEEE/CVF Conference on Computer Vision and Pattern Recognition Workshops (CVPRW).

Situs dataset: https://sites.google.com/view/utarldd/home

## Catatan

Equilibre memberikan **indikator risiko**, bukan diagnosis medis.

Keterbatasan yang diketahui: melihat HP yang dipegang setinggi dada (kepala menunduk ±10–15°) bisa terbaca `lelah ringan`
selama ±30 detik, karena kelopak ikut turun mengikuti pandangan sehingga kedipan terbaca lebih lambat (±430 ms, dibanding
±180 ms saat kepala tegak pada orang yang sama). HP setinggi dagu atau di pangkuan terbaca `normal`. Ukuran dan dua
perbaikan yang dicoba ada di `docs/tuning-notes.md`.
