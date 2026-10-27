# Equilibre

Equilibre adalah web app pendamping kerja yang membantu pekerja di depan komputer mengenali tanda kelelahan sebelum berubah
menjadi stres dan burnout. MediaPipe berjalan langsung di browser untuk membaca indikator mata dan wajah (kedip, PERCLOS,
menguap, posisi kepala) serta keberadaan tubuh di depan kamera. **Video dan data wajah tidak pernah keluar dari perangkat.**
Yang dikirim ke server hanya label, angka ringkasan, dan nama aturan yang terpenuhi. Flow **IBM Langflow** menyusun rekomendasi
jeda berbasis bukti dalam Bahasa Indonesia, dan **IBM Bob** menjadi agen percakapan "Tanya Equilibre" yang memanggil flow
Langflow lewat MCP.

**Untuk siapa.** Equilibre gratis bagi pekerja yang seharian di depan laptop untuk mengenali kelelahan dan mengambil jeda, dan
dibayar perusahaan sebagai program kesejahteraan dan K3: pekerja memilih sendiri untuk ikut, wajah dianalisis di perangkat, dan
perusahaan hanya melihat ringkasan kelompok minimal 10 orang. Yang sudah dibangun adalah app untuk pekerja; ringkasan untuk
perusahaan masih rencana (lihat "Langkah lanjut").

> Status: prototipe untuk IBM × Hacktiv8 National Hackathon 2026. Demo online (frontend saja): https://equilibre-orcin.vercel.app;
> versi lengkap dengan Langflow dan IBM Bob berjalan lokal.
> Equilibre memberikan **indikator risiko**, bukan diagnosis medis.

## Arsitektur

```mermaid
flowchart LR
  subgraph device["Perangkat pengguna (browser)"]
    cam["Webcam"] --> mp["MediaPipe Face Landmarker<br/>+ Image Segmenter"]
    mp --> feat["Fitur jendela 60 detik"]
    feat --> rules["Rules + baseline pribadi<br/>(kalibrasi)"]
    rules --> label["Label + alasan"]
    feat --> blink["Skor pola kedip<br/>(bawaan: hanya ditampilkan)"]
    blink -. "?label=gabungan" .-> label
    label --> db[("Riwayat IndexedDB")]
    label --> pip["Pendamping PiP"]
  end
  label -- "label + angka agregat<br/>+ nama aturan" --> api["Backend Express<br/>127.0.0.1:8787"]
  ask["Pertanyaan pengguna<br/>+ angka hari ini"] --> api
  api -- "jalur A: /api/analyze" --> fa["Langflow<br/>analisis_status"]
  api -- "jalur B: /api/tanya" --> bob["IBM Bob Shell<br/>(headless)"]
  bob -- "MCP" --> fb["Langflow<br/>cari_panduan · ringkasan_harian"]
  fa --> kb[("Knowledge base<br/>9 catatan")]
  fb --> kb
  fa --> llm["watsonx.ai<br/>Mistral Small 3.1"]
  fb --> llm
```

- **Jalur A (rekomendasi):** tombol "Minta saran sekarang" (Dashboard) atau saran otomatis → backend → flow `analisis_status`
  → rekomendasi jeda + alasan + sumber.
- **Jalur B (percakapan):** halaman "Tanya" → backend menjalankan IBM Bob → Bob memilih salah satu dari dua tool Langflow
  lewat MCP → jawaban + sumber.
- Backend menyimpan API key Langflow dan Bob, sehingga browser tidak pernah memegang kunci apa pun.

### Data yang keluar dari perangkat

| Ke mana | Isi | Penjaga |
|---|---|---|
| `POST /api/analyze` → Langflow | `label`, `skor`, `tanda` (nama aturan; `pola_kedip` hanya dengan `?label=gabungan`), `perclos`, `kedip_per_menit`, `durasi_kedip_ms`, `mata_tertutup_lama`, `menguap`, `pct_kepala_menunduk`, `pct_wajah_hilang`, `menit_sejak_jeda`, `menit_lelah_60` | `server/src/features.ts` menolak field lain dan angka di luar rentang; `tanda` hanya boleh dari daftar tetap |
| `POST /api/tanya` → Bob → Langflow | teks pertanyaan (3–300 karakter), label terakhir, `menit_lelah_60`, dan angka hari ini (menit per label, jumlah jeda, rata-rata KSS) | `server/src/tanya.ts` menolak field lain dan menyamarkan email serta deret ≥ 9 angka (telepon, NIK, rekening) sebelum pertanyaan diteruskan; nama tidak bisa disaring. Halaman Tanya menyebutkan apa yang dikirim di bawah kotak pertanyaan, dan jawaban memberi tahu bila ada yang disamarkan |
| Google Sheet pengembang, **hanya mode uji `?kode=`** setelah penguji setuju dan menekan Kirim | riwayat jendela uji (label + angka payload per evaluasi, KSS, koreksi label, jeda), 4 angka baseline kalibrasi, jenis browser/OS, resolusi kamera, fps rata-rata, isian awal, feedback, kode uji | whitelist field di `web/src/userTest.ts` (dites); penerima menolak kode yang tidak terdaftar (`uji-pengguna/Code.gs`); data dihapus paling lambat 30 Nov 2026 (gelombang pertama: 31 Okt), sesuai layar persetujuan |
| tidak pernah | video, gambar, landmark wajah, EAR per frame, skor pola kedip; baseline kalibrasi dan riwayat di luar mode uji | diproses dan disimpan hanya di browser |

