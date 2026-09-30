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
| `equilibre-sesi-20260923-075630.csv` | 6 skenario protokol di bawah, 07:23–07:56 | `?debug=1&calib=30&window=20&tidur=1`. **Kamera ter-crop**: saat kepala direbahkan di meja, siluet tubuh hanya 0,1% luas kalibrasi |

Baseline sesi 21 Sep 14:01: EAR terbuka 0,243, EAR terpejam 0,033, kedip 25,8/menit, durasi kedip 223 ms, pitch −5,4°, jawOpen P95 0,03.
Baseline sesi 23 Sep 07:25: EAR terbuka 0,228, EAR terpejam 0,035, kedip 25,7/menit, durasi kedip 235 ms, pitch −7,8°, jawOpen P95 0,05, luas tubuh 0,273.

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
   - Opsi A: frame yang termasuk kedip pendek (< ±500 ms) tidak dihitung ke PERCLOS, jadi hanya penutupan yang lebih lama yang masuk. **Dipakai sejak 21 Sep malam** (`SHORT_BLINK_MS` di `features.ts`), lihat bagian "Aturan tertidur dan lelah, versi 2".
   - Opsi B: batas `perclosMild` personal, misalnya `max(0,08, 2 × PERCLOS saat kalibrasi tahap B)`. Ini perlu field baru di `Baseline`.
2. **Jendela dengan fps rendah menghasilkan fitur yang tidak bisa dipercaya.** Saat tab tersembunyi (±1–2,5 fps, misalnya 14:01:49–14:02:09 dan 14:04:02–14:05:05), semua kedip dibatalkan (jeda > 500 ms) sehingga kedip/menit = 0, sementara PERCLOS dihitung dari segelintir frame. Pada 14:04:55, 1 dari ±10 frame tertutup langsung menghasilkan label mentah "lelah". Usulan: jangan beri label kalau fps jendela < ±5, dan tampilkan "tidak dipantau". → **Dipakai 22 Sep dengan batas 3 fps** (`RULES.minWindowFps`): label terakhir ditahan dengan catatan "Pemantauan dijeda". Batas 5 akan mematikan label di mode hemat daya. Ini terkait keputusan tab tersembunyi di `IDEA.md` bagian 7.
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
| Label baru `tertidur` | – | ~~Syarat **semua**: mata terlihat terbuka ≤ 10% dari jendela, tubuh ada di ≥ 80% sampel, gerak tubuh (median) ≤ 0,015, dan status "lelah" sudah ≥ 15 menit dalam 60 menit terakhir~~ → diganti versi 2 di bawah (21 Sep malam) |

Deteksi tubuh memakai **MediaPipe Image Segmenter (model selfie, ±250 KB, CPU, 2×/detik)**. Mask orang diringkas jadi grid 16×12 dan langsung dibuang. Yang disimpan hanya `body_area` (luas mask) dan `body_motion` (perubahan grid antar-sampel). Pose Landmarker tidak dipakai karena detektornya memakai wajah sebagai patokan, sehingga kemungkinan ikut gagal saat kepala di meja. Kalibrasi tahap B sekarang juga menyimpan `bodyArea`. Tubuh dianggap ada kalau luasnya ≥ 5% frame dan ≥ 30% dari `bodyArea`. Baseline lama tetap bisa dipakai, tapi sebaiknya kalibrasi ulang.

## Aturan tertidur dan lelah, versi 2 (21 Sep malam)

Keputusan user: `tertidur` bisa terjadi tanpa riwayat lelah (orang bisa ketiduran tanpa terlihat lelah dulu). Yang jarang adalah **saran istirahat panjang**, yang muncul kalau `lelah`/`tertidur` sering dalam 1 jam.

Setiap frame, mata dinilai **terlihat terbuka**, **terlihat terpejam**, atau **tidak terlihat**:

| Keadaan | Syarat |
|---|---|
| terlihat terbuka | wajah ada dan EAR ≥ batas P80, **termasuk saat menunduk**. Kelopak yang terbuka lebar tidak bisa terlihat terpejam; di CSV 21 Sep, menunduk ke HP memberi EAR 0,32 (tegak 0,24) |
| terlihat terpejam | kepala tegak dan EAR < batas P80 |
| tidak terlihat | wajah hilang, atau menunduk dengan kelopak rendah (bisa melihat ke bawah, bisa terpejam) |

