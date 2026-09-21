# Catatan tuning threshold

Catatan kerja untuk menyetel threshold rules (`web/src/rules.ts`, `features.ts`, `blink.ts`, `yawn.ts`, `calibration.ts`) dari sesi rekaman sendiri. Semua threshold yang ditandai ⚠️ di kode masih nilai awal.

## Cara memutar ulang sesi

1. Di aplikasi, klik **Unduh log sesi (CSV)**. Isinya angka per frame saja (EAR, jawOpen, pitch, blendshape kedip dan arah pandang, luas dan gerak tubuh), tanpa gambar.
2. Jalankan:

   ```bash
   cd equilibre/web
   npm run replay -- "C:/Users/LEGION 5/Downloads/equilibre-sesi-20260921-140729.csv"
   ```

`scripts/replay.ts` memakai pipeline yang **sama persis** dengan loop live (`Monitor` di `monitor.ts`, yang memanggil `blink`, `yawn`, `features`, `rules`). Jadi setelah threshold di `src/` diubah, cukup jalankan replay lagi untuk melihat efeknya. Hasilnya berupa timeline tiap 10 detik: fps, 6 fitur jendela, label mentah → label tampil (setelah hysteresis), dan alasannya.

CSV sesi **jangan di-commit**, karena berisi data wajah (numerik) milik tester. Pola `equilibre-sesi-*.csv` sudah masuk `.gitignore`.

## Data sesi

| File (di `Downloads`) | Isi | Catatan |
|---|---|---|
| `equilibre-sesi-20260921-134148.csv` | Percobaan kalibrasi yang gagal terus | Sebelum perbaikan `d6f46eb`. `baseline=null`, jadi tidak bisa di-replay, tapi berguna untuk melihat pola mata terpejam |
| `equilibre-sesi-20260921-140729.csv` | Kalibrasi berhasil + skenario "pura-pura mengantuk" (PLAN-2026-09-22 Langkah 6) | `?calib=30&window=20`, kamera sejajar mata |

Baseline sesi 21 Sep 14:01: EAR terbuka 0,243, EAR terpejam 0,033, kedip 25,8/menit, durasi kedip 223 ms, pitch −5,4°, jawOpen P95 0,03.

## Hasil uji "pura-pura mengantuk" (21 Sep)

Keempat label muncul sesuai skenario, dan hysteresis bekerja: evaluasi mentah yang berbeda satu kali tidak mengganti label.

| Waktu | Label tampil | Pemicu |
|---|---|---|
| 14:01–14:02:10 | normal | – |
| 14:02:20 | lelah ringan | kepala menunduk 68% |
| 14:03:20 | lelah | mata tertutup 17–18% + menguap 1× |
| 14:03:41–14:04:02 | lelah ringan | mata tertutup 10–15% |
| 14:05:25–14:06:16 | tidak di depan layar | wajah hilang 96–100% |
| 14:06:36 | normal | – |
| 14:07:06 | lelah ringan (sebentar) | mata tertutup 12,6%, lihat temuan 1 |

Arah pitch sudah dicek user: `pitch relatif` negatif saat menunduk.

## Temuan dan usulan (untuk 23 Sep)

1. **PERCLOS saat normal sudah 4–7%, karena kedip ikut terhitung.** Tester ini sering berkedip (26–48/menit), dan di 10 fps setiap kedip menyumbang 1–2 frame di bawah batas P80. Akibatnya, setelah kembali normal pun PERCLOS sempat 11–13% dan label jadi "lelah ringan" (14:06:56–14:07:06).
   - Opsi A: frame yang termasuk kedip pendek (< ±500 ms) tidak dihitung ke PERCLOS, jadi hanya penutupan yang lebih lama yang masuk.
   - Opsi B: batas `perclosMild` personal, misalnya `max(0,08, 2 × PERCLOS saat kalibrasi tahap B)`. Ini perlu field baru di `Baseline`.
2. **Jendela dengan fps rendah menghasilkan fitur yang tidak bisa dipercaya.** Saat tab tersembunyi (±1–2,5 fps, misalnya 14:01:49–14:02:09 dan 14:04:02–14:05:05), semua kedip dibatalkan (jeda > 500 ms) sehingga kedip/menit = 0, sementara PERCLOS dihitung dari segelintir frame. Pada 14:04:55, 1 dari ±10 frame tertutup langsung menghasilkan label mentah "lelah". Usulan: jangan beri label kalau fps jendela < ±5, dan tampilkan "tidak dipantau". Ini terkait keputusan tab tersembunyi di `IDEA.md` bagian 7.
3. **Menguap: hanya 1 dari beberapa percobaan yang terhitung** (6,8 detik, 14:02:54). Percobaan 14:02:26 hanya 0,9 detik di atas `jawOpen` 0,5 (minimum 1,5 detik). Percobaan 14:02:17 terjadi saat kepala menunduk, dan wajah sempat hilang dari deteksi. Sebelum menurunkan durasi minimum, rekam dulu sesi **berbicara** supaya bicara tidak ikut terhitung menguap.
4. **EAR terbuka bergantung pada posisi kamera**: ±0,30 saat kamera di bawah wajah, 0,243 saat sejajar mata. Kalibrasi personal menangani ini, tapi user perlu kalibrasi ulang kalau kamera dipindah. Pesan di panel kalibrasi sudah menyebut hal ini.
5. **Kalibrasi tahap A (sudah diperbaiki di `d6f46eb`).** Landmark mata terpejam sesekali "meloncat" terbuka, dan 3 detik rekaman sering tidak bersamaan dengan saat mata benar-benar terpejam. Sekarang tahap A menunggu mata terdeteksi terpejam, cukup ≥30% frame terbaca tertutup, dan `eyeBlink` dipakai sebagai cadangan.