## Deteksi di browser

**Kalibrasi (sekali, ±5 menit).** Tahap 1: pejamkan mata sampai terdengar bunyi (EAR mata terpejam). Tahap 2: bekerja seperti
biasa selama 5 menit (EAR terbuka, kedip per menit, durasi kedip, sudut kepala, bukaan mulut, luas tubuh, dan statistik
kedipan). Hasilnya jadi **baseline pribadi** di `localStorage`, jadi setiap batas dinilai terhadap orang itu sendiri.

**Fitur tiap jendela 60 detik, dievaluasi tiap 10 detik** (`web/src/features.ts`, `blink.ts`, `yawn.ts`, `body.ts`):

- PERCLOS: porsi frame dengan mata tertutup (EAR di bawah 8% rentang terbuka–terpejam); kedip pendek < 500 ms tidak dihitung.
  Untuk batas mata tertutup (PERCLOS dan konfirmasi pejaman ≥ 1 detik), EAR terpejam hasil kalibrasi dipakai paling tinggi 15% EAR
  terbuka: dua penguji berkacamata terkalibrasi di 50–56%, sehingga mata yang menyipit terbaca tertutup. Batas atas itu tidak pernah
  di bawah EAR 0,032, karena mata terpejam tetap terbaca ±0,02–0,035. Tanpa lantai ini, kalibrasi sambil menyipit di tahap kerja
  (EAR terbuka 0,107) menaruh kedua batas di bawah mata yang benar-benar terpejam.
- Kedip per menit dan durasi kedip rata-rata; mata terpejam ≥ 1 detik dihitung terpisah.
- Menguap: `jawOpen` ≥ 0,5 selama ≥ 1,5 detik.
- Kepala menunduk ≤ −15° dari sudut kalibrasi: mata tidak dinilai (kelopak ikut turun saat melihat HP/dokumen), hanya dicatat.
- Tubuh (MediaPipe Image Segmenter, 2×/detik): mask diringkas jadi luas dan gerak, lalu langsung dibuang.

**Aturan → label** (`web/src/rules.ts`, satu kalimat alasan per aturan, lengkap dengan angka dan batasnya):

| Tanda | Kondisi |
|---|---|
| `mata_sering_tertutup` | PERCLOS ≥ 8% (≥ 15% langsung `lelah`) |
| `kedipan_lambat` | durasi kedip rata-rata ≥ 2× baseline |
| `menguap` | ≥ 1 kali dalam jendela |
| `mata_terpejam_lama` | ≥ 1 kali mata terpejam 1 detik atau lebih |
| `kedipan_sering` | kedip ≥ 2× baseline, **hanya pendukung** (dihitung kalau sudah ada tanda lain) |
| `pola_kedip` | hanya dengan `?label=gabungan`: skor pola kedip ≥ 71% saat aturan lain menyatakan `normal` → `lelah ringan` (tidak pernah menaikkan ke `lelah`) |

| Label | Syarat |
|---|---|
| `normal` | tidak ada tanda |
| `lelah ringan` | 1–2 tanda |
| `lelah` | ≥ 3 tanda, atau PERCLOS ≥ 15% |
| `tertidur` | tubuh tetap di depan kamera dan diam, sementara mata terlihat terpejam selama 5 menit, atau tidak terlihat sama sekali selama 10 menit (misalnya kepala di meja) |
| `tidak di depan layar` | wajah tidak terdeteksi ≥ 50% jendela |

- **Hysteresis:** label baru baru tampil setelah muncul 2 evaluasi berturut-turut.
- **Label ditahan** saat kamera < 3 fps (tab tersembunyi) atau saat mata tidak terlihat tapi tubuh masih ada (melihat HP).
- **Saran istirahat panjang:** ≥ 15 menit `lelah`/`tertidur` dalam 60 menit terakhir → saran berhenti, bila perlu minta izin.
- **Jeda** tercatat saat wajah dan tubuh tidak terlihat ≥ 2 menit, atau lewat tombol "Saya sudah jeda".
- **Mode hemat daya:** deteksi 5 fps (bawaan 10 fps), menyala sendiri saat baterai < 20% dan tidak diisi.
- **Pendamping (Picture-in-Picture):** jendela kecil berisi karakter beruang yang ekspresinya mengikuti label dan menyapa saat
  `lelah`/`tertidur`. Selama jendela ini terbuka, deteksi tetap ±10 fps walau tab Equilibre tersembunyi (terukur 9,9 fps).
  Dibuka lewat tombol atau ikut terbuka saat klik "Mulai" kalibrasi, dan di Chrome terbuka sendiri saat pindah tab (auto-PiP
  Media Session, hanya selama kamera aktif); pindah ke aplikasi lain tetap butuh tombol.