`tertidur` (`SLEEP` di `rules.ts`, `BODY` di `body.ts`) kalau jendela sekarang **dan** salah satu jendela panjang terlihat tidur:

| Jalur | Jendela panjang | Syarat tambahan |
|---|---|---|
| mata terlihat terpejam | 5 menit | mata terlihat terpejam ≥ 50% frame |
| mata tidak terlihat | 10 menit | – |

Syarat "terlihat tidur" di tiap jendela: mata terlihat terbuka ≤ 10% frame, tubuh ≥ ~~50%~~ → 40% (D-34, 23 Sep) luas kalibrasi di ≥ 80% sampel (jaket di kursi tidak cukup), tubuh diam (gerak ≤ 0,015) di ≥ 90% sampel, dan data jendela panjang mencakup ≥ 90% durasinya. Karena toleransi 10% ini, "5 menit" bisa tercapai sejak ±4,5 menit dan "10 menit" sejak ±9 menit. Jendela sekarang membuat label keluar dari `tertidur` dalam ±20 detik setelah bangun.

Perubahan lain di versi yang sama:

- **Mata tidak terlihat ≥ 50% jendela + tubuh ada** → label ditahan. Sebelumnya hanya "wajah hilang ≥ 50%"; sekarang juga kepala jatuh ke depan dengan wajah masih terdeteksi.
- **PERCLOS tanpa kedip pendek** (< 500 ms), temuan 1 opsi A.
- **Kedip ≥ 2× baseline** jadi poin pendukung: hanya dihitung kalau sudah ada tanda lain; kalau sendirian, muncul sebagai `catatan`. Di CSV 21 Sep laju kedip saat normal 24–48/menit (baseline 25,8), saat pura-pura mengantuk sampai 67.
- **Saran istirahat panjang**: kalau label tampil `lelah`/`tertidur` total ≥ 15 menit dalam 60 menit terakhir (`ADVICE` di `rules.ts`; menit yang ditahan dan `lelah ringan` tidak dihitung), panel Status menyarankan berhenti dan, kalau badan kurang fit, minta izin. Payload membawa `menit_lelah_60`; server menurunkan `saran_istirahat_panjang` dengan batas yang sama, jadi keputusan ini tidak dibuat oleh LLM.

Efek di replay CSV 21 Sep, jendela 60 detik (`--window=60`), kode lama → baru:

| Bagian | Lama | Baru |
|---|---|---|
| PERCLOS saat normal | 7–8% | 0–3% |
| Pura-pura mengantuk 14:03 | `lelah` (PERCLOS 10–15%) | `lelah ringan` (PERCLOS 4–5%; menguap + pejam 5,7 detik) |
| Kembali normal | `lelah ringan` sampai 14:04:44 | `normal` sejak 14:04:13 |

Jadi "lelah" di sesi pura-pura itu sebagian besar berasal dari kedip cepat. Untuk demo, `lelah` butuh pejam pelan ≥ 1 detik berulang, bukan kedip cepat.

**Batas yang sudah diketahui (simulasi `monitor.test.ts`/probe):** HP di pangkuan dengan wajah tidak terlihat dan tubuh **diam sempurna** 10 menit tetap terbaca `tertidur`. Menggulir dengan jempol hampir tidak terlihat di grid 16×12. Kandidat pembeda, belum dipakai sampai ada rekaman: posisi puncak siluet (kepala di meja → turun jauh dari posisi kalibrasi), dan lama diam tanpa putus.

⚠️ Semua angka di atas masih nilai awal. Yang paling belum pasti adalah `BODY.stillMotion` (0,015), karena skala `body_motion` belum pernah diukur.

### Rekaman yang dibutuhkan untuk tuning

Buka `?debug=1&calib=30&window=20&tidur=1` (jalur tertidur jadi 1 menit mata terpejam / 2 menit mata tidak terlihat), **kalibrasi ulang**, lalu rekam satu sesi dan unduh CSV-nya:

