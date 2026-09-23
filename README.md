# Equilibre

Equilibre adalah web app pendamping kerja yang membantu pekerja di depan komputer mengenali tanda kelelahan sebelum berubah menjadi stres dan burnout. MediaPipe Face Landmarker berjalan langsung di browser untuk membaca indikator mata dan wajah (kedip, PERCLOS, menguap, posisi kepala), dan MediaPipe Image Segmenter (model selfie) mendeteksi apakah tubuh masih di depan kamera saat wajah tidak terlihat. **Video dan data wajah tidak pernah keluar dari perangkat.** Yang dikirim ke server hanya label dan angka ringkasan. Flow Langflow menyusun rekomendasi relief berbasis bukti dalam Bahasa Indonesia, dan IBM Bob menjadi agen percakapan "Tanya Equilibre" yang memanggil flow Langflow lewat MCP.

> Status: tahap awal pengembangan (IBM × Hacktiv8 National Hackathon 2026).

## Struktur

| Folder | Isi |
|---|---|
| `web/` | Frontend Vite + TypeScript + `@mediapipe/tasks-vision` |
| `server/` | Backend perantara Node.js + Express. Menyimpan API key Langflow supaya tidak pernah sampai ke browser |
| `langflow-flows/` | Ekspor JSON flow Langflow (tanpa API key), draf prompt, 20 skenario uji + pengeceknya (`node langflow-flows/cek-skenario.mts`) |
| `knowledge/` | Knowledge base RAG: parafrase 9 sumber (WHO, NIOSH, Permenkes 48/2016, Kemenkes, PLOS ONE, SLEEP Advances, AAO, Environ Health Perspect, Regulation (EU) 432/2012) dengan sitasi dan lisensi; daftarnya di `knowledge/README.md` |

## Menjalankan (development)

Prasyarat: Node.js 20+, Langflow berjalan di `http://127.0.0.1:7860`.

```bash
cp .env.example .env          # isi LANGFLOW_API_KEY dan LANGFLOW_FLOW_ID

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

## Riwayat dan umpan balik

Riwayat disimpan di IndexedDB browser, **hanya di perangkat**, selama 30 hari: label tiap 10 detik beserta angka
ringkasannya, jeda (wajah hilang ≥ 2 menit), rekomendasi Langflow dan umpan baliknya ("sudah dilakukan" / "tidak
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