## Menunduk melihat HP, dan tertidur di meja (21 Sep sore)

Temuan user saat uji di mode debug:

1. **Melihat HP (kepala menunduk) terbaca "lelah".** Ada dua penyebab. Pertama, `pct_kepala_menunduk ≥ 30%` langsung menambah 1 poin. Kedua, saat melihat ke bawah kelopak atas ikut turun, dan webcam melihat mata dari atas, sehingga EAR turun seperti mata terpejam dan PERCLOS naik. Di CSV `equilibre-sesi-20260921-140729.csv`, saat kepala menunduk tapi mata tetap menatap layar, EAR justru tinggi (median 0,32). Jadi yang menurunkan EAR adalah arah pandang ke bawah. CSV uji HP-nya sendiri belum ada, jadi ini baru dugaan terkuat.
2. **Tertidur di meja tidak bisa dibedakan dari pergi.** Dua-duanya hanya terbaca sebagai "wajah hilang", karena sebelumnya Equilibre hanya membaca wajah.

Perubahan:

| Bagian | Sebelum | Sesudah |
|---|---|---|
| Mata dinilai | Semua frame yang ada wajahnya | Hanya saat kepala tidak menunduk (`pitch relatif > −15°`, `eyesReadable` di `features.ts`). PERCLOS `null` kalau mata terbaca < 5 detik |
| Poin ke-4 | Kepala menunduk ≥ 30% | **Mata terpejam ≥ 1 detik** (`mata_tertutup_lama` ≥ 1). Penutupan ≥ 1 detik yang terpotong karena kepala turun/wajah hilang tetap dihitung, karena begitulah pola orang tertidur: mata terpejam dulu, baru kepala jatuh |
| Kepala menunduk | Poin lelah | Hanya `catatan` di UI (tidak dihitung) |
| Wajah hilang, tubuh masih ada | "tidak di depan layar" | Label terakhir **ditahan** dengan penjelasan (mata tidak bisa dinilai) |
| Label baru `tertidur` | – | Syarat **semua**: mata terlihat terbuka ≤ 10% dari jendela, tubuh ada di ≥ 80% sampel, gerak tubuh (median) ≤ 0,015, dan status "lelah" sudah ≥ 15 menit dalam 60 menit terakhir |

Deteksi tubuh memakai **MediaPipe Image Segmenter (model selfie, ±250 KB, CPU, 2×/detik)**. Mask orang diringkas jadi grid 16×12 dan langsung dibuang. Yang disimpan hanya `body_area` (luas mask) dan `body_motion` (perubahan grid antar-sampel). Pose Landmarker tidak dipakai karena detektornya memakai wajah sebagai patokan, sehingga kemungkinan ikut gagal saat kepala di meja. Kalibrasi tahap B sekarang juga menyimpan `bodyArea`. Tubuh dianggap ada kalau luasnya ≥ 5% frame dan ≥ 30% dari `bodyArea`. Baseline lama tetap bisa dipakai, tapi sebaiknya kalibrasi ulang.

Syarat `tertidur` sengaja ketat (keputusan user 21 Sep): kondisi ini langka dan baru masuk akal setelah lelah berat dalam waktu lama. Kalau indikator risiko stres sudah ada (1 Okt), indikator itu bisa ditambahkan sebagai syarat.

⚠️ Semua angka di atas masih nilai awal. Yang paling belum pasti adalah `SLEEP.maxMotion` (0,015), karena skala `body_motion` belum pernah diukur.

### Rekaman yang dibutuhkan untuk tuning

Buka `?debug=1&calib=30&window=20&lelah=1`, **kalibrasi ulang**, lalu rekam satu sesi dan unduh CSV-nya:

1. Kerja normal 1 menit.
2. Melihat HP di tangan 1 menit, lalu HP di pangkuan 1 menit (kepala sangat menunduk).
3. Pura-pura mengantuk sampai label "lelah" bertahan ≥ 1 menit.
4. Kepala direbahkan di meja, diam 2 menit → harapannya "lelah" ditahan, lalu "tertidur".
5. Tinggalkan kursi 1 menit → "tidak di depan layar".

Yang dicek dari CSV: `look_down` saat melihat HP vs saat mata terpejam (kandidat pembeda kalau HP dipegang setinggi dada dan kepala hanya sedikit menunduk), `body_area` saat duduk / kepala di meja / kursi kosong, dan `body_motion` saat bekerja vs diam. Replay dengan syarat tertidur lain: `npm run replay -- <file.csv> --lelah=1`.