- Semua threshold adalah konstanta bernama di modulnya; yang masih nilai awal ditandai ⚠️ di kode.

### Skor pola kedip (UTA-RLDD)

Halaman Debug menampilkan **skor pola kedip**: peluang bahwa 30 kedipan terakhir mirip pola orang mengantuk.
Fiturnya dari paper UTA-RLDD (durasi, amplitudo, kecepatan membuka mata, frekuensi; dinormalkan terhadap kedipan kalibrasi
orang itu), lalu regresi logistik (`web/src/blinkScore.ts`). Secara bawaan skor ini **hanya informasi**: tidak mengubah label.
Dengan `?label=gabungan` (dalam uji), skor ≥ 71% menaikkan `normal` ke `lelah ringan` dengan tanda `pola_kedip`. Angka skornya
tidak pernah dikirim ke server.

Model dilatih dan diuji pada video UTA-RLDD yang diekstrak dengan pipeline app sendiri (`web/extract.html`,
`web/scripts/rldd-*.ts`). Konfigurasi dikunci sebelum data uji diunduh, lalu diuji **sekali** pada 6 orang yang belum pernah
dilihat:

| Tugas (jendela 60 detik) | Classifier | Tebak kelas mayoritas | Rules Equilibre | Kontrol label acak | Hasil |
|---|---|---|---|---|---|
| segar vs mengantuk (fitur kedipan), 471 jendela | **77,9%**, macro-F1 0,764, 10/12 video | 69,9% (F1 0,411) | 38,0% | 69,9% | lolos |
| 3 kelas (segar / waspada rendah / mengantuk) | 28,2% | 40,6% | 22,1% | 41,7% | gagal, tidak dipakai |

Model yang terpasang dilatih ulang pada 12 orang (leave-one-subject-out 73,5%, 17/24 video).

### Rules, pola kedip, atau gabungan? (12 orang, leave-one-subject-out)

Label di app datang dari rules. Untuk memilih penentu label, tiga kandidat diuji dengan protokol yang dikunci sebelum dijalankan
(`web/scripts/rldd-compare.ts`). Datanya 12 orang UTA-RLDD, video segar vs mengantuk, jendela 60 detik tanpa masa kalibrasi; tiap
orang dinilai oleh model yang tidak pernah melihatnya. Positif = `lelah ringan` atau lebih. Ambang classifier dipilih dari data
latih saja, supaya alarm palsu pada jendela segar ≤ 10%. Kandidat dengan alarm palsu > 10% gugur; dari sisanya dipilih yang
menangkap kantuk terbanyak.

| Kandidat | Alarm palsu (jendela segar) | Kantuk tertangkap (jendela mengantuk) | Orang tertangkap ≥ 1× | Orang ditegur palsu ≥ 1× | Confusion matrix: segar (normal / ditandai) · mengantuk (terlewat / tertangkap) |
|---|---|---|---|---|---|
| Rules (label yang tampil sekarang) | 0,7% (2/304) | 24,1% (155/643) | 8/12 | 1/12 | 302 / 2 · 488 / 155 |
| Classifier pola kedip, ambang 0,66–0,75 | 10,2% (31/304), gugur | 66,9% (430/643) | 10/12 | 6/12 | 273 / 31 · 213 / 430 |
| **Gabungan: rules atau classifier**, ambang 0,66–0,77 | **9,9% (30/304)** | **65,9% (424/643)** | **11/12** | 7/12 | 274 / 30 · 219 / 424 |

Gabungan terpilih menurut aturan itu, tetapi classifier saja gugur hanya karena satu jendela, jadi keduanya praktis setara. Alarm
palsu gabungan menumpuk pada 2 orang (36% dan 53% jendela segarnya); 5 orang tanpa alarm palsu sama sekali. Pada ambang 0,5,
classifier menandai 30,3% jendela segar orang yang belum dikenalnya. Kantuk satu orang tidak tertangkap oleh kandidat mana pun.
**Bawaan app tetap rules.** Gabungan terpasang di balik `?label=gabungan` dengan ambang **0,71**, dari prosedur yang sama dijalankan
sekali pada 12 orang (`rldd-compare.ts --ambang-app`; di luar fold: alarm palsu 9,2%, kantuk tertangkap 65,5%). Gabungan baru jadi
bawaan setelah diuji pada pengguna nyata, karena dataset ini tidak memuat kasus yang membuat rules gagal di uji pengguna
(kacamata, lihat "Testing dan validasi"). Angka rules 38,0%
di tabel sebelumnya adalah akurasi dengan `lelah ringan` di video mengantuk dihitung salah; tabel ini memisahkan alarm palsu dan
kantuk tertangkap, dengan `lelah ringan` dihitung positif.