1. Kerja normal 1 menit.
2. Melihat HP di tangan 1 menit, lalu HP di pangkuan **3 menit sambil menggulir seperti biasa** → tidak boleh `tertidur`.
   - **HP tidak perlu terlihat kamera.** Equilibre tidak mendeteksi HP; yang dibaca hanya wajah (ada/tidak, posisi kepala, mata) dan siluet tubuh (luas, gerak). Yang diuji adalah postur main HP: kepala menunduk dalam, tangan di bawah meja, hanya jempol yang bergerak. Ini kasus tersulit karena kamera hanya melihat kepala dan bahu yang nyaris diam, mirip tidur telungkup.
   - Pegang HP di tempat yang biasa dipakai. Kalau biasanya di pangkuan di bawah meja, biarkan HP dan tangan di luar frame. Kalau tangan dan HP ikut masuk frame, gerakannya mungkin ikut terbaca sebagai gerak tubuh, sehingga uji jadi lebih mudah dari kenyataan.
   - Menggulir dan membaca seperti biasa (media sosial, chat). Jangan sengaja diam, jangan sengaja banyak bergerak.
   - Wajah boleh kadang terbaca, kadang tidak. Kalau terbaca dengan mata terbuka, `tertidur` sudah batal; kalau tidak terbaca, hanya gerak tubuh yang menentukan. Catat mana yang lebih sering terjadi (panel debug: "Wajah terdeteksi" / "Wajah tidak terdeteksi").
3. Pura-pura mengantuk: pejam pelan ≥ 1 detik beberapa kali dan menguap, sampai label "lelah" bertahan ≥ 1 menit.
4. Mata terpejam dengan kepala tegak, diam 90 detik → "lelah", lalu "tertidur".
5. Kepala direbahkan di meja, diam 3 menit → label ditahan, lalu "tertidur".
6. Tinggalkan kursi 1 menit → "tidak di depan layar". Lalu gantungkan jaket di sandaran kursi dan pergi 3 menit → tidak boleh `tertidur`.

Yang dicek dari CSV: `body_area` saat duduk / kepala di meja / kursi kosong / jaket di kursi, `body_motion` saat bekerja, menggulir HP, dan tidur, serta `look_down` saat melihat HP vs mata terpejam. Replay: `npm run replay -- <file.csv> --tidur=1 [--window=60]`.

## Hemat daya: deteksi ±5 fps (22 Sep)

Toggle "Hemat daya" di panel Sinyal wajah menurunkan loop deteksi dari 100 ms ke 200 ms (`web/src/powerSaving.ts`). Kalibrasi selalu berjalan ±10 fps, jadi satu baseline dipakai di kedua mode. Pilihan diingat di perangkat, dan mode ini menyala sendiri saat baterai di bawah 20% dan tidak diisi (Battery Status API, hanya Chromium). Header CSV mencatat kapan mode berubah: `hemat_daya=[{"t_ms":…,"sebab":"pilihan"|"baterai"|null}]`.

Biayanya diukur sebelum toggle ditulis, dengan memutar ulang sesi 21 Sep seolah direkam di 5 fps:

```bash
npm run replay -- "<csv>" --fps=5 --phase=0   # --phase=1: jam 5 fps digeser satu frame rekaman
```

| Sesi 21 Sep 14:07, jendela 20 detik | 10 fps | 5 fps fase 0 | 5 fps fase 1 |
|---|---|---|---|
| Kedip total | 118 | 93 (−21%) | 100 (−15%) |
| Mata terpejam ≥ 1 detik | 2 | 3 | 2 |
| Kedip/menit saat tab terlihat | 24–67 | 15–48 | 18–64 |
| Durasi kedip rata-rata saat tab terlihat | 137–269 ms | 205–333 ms | 208–296 ms |
| Label tampil berbeda dari 10 fps (jendela 20 / 60 detik) | — | 0 / 1 dari 37 | 2 / 0 dari 37 |

