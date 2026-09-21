# Catatan tuning threshold

Catatan kerja untuk menyetel threshold rules (`web/src/rules.ts`, `features.ts`, `blink.ts`, `yawn.ts`, `calibration.ts`) dari sesi rekaman sendiri. Semua threshold yang ditandai ⚠️ di kode masih nilai awal.

## Cara memutar ulang sesi

1. Di aplikasi, klik **Unduh log sesi (CSV)**. Isinya angka per frame saja (EAR, jawOpen, pitch, blendshape kedip), tanpa gambar.
2. Jalankan:

   ```bash
   cd equilibre/web
   npm run replay -- "C:/Users/LEGION 5/Downloads/equilibre-sesi-20260921-140729.csv"
   ```

`scripts/replay.ts` memakai modul yang **sama persis** dengan loop live (`blink`, `yawn`, `calibration`, `features`, `rules`). Jadi setelah threshold di `src/` diubah, cukup jalankan replay lagi untuk melihat efeknya. Hasilnya berupa timeline tiap 10 detik: fps, 6 fitur jendela, label mentah → label tampil (setelah hysteresis), dan alasannya.

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