## Langflow: tiga flow

Ekspor JSON ada di `langflow-flows/` (tanpa API key). Ketiganya memakai pola yang sama: **Chat Input → Prompt Template (+
Knowledge → Parser) → Language Model → Chat Output**. LLM: watsonx.ai `mistralai/mistral-small-3-1-24b-instruct-2503`
(region Dallas, temperature 0,2, maks. 512 token). Embedding knowledge base: watsonx.ai `intfloat/multilingual-e5-large`.

| Flow | Dipanggil oleh | Input | Output |
|---|---|---|---|
| `analisis_status` | backend, jalur A | JSON fitur + keputusan server (status, durasi jeda, saran istirahat panjang) | JSON `{rekomendasi, alasan, sumber}` |
| `cari_panduan` | IBM Bob lewat MCP | pertanyaan pengguna | jawaban dari knowledge base + sumber, atau "Maaf, panduan Equilibre belum membahas hal itu." |
| `ringkasan_harian` | IBM Bob lewat MCP | angka hari ini dari app | ringkasan kondisi kerja hari ini (tanpa knowledge base) |

**Status diputuskan server, bukan LLM** (`server/src/features.ts`), supaya kata-katanya konsisten dan LLM tidak menilai ulang:

| Label | Status | Jeda | Kueri knowledge base |
|---|---|---|---|
| `normal` | baik | – | istirahat mata saat bekerja lama di depan layar |
| `lelah ringan` | perlu jeda singkat | 5 menit | jeda singkat untuk mengurangi lelah |
| `lelah` | perlu jeda | 10 menit | istirahat dan peregangan |
| `tertidur` | perlu jeda aktif | 10 menit | bergerak, cahaya terang, minum air, udara segar |
| ≥ 15 menit lelah dalam 1 jam | perlu istirahat panjang | – | berhenti, istirahat cukup, cuti |

Label `tidak di depan layar` tidak dikirim. Kalau jawaban Mistral gagal atau bukan JSON, flow yang sama dijalankan sekali lagi
dengan model cadangan (Qwen3.8 Flash lewat OpenRouter).

**Aturan utama prompt `analisis_status`** (`langflow-flows/prompt-analisis_status.txt`): status dan durasi jeda tidak boleh
diubah; kegiatan hanya dari KONTEKS knowledge base; alasan hanya dari daftar `tanda` (tidak menilai angka sendiri, kepala
menunduk bukan tanda lelah); tidak mendiagnosis atau menyebut penyakit; `sumber` = nama file catatan yang benar-benar dipakai;
balasan hanya JSON.

**Knowledge base** (`knowledge/`): parafrase 9 sumber (WHO, NIOSH, Permenkes 48/2016, Kemenkes Healing119, PLOS ONE, SLEEP
Advances, American Academy of Ophthalmology, Environmental Health Perspectives, Regulation (EU) 432/2012), masing-masing dengan
sitasi dan lisensi. Klaim yang tidak ada di catatan tidak boleh muncul di rekomendasi; daftarnya di `knowledge/README.md`.

**Saran otomatis** (toggle "Minta saran otomatis" di halaman Privasi & pengaturan, bawaan mati): hanya saat label berubah menjadi `lelah ringan`/`lelah`/`tertidur`
atau saran istirahat panjang muncul, paling sering sekali per 10 menit (`tertidur` dan istirahat panjang boleh menembus sekali,
jadi maksimal 2 panggilan per 10 menit).

## Tanya Equilibre (IBM Bob + Langflow lewat MCP)

Halaman "Tanya" mengirim pertanyaan ke `POST /api/tanya`. Backend menjalankan IBM Bob Shell secara headless
(`bob run --format json`) dari folder kerja terpisah (`../bob-workspace/`, berisi konfigurasi MCP ke Langflow). Bob memilih
satu dari dua tool Langflow: `cari_panduan` (tanya-jawab dari knowledge base) atau `ringkasan_harian` (merangkum angka riwayat
hari ini), lalu jawabannya ditampilkan di app beserta sumbernya. `analisis_status` tidak dibuka untuk Bob, karena statusnya
diputuskan server, bukan LLM.

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
ringkasannya, jeda, rekomendasi Langflow dan umpan baliknya ("sudah dilakukan" / "tidak relevan"), koreksi label dari
pengguna ("Label ini tidak sesuai"), dan isian Karolinska Sleepiness Scale (KSS). Halaman "Insight" menampilkan satu hari per
tampilan (lihat "Antarmuka"); riwayat bisa diunduh sebagai JSON atau dihapus seluruhnya dari halaman Privasi & pengaturan.

## Antarmuka