- Segmen normal memberi label yang sama di ketiga versi. Semua perbedaan label ada di segmen pura-pura mengantuk.
- Penutupan ≥ 1 detik tambahan di fase 0 (14:03:09) sebenarnya tiga kedip beruntun yang dipisah satu frame mata terbuka. Di 5 fps frame terbuka itu terlewat. Kedip beruntun seperti ini bisa menambah satu poin lelah palsu.
- Karena baseline kedip dari kalibrasi 10 fps, poin "kedip ≥ 2× baseline" jadi kurang peka saat hemat daya aktif.
- Usulan poin 2 di atas ("jangan beri label kalau fps jendela < ±5") akan mematikan label di mode ini, karena fps jendelanya 4,9–5,0. Kalau usulan itu dikerjakan, batasnya harus di bawah 5 (mis. ±3).
- Hanya satu sesi, satu tester. Belum dicoba dengan wajah di 5 fps sungguhan.

## Rekaman 6 skenario (23 Sep): ambang mata disetel dari data

`equilibre-sesi-20260923-075630.csv`, 07:23–07:56, `?debug=1&calib=30&window=20&tidur=1`. Catatan tester: skenario 1
sesuai, 2 melihat HP terbaca `lelah`/`lelah ringan`, 3 sesuai, 4 `tertidur` muncul, 5 terbaca "tidak di depan layar"
(kamera ter-crop), 6 jaket tidak terbaca sebagai tubuh. Sesi berbicara: metrik menguap tidak bertambah. Wi-Fi mati: sesuai.

### Kenapa membaca layar dan melihat HP terbaca lelah

| Segmen | EAR median | Frame < 0,073 (ambang lama) | Pitch relatif | Label lama |
|---|---|---|---|---|
| Kerja normal / baca layar | 0,258 | 6,6% | −2,7° | `lelah` 9 jendela (palsu) |
| HP di tangan | 0,207 | 42,2% | −1,4° | `lelah ringan` (palsu) |
| HP di pangkuan | 0,065 | 70,9% | −18,0° | menunduk → mata tidak dinilai |
| Pura-pura mengantuk | 0,143 | 30,1% | −7,9° | `lelah` (benar) |
| Mata terpejam / tertidur | 0,025 | 99,6% | −4,9° | `tertidur` (benar) |

Pita EAR "menunduk ringan" (0,05–0,09) dan "mata terpejam" (0,02–0,035) sebenarnya terpisah, tetapi **kedua ambang
lama jatuh di dalam pita menunduk**: frame tertutup 0,073 (0,2 rentang) dan episode kedip 0,131 (0,5 rentang). Kepala
turun 5–6° saja sudah cukup; batas "menunduk" (−15°) tidak tercapai, jadi mata tetap dinilai.

Yang tidak memisahkan: blendshape `eyeBlink` (0,65–0,75 di semua kondisi) dan `eyeLookDown` (0,63–0,79 pada frame
tertutup di semua kondisi). Yang memisahkan: **median EAR per episode ≥ 1 detik** — palsu 0,061–0,111 (16 dari 18),
asli 0,025–0,060 (10 dari 14).

### Perubahan

| Nilai | Lama | Baru | Berkas |
|---|---|---|---|
| Ambang frame mata tertutup | 0,2 rentang (P80) | **0,08 rentang** | `calibration.ts` `PERCLOS_FRACTION` |
| Pejaman ≥ 1 detik | cukup melewati titik tengah | **mayoritas frame di bawah 0,13 rentang** | `calibration.ts` + `blink.ts` |
| Luas tubuh untuk `tertidur` | 50% luas kalibrasi | **40%** | `body.ts` `sleepShareOfBaseline` |
| Batas kedipan lambat | 1,5× baseline | **2× baseline** | `rules.ts` `slowBlinkFactor` |

Kedip < 1 detik sengaja tidak ikut dikonfirmasi kedalamannya, supaya laju kedip dan baseline-nya tetap sebanding.

### Hasil replay rekaman yang sama

| Segmen | Sebelum | Sesudah |
|---|---|---|
| 1 kerja normal / baca layar (33 jendela) | normal 21, **lelah 9**, lelah ringan 3 | normal 31, lelah ringan 2 |
| 2a HP di tangan (5) | lelah ringan 5 | lelah ringan 3, normal 2 |
| 2b HP di pangkuan (7) | lelah ringan 7 | normal 5, lelah ringan 2 |
| 2c HP di tangan lagi (6) | lelah ringan 4, normal 2 | normal 6 |
| 3 pura-pura mengantuk (14) | lelah 7 | lelah 7 |
| 4 mata terpejam / tertidur (26) | tertidur 6, lelah 12 | tertidur 4, lelah 8 |
| 6 pergi + jaket (38) | tidak di depan layar 19, lelah ringan 8 | tidak di depan layar 18, normal 20 |

