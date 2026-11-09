# Equilibre

Equilibre adalah web app *wellness and productivity* untuk pekerja kantoran yang membantu mereka mengenali tanda kelelahan sebelum berubah
menjadi stres dan burnout. MediaPipe berjalan langsung di browser untuk membaca indikator mata dan wajah (kedip, PERCLOS,
menguap, posisi kepala) serta keberadaan tubuh di depan kamera. **Video dan data wajah tidak pernah keluar dari perangkat.**
Yang dikirim ke server hanya label, angka ringkasan, dan nama aturan yang terpenuhi. Flow **IBM Langflow** menyusun rekomendasi
jeda berbasis bukti dalam Bahasa Indonesia, dan **IBM Bob** menjadi agen percakapan "Ask Equilibre" yang memanggil flow
Langflow lewat MCP. Kartu **Plan my next hour** memadukan tingkat energi saat ini dengan tugas dari Google Tasks untuk memilih
langkah berikutnya (jalan sebentar, tugas aktif, atau jeda); judul tugas tidak pernah keluar dari laptop. Bila kamera tidak bisa
membaca wajah dengan andal (gelap, silau di kacamata, fps terlalu rendah), app menyatakan **"Can't assess"** beserta cara
memperbaikinya, bukan menebak. Equilibre memberi tahu **pola, bukan diagnosis**: berbeda dari timer seperti Pomodoro, sapaannya
mengikuti tanda di wajahmu terhadap kalibrasi pribadi dan selalu menyebut alasannya. Antarmuka berbahasa Inggris.

**Untuk siapa.** Equilibre gratis bagi pekerja yang seharian di depan laptop untuk mengenali kelelahan dan mengambil jeda, dan
dibayar perusahaan sebagai program kesejahteraan dan K3: pekerja memilih sendiri untuk ikut, wajah dianalisis di perangkat, dan
perusahaan hanya melihat ringkasan kelompok minimal 10 orang. Yang sudah dibangun adalah app untuk pekerja; ringkasan untuk
perusahaan masih rencana (lihat "Langkah lanjut").

> Status: prototipe untuk IBM × Hacktiv8 National Hackathon 2026. Demo online: https://equilibre-orcin.vercel.app. Backend,
> Langflow, dan IBM Bob berjalan di laptop pengembang; demo online menjangkaunya lewat tunnel, jadi saran Langflow, rencana dari
> Langflow, dan Ask Equilibre di demo itu **hanya aktif saat laptop menyala** (saat laptop mati, app menampilkan keadaan offline).
> Backend di server sendiri masih rencana. Status tiap fitur: tabel "Status fitur". Equilibre memberikan **indikator risiko**, bukan
> diagnosis medis.

## Status fitur

Per 8 Nov 2026 (branch `p20-final`). **Aktif** = jalan ujung ke ujung dan teruji · **Dibangun, cek live belum** = kode dan unit test
ada, belum dicoba pada kamera, akun, atau layanan sungguhan · **Rencana** = belum dibangun.

| Fitur | Status | Bukti / yang belum |
|---|---|---|
| Kalibrasi pribadi, 5 label dengan alasan per aturan, jendela PiP, hemat daya | Aktif | replay rekaman, uji pengguna 7 orang ("Testing dan validasi"); alarm palsunya mendorong "Kamera yang jujur" |
| Saran Langflow `analisis_status` (watsonx Mistral Small 3.1, cadangan Gemini 2.5 Flash) | Aktif; online hanya saat laptop menyala | uji LLM 19 skenario; S22 di Tokyo 10,9 detik |
| Ask Equilibre (IBM Bob → MCP → Langflow) | Aktif; online hanya saat laptop menyala | uji tool wajib + 2 prompt injection |
| Skor pola kedip (regresi logistik, UTA-RLDD) | Aktif, hanya ditampilkan di Debug; ikut menentukan label hanya dengan `?label=gabungan` | uji terkunci 6 orang |
| Kamera yang jujur, bagian fps: PERCLOS berbobot waktu, mata terpejam lama terverifikasi, tanda waktu kedip mati di < 8 fps | Dibangun, cek live belum | harness UTA-RLDD 10/7/5/3 fps: alarm palsu 0,0%; uji kamera nyata belum |
| Kamera yang jujur, gerbang kualitas: "Can't assess" (wajah, cahaya, silau, kacamata), "Limited check", "Last assessed N min ago" | Dibangun, cek live belum | unit test saja (CSV UTA-RLDD tidak memuat pose, cahaya, atau kacamata); uji kamera nyata belum |
| Impor Google Tasks (baca saja) | Dibangun, cek live lolos (9 Nov) | akun Google sungguhan di localhost: 24 tugas terbuka dari 1 daftar; Disconnect dan rekaman jaringan belum |
| Centang tugas selesai di Google Tasks ("I finished it", izin tulis bertahap) | Dibangun, cek live belum | unit test (URL + body hanya status, satu PATCH per klik, tugas contoh tidak pernah dikirim, kontrol negatif izin ditolak/403/404); popup izin tulis dan PATCH sungguhan belum dicoba |
| Rubrik tugas di perangkat + fase energi | Dibangun, cek live belum | unit test (58 judul contoh), dicek di browser dengan tugas contoh; belum pada daftar Google Tasks nyata atau dengan kamera menyala |
| Plan my next hour: Task Matcher di browser (rencana offline) | Dibangun, cek live belum | dicek di browser dengan tugas contoh (`?kamera=0&demo=rina`), tanpa kamera |
| Plan my next hour: flow Langflow `rencana_kerja` + watsonx | Dibangun, cek live belum | Task Matcher Python cocok 16/16 kasus dengan versi TS; flow belum pernah dijalankan di Langflow, belum ada panggilan LLM |
| Penjadwal jalan singkat | Dibangun, cek live belum | unit test + cek browser tanpa kamera; pemicu berbasis waktu dengan kamera menyala belum |
| Log keputusan rencana (di perangkat) | Dibangun, cek live belum | upgrade database v1 → v2 dibuktikan di Chrome; "tugas selesai" dengan akun Google nyata belum |
| Judul tugas ikut dikirim (opt-in, disamarkan, hanya watsonx) | Rencana | – |
| Model jendela kamera (regresi logistik 6 fitur vs GBDT dangkal, `web/scripts/rldd-model.ts`) | Diuji offline, tidak dipakai | UTA-RLDD, dikembangkan pada 6 orang (LOSO luar + dalam), konfigurasi dibekukan lalu diuji sekali pada 6 orang lain: **gagal** (5 fps: sensitivitas 0,0% vs rules 17,3%); selisih AUROC GBDT − LR di data pengembangan 0,068, CI 95% [−0,055; 0,232] memuat 0. Label tetap dari rules + gerbang kualitas |
| Ranker XGBoost untuk Task Matcher | Rencana | butuh log keputusan dari pilot, bukan data sintetis |
| Backend + Langflow di server sendiri (AI online tanpa laptop) | Rencana | penerusan Ask ke laptop sudah ditulis, tidak aktif |
| Ringkasan kelompok (≥ 10 orang) untuk perusahaan | Rencana | – |

## Arsitektur

```mermaid
flowchart LR
  subgraph device["Perangkat pengguna (browser)"]
    cam["Webcam"] --> mp["MediaPipe Face Landmarker<br/>+ Image Segmenter"]
    mp --> feat["Fitur jendela 60 detik"]
    mp --> sqi["Gerbang kualitas<br/>(wajah, cahaya, fps, kacamata)"]
    feat --> rules["Rules + baseline pribadi<br/>(kalibrasi)"]
    sqi --> rules
    rules --> label["Label + alasan,<br/>atau Can't assess"]
    feat --> blink["Skor pola kedip<br/>(bawaan: hanya ditampilkan)"]
    blink -. "?label=gabungan" .-> label
    label --> db[("Riwayat + log keputusan<br/>IndexedDB")]
    label --> pip["Jendela PiP"]
    label --> phase["Fase energi<br/>+ jam rawan pribadi"]
    tag["Rubrik tugas<br/>t1..tn: sifat, beban"] --> plan["Plan my next hour<br/>(Task Matcher TS = rencana offline)"]
    phase --> plan
  end
  subgraph laptop["Laptop pengembang (demo online: lewat tunnel, hanya saat laptop menyala)"]
    api["Backend Express<br/>127.0.0.1:8787"]
    api -- "jalur A: /api/analyze" --> fa["Langflow<br/>analisis_status"]
    api -- "jalur B: /api/tanya" --> bob["IBM Bob Shell<br/>(headless)"]
    bob -- "MCP" --> fb["Langflow<br/>cari_panduan · ringkasan_harian"]
    api -- "jalur C: /api/rencana" --> fr["Langflow rencana_kerja<br/>komponen Task Matcher"]
    fa --> kb3[("Knowledge base v3<br/>9 catatan")]
    fb --> kb3
    fr --> kb4[("Knowledge base v4<br/>12 catatan")]
  end
  gt["Google Tasks API<br/>tasks.readonly<br/>(+ tasks saat dicentang)"] -- "judul + tenggat<br/>(hanya ke tab ini)" --> tag
  plan -- "I finished it: id tugas<br/>+ status completed" --> gt
  label -- "label + angka agregat<br/>+ nama aturan" --> api
  ask["Pertanyaan pengguna<br/>+ angka hari ini"] --> api
  plan -- "fase + t1..tn abstrak<br/>(tanpa judul)" --> api
  fa --> llm["watsonx.ai Tokyo<br/>Mistral Small 3.1<br/>(cadangan: Gemini 2.5 Flash)"]
  fb --> llm
  fr --> llm
```

- **Jalur A (rekomendasi):** tombol "Minta saran sekarang" (Dashboard) atau saran otomatis → backend → flow `analisis_status`
  → rekomendasi jeda + alasan + sumber.