Satu halaman web dengan lima tab (`web/index.html`, navigasi lewat hash URL di `web/src/router.ts`; alamat lama `#sekarang` dan
`#teknis` tetap membuka Dashboard dan Debug). Detektor membaca satu video terus-menerus: di Dashboard dan Debug video itu tampil
besar di dalam halaman, di tab lain sebagai pratinjau kecil di samping; di layar sempit pratinjau mengambang di pojok dan tab
pindah ke bawah. Istilah yang janggal bila diterjemahkan memakai bahasa Inggris (Dashboard, Insight, Debug, Live view).
Kunjungan pertama dibuka dengan layar sambutan: apa yang tetap di laptop, apa yang dikirim dan kapan, lalu langkah berikutnya.
Browser baru meminta izin kamera setelah tombol "Nyalakan kamera" (`welcome.ts`).

| Tab | Isi |
|---|---|
| **Dashboard** | Label saat ini dalam satu kalimat bersama beruang yang matanya mengikuti label (`statusCopy.ts`, `bear.ts`), dengan "Kenapa label ini?" (kalimat alasan dari aturan dan tombol "Label ini tidak sesuai?"); **Live view**: kamera biasa di samping kamera dengan jaring wajah MediaPipe (garis mata hijau/merah menurut batas kedip pribadi, mulut kuning saat menguap), 6 tile dengan satu kalimat cara membaca, grafik EAR 20 detik (`live.ts`, `liveView.ts`); ringkasan hari ini (menit sejak jeda, waktu dipantau, jumlah jeda, satu batang komposisi label) di samping "Minta saran sekarang" dengan umpan balik; cek kantuk KSS |
| **Insight** | Satu hari: 2–3 kalimat ringkasan dan empat angka (`insight.ts`), waktu per label untuk kelima label, garis tingkat kelelahan (normal 0 … tertidur 3, rata-rata per 1/5/10 menit, putus saat tidak dipantau, jeda diarsir), menit per jam bertumpuk dengan tabelnya, saran hari itu dengan umpan baliknya, dan rincian angka |
| **Tanya** | Percakapan dengan IBM Bob: contoh pertanyaan, gelembung tanya-jawab beserta sumbernya; tiap pertanyaan tetap dijawab sendiri-sendiri |
| **Privasi & pengaturan** | Apa yang keluar dari perangkat, kalibrasi, saran otomatis, pengingat cek kantuk tiap 15 menit, hemat daya, pendamping, unduh/hapus riwayat, mode pengembang, dan batasan Equilibre (bukan alat medis, kalibrasi ulang saat kondisi berubah, HP setinggi dada, tidak menebak emosi) |
| **Debug** (di menu hanya saat **Mode pengembang** menyala di Privasi atau lewat `?debug=1`; `#debug` tetap bisa dibuka langsung, `devMode.ts`) | Kamera besar dengan 6 titik EAR per mata dan mask tubuh, di samping grafik EAR 20 detik dengan batas pribadi dari kalibrasi (`earChart.ts`); tile sinyal per frame, fitur jendela, dan baseline (termasuk EAR terpejam ÷ EAR terbuka), masing-masing dengan satu kalimat cara membaca; skor pola kedip, JSON yang dikirim, unduh log CSV |

Gaya visualnya: peran warna ala Material 3 (surface/container/on-*), indikator status ala IBM Carbon (tiap label punya warna,
bentuk, dan teks: ● normal, ◆ lelah ringan, ▲ lelah, ■ tertidur, ○ tidak di depan layar), panduan grafik Apple HIG, mode terang
dan gelap mengikuti sistem. Warna grafik diperiksa dengan validator palet (buta warna dan kontras). Font IBM Plex Sans disajikan
dari `web/public/fonts/`, jadi app tidak menghubungi layanan font pihak ketiga.

## Menjalankan (development)

Prasyarat: Node.js 22.18+ (skrip `.ts` dijalankan langsung dengan type stripping bawaan Node), Langflow 1.12 di
`http://127.0.0.1:7860` dengan ketiga flow diimpor dari `langflow-flows/` dan kredensial watsonx.ai sebagai Global Variable,
serta IBM Bob Shell untuk "Tanya Equilibre".

```bash
cp .env.example .env          # isi LANGFLOW_API_KEY, LANGFLOW_FLOW_ID, dan BOB_API_KEY (Tanya Equilibre)

cd server && npm install && npm run dev     # http://localhost:8787 (cek: curl 127.0.0.1:8787/api/health)
cd web && npm install && npm run dev        # http://localhost:5173
```

Parameter URL untuk pengembangan dan uji coba:

