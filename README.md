# Equilibre

Equilibre adalah web app pendamping kerja yang membantu pekerja di depan komputer mengenali tanda kelelahan sebelum berubah menjadi stres dan burnout. MediaPipe Face Landmarker berjalan langsung di browser untuk membaca indikator mata dan wajah (kedip, PERCLOS, menguap, posisi kepala), dan MediaPipe Image Segmenter (model selfie) mendeteksi apakah tubuh masih di depan kamera saat wajah tidak terlihat. **Video dan data wajah tidak pernah keluar dari perangkat.** Yang dikirim ke server hanya label dan angka ringkasan. Flow Langflow menyusun rekomendasi relief berbasis bukti dalam Bahasa Indonesia, dan IBM Bob menjadi agen percakapan "Tanya Equilibre" yang memanggil flow Langflow lewat MCP.

> Status: tahap awal pengembangan (IBM × Hacktiv8 National Hackathon 2026).

## Struktur

| Folder | Isi |
|---|---|
| `web/` | Frontend Vite + TypeScript + `@mediapipe/tasks-vision` |
| `server/` | Backend perantara Node.js + Express. Menyimpan API key Langflow supaya tidak pernah sampai ke browser |
| `langflow-flows/` | Ekspor JSON flow Langflow (tanpa API key) |

## Menjalankan (development)

Prasyarat: Node.js 20+, Langflow berjalan di `http://127.0.0.1:7860`.

```bash
cp .env.example .env          # isi LANGFLOW_API_KEY dan LANGFLOW_FLOW_ID

cd server && npm install && npm run dev     # http://localhost:8787
cd web && npm install && npm run dev        # http://localhost:5173
```

## Atribusi dataset

Classifier kelelahan Equilibre dilatih dengan **UTA Real-Life Drowsiness Dataset (UTA-RLDD)**, digunakan dengan izin dari pembuatnya:

> Ghoddoosian, R., Galib, M., & Athitsos, V. (2019). *A Realistic Dataset and Baseline Temporal Model for Early Drowsiness Detection*. IEEE/CVF Conference on Computer Vision and Pattern Recognition Workshops (CVPRW).

Situs dataset: https://sites.google.com/view/utarldd/home

## Catatan

Equilibre memberikan **indikator risiko**, bukan diagnosis medis.