"Mata terpejam ≥ 1 detik" se-sesi: 44 → 25 kejadian. `tertidur` muncul 20 detik lebih lambat dari sebelumnya.

### Yang masih tersisa

- **Skenario 5 belum terjawab.** Kepala di meja memberi luas siluet 0,1% dari kalibrasi, sama dengan jaket di kursi,
  jadi jalur `tertidur` lewat tubuh tidak teruji. Rekam ulang skenario 5 saja, dengan kamera memuat kepala sampai
  bahu/dada.
- **Kedip < 1 detik yang dangkal** masih menaikkan rata-rata durasi kedip: sisa 2 jendela `lelah ringan` palsu di
  skenario 1 (07:28:47–58) memakai rata-rata 587–597 ms. Aturan kedalaman untuk kedip perlu rekaman + kalibrasi baru,
  karena `blinkPerMin`/`blinkDurationMs` di baseline lama dihitung dengan aturan lama.
- **HP di tangan 07:30:58–07:31:18** masih `lelah ringan` (mata tertutup 9–14% + satu pejaman ≥ 1 detik). Di segmen itu
  mata memang terbaca benar-benar terpejam (15% frame di bawah 0,044), jadi bukan lagi kasus kelopak setengah turun.
  → diukur ulang 30 Sep dan diterima sebagai keterbatasan, lihat "HP di tangan, rekaman 7 segmen (30 Sep)".

## Kepala bersandar, wajah tersembunyi (26 Sep)

Laporan user: kepala bersandar ±10 menit dengan wajah tidak terlihat, tetapi tidak terbaca `tertidur`. Log
`equilibre-sesi-20260926-220519.csv` (`tidur_menit=1`, jadi jalur mata tidak terlihat cukup 2 menit; hemat daya ±5 fps;
`bodyArea` kalibrasi 0,433). Segmen 21:40:30–21:49:30, 2.660 frame:

| Syarat tertidur | Ukuran | Hasil |
|---|---|---|
| tubuh ≥ 40% luas kalibrasi di ≥ 80% sampel | luas median ±0,60 (ambang 0,173), 100% sampel | lolos |
| tubuh diam (gerak ≤ 0,015) di ≥ 90% sampel | gerak median 0,0006, p90 ≤ 0,0146 per menit; 92–100% sampel | lolos |
| mata terlihat terbuka ≤ 10% frame | wajah tetap terdeteksi di 26% frame (15–44% per menit), dan di **semua** frame itu mata terbuka: EAR median 0,308 (baseline terbuka 0,287), skor kedip model median 0,013, pandangan ke bawah 0,90 | **gagal** |

Kontrol ambang: dengan ambang "terbuka" jauh lebih ketat (EAR ≥ 50% rentang dan skor kedip < 0,5) segmen ini tetap 25,9%
terbuka, jadi yang menggagalkan bukan ambang PERCLOS yang rendah. Sebagai pembanding, tes mata terpejam 21:51–21:55
(wajah terlihat) terbaca EAR median 0,018 dan skor kedip 0,766, dan `tertidur` muncul.

~~Kesimpulan: aturan bekerja sesuai rancangan (mata yang terlihat terbuka menggugurkan `tertidur`).~~ → **keliru** (koreksi
malam yang sama, setelah user mengirim foto posisinya: kepala di meja, puncak kepala menghadap kamera, wajah tidak mungkin
terlihat). "Wajah" di 26% frame itu **deteksi palsu** di rambut/lengan: 284 run dalam 9 menit, 78% hanya 1–2 frame, sudut
kepala melompat 6,5° per frame (p90 26,6°) dan menengadah sampai +67°; wajah asli di sesi yang sama bertahan ratusan frame
dengan lompatan ≤ 0,5°. EAR dan skor kedip "sepakat terbuka" karena keduanya berasal dari deteksi palsu yang sama, bukan
dua bukti independen.