| Parameter | Fungsi |
|---|---|
| `?calib=30&window=20&tidur=1` | kalibrasi 30 detik, jendela fitur 20 detik, `tertidur` setelah 1 menit (untuk demo) |
| `?debug=1` | overlay titik mata dan mask tubuh di semua tab, plus matriks transformasi wajah di tab Debug; juga menyalakan Mode pengembang (tab Debug di menu, diingat di perangkat ini) |
| `?uji=1` | mode uji pengguna: pengingat isian KSS tiap 15 menit selalu menyala (di luar uji: sakelar di Privasi, bawaan mati) |
| `?kode=EQ-XXXX` | uji pengguna jarak jauh: kartu persetujuan → kalibrasi → 60 menit kerja dengan KSS tiap 15 menit → feedback → satu kiriman ke Google Sheet pengembang; riwayat uji di database terpisah (`uji-pengguna/README.md`) |
| `?riwayat=<nama>` | riwayat disimpan di database terpisah, tidak mencampuri riwayat asli |
| `?kamera=0` | halaman tanpa kamera dan model (pemeriksaan otomatis, tangkapan layar riwayat) |
| `?label=gabungan` | label dari rules + skor pola kedip (dalam uji): skor ≥ 71% menaikkan `normal` ke `lelah ringan`, tanda `pola_kedip` ikut terkirim; butuh baseline dengan data kedipan |

**Demo online (frontend saja).** `cd web && npm run build:demo` menghasilkan `web/dist/` untuk hosting statis tanpa backend.
Deteksi, riwayat, Insight, dan pendamping sama persis dengan versi lokal karena semuanya berjalan di browser. Saran Langflow dan
Tanya Equilibre dinonaktifkan dengan keterangan, karena keduanya butuh backend, Langflow, dan Bob Shell yang berjalan lokal.
Branch `deploy` adalah penanda rilis untuk hosting dan hanya di-fast-forward dari `main`, tidak pernah berisi kode sendiri.

## Testing dan validasi

| Uji | Hasil |
|---|---|
| Unit test (Vitest) | `npm --prefix web test`: **292 test, 24 file lolos** (rules, fitur, kedip, menguap, kalibrasi, whitelist payload, server `/api/analyze` dan `/api/tanya`, riwayat, kirim otomatis, pendamping, skor pola kedip, layar sambutan sebelum kamera). Test kunci dicek dengan mutasi: kode dirusak sengaja → test gagal |
| Build dan typecheck | `npm --prefix web run build` ✓, `npm --prefix server run typecheck` ✓ |
| Replay rekaman sesi | Tombol "Unduh log sesi (CSV)" menyimpan angka per frame (tanpa gambar); `cd web && npm run replay -- <csv>` memutarnya lewat pipeline yang sama dengan app. Dipakai untuk menyetel threshold dan membandingkan sebelum/sesudah (`docs/tuning-notes.md`) |
| Skenario demo (replay rekaman pengembang) | kerja normal: `lelah` palsu 9 → **0** jendela setelah penyetelan; pura-pura mengantuk → `lelah` (7 jendela); mata terpejam → `tertidur`; kepala di meja dengan wajah tersembunyi → `tertidur`; pergi → `tidak di depan layar`; jaket di kursi tidak pernah jadi `tertidur` (kontrol negatif); HP di pangkuan dan HP setinggi dagu → `normal`; HP setinggi dada → `lelah ringan` (Keterbatasan) |
| Aturan server tanpa LLM | `node langflow-flows/cek-skenario.mts`: **22/22 skenario** lolos + **7/7 kontrol negatif** tertolak (field asing, status salah, skor tidak cocok label, tanda asing, `pola_kedip` bersama tanda aturan) |
| Pemilihan LLM | 19 skenario × 2 model di watsonx (`langflow-flows/uji-llm.mts`, jawaban mentah di `langflow-flows/hasil-uji/`): Mistral Small 3.1 JSON terbaca 19/19, `sumber` di luar konteks 0; Granite 4-h-small JSON rusak 2/19 dan menambah sinyal yang tidak ada. Rubrik 1–5: Mistral 19, Granite 14 → Mistral dipakai |
| Perbaikan prompt | uji ulang skenario yang sama: saran di luar konteks ("berjalan/minum air" untuk jeda biasa) 9/9 → 0/8; alasan menyebut tanda yang benar 2/9 → 9/9; nama field bocor ke teks 3 → 0 |
| IBM Bob | jawaban tanpa panggilan tool ditolak (dicek dengan Langflow mati); 2 prompt injection ("jalankan `dir C:\`", "buat file halo.txt"): tidak ada perintah dijalankan, workspace tidak berubah; `analisis_status` tidak terlihat oleh Bob walau prompt tidak melarangnya; keluhan di luar knowledge base (pusing, mual) ditolak tanpa sumber |
| Skor pola kedip | uji sekali pada 6 orang baru UTA-RLDD, lalu dibandingkan dengan rules pada 12 orang (dua tabel di "Deteksi di browser"); di app, 16% saat kerja segar dan 80–97% saat pengembang mengantuk dan menguap (satu sesi, anekdot) |
| Uji pengguna | **4 penguji non-tim (7–8 Okt)**, laptop masing-masing lewat demo online (`?kode=`), 7 isian KSS. Penguji B (segar, semua KSS ≤ 4, berkacamata) terbaca `lelah ringan` atau lebih pada **115 dari 282 jendela (40,8%)**: alarm palsu, karena mata "terpejam" B saat kalibrasi hanya turun ke 0,56× mata terbuka. Dari 4 isian KSS ≤ 5, 2 benar `normal` (C, D) dan 2 alarm palsu (keduanya B). Satu-satunya isian KSS ≥ 7 (D, KSS 9) tertangkap sebagai `lelah`, tetapi diisi bersamaan dengan "sudah jeda 5 menit" sehingga diragukan. Feedback median (1–5): sesuai 3,5, mengganggu 1,5, mau memakai 3,5. Batas mata tertutup diperbaiki 10 Okt (lihat "Deteksi di browser") dan belum diuji ulang pada penguji. Data sekecil ini dilaporkan sebagai hitungan, bukan persen akurasi |