- **Jalur B (percakapan):** kotak "Ask Equilibre" di Dashboard → backend menjalankan IBM Bob → Bob memilih salah satu dari dua tool Langflow
  lewat MCP → jawaban + sumber.
- **Jalur C (rencana, dibangun, cek live belum):** tombol "Plan my next hour" → backend `/api/rencana` → flow `rencana_kerja`: komponen
  Task Matcher memilih langkah dan tugas dengan aturan tetap, LLM hanya menulis alasannya dari knowledge base. Tanpa backend, Task Matcher
  yang sama di browser memberi rencana offline (lihat "Plan my next hour").
- Backend menyimpan API key Langflow dan Bob, sehingga browser tidak pernah memegang kunci apa pun.
- **Di mana backend berjalan.** Server Express, Langflow, dan Bob Shell berjalan di laptop pengembang. Demo online menjangkaunya lewat
  tunnel ngrok ("Demo online" di bawah), jadi fitur AI online hanya hidup selama laptop menyala. Backend di server sendiri (VPS) =
  **Rencana**: ditunda karena sewa VPS berakhir; kode penerusan Ask dari server itu ke Bob di laptop sudah ada dan tidak aktif.

### Data yang keluar dari perangkat

| Ke mana | Isi | Penjaga |
|---|---|---|
| `POST /api/analyze` → Langflow | `label`, `skor`, `tanda` (nama aturan; `pola_kedip` hanya dengan `?label=gabungan`), `perclos`, `kedip_per_menit`, `durasi_kedip_ms`, `mata_tertutup_lama`, `menguap`, `pct_kepala_menunduk`, `pct_wajah_hilang`, `menit_sejak_jeda`, `menit_lelah_60` | `server/src/features.ts` menolak field lain dan angka di luar rentang; `tanda` hanya boleh dari daftar tetap |
| `POST /api/tanya` → Bob → Langflow | teks pertanyaan (3–300 karakter), label terakhir, `menit_lelah_60`, dan angka hari ini (menit per label, jumlah jeda, rata-rata KSS) | `server/src/tanya.ts` menolak field lain dan menyamarkan email serta deret ≥ 9 angka (telepon, NIK, rekening) sebelum pertanyaan diteruskan; nama tidak bisa disaring. Kotak Ask menyebutkan apa yang dikirim di bawahnya, dan jawaban memberi tahu bila ada yang disamarkan |
| `POST /api/rencana` → Langflow `rencana_kerja`, **hanya saat tombol Plan ditekan** | `fase` (tingkat energi), `jam_rawan` (ya/tidak), `menit_sejak_jeda`, dan tiap tugas sebagai `{id: "t1"…, sifat, beban, hari_ke_tenggat, posisi}` (maks. 50). **Tanpa judul tugas, catatan, atau nama daftar** | `server/src/rencana.ts` menolak kunci asing di dua tingkat dan `id` selain `"t" + (posisi + 1)`; jawaban LLM ditolak bila menyebut tugas selain yang dipilih Task Matcher, menit selain menit langkahnya, atau tidur (server dan browser); judul ditempelkan kembali di browser |
| Google (`accounts.google.com`, `tasks.googleapis.com`; `oauth2.googleapis.com/revoke` saat Disconnect), hanya setelah pengguna menekan Connect di Settings → Google Tasks | token akses Google (izin `tasks.readonly`) untuk membaca tugas terbuka. Judul dan tanggal tenggat **masuk** ke tab ini dan tidak diteruskan ke mana pun; catatan tugas dibuang. Saat **I finished it** ditekan pada tugas Google: `PATCH` langsung dari browser ke `tasks.googleapis.com`, id daftar + id tugas di URL dan body `{"status":"completed"}` saja, dengan token berizin `tasks` | library Google Identity Services baru dimuat saat Connect; token dan tugas hanya di memori (hilang saat tab ditutup); hanya jenis tugas yang dikonfirmasi pengguna yang disimpan, di perangkat. Izin tulis diminta bertahap (`include_granted_scopes`) hanya di klik "I finished it", tidak pernah saat Connect atau otomatis; tugas contoh demo tidak pernah dikirim (`googleTasks.test.ts`, `tasksPanel.test.ts`, `planPanel.test.ts`) |
| Google Sheet pengembang, **hanya mode uji `?kode=`** setelah penguji setuju dan menekan Kirim | riwayat jendela uji (label + angka payload per evaluasi, sebab label ditahan, KSS, koreksi label, jeda), 4 angka baseline kalibrasi, jenis browser/OS, resolusi kamera, fps rata-rata, isian awal, feedback, kode uji; log keputusan rencana tidak ikut | whitelist field di `web/src/userTest.ts` (dites); penerima menolak kode yang tidak terdaftar (`uji-pengguna/Code.gs`); data dihapus paling lambat 30 Nov 2026 (gelombang pertama: 31 Okt), sesuai layar persetujuan |
| Google (`odml.pa.googleapis.com`), dari library MediaPipe Tasks tiap 60 detik per task | **diblokir.** Metrik kinerja dan pemakaian MediaPipe: jenis task, mode, keluarga OS, versi library, waktu muat, jumlah dan lama inferensi (88–103 byte per kiriman, diukur 29 Okt); tanpa video, gambar, landmark, atau label. MediaPipe tidak punya opsi untuk mematikannya ([Privacy Notice](https://github.com/google-ai-edge/mediapipe#privacy-notice)) | `Content-Security-Policy` `connect-src` di ketiga halaman (`index.html`, `auth.html`, `app.html`) hanya mengizinkan origin sendiri, penerima uji Apps Script, Supabase Auth, serta Google Identity Services (`accounts.google.com/gsi/`) dan Tasks API (`web/src/csp.test.ts`, dengan kontrol negatif) |
| Supabase Auth (`https://<project>.supabase.co`), saat daftar dan masuk | nama, email, password (disimpan Supabase sebagai hash); Supabase juga mencatat waktu masuk, alamat IP, dan browser di log-nya. Masuk dengan Google: browser pindah ke Google, lalu Google memberi Supabase nama, email, dan tautan foto profil (tanpa password). Halaman akun juga bertanya sekali ke `/auth/v1/settings` (tanpa data pribadi) apakah Google aktif | tidak ada tabel data: riwayat, label, dan baseline tidak pernah dikirim ke Supabase; link uji `?kode=` tidak memakai akun |
| tidak pernah | video, gambar, landmark wajah, EAR per frame, skor pola kedip; judul tugas, catatan tugas, nama daftar; log keputusan rencana; baseline kalibrasi dan riwayat di luar mode uji | diproses dan disimpan hanya di browser, terpisah per akun di laptop yang sama |

Tabel ini merinci kartu "What leaves this laptop" di Settings. Penjaga di browser berlaku untuk semua host, jadi library yang
ditambah kemudian pun tidak bisa mengirim ke tempat lain. Diukur 29 Okt dengan Chrome headless dan kamera palsu berwajah selama 150
detik: tanpa CSP, 4 POST ke `odml.pa.googleapis.com` dijawab HTTP 200 pada detik 60 dan 120; dengan CSP, 0 terkirim, 2 ditolak pada
detik 60, lalu logger MediaPipe berhenti sendiri, dan label tetap berjalan (9,2 fps). Dua host Google Tasks ditambahkan 8 Nov; rekaman
jaringan dengan akun Google sungguhan belum dibuat.

## Deteksi di browser

**Kalibrasi (sekali, ±5 menit).** Tahap 1: pejamkan mata sampai terdengar bunyi (EAR mata terpejam). Tahap 2: bekerja seperti
biasa selama 5 menit (EAR terbuka, kedip per menit, durasi kedip, sudut kepala, bukaan mulut, luas tubuh, dan statistik
kedipan). Hasilnya jadi **baseline pribadi** di `localStorage`, jadi setiap batas dinilai terhadap orang itu sendiri.

**Fitur tiap jendela 60 detik, dievaluasi tiap 10 detik** (`web/src/features.ts`, `blink.ts`, `yawn.ts`, `body.ts`):

- PERCLOS: porsi **waktu** dengan mata tertutup (EAR di bawah 8% rentang terbuka–terpejam); kedip pendek < 500 ms tidak dihitung.
  Tiap frame dihitung sepanjang jarak ke frame berikutnya, dan jarak > 500 ms (tab sibuk, frame macet) dihitung seperti jarak biasa,
  supaya fps yang turun-naik tidak menggeser angkanya.
  Untuk batas mata tertutup (PERCLOS dan konfirmasi pejaman ≥ 1 detik), EAR terpejam hasil kalibrasi dipakai paling tinggi 15% EAR
  terbuka: dua penguji berkacamata terkalibrasi di 50–56%, sehingga mata yang menyipit terbaca tertutup. Batas atas itu tidak pernah
  di bawah EAR 0,032, karena mata terpejam tetap terbaca ±0,02–0,035. Tanpa lantai ini, kalibrasi sambil menyipit di tahap kerja
  (EAR terbuka 0,107) menaruh kedua batas di bawah mata yang benar-benar terpejam.
- Kedip per menit dan durasi kedip rata-rata, **hanya pada ≥ 8 fps**: di bawahnya satu kedip hanya 1–2 frame, sehingga durasinya
  terbaca sebagai jarak frame (di 5 fps kedip terpendek tercatat 200 ms) dan menghasilkan "kedipan lambat" palsu.
- Mata terpejam ≥ 1 detik dihitung terpisah. Penutupan yang terpotong jeda frame tidak lagi dibuang, tetapi dihitung dari sampel
  yang benar-benar terlihat (batas bawah); di < 8 fps batas bawah itu harus ≥ 1 detik dengan sebagian besar frame di bawah ambang
  konfirmasi, supaya dua kedipan berurutan tidak menyatu menjadi satu penutupan lama.
- Menguap: `jawOpen` ≥ 0,5 selama ≥ 1,5 detik.
- Kepala menunduk ≤ −15° dari sudut kalibrasi: mata tidak dinilai (kelopak ikut turun saat melihat HP/dokumen), hanya dicatat.
- Tubuh (MediaPipe Image Segmenter, 2×/detik): mask diringkas jadi luas dan gerak, lalu langsung dibuang.

**Aturan → label** (`web/src/rules.ts`, satu kalimat alasan per aturan, lengkap dengan angka dan batasnya):

| Tanda | Kondisi |
|---|---|
| `mata_sering_tertutup` | PERCLOS ≥ 8% (≥ 15% langsung `lelah`) |
| `kedipan_lambat` | durasi kedip rata-rata ≥ 2× baseline (hanya ≥ 8 fps) |
| `menguap` | ≥ 1 kali dalam jendela |
| `mata_terpejam_lama` | ≥ 1 kali mata terpejam 1 detik atau lebih |
| `kedipan_sering` | kedip ≥ 2× baseline, **hanya pendukung** (dihitung kalau sudah ada tanda lain; hanya ≥ 8 fps) |
| `pola_kedip` | hanya dengan `?label=gabungan`: skor pola kedip ≥ 71% saat aturan lain menyatakan `normal` → `lelah ringan` (tidak pernah menaikkan ke `lelah`) |

| Label | Syarat |
|---|---|
| `normal` | tidak ada tanda |
| `lelah ringan` | 1–2 tanda |
| `lelah` | ≥ 3 tanda, atau PERCLOS ≥ 15% |
| `tertidur` | tubuh tetap di depan kamera dan diam, sementara mata terlihat terpejam selama 5 menit, atau tidak terlihat sama sekali selama 10 menit (misalnya kepala di meja) |
| `tidak di depan layar` | wajah tidak terdeteksi ≥ 50% jendela |

- **Hysteresis:** masuk ke label lelah (`lelah ringan`, `lelah`, `tertidur`) butuh 3 evaluasi berturut-turut; pindah antar label
  lelah dan kembali ke `normal` butuh 2. Sapaan "You look tired" di PiP paling sering sekali per 20 menit (`tertidur` dan saran
  istirahat panjang tetap boleh menyela).
- **Label ditahan** saat kamera < 3 fps (tab tersembunyi), saat mata tidak terlihat tapi tubuh masih ada (melihat HP), atau saat
  gerbang kualitas menyatakan jendela tidak bisa dibaca (lihat "Kamera yang jujur"). Yang tampil adalah "Can't assess" beserta alasan
  dan cara memperbaikinya; label terakhir hanya tampil abu-abu sebagai "Last assessed N min ago", dan saran otomatis, kirim otomatis,
  sapaan, serta konteks Ask tidak memakai label basi itu.
- **Saran istirahat panjang:** ≥ 15 menit `lelah`/`tertidur` dalam 60 menit terakhir → saran berhenti, bila perlu minta izin.
- **Jeda** tercatat saat wajah dan tubuh tidak terlihat ≥ 2 menit, atau lewat tombol "Saya sudah jeda".
- **Mode hemat daya:** deteksi 5 fps (bawaan 10 fps), menyala sendiri saat baterai < 20% dan tidak diisi. Di 5 fps app menyatakan
  "Limited check" (tanda waktu kedip mati) dan menawarkan tombol "Turn off power saving".
- **Jendela Picture-in-Picture:** jendela kecil yang selalu di atas, berisi kondisi saat ini (titik warna + nama), alasan
  singkatnya, sapaan saat `lelah`/`tertidur` (duduk tegak, jalan sebentar, cari cahaya siang), serta tombol **Pause** dan
  **Recalibrate** (`pipCompanion.ts`). Selama jendela ini terbuka, deteksi tetap ±10 fps walau tab Equilibre tersembunyi
  (terukur 9,9 fps). Dibuka lewat tombol, ikut terbuka saat klik "Start" kalibrasi, dan di Chrome terbuka sendiri saat
  pindah tab (auto-PiP Media Session, hanya selama kamera aktif); pindah ke aplikasi lain tetap butuh tombol.
- **Pause** mematikan kamera; tidak ada yang dibaca atau disimpan sampai **Resume**. Jendela penilaian dan hitungan sejak jeda
  mulai dari awal sesudahnya.
- **Kalibrasi ulang otomatis:** bila belum ada baseline, atau baseline lebih tua dari 12 jam ⚠️ (cahaya dan posisi duduk
  berubah dalam sehari), layar kalibrasi terbuka sendiri setelah kamera menyala; baseline lama tetap dipakai bila dibatalkan.
- Semua threshold adalah konstanta bernama di modulnya; yang masih nilai awal ditandai ⚠️ di kode.

### Kamera yang jujur: gerbang kualitas dan "Can't assess" (dibangun, uji kamera nyata belum)

Uji pengguna menunjukkan dua jenis salah: alarm palsu pada penguji segar berkacamata, dan kantuk terlewat saat kamera hanya memberi
sedikit frame. Karena itu tiap jendela dinilai dulu apakah wajah bisa dibaca (`web/src/quality.ts`, `light.ts`). FaceLandmarker tidak
memberi skor keyakinan, jadi kualitas diturunkan dari frame itu sendiri:

- **Wajah terbaca:** menghadap layar (|yaw| ≤ 30°, |roll| ≤ 25°, kepala tidak mendongak > 20° dari kalibrasi) dan cukup dekat (jarak
  antar-mata ≥ 35 px di video; app meminta 640×480, dan ukuran yang diberikan kamera dicatat di log sesi).
- **Mata tak terbaca ≠ mata tertutup:** beda EAR kiri–kanan yang besar (satu lensa silau, satu mata tertutup benda) atau ≥ 8% piksel
  di sekitar mata jenuh (silau lensa) membuat mata dianggap tak terbaca, jadi tidak dihitung sebagai tertutup.
- **Kacamata:** bila saat kalibrasi EAR terpejam > 0,3× EAR terbuka (dua penguji berkacamata: 0,50 dan 0,56; tanpa kacamata 0,05–0,15),
  mata tidak bisa diukur andal sampai kalibrasi berikutnya.
- **Cahaya:** kecerahan wajah dibaca sekali per detik dari beberapa piksel video yang langsung dibuang (< 40 dari 255 = terlalu gelap).
  Tanpa wajah, yang dibaca seluruh frame, bukan bagian tengahnya: kepala di atas meja dengan rambut gelap di ruang terang tidak dikira
  "too dark", sehingga `tertidur` tetap bisa muncul. Silau tampil dengan alasannya sendiri, bukan "too dark".
- **Frame berhenti:** bila tidak ada frame selama 10 detik (kamera dipakai app lain, kamera dicabut), jendela dinilai menurut jam dan
  tampil "Can't assess", bukan label lama seolah masih terkini.

| Tingkat | Kapan | Yang dinilai | Yang tampil |
|---|---|---|---|
| Penuh | fps ≥ 8, wajah dan mata terbaca | semua tanda | label |
| Limited check (fps) | fps < 8, misalnya hemat daya | PERCLOS, mata terpejam lama, menguap | label + "Limited check…"; tombol "Turn off power saving" bila hemat daya menyala |
| Limited check (mata) | mata terbaca < 60% waktu, atau kalibrasi tidak bisa membedakan mata terbuka dan terpejam | menguap saja, maks. `lelah ringan` | label + alasannya + satu saran (kalibrasi ulang dengan cahaya dari depan, miringkan kacamata) |
| Can't assess | frame ada < 50% waktu (termasuk frame berhenti), wajah terbaca < 50%, terlalu gelap, atau silau | tidak ada | "Can't assess" + alasan + cara memperbaikinya; label terakhir abu-abu "Last assessed N min ago" |

Pindah tingkat butuh 2 jendela berturut-turut. Semua ambang adalah usulan awal (⚠️) dan belum disetel pada kamera sungguhan; protokol
uji kamera 11 skenario (kacamata, silau, hemat daya, ruangan gelap, kontrol positif mata terpejam, HP, menoleh, bicara/tertawa vs
menguap, kepala di meja di ruang terang, kamera direbut app lain) sudah ditulis dan menunggu dijalankan.

**Ketahanan fps pada UTA-RLDD** (`web/scripts/rldd-robust.ts`): 12 orang, video segar vs mengantuk, rekaman disubsampel ke 10/7/5/3
fps; positif = `lelah ringan` atau lebih; kriteria lulus ditulis sebelum harness dijalankan. Kode lama vs kode sekarang, jam rata:

| fps | Alarm palsu, jendela segar | Orang ditegur palsu ≥ 1× (dari 12) | Kantuk tertangkap, jendela mengantuk |
|---|---|---|---|
| 10 | 0,7% → **0,0%** | 1 → 0 | 24,1% → 22,4% |
| 7 | 1,6% → **0,0%** | 2 → 0 | 30,0% → 12,0% |
| 5 (hemat daya) | 8,9% → **0,0%** | 4 → 0 | 29,5% → 11,2% |
| 3 | 67,8% → **0,0%** | 10 → 0 | 72,5% → 10,6% |

- Dengan jeda frame acak (tiap langkah ±20%, dan jeda 600–900 ms sesudah 2% frame), alarm palsu kode sekarang 1,0% di 10 fps dan
  0,0% di 7/5/3 fps.
  Di 3 fps dengan jeda, app abstain (hanya 1,4% jendela segar dan 2,8% jendela mengantuk dinilai), sedangkan kode lama tetap
  menampilkan label lama: 45,7% jendela segar terbaca lelah+.
- Mata terpejam lama yang terpotong jeda frame tidak lagi hilang: video mengantuk, 10 fps dengan jeda, 7,86 → 12,35 kejadian per jam
  (tanpa jeda: 12,32). Mata terpejam lama palsu di video segar: 0 di kode lama dan kode sekarang, di semua fps.
- Kontrol label diacak (segar ↔ mengantuk ditukar per orang, semua 4.096 pola): selisih rata-rata 0,0% di semua kondisi, jadi alat
  ukurnya tidak membuat pemisahan sendiri.
- **Kriteria recall gagal, dan diterima.** Dari tiga kriteria yang dikunci sebelum harness, dua lulus (alarm palsu 5 fps ≤ 10 fps + 3
  poin; mata terpejam lama palsu tidak naik) dan satu **gagal**: recall 5 fps tidak boleh turun lebih dari 5 poin dari kode lama,
  padahal turun 29,5% → 11,2% (dengan jeda 37,8% → 10,2%). Recall kode lama di fps rendah digelembungkan artefak yang sama dengan
  alarm palsunya: durasi kedip terkuantisasi menyalakan `kedipan_lambat` pada orang segar. Pilihannya 0% alarm palsu dengan recall
  5 fps ±11%; kriteria tidak diubah sesudah hasil terlihat. Varian yang menilai kedip lambat terhadap jarak frame (alarm palsu 5 fps
  3,3%, recall ±19%) = Rencana.
- Pose wajah, cahaya, dan kacamata tidak ada di CSV UTA-RLDD, jadi bagian gerbang itu baru teruji lewat unit test.

### Skor pola kedip (UTA-RLDD)

Halaman Debug menampilkan **skor pola kedip**: peluang bahwa 30 kedipan terakhir mirip pola orang mengantuk.
Fiturnya dari paper UTA-RLDD (durasi, amplitudo, kecepatan membuka mata, frekuensi; dinormalkan terhadap kedipan kalibrasi
orang itu), lalu regresi logistik (`web/src/blinkScore.ts`). Secara bawaan skor ini **hanya informasi**: tidak mengubah label.
Dengan `?label=gabungan` (dalam uji), skor ≥ 71% menaikkan `normal` ke `lelah ringan` dengan tanda `pola_kedip`. Angka skornya
tidak pernah dikirim ke server. Model dilatih pada 10 fps, jadi di bawah 8 fps skor tidak dihitung.

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
| Rules (bawaan app; kode sebelum perbaikan fps) | 0,7% (2/304) | 24,1% (155/643) | 8/12 | 1/12 | 302 / 2 · 488 / 155 |
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
kantuk tertangkap, dengan `lelah ringan` dihitung positif. Angka rules di tabel ini berasal dari kode sebelum perbaikan fps; kode
sekarang di 10 fps: alarm palsu 0,0%, kantuk tertangkap 22,4% (lihat "Kamera yang jujur").

## Langflow: empat flow

Ekspor JSON ada di `langflow-flows/` (tanpa API key). Tiga flow pertama memakai pola yang sama: **Chat Input → Prompt Template (+
Knowledge → Parser) → Language Model → Chat Output**; `rencana_kerja` menyisipkan komponen kustom Task Matcher sesudah Chat Input
(lihat di bawah). LLM: watsonx.ai `mistralai/mistral-small-3-1-24b-instruct-2503` (region Tokyo `jp-tok` sejak 1 Nov 2026,
temperature 0,2, maks. 512 token; uji S22 di Tokyo: 10,9 detik, JSON valid). Embedding knowledge base: Google
`models/gemini-embedding-001`, 1 chunk per catatan: `equilibre_panduan_v3` (9 catatan) untuk dua flow saran dan `equilibre_panduan_v4`
(12 catatan, termasuk 3 catatan rencana) hanya untuk `rencana_kerja`, supaya retrieval dua flow saran yang sudah diuji tidak berubah.
Embedding Gemini dipakai karena Langflow 1.12.2 membuat embedding watsonx lewat region Dallas apa pun region proyeknya, sehingga vektor
e5 tidak bisa dibangun dengan proyek Tokyo.

**Model cadangan: Gemini 2.5 Flash.** Kalau model utama gagal atau jawabannya bukan JSON, server menjalankan flow yang sama
sekali lagi dengan node LLM diganti `gemini-2.5-flash` (tweak per permintaan, maks. 4096 token karena token berpikir Gemini ikut
dihitung sebagai output). Kartu saran menyebut model yang menjawab; server membaca nama model utama dari node LLM flow (tanpa
panggilan LLM). Riwayat: 28 Okt–1 Nov ketiga flow sepenuhnya memakai Gemini karena trial IBM Cloud pengembang berakhir 26 Okt.
Setelan kedua penyedia ada di `langflow-flows/profil.mts`; `node langflow-flows/ganti-model.mts watsonx|gemini` memindahkan
keempat flow (tanpa panggilan LLM).

| Flow | Dipanggil oleh | Input | Output |
|---|---|---|---|
| `analisis_status` | backend, jalur A | JSON fitur + keputusan server (status, durasi jeda, saran istirahat panjang) | JSON `{rekomendasi, alasan, sumber}` |
| `cari_panduan` | IBM Bob lewat MCP | pertanyaan pengguna | jawaban dari knowledge base + sumber, atau "Maaf, panduan Equilibre belum membahas hal itu." |
| `ringkasan_harian` | IBM Bob lewat MCP | angka hari ini dari app | ringkasan kondisi kerja hari ini (tanpa knowledge base) |
| `rencana_kerja` (dibangun, belum pernah dijalankan di Langflow) | backend, jalur C | JSON fase energi + tugas abstrak `t1..tn` | JSON `{langkah[], tugas_id, alasan, sumber}`; server menambah `model` dan `cadangan` |

**`rencana_kerja`:** Chat Input → komponen kustom **Task Matcher** (`langflow-flows/komponen/task_matcher.py`, port dari
`web/src/taskMatcher.ts`; `uji-task-matcher.py`: 16/16 kasus cocok dengan versi TS, 6/6 masukan buruk ditolak) → kueri ke knowledge
base v4 → Parser → Prompt → watsonx → Chat Output. Task Matcher memilih langkah dan tugas; prompt (`prompt-rencana_kerja.txt`) meminta LLM
menjelaskan pilihan itu, bukan memilih sendiri, dan menyebut tugas hanya dengan penanda seperti `t3`. Flow dibangun offline dari
`analisis_status.json` oleh `buat-rencana.mts`, sehingga id node LLM sama dan cadangan Gemini lewat tweak berlaku juga. Cadangan Gemini
boleh di sini hanya karena permintaan ini tidak memuat judul tugas.

**Status diputuskan server, bukan LLM** (`server/src/features.ts`), supaya kata-katanya konsisten dan LLM tidak menilai ulang:

| Label | Status | Jeda | Kueri knowledge base |
|---|---|---|---|
| `normal` | baik | – | istirahat mata saat bekerja lama di depan layar |
| `lelah ringan` | perlu jeda singkat | 5 menit | jeda singkat untuk mengurangi lelah |
| `lelah` | perlu jeda | 10 menit | istirahat dan peregangan |
| `tertidur` | perlu jeda aktif | 10 menit | bergerak, cahaya terang, minum air, udara segar |
| ≥ 15 menit lelah dalam 1 jam | perlu istirahat panjang | – | berhenti, istirahat cukup, cuti |

Label `tidak di depan layar` tidak dikirim. Kalau jawaban model utama gagal atau bukan JSON, flow yang sama dijalankan sekali
lagi dengan model cadangan Gemini 2.5 Flash (lihat di atas).

**Aturan utama prompt `analisis_status`** (`langflow-flows/prompt-analisis_status.txt`): status dan durasi jeda tidak boleh
diubah; kegiatan hanya dari KONTEKS knowledge base; alasan hanya dari daftar `tanda` (tidak menilai angka sendiri, kepala
menunduk bukan tanda lelah); tidak mendiagnosis atau menyebut penyakit; `sumber` = nama file catatan yang benar-benar dipakai;
balasan hanya JSON.

**Knowledge base** (`knowledge/`, 12 catatan): parafrase 9 sumber (WHO, NIOSH, Permenkes 48/2016, Kemenkes Healing119, PLOS ONE,
SLEEP Advances, American Academy of Ophthalmology, Environmental Health Perspectives, Regulation (EU) 432/2012), ditambah 3 catatan
untuk Plan my next hour dari artikel jurnal (jam rawan siang, jalan singkat, tugas aktif vs monoton), masing-masing dengan sitasi,
lisensi, dan batas klaimnya. Klaim yang tidak ada di catatan tidak boleh muncul di rekomendasi; daftarnya di `knowledge/README.md`.

**Saran otomatis** (sakelar "Ask for advice automatically" di Settings, bawaan mati): hanya saat label berubah menjadi `lelah ringan`/`lelah`/`tertidur`
atau saran istirahat panjang muncul, paling sering sekali per 10 menit (`tertidur` dan istirahat panjang boleh menembus sekali,
jadi maksimal 2 panggilan per 10 menit).

## Tanya Equilibre (IBM Bob + Langflow lewat MCP)

Kotak "Ask Equilibre" di Dashboard mengirim pertanyaan ke `POST /api/tanya`. Backend menjalankan IBM Bob Shell secara headless
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

## Plan my next hour (Google Tasks + Task Matcher; dibangun, cek live belum)

Kartu di Dashboard yang menjawab "apa yang sebaiknya kukerjakan sekarang?" dari tingkat energi saat ini dan tugas terbuka. Rencana
hanya dibuat saat tombol **Plan my next hour** ditekan. Prinsipnya dari riset tidur: tugas monoton saat mengantuk berisiko, tugas
aktif menutupi kantuk untuk sementara, dan jeda gerak singkat menaikkan rasa berenergi (kewaspadaan terukur tidak berubah). Bahwa
memilih tugas dari sinyal kantuk mengalahkan aturan gratis "tugas berat dulu" baru hipotesis untuk pilot.

1. **Tugas** (`web/src/googleTasks.ts`, Settings → Google Tasks: Connect / Refresh / Disconnect): token client Google Identity Services
   dengan izin `tasks.readonly`; token dan tugas hanya di memori. Dibaca ≤ 20 daftar dan ≤ 100 tugas terbuka per daftar, dalam urutan
   Google Tasks (subtugas tepat setelah induknya); catatan dibuang, judul dipotong 300 karakter. Tanpa Google, akun demo `?demo=rina`
   memakai 6 tugas contoh berlabel "Sample tasks", yang tidak pernah dicampur dengan Google Tasks. **I finished it** pada tugas Google
   mencentangnya di Google Tasks (`PATCH` status `completed` saja, langsung dari browser). Izin tulis `tasks` diminta bertahap pada klik
   pertama itu; token dari jendela Google baru dipakai setelah `PATCH`-nya berhasil, karena jendela itu bisa berganti akun Google.
2. **Rubrik tugas di perangkat** (`taskTagger.ts`): kata kerja di judul (Inggris + Indonesia) → **sifat** aktif/monoton dan **beban**
   berat/ringan; **tenggat** (hari ini / besok / ≤ 3 hari / lainnya) dari tanggal `due`; **urutan** dari posisi di daftar. Kata kerja
   yang tidak dikenal atau ambigu = "belum dinilai" dan ditanya sekali; jenis tugas yang dipilih rencana bisa diubah kapan saja lewat
   tombol **Kind: … Change** di langkah tugasnya, lalu rencana disusun ulang. Koreksi satu ketukan disimpan di perangkat per tugas dan
   per akun, dan menambah kamus pribadi (kata umum seperti "the" atau "untuk" tidak ikut dipelajari). Server tidak ikut menentukan.
3. **Fase energi** (`phase.ts`): Siap fokus / Biasa / Rendah ringan / Rendah berat / Tidak tahu, dari label, gerbang kualitas, isian
   KSS ≤ 15 menit terakhir, dan jam. **Jam rawan pribadi** = jam dengan porsi lelah tertinggi di riwayat 7 hari (bawaan 13.00–16.00
   bila data < 3 hari). Bila kamera tidak bisa menilai, fasenya "Tidak tahu" dan rencana menyebutnya, bukan menebak.
4. **Task Matcher** (`taskMatcher.ts`; port Python di flow `rencana_kerja`): `skor(t) = 3·cocok(sifat, beban, fase) +
   2·urgensi(tenggat) + 1·urutan(posisi)` ⚠️, seri → urutan pengguna. Rendah ringan atau jam rawan: jalan 5 menit dulu (di jam rawan
   bila ≥ 30 menit tanpa jeda), lalu tugas aktif 25 menit, hindari tugas monoton. `lelah` bertahan atau `tertidur`: jeda aktif 10
   menit dulu, tanpa tugas (tanpa tidur siang, sama dengan flow saran). Hasilnya: langkah, tugas terpilih, dan kode alasan.
5. **Penjelasan:** `/api/rencana` → `rencana_kerja` menulis alasannya dari knowledge base v4 dengan penanda `t3`, lalu browser
   menempelkan judul asli. LLM hanya menulis kalimat, tidak memilih: server dan browser menolak jawaban yang tugas atau urutan jenis
   langkahnya beda dari Task Matcher lokal, dan kalimat yang menyebut tugas lain, menit selain menit langkahnya, atau tidur. Bila
   ditolak, atau tanpa backend, tampil **rencana offline** beserta sebabnya. Kartu menyebut model yang menjawab dan sumbernya, lalu
   bertanya **Fits / Doesn't fit**.
6. **Penjadwal jalan singkat** (`walkScheduler.ts`): saran jalan 5–10 menit dalam 30 menit sebelum jam rawan bila ≥ 30 menit tanpa
   jeda, tiap 30 menit layar terus-menerus selama jam rawan, dan sesudah "I finished it"; paling sering sekali per 30 menit; tidak
   pernah saat "I'm in a meeting" (sakelar di kartu Today). Jeda ≥ 2 menit menjauh dari layar dihitung sebagai jalan.
7. **Log keputusan lokal** (`decisionLog.ts`, store IndexedDB `keputusan`, database versi 2): fitur keputusan seperti dikirim (tanpa
   judul, nama daftar, atau id tugas Google), tugas terpilih + kode alasan, asal rencana (server/offline), "Fits"/"Doesn't fit", label
   30–35 menit sesudahnya, dan apakah tugas tidak lagi terbuka dalam 60 menit. Ikut "Download history (JSON)" dan "Delete all history";
   tidak dikirim. Ini bahan latih ranker XGBoost (**Rencana**), yang baru bermakna setelah ada data pilot, bukan dari data sintetis
   buatan aturan sendiri.

## Riwayat dan umpan balik

Riwayat disimpan di IndexedDB browser, **hanya di perangkat**, selama 30 hari: label tiap 10 detik beserta angka
ringkasannya, jeda, rekomendasi Langflow dan umpan baliknya ("sudah dilakukan" / "tidak relevan"), koreksi label dari
pengguna ("Label ini tidak sesuai"), isian Karolinska Sleepiness Scale (KSS), dan log keputusan Plan my next hour (store
`keputusan`, database versi 2; database versi 1 dinaikkan tanpa kehilangan data, dibuktikan di Chrome). Halaman "Insight" menampilkan
satu hari per tampilan (lihat "Antarmuka"); riwayat bisa diunduh sebagai JSON atau dihapus seluruhnya dari Settings.

## Antarmuka

Tiga halaman (`web/index.html`, `web/auth.html`, `web/app.html`; Vite multi-page). Alurnya: **landing** → **Sign up / Sign in**
→ layar sebelum kamera (kunjungan pertama) → **kalibrasi** bila baseline tidak ada atau basi → **Dashboard**. Link lama
(`/?kode=…`, `/?debug=1`, `/#dashboard`) dialihkan ke `app.html` dengan query yang sama.

| Halaman | Isi |
|---|---|
| **Landing** (`index.html`, `src/landing/`) | "You can't see what your body feels": cara kerja, perbandingan timer vs Equilibre, "What you see vs. what we see" (ilustrasi berubah menjadi titik wajah dan kotak berlabel EAR/Jaw open saat digulir), janji privasi, ajakan mulai. Animasi GSAP + ScrollTrigger; tidak menyalakan kamera |
| **Sign up / Sign in** (`auth.html`, `authPage.ts`) | Supabase Auth email + password atau Google (alur PKCE; tombol muncul hanya bila penyedia Google aktif di project), galat per kode Supabase (`authCopy.ts`), panel "What we keep", tampilan readout sintetis |
| **Dashboard** | Kamera selebar layar dengan sakelar **What we see** (jaring wajah MediaPipe) / **What you see** (kamera biasa), kondisi saat ini, tombol **Pause**, **Recalibrate**, **Picture-in-Picture**; tile "What we see, right now" + grafik EAR 20 detik; **Ask Equilibre**: "Why this state?" dijawab di perangkat dari aturan dan angka, "What should I do?" meminta saran Langflow, pertanyaan bebas ke IBM Bob; ringkasan hari ini dan cek kantuk KSS; status "Can't assess" / "Limited check" dengan cara memperbaikinya; kartu **Plan my next hour** (garis waktu langkah, alasan, sumber, model, "Fits / Doesn't fit", "I finished it"); baris saran jalan singkat + Dismiss; sakelar "I'm in a meeting" di kartu Today |
| **Insights** (`src/insights/`) | Esai pribadi bergaya scrollytelling dari riwayat sendiri (template di perangkat, tanpa LLM) di samping *clustered force layout* (d3-force: tiap gelembung = 15 menit, warna = kondisi, dikelompokkan per kondisi / waktu / hari); heatmap jam × hari; batang harian per kondisi; lalu rincian satu hari (garis tingkat kelelahan, menit per jam, saran hari itu) |
| **Settings** | Akun (Sign out), kalibrasi dan umur baseline, saran otomatis, pengingat cek kantuk, hemat daya, PiP, Google Tasks (Connect / Refresh / Disconnect + pratinjau 8 tugas), apa yang keluar dari laptop ini, unduh/hapus riwayat, mode Debug, batasan Equilibre |
| **Debug** (di menu hanya saat **Debug mode** menyala di Settings atau lewat `?debug=1`) | Kamera dengan 6 titik EAR per mata dan mask tubuh, grafik EAR dengan batas pribadi, tile sinyal per frame, tile cahaya (kecerahan, silau wajah, mata ÷ wajah, silau lensa), fitur jendela, baseline, skor pola kedip, JSON yang dikirim, unduh log CSV |

**Kalibrasi** (`scanEffect.ts`): kamera biasa → begitu wajah pertama terlihat, garis scan menyapu dari atas ke bawah dalam
1 detik dan mengubah tubuh menjadi piksel (mask segmentasi tubuh dalam grid 48 kolom, hanya bagian yang tersambung ke wajah;
bila mask tidak menyentuh wajah, siluet kepala-bahu dari titik wajah menggantikannya; Debug menulis posisi mask vs wajah) → 0,5 detik
kemudian kotak berlabel di mata kiri, mata kanan, dan mulut dengan nilai langsung (EAR, Jaw Open), tetap tampil selama kalibrasi.
Selama progress bar langkah 2 berjalan, tanda "+" yang berpendar (rujukan: Codrops ScanEffect, effect 3) muncul sebagai titik di
puncak kepala lalu menyebar ke bawah sebagai cincin yang makin lebar, dengan easing `cubic-bezier(0.4, 0, 0.2, 1)` yang melambat di
akhir (3,2 detik per cincin, jeda 0,3 detik, berulang), hanya di blok piksel tubuh; di tepi cincin tanda "+" pecah menjadi potongan.
Pembukaan dan cincin digambar tiap frame layar, sisanya hanya pada frame detektor.

**Gaya visual "The Readout"** (hasil riset brand-fit, `src/design/tokens.css`): kertas `#F3F2ED` dan tinta `#121518`; warna
hanya untuk kondisi tubuh (Normal `#1F9D8A`, Mildly tired `#E0A526`, Tired `#E5483B`, Asleep `#6B5BD2`, Away `#9AA1A9`);
IBM Plex Sans untuk antarmuka, Plex Mono untuk setiap angka dan label, Plex Serif italic untuk satu kata aksen; sudut 4px, garis
1px, tanpa bayangan. Semua font disajikan dari situs sendiri, jadi app tidak menghubungi layanan font pihak ketiga.

## Menjalankan (development)

Prasyarat: Node.js 22.18+ (skrip `.ts` dijalankan langsung dengan type stripping bawaan Node), Langflow 1.12 di
`http://127.0.0.1:7860` dengan flow `analisis_status`, `cari_panduan`, dan `ringkasan_harian` diimpor dari `langflow-flows/` dan
kredensial model sebagai Global Variable (watsonx.ai: `WATSONX_APIKEY`, `WATSONX_PROJECT_ID`, `WATSONX_URL`; Google: `GOOGLE_API_KEY`
tipe Credential, untuk embedding knowledge base dan model cadangan), knowledge base `equilibre_panduan_v3`, lalu
`node langflow-flows/ganti-model.mts watsonx`; serta IBM Bob Shell untuk "Tanya Equilibre". Pada Langflow baru:
`node langflow-flows/buat-kb.mjs --versi=v3` membangun v3 dari 9 catatan yang sama (tiga catatan Plan my next hour tidak ikut); tanpa
`--versi` skrip membangun v4 (langkah Plan my next hour di bawah).

```bash
cp .env.example .env          # isi LANGFLOW_API_KEY, LANGFLOW_FLOW_ID, dan BOB_API_KEY (Ask Equilibre);
                              # LANGFLOW_RENCANA_FLOW_ID untuk Plan my next hour (kosong = /api/rencana 503, app memakai rencana offline)
# akun (opsional): web/.env.local berisi VITE_SUPABASE_URL dan VITE_SUPABASE_PUBLISHABLE_KEY; tanpa keduanya app terbuka tanpa akun

cd server && npm install && npm run dev     # http://localhost:8787 (cek: curl 127.0.0.1:8787/api/health)
cd web && npm install && npm run dev        # http://localhost:5173
```

**Plan my next hour: flow `rencana_kerja` dan knowledge base v4 (opsional).** Dengan Langflow menyala, dari folder `equilibre/`:

```bash
node langflow-flows/buat-kb.mjs --pratinjau     # cek pemecahan: 12 catatan, masing-masing 1 chunk; tidak menyimpan apa pun
node langflow-flows/buat-kb.mjs                 # membuat equilibre_panduan_v4 (panggilan embedding saja, tanpa LLM)
node langflow-flows/buat-rencana.mts --unggah   # tutup dulu flow di UI Langflow; mengunggah rencana_kerja.json dengan id-nya sendiri
# .env: LANGFLOW_RENCANA_FLOW_ID=08662df6-d885-4cea-891f-b558071e7c71, lalu restart server
curl -s 127.0.0.1:8787/api/health
node langflow-flows/cek-flow.mjs --penuh        # 4 flow live sama dengan ekspor (tanpa LLM)
node langflow-flows/ganti-model.mts watsonx --cek
```

Urutan ini sudah ditulis tetapi belum pernah dijalankan pada Langflow sungguhan.

**Google Tasks (opsional).** Client ID OAuth Google tipe Web adalah pengenal publik (tampil di halaman mana pun yang memakainya), jadi
ditulis sebagai konstanta `GOOGLE_CLIENT_ID` di `web/src/googleTasks.ts`, bukan di `.env`. Untuk project Google Cloud sendiri: aktifkan
Google Tasks API, buat OAuth client **Web** terpisah dari login Supabase dengan Authorized JavaScript origins `http://localhost:5173`
(dan domain demo), tambahkan test user selama status Testing, lalu ganti konstanta itu. Login Supabase tidak diberi scope Tasks, supaya
login biasa tidak terkena batas test user. Scope yang dipakai: `https://www.googleapis.com/auth/tasks.readonly` saat Connect, dan
`https://www.googleapis.com/auth/tasks` hanya untuk centang tugas; cantumkan keduanya di OAuth consent screen → Data access.

Parameter URL untuk pengembangan dan uji coba:

| Parameter | Fungsi |
|---|---|
| `?calib=30&window=20&tidur=1` | kalibrasi 30 detik, jendela fitur 20 detik, `tertidur` setelah 1 menit (untuk demo) |
| `?debug=1` | overlay titik mata dan mask tubuh di semua tab, plus matriks transformasi wajah di tab Debug; juga menyalakan Mode pengembang (tab Debug di menu, diingat di perangkat ini) |
| `?uji=1` | mode uji pengguna: pengingat isian KSS tiap 15 menit selalu menyala (di luar uji: sakelar di Settings, bawaan mati) |
| `?kode=EQ-XXXX` | uji pengguna jarak jauh: kartu persetujuan → kalibrasi → 60 menit kerja dengan KSS tiap 15 menit → feedback → satu kiriman ke Google Sheet pengembang; riwayat uji di database terpisah (`uji-pengguna/README.md`) |
| `?riwayat=<nama>` | riwayat disimpan di database terpisah, tidak mencampuri riwayat asli |
| `?kamera=0` | halaman tanpa kamera dan model (pemeriksaan otomatis, tangkapan layar riwayat) |
| `?demo=rina` | akun demo tanpa login: riwayat contoh dua minggu milik persona fiktif (app menyebutnya di tiap halaman) dan 6 tugas contoh untuk Plan my next hour; terpisah dari riwayat dan rubrik asli |
| `?label=gabungan` | label dari rules + skor pola kedip (dalam uji): skor ≥ 71% menaikkan `normal` ke `lelah ringan`, tanda `pola_kedip` ikut terkirim; butuh baseline dengan data kedipan |

**Demo online.** `cd web && npm run build:demo` menghasilkan `web/dist/` untuk Vercel. Deteksi, riwayat, Insights, akun, dan jendela
PiP sama persis dengan versi lokal karena semuanya berjalan di browser. Saran Langflow, rencana dari `rencana_kerja`, dan Ask Equilibre
(Bob) butuh backend, Langflow, dan Bob Shell, yang tetap berjalan di laptop pengembang, jadi fitur itu online **hanya selama laptop
menyala**:

```
browser → Vercel Function web/api/proxy.ts → tunnel ngrok (domain tetap) → server :8788 (pintu demo) → Langflow / Bob
```

- Fungsi Vercel menambahkan rahasia bersama (`BACKEND_SECRET` di Vercel = `PROXY_SECRET` di `.env`) dan hash pengunjung. Kunci Langflow,
  watsonx, Gemini, dan Bob tidak pernah ada di Vercel. Server membuka pintu `:8788` hanya kalau `PROXY_SECRET` terisi; permintaan tanpa
  rahasia mendapat 403. Port lokal `:8787` tidak berubah.
- Batas di pintu demo: 40 saran (rencana ikut dihitung di sini) dan 15 pertanyaan per hari (WIB) untuk semua pengunjung, satu
  permintaan per menit per pengunjung. Kirim otomatis tetap mati di demo.
- Halaman demo bertanya `/api/health` dulu (tanpa LLM) dan hanya menawarkan saran/Ask yang bisa dijawab saat itu; saat laptop mati
  muncul keterangan, bukan error, dan Plan my next hour memakai rencana offline tanpa memanggil server.
- **Rencana: backend di VPS.** Supaya fitur AI online hidup tanpa laptop, server + Langflow dirancang pindah ke VPS dengan Bob tetap
  di laptop. Ditunda karena sewa VPS berakhir. Yang sudah ada: penerusan `/api/tanya` dari server itu ke laptop lewat tunnel SSH balik
  (`server/src/forward.ts`, `ASK_FORWARD_URL`, `npm --prefix server run ask-tunnel`), diuji dengan dua server lokal tanpa LLM, dan tidak
  aktif selama `ASK_FORWARD_URL` kosong.
- Menyalakan: `npm --prefix server start` (Langflow sudah jalan), lalu di terminal lain `npm --prefix server run tunnel`. Sekali saja:
  isi `NGROK_DOMAIN` di `.env`, lalu di Vercel isi `BACKEND_URL=https://<domain>` dan `BACKEND_SECRET` (`npm --prefix server run
  tunnel -- --salin-rahasia` menyalinnya ke clipboard tanpa mencetak).

Branch `deploy` adalah penanda rilis untuk hosting dan hanya di-fast-forward dari `main`, tidak pernah berisi kode sendiri.

## Testing dan validasi

| Uji | Hasil |
|---|---|
| Unit test (Vitest) | `npm --prefix web test`: **748 test, 50 file lolos** (9 Nov; rules, fitur, kedip, menguap, kalibrasi, gerbang kualitas, penjaga cahaya, whitelist payload, server `/api/analyze`, `/api/tanya`, dan `/api/rencana`, penerusan Ask, riwayat dan upgrade database, kirim otomatis, sapaan PiP, skor pola kedip, Google Tasks (impor dan centang tugas), rubrik tugas (58 judul contoh), fase energi, Task Matcher, kartu rencana dan penolakan kalimat yang menyimpang, tombol ubah jenis tugas, penjadwal jalan, log keputusan, jam dinding setelah laptop tidur, layar sambutan sebelum kamera, CSP tiga halaman, galat akun, kembali dari Google, linimasa scan kalibrasi, model Insights, landing). Test kunci dicek dengan mutasi: kode dirusak sengaja → test gagal |
| Build dan typecheck | `npm --prefix web run build` ✓, `npm --prefix server run typecheck` ✓ |
| Replay rekaman sesi | Tombol "Unduh log sesi (CSV)" menyimpan angka per frame (tanpa gambar); `cd web && npm run replay -- <csv>` memutarnya lewat pipeline yang sama dengan app. Dipakai untuk menyetel threshold dan membandingkan sebelum/sesudah (`docs/tuning-notes.md`) |
| Skenario demo (replay rekaman pengembang, hasil kode sebelum perubahan kamera 7 Nov) | kerja normal: `lelah` palsu 9 → **0** jendela setelah penyetelan; pura-pura mengantuk → `lelah` (7 jendela); mata terpejam → `tertidur`; kepala di meja dengan wajah tersembunyi → `tertidur`; pergi → `tidak di depan layar`; jaket di kursi tidak pernah jadi `tertidur` (kontrol negatif); HP di pangkuan dan HP setinggi dagu → `normal`; HP setinggi dada → `lelah ringan` (Keterbatasan) |
| Ketahanan fps (UTA-RLDD, 12 orang) | `web/scripts/rldd-robust.ts`, rekaman disubsampel ke 10/7/5/3 fps dengan dan tanpa jeda frame acak: alarm palsu kode sekarang 0,0% di semua fps dengan jam rata (kode lama 0,7 / 1,6 / 8,9 / 67,8%); kantuk tertangkap 10 fps 24,1 → 22,4%, 5 fps 29,5 → 11,2%. Kriteria recall yang dikunci sebelum harness **gagal** dan diterima (rincian di "Kamera yang jujur"). Cek alat ukur: kode lama di 10 fps memberi 1307/1307 jendela identik dengan dataset perbandingan rules sebelumnya |
| Task Matcher Python vs TS | `langflow-flows/uji-task-matcher.py`: 16/16 kasus dari `web/src/taskMatcher.fixtures.json` cocok, 6/6 masukan buruk ditolak; mutasi "besok = ≤ 3 hari" → 13/16 gagal |
| Plan my next hour di browser | Chrome, `?kamera=0&demo=rina`, backend mati: rubrik ditanya sekali dan bertahan setelah reload, rencana offline menyebut sebabnya; dengan balasan server tiruan judul menggantikan `t1` dan lencana model + sumber tampil; 0 permintaan `/api/` dalam 40 detik setelah halaman dimuat, 0 galat konsol. Database riwayat versi 1 berisi data → kode baru → versi 2, data lama utuh |
| Belum diuji | gerbang kualitas dan penjaga cahaya pada kamera nyata (protokol 9 skenario siap); rekaman jaringan Google Tasks dengan akun sungguhan; centang tugas di Google Tasks (popup izin tulis + `PATCH`) dengan akun sungguhan; flow `rencana_kerja` di Langflow dan jawaban LLM-nya; fase energi dan penjadwal jalan dengan kamera menyala |
| Aturan server tanpa LLM | `node langflow-flows/cek-skenario.mts`: **22/22 skenario** lolos + **7/7 kontrol negatif** tertolak (field asing, status salah, skor tidak cocok label, tanda asing, `pola_kedip` bersama tanda aturan) |
| Pemilihan LLM | 19 skenario × 2 model di watsonx (`langflow-flows/uji-llm.mts`, jawaban mentah di `langflow-flows/hasil-uji/`): Mistral Small 3.1 JSON terbaca 19/19, `sumber` di luar konteks 0; Granite 4-h-small JSON rusak 2/19 dan menambah sinyal yang tidak ada. Rubrik 1–5: Mistral 19, Granite 14 → Mistral dipakai |
| Peralihan ke Gemini (28 Okt) | knowledge base v3 vs v2 (`langflow-flows/cek-retrieval.mts`, tanpa LLM): 11 dari 15 catatan 3 teratas per status sama, 3/3 pertanyaan contoh menemukan catatan yang diharapkan di urutan pertama, kueri di luar topik ("resep rendang") skornya lebih buruk dari semua kueri relevan. Lewat `uji-llm.mts` (input dan tweak sama dengan server): 4 skenario `analisis_status` (S01, S13, S15, S22) JSON terbaca 4/4, `sumber` di luar konteks 0, alasan hanya dari `tanda`, 11,8–17,9 detik (batas server 30 detik); 1 pertanyaan `cari_panduan` ("Kenapa mataku perih?") dijawab dari catatan AAO beserta sumbernya dalam 12,8 detik. Lewat server asli (`POST /api/analyze` → Langflow → Gemini, tanpa tweak model): S10 (`lelah`, 3 tanda) dijawab dalam 16,8 detik tanpa cadangan, status dan lama jeda dari server, 3 sumber dari konteks |
| Perbaikan prompt | uji ulang skenario yang sama: saran di luar konteks ("berjalan/minum air" untuk jeda biasa) 9/9 → 0/8; alasan menyebut tanda yang benar 2/9 → 9/9; nama field bocor ke teks 3 → 0 |
| IBM Bob | jawaban tanpa panggilan tool ditolak (dicek dengan Langflow mati); 2 prompt injection ("jalankan `dir C:\`", "buat file halo.txt"): tidak ada perintah dijalankan, workspace tidak berubah; `analisis_status` tidak terlihat oleh Bob walau prompt tidak melarangnya; keluhan di luar knowledge base (pusing, mual) ditolak tanpa sumber |
| Skor pola kedip | uji sekali pada 6 orang baru UTA-RLDD, lalu dibandingkan dengan rules pada 12 orang (dua tabel di "Deteksi di browser"); di app, 16% saat kerja segar dan 80–97% saat pengembang mengantuk dan menguap (satu sesi, anekdot) |
| Uji pengguna | **4 penguji non-tim (7–8 Okt)**, laptop masing-masing lewat demo online (`?kode=`), 7 isian KSS. Penguji B (segar, semua KSS ≤ 4, berkacamata) terbaca `lelah ringan` atau lebih pada **115 dari 282 jendela (40,8%)**: alarm palsu, karena mata "terpejam" B saat kalibrasi hanya turun ke 0,56× mata terbuka. Dari 4 isian KSS ≤ 5, 2 benar `normal` (C, D) dan 2 alarm palsu (keduanya B). Satu-satunya isian KSS ≥ 7 (D, KSS 9) tertangkap sebagai `lelah`, tetapi diisi bersamaan dengan "sudah jeda 5 menit" sehingga diragukan. Feedback median (1–5): sesuai 3,5, mengganggu 1,5, mau memakai 3,5. Batas mata tertutup diperbaiki 10 Okt (lihat "Deteksi di browser") dan belum diuji ulang pada penguji. **Gelombang 2 (31 Okt, 3 penguji baru, sebelum perbaikan fps dan gerbang kualitas):** `lelah ringan`+ saat wajah terlihat A2 19,2% (KSS selalu 3), B2 13,9%, C2 0% dengan 73% evaluasi ditahan karena fps rendah; tidak ada KSS ≥ 7; median "mengganggu" naik 1,5 → 4, dua penguji berhenti sekitar menit ke-30. Total 7 penguji di luar tim. Data sekecil ini dilaporkan sebagai hitungan, bukan persen akurasi |

## Responsible AI

| Prinsip | Implementasi di kode |
|---|---|
| Privasi | Video diproses di perangkat; hanya label, angka agregat, dan nama aturan yang dikirim, dengan whitelist di server (tabel "Data yang keluar"). Judul tugas tetap di laptop: rencana hanya mengirim `t1..tn` dengan sifat, beban, tenggat, dan urutan; token Google hanya di memori. Riwayat dan log keputusan hanya di IndexedDB, bisa diunduh atau dihapus seluruhnya. Log sesi CSV hanya dibuat kalau pengguna menekan tombol unduh |
| Transparansi dan explainability | Tiap label disertai alasan per aturan dengan angka dan batasnya ("Kedipan rata-rata 430 ms, lebih lambat dari biasanya (151 ms; batas 301 ms)"); konteks yang tidak dihitung ditulis sebagai catatan. Saat kamera tidak bisa membaca, app berkata "Can't assess" atau "Limited check" beserta alasan dan cara memperbaikinya, dan label lama ditandai "Last assessed N min ago". Tiap rekomendasi, rencana, dan jawaban Bob menyebut sumber dari knowledge base; kartu saran dan rencana menyebut model yang menjawab. Skor pola kedip diberi keterangan perannya (tampil saja, atau ikut menentukan label di `?label=gabungan`); alasan `pola_kedip` menyebut skor dan batasnya |
| Bukan diagnosis | Prompt melarang diagnosis dan menyebut penyakit; knowledge base hanya berisi panduan jeda dan kerja yang bersumber; keluhan di luar catatan ditolak; landing dan Settings menyatakan Equilibre bukan alat medis dan memberi tahu pola, bukan diagnosis |
| Human oversight | Pengguna yang memutuskan tindakan. Kirim otomatis bawaan mati, dan rencana hanya dibuat saat tombol ditekan. Pengguna bisa mengoreksi label, memberi umpan balik rekomendasi dan rencana ("Fits / Doesn't fit"), mengonfirmasi jenis tugas dengan satu ketukan, membungkam saran jalan dengan "I'm in a meeting", dan mengisi KSS; semuanya tersimpan di perangkat untuk evaluasi |
| Fairness | Setiap batas dinilai terhadap baseline pribadi hasil kalibrasi. UTA-RLDD didominasi pria (±85%) dan threshold disetel dari rekaman pengembang, jadi hasil pada orang lain belum diketahui (lihat Keterbatasan) |
| Regulasi | EU AI Act (Regulation (EU) 2024/1689) Pasal 5(1)(f) melarang AI menyimpulkan emosi di tempat kerja; Recital 18 menegaskan keadaan fisik seperti kelelahan tidak termasuk pengenalan emosi. Equilibre hanya mendeteksi kelelahan dan tidak punya label emosi |
| Keamanan agen | Bob hanya punya 2 tool Langflow lewat MCP, tanpa file/terminal/browser, di workspace terpisah, dengan batas langkah, biaya, dan waktu; pertanyaan dibungkus sebagai data |
| Grounding | Jawaban Bob hanya diteruskan kalau Bob benar-benar memanggil flow; rekomendasi hanya dari catatan knowledge base; status dari server, bukan LLM; tugas dipilih Task Matcher (aturan tetap), LLM hanya menjelaskan, dan browser memakai rencana server hanya bila sama dengan Task Matcher lokal |

## Keterbatasan

- **Threshold disetel dari rekaman satu orang** (pengembang) dan belum diuji pada pengguna lain; nilai yang masih awal ditandai ⚠️
  di kode. Ambang gerbang kualitas dan penjaga cahaya belum disetel pada kamera sama sekali.
- **Rules melewatkan sebagian besar kantuk, dan pernah salah besar pada wajah berkacamata.** Pada 12 orang UTA-RLDD, rules kode
  sekarang menangkap 22,4% jendela mengantuk di 10 fps dan 11,2% di 5 fps (hemat daya), dengan alarm palsu 0,0%: alarm palsu
  ditukar dengan kantuk yang terlewat. Gabungan dengan classifier pola kedip menangkap 65,9% dengan alarm palsu 9,9% (kode sebelum
  perbaikan fps), tetapi baru terpasang di balik `?label=gabungan` dan belum diuji pada pengguna (lihat "Rules, pola kedip, atau
  gabungan?"). Di uji pengguna, penguji segar berkacamata terbaca lelah pada 40,8% jendela; batas mata tertutup dan cek kacamata saat
  kalibrasi sudah ada, tetapi belum diuji ulang pada penguji.
- **HP dipegang setinggi dada** (kepala menunduk ±10–15°) bisa terbaca `lelah ringan` selama ±30 detik: kelopak ikut turun
  mengikuti pandangan sehingga kedipan terbaca lebih lambat (±430 ms, dibanding ±180 ms saat kepala tegak pada orang yang sama).
  HP setinggi dagu atau di pangkuan terbaca `normal`. Dua perbaikan dicoba dan keduanya merusak deteksi yang benar
  (`docs/tuning-notes.md`), jadi threshold dibiarkan.
- Kedipan dangkal < 1 detik masih bisa menaikkan rata-rata durasi kedip saat kerja normal (sisa 2 jendela `lelah ringan` palsu
  di rekaman 23 Sep).
- EAR bergantung pada posisi kamera; kalau kamera dipindah, kalibrasi perlu diulang.
- Tab tersembunyi tanpa pendamping PiP turun ke ±1 fps, sehingga pemantauan dijeda ("Can't assess"). Mode hemat daya melewatkan
  15–21% kedip, dan di 5 fps tanda waktu kedip mati.
- Skor pola kedip: 12 orang, dataset didominasi pria, klasifikasi 3 kelas gagal, tidak dihitung di bawah 8 fps.
- Menguap yang singkat (< 1,5 detik) atau terjadi saat kepala menunduk tidak terhitung.
- Rekomendasi butuh ±12 detik dengan Mistral (median uji LLM; 10–22 detik) atau 12–18 detik dengan Gemini 2.5 Flash (5 panggilan),
  dan kuota penyedia model; "Tanya Equilibre" melayani satu pertanyaan sekaligus.
- Uji pengguna baru 7 orang; satu-satunya isian KSS ≥ 7 diragukan, jadi akurasi terhadap kantuk yang dirasakan belum bisa
  dinyatakan sebagai persen.
- Saran Langflow, rencana dari Langflow, dan Ask Equilibre di demo online hanya jalan saat laptop pengembang menyala (tunnel); di luar
  itu demo online hanya bagian browser.
- **Plan my next hour:** bobot Task Matcher, menit langkah, dan kamus kata kerja adalah usulan awal ⚠️; belum ada bukti bahwa rencana
  dari sinyal kantuk lebih baik daripada aturan gratis "tugas berat dulu". Flow `rencana_kerja` belum pernah dijalankan; impor Google
  Tasks baru dicoba dengan satu akun sungguhan (9 Nov), dan centang tugas di Google Tasks belum. Google Tasks API tidak punya field
  prioritas atau durasi, dan `due` hanya tanggal. Selama
  OAuth Google berstatus Testing, hanya akun yang didaftarkan sebagai test user yang bisa menyambung (maks. 100), dengan layar
  peringatan "unverified app".

## Langkah lanjut

- Uji kamera gerbang kualitas (9 skenario: kacamata, silau, hemat daya, gelap, kontrol positif, HP, menoleh, bicara/tertawa), lalu
  uji pengguna berikutnya (dengan dan tanpa kacamata, cahaya dan kamera berbeda, sesi segar dan rawan kantuk) untuk memutuskan
  penentu label dari hasilnya.
- Menjalankan flow `rencana_kerja` dan centang Google Tasks pada layanan sungguhan; pilot yang membandingkan rencana dari sinyal kantuk
  dengan aturan gratis "tugas berat dulu".
- Ranker XGBoost untuk Task Matcher, dilatih dari log keputusan pilot (bukan data sintetis); judul tugas sebagai sakelar opt-in
  (disamarkan di laptop, pratinjau sebelum kirim, hanya ke watsonx).
- Tren harian dan indikator risiko stres dari riwayat; rujukan ke tenaga kesehatan bila tren tinggi.
- Backend dan Langflow di server sendiri (VPS; rancangan dan penerusan Ask sudah ada) supaya fitur AI online hidup tanpa laptop
  pengembang; akun opsional dengan data agregat.
- Dashboard tim dengan data agregat anonim untuk perusahaan; jeda otomatis saat video call.
- Validasi pada lebih banyak pengguna perempuan dan pengguna Asia Tenggara.

## Struktur repo

| Folder | Isi |
|---|---|
| `web/` | Frontend Vite + TypeScript + `@mediapipe/tasks-vision`; `web/src/` berisi pipeline murni (fitur, rules, kedip, menguap, tubuh, gerbang kualitas, cahaya, skor pola kedip, rubrik tugas, fase energi, Task Matcher, penjadwal jalan) yang dipakai app dan replay; `web/scripts/` berisi replay, skrip UTA-RLDD, dan harness ketahanan fps `rldd-robust.ts` |
| `server/` | Backend perantara Node.js + Express: whitelist payload, keputusan status, pemanggilan Langflow dan Bob, `/api/rencana`, pintu demo dan penerusan Ask. Menyimpan API key supaya tidak pernah sampai ke browser |
| `langflow-flows/` | Ekspor JSON keempat flow (tanpa API key), prompt, komponen kustom Task Matcher (`komponen/`) + `uji-task-matcher.py`, `buat-rencana.mts` (membangun dan mengunggah `rencana_kerja`), `buat-kb.mjs` (knowledge base v4), 22 skenario uji + pengecek, runner uji LLM (`uji-llm.mts`, memanggil LLM hanya dengan `--jalankan`) dan hasilnya, `cek-flow.mjs [--penuh] [--pulihkan]` untuk memastikan flow live sama dengan ekspor (edge, atau dengan `--penuh` seluruh field termasuk `show`; dijalankan sebelum demo), `pasang-prompt.mjs` untuk memasang prompt, `pesan-flow.mjs` untuk membaca teks masuk/keluar flow terakhir |
| `knowledge/` | Knowledge base RAG: 12 catatan parafrase dengan sitasi dan lisensi (v3 = 9 catatan pertama, v4 = semuanya) |
| `docs/` | Catatan penyetelan threshold dari rekaman sesi |
| `uji-pengguna/` | Penerima hasil uji pengguna jarak jauh (Google Apps Script → Google Sheet) dan cara memasangnya |

## Atribusi

Skor pola kedip dilatih dengan **UTA Real-Life Drowsiness Dataset (UTA-RLDD)**, digunakan dengan izin dari pembuatnya. Video
dataset tidak disertakan di repo ini.

> Ghoddoosian, R., Galib, M., & Athitsos, V. (2019). *A Realistic Dataset and Baseline Temporal Model for Early Drowsiness Detection*. IEEE/CVF Conference on Computer Vision and Pattern Recognition Workshops (CVPRW).

Situs dataset: https://sites.google.com/view/utarldd/home

Sumber knowledge base dan lisensinya tercantum di `knowledge/README.md`. Deteksi wajah dan tubuh memakai
[MediaPipe](https://ai.google.dev/edge/mediapipe) (Face Landmarker dan Image Segmenter). Font
[IBM Plex Sans, Mono, Serif](https://github.com/IBM/plex) © IBM Corp., SIL Open Font License 1.1 (`web/public/fonts/OFL.txt`;
Mono dan Serif lewat paket `@fontsource`). Animasi memakai [GSAP](https://gsap.com) (lisensi GSAP "no charge", bebas untuk
pemakaian komersial), visualisasi Insights memakai [d3-force](https://github.com/d3/d3-force) (ISC), dan akun memakai
[supabase-js](https://github.com/supabase/supabase-js) (MIT). Impor tugas memakai Google Identity Services dan Google Tasks API, dimuat
dari Google saat pengguna menekan Connect (tidak disalin ke repo).

## Lisensi

Kode Equilibre dirilis dengan lisensi **BSD 3-Clause** (`LICENSE`). Lisensi itu tidak mencakup bagian milik pihak lain, yang
tetap mengikuti ketentuannya masing-masing:

- koefisien skor pola kedip (`web/src/blinkScore.ts`), dilatih dari UTA-RLDD: pemakaian ulang mengikuti ketentuan dataset;
- `@mediapipe/tasks-vision` (Apache-2.0) beserta model di `web/public/models/`, sesuai model card MediaPipe masing-masing;
- font IBM Plex Sans, Mono, dan Serif (SIL Open Font License 1.1, `web/public/fonts/OFL.txt`);
- `gsap` (lisensi GSAP standar "no charge"), `lenis` (MIT), `d3-force` (ISC), `@supabase/supabase-js` (MIT), sebagai
  dependensi npm, tidak disalin ke repo;
- isi `knowledge/`: parafrase sumber pihak ketiga, lisensi per sumber di `knowledge/README.md`.