Perbaikan (`STEADY_FACE` di `features.ts`, ⚠️ nilai awal): frame wajah hanya dihitung di dalam run ≥ 1 detik (boleh putus
1 frame) dengan lompatan pitch median ≤ 3°. Diukur pada 4 log:

| Log | Frame wajah yang tetap dipakai | Segmen kepala di meja, "mata terbuka" |
|---|---|---|
| 26 Sep | 77,6% (yang dibuang: flicker + transisi 21:39:25–21:40:20) | 25,9% → 0,6% |
| 23 Sep (6 skenario, termasuk HP) | 99,9% | — |
| 21 Sep (dua sesi) | 99,7% dan 99,7% | — |

Replay: 26 Sep → `tertidur` mulai 21:41:29 (±2 menit setelah bersandar, `tidur=1`) sampai 21:50; tes mata terpejam tidak
berubah. 21 Sep tidak berubah; 23 Sep 1 baris berubah (evaluasi terakhir, 0 fps). Varian yang ditolak: run ≥ 5 frame saja
(bersandar masih 10,5%), celah dalam milidetik (tidak menyambung apa pun di 5 fps, dan menurunkan 21 Sep ke 94–95%).

Pesan penahanan tetap diperbaiki (menyebut porsi mata terbuka kalau > 10%), karena berguna saat mata memang terbuka. Ini
juga ukuran pertama `BODY.stillMotion` dan `BODY.sleepShareOfBaseline` dengan kepala di meja: keduanya jauh di sisi aman.
Belum terverifikasi: filter ini di app live dengan posisi yang sama, dan apakah flicker juga memotong deteksi jeda
(`stepBreak` di `main.ts` masih memakai `face` mentah per frame).

## HP di tangan, rekaman 7 segmen (30 Sep)

Log `equilibre-sesi-20260930-232017.csv`, `?debug=1` (kalibrasi 5 menit, jendela 60 detik, 9,9–10 fps). Tester sudah
mengantuk (malam, menguap 3×), jadi segmen terakhir tidak dipakai untuk menyetel.

| Segmen | Label tampil (replay) | Pemicu |
|---|---|---|
| Kontrol, menatap layar | normal | – |
| HP di tangan setinggi dada, 2 menit | `lelah ringan` 30 detik di akhir | kedipan rata-rata 430–506 ms, batas 301 ms (2 × 151 ms) |
| HP setinggi dagu, kepala hampir tegak | normal | – |
| Layar, lalu menguap | `lelah ringan` | menguap asli: `jawOpen` 0,91 selama ±2 detik |
| Bolak-balik HP ↔ layar tiap 5 detik | `lelah ringan` 30 detik | kedipan lambat, tercampur kantuk |
| Layar, menguap dan mengantuk | `lelah ringan` | menguap 4,3 detik + kedipan lambat (benar) |

Kedipan saat kepala di −10° sampai −15° (masih di atas batas menunduk −15°, jadi mata tetap dinilai) rata-rata 432 ms
(11 kedip); saat kepala tegak 179 ms. Bukan transisi kepala: tidak ada dari 7 kedip ≥ 500 ms yang terjadi saat pitch
berubah ≥ 5°. Di sudut itu kelopak mengikuti pandangan ke HP, jadi kedip biasa terbaca lebih lama.

Dua perbaikan dicoba lewat replay pada rekaman 21, 23, 26, dan 30 Sep (tanpa perubahan, keluaran identik dengan replay asli):

- Batas menunduk −15° → −10°/−12°: HP jadi normal, tetapi pura-pura mengantuk 23 Sep kehilangan `lelah` dan tes mata
  terpejam 26 Sep turun dari `lelah`/`tertidur` ke `lelah ringan`.
- Durasi kedip hanya dari kedip dengan kepala di atas −10°: HP setinggi dada jadi normal, tetapi rekaman 23 Sep mendapat 6
  jendela `lelah ringan` palsu baru (kembali duduk, jendela 20 detik dengan sedikit kedip).

Keputusan: **diterima sebagai keterbatasan**, threshold tidak diubah. Untuk demo, HP dipegang setinggi dagu atau diletakkan
di pangkuan (menunduk ≥ 15°, mata tidak dinilai).