## Responsible AI

| Prinsip | Implementasi di kode |
|---|---|
| Privasi | Video diproses di perangkat; hanya label, angka agregat, dan nama aturan yang dikirim, dengan whitelist di server (tabel "Data yang keluar"). Riwayat hanya di IndexedDB, bisa diunduh atau dihapus seluruhnya. Log sesi CSV hanya dibuat kalau pengguna menekan tombol unduh |
| Transparansi dan explainability | Tiap label disertai alasan per aturan dengan angka dan batasnya ("Kedipan rata-rata 430 ms, lebih lambat dari biasanya (151 ms; batas 301 ms)"); konteks yang tidak dihitung ditulis sebagai catatan. Tiap rekomendasi dan jawaban Bob menyebut sumber dari knowledge base. Skor pola kedip diberi keterangan perannya (tampil saja, atau ikut menentukan label di `?label=gabungan`); alasan `pola_kedip` menyebut skor dan batasnya |
| Bukan diagnosis | Prompt melarang diagnosis dan menyebut penyakit; knowledge base hanya berisi panduan jeda dan kerja yang bersumber; keluhan di luar catatan ditolak; halaman Privasi & pengaturan menyatakan Equilibre bukan alat medis |
| Human oversight | Pengguna yang memutuskan tindakan. Kirim otomatis bawaan mati. Pengguna bisa mengoreksi label, memberi umpan balik rekomendasi, dan mengisi KSS; semuanya tersimpan untuk evaluasi |
| Fairness | Setiap batas dinilai terhadap baseline pribadi hasil kalibrasi. UTA-RLDD didominasi pria (±85%) dan threshold disetel dari rekaman pengembang, jadi hasil pada orang lain belum diketahui (lihat Keterbatasan) |
| Regulasi | EU AI Act (Regulation (EU) 2024/1689) Pasal 5(1)(f) melarang AI menyimpulkan emosi di tempat kerja; Recital 18 menegaskan keadaan fisik seperti kelelahan tidak termasuk pengenalan emosi. Equilibre hanya mendeteksi kelelahan dan tidak punya label emosi |
| Keamanan agen | Bob hanya punya 2 tool Langflow lewat MCP, tanpa file/terminal/browser, di workspace terpisah, dengan batas langkah, biaya, dan waktu; pertanyaan dibungkus sebagai data |
| Grounding | Jawaban Bob hanya diteruskan kalau Bob benar-benar memanggil flow; rekomendasi hanya dari catatan knowledge base; status dari server, bukan LLM |

## Keterbatasan

- **Threshold disetel dari rekaman satu orang** (pengembang) dan belum diuji pada pengguna lain; nilai yang masih awal ditandai ⚠️
  di kode.
- **Rules melewatkan sebagian besar kantuk, dan pernah salah besar pada wajah berkacamata.** Pada 12 orang UTA-RLDD, rules hanya
  menangkap 24,1% jendela mengantuk (alarm palsu 0,7%). Gabungan dengan classifier pola kedip menangkap 65,9% dengan alarm palsu
  9,9%, tetapi baru terpasang di balik `?label=gabungan` dan belum diuji pada pengguna (lihat "Rules, pola kedip, atau
  gabungan?"). Di uji pengguna, penguji segar berkacamata terbaca lelah
  pada 40,8% jendela; batas mata tertutup sudah diperbaiki, tetapi belum diuji ulang pada penguji.
- **HP dipegang setinggi dada** (kepala menunduk ±10–15°) bisa terbaca `lelah ringan` selama ±30 detik: kelopak ikut turun
  mengikuti pandangan sehingga kedipan terbaca lebih lambat (±430 ms, dibanding ±180 ms saat kepala tegak pada orang yang sama).
  HP setinggi dagu atau di pangkuan terbaca `normal`. Dua perbaikan dicoba dan keduanya merusak deteksi yang benar
  (`docs/tuning-notes.md`), jadi threshold dibiarkan.
- Kedipan dangkal < 1 detik masih bisa menaikkan rata-rata durasi kedip saat kerja normal (sisa 2 jendela `lelah ringan` palsu
  di rekaman 23 Sep).
- EAR bergantung pada posisi kamera; kalau kamera dipindah, kalibrasi perlu diulang.
- Tab tersembunyi tanpa pendamping PiP turun ke ±1 fps, sehingga pemantauan dijeda. Mode hemat daya melewatkan 15–21% kedip.
- Skor pola kedip: 12 orang, dataset didominasi pria, klasifikasi 3 kelas gagal, belum diuji di mode hemat daya (5 fps).
- Menguap yang singkat (< 1,5 detik) atau terjadi saat kepala menunduk tidak terhitung.
- Rekomendasi butuh ±12 detik (median uji LLM; 10–22 detik) dan kuota watsonx.ai; "Tanya Equilibre" melayani satu pertanyaan
  sekaligus.
- Uji pengguna baru 4 orang dengan 7 isian KSS (1 isian ≥ 7, diragukan), jadi akurasi terhadap kantuk yang dirasakan belum bisa
  dinyatakan sebagai persen.
- Demo online hanya frontend; saran Langflow dan "Tanya Equilibre" butuh backend lokal dengan Langflow dan Bob Shell.

## Langkah lanjut

- Uji pengguna gelombang kedua (≥ 6 orang baru; dengan dan tanpa kacamata, cahaya dan kamera berbeda, sesi segar dan rawan kantuk),
  lalu memutuskan penentu label dari hasilnya.
- Tren harian dan indikator risiko stres dari riwayat; rujukan ke tenaga kesehatan bila tren tinggi.
- Backend dan Langflow terkelola untuk demo online (frontend statis sudah), akun opsional dengan data agregat.
- Dashboard tim dengan data agregat anonim untuk perusahaan; jeda otomatis saat video call.
- Validasi pada lebih banyak pengguna perempuan dan pengguna Asia Tenggara.

## Struktur repo

| Folder | Isi |
|---|---|
| `web/` | Frontend Vite + TypeScript + `@mediapipe/tasks-vision`; `web/src/` berisi pipeline murni (fitur, rules, kedip, menguap, tubuh, skor pola kedip) yang dipakai app dan replay; `web/scripts/` berisi replay dan skrip UTA-RLDD |
| `server/` | Backend perantara Node.js + Express: whitelist payload, keputusan status, pemanggilan Langflow dan Bob. Menyimpan API key supaya tidak pernah sampai ke browser |
| `langflow-flows/` | Ekspor JSON ketiga flow (tanpa API key), prompt, 21 skenario uji + pengecek, runner uji LLM (`uji-llm.mts`, memanggil LLM hanya dengan `--jalankan`) dan hasilnya, `cek-flow.mjs [--pulihkan]` untuk memastikan edge flow sama dengan ekspor, `pasang-prompt.mjs` untuk memasang prompt, `pesan-flow.mjs` untuk membaca teks masuk/keluar flow terakhir |
| `knowledge/` | Knowledge base RAG: 9 catatan parafrase dengan sitasi dan lisensi |
| `docs/` | Catatan penyetelan threshold dari rekaman sesi |
| `uji-pengguna/` | Penerima hasil uji pengguna jarak jauh (Google Apps Script → Google Sheet) dan cara memasangnya |

## Atribusi

Skor pola kedip dilatih dengan **UTA Real-Life Drowsiness Dataset (UTA-RLDD)**, digunakan dengan izin dari pembuatnya. Video
dataset tidak disertakan di repo ini.

> Ghoddoosian, R., Galib, M., & Athitsos, V. (2019). *A Realistic Dataset and Baseline Temporal Model for Early Drowsiness Detection*. IEEE/CVF Conference on Computer Vision and Pattern Recognition Workshops (CVPRW).

Situs dataset: https://sites.google.com/view/utarldd/home

Sumber knowledge base dan lisensinya tercantum di `knowledge/README.md`. Deteksi wajah dan tubuh memakai
[MediaPipe](https://ai.google.dev/edge/mediapipe) (Face Landmarker dan Image Segmenter). Font
[IBM Plex Sans](https://github.com/IBM/plex) © IBM Corp., SIL Open Font License 1.1 (`web/public/fonts/OFL.txt`).

## Lisensi

Kode Equilibre dirilis dengan lisensi **BSD 3-Clause** (`LICENSE`). Lisensi itu tidak mencakup bagian milik pihak lain, yang
tetap mengikuti ketentuannya masing-masing:

- koefisien skor pola kedip (`web/src/blinkScore.ts`), dilatih dari UTA-RLDD: pemakaian ulang mengikuti ketentuan dataset;
- `@mediapipe/tasks-vision` (Apache-2.0) beserta model di `web/public/models/`, sesuai model card MediaPipe masing-masing;
- font IBM Plex Sans (SIL Open Font License 1.1, `web/public/fonts/OFL.txt`);
- isi `knowledge/`: parafrase sumber pihak ketiga, lisensi per sumber di `knowledge/README.md`.
