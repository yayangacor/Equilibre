# Knowledge base rekomendasi Equilibre

Catatan ini adalah sumber RAG untuk flow Langflow `analisis_status` dan `cari_panduan`. Setiap file berisi
**parafrase** poin yang boleh dipakai rekomendasi, sitasi lengkap, tautan, dan lisensinya. Teks sumber tidak
disalin utuh. Klaim yang tidak ada di sini tidak boleh muncul di rekomendasi.

| File | Sumber | Lisensi | Dipakai untuk status |
|---|---|---|---|
| `albulescu-2022-micro-break.md` | Albulescu dkk. (2022), meta-analisis micro-break, PLOS ONE | CC BY 4.0 | perlu jeda singkat, perlu jeda, perlu jeda aktif |
| `aao-20-20-20.md` | American Academy of Ophthalmology, EyeWiki "Computer Vision Syndrome" | hak cipta AAO, hanya parafrase | baik, perlu jeda singkat |
| `abe-2023-perclos.md` | Abe (2023), review PERCLOS, SLEEP Advances | CC BY | alasan (menjelaskan keterbatasan deteksi) |
| `who-2022-mental-health-at-work.md` | WHO Guidelines on mental health at work (2022) + ringkasan World Psychiatry (2023) | CC BY-NC-SA 3.0 IGO / CC BY 4.0 | perlu istirahat panjang |
| `kemenkes-healing119.md` | Kemenkes, layanan Healing119.id (7 Agu 2025) | informasi publik pemerintah | eskalasi (keluhan berat) |
| `permenkes-48-2016-k3-perkantoran.md` | Permenkes No. 48 Tahun 2016, Standar K3 Perkantoran (BN 2016 No. 1598) | peraturan, hanya parafrase | perlu jeda singkat, perlu jeda, perlu istirahat panjang |
| `niosh-kewaspadaan-kerja.md` | NIOSH, Training for Nurses on Shift Work and Long Work Hours (Pub. 2015-115) | karya pemerintah AS, hanya parafrase | perlu jeda aktif, perlu jeda |
| `eu-432-2012-air-minum.md` | Regulation (EU) No 432/2012, klaim kesehatan air (dasar: EFSA 2011) | dokumen resmi UE, hanya parafrase | perlu jeda aktif, perlu jeda |
| `allen-2016-ventilasi.md` | Allen dkk. (2016), ventilasi kantor dan skor kognitif, Environ Health Perspect | CC BY 4.0 | perlu jeda aktif |

Diverifikasi dari halaman sumber pada 22 September 2026.

## Isi jeda aktif (D-27) dan sumbernya

| Kegiatan | Sumber | Yang **tidak** didukung sumber |
|---|---|---|
| pindah ke tempat lebih terang / cahaya matahari | NIOSH | — |
| jalan cepat, naik tangga, peregangan | NIOSH, Permenkes 48/2016 | lama efeknya tidak diketahui |
| minum air | EU 432/2012 | menghilangkan kantuk |
| buka jendela / cari udara segar | Allen 2016 | menghilangkan kantuk; efek keluar ruangan sebentar |

## Belum ada sumbernya (jangan diklaim dulu)

- Tidur singkat dan kafein disebut NIOSH, tetapi tidak dipakai Equilibre (lihat catatan NIOSH).
- Permenaker No. 5 Tahun 2018 (K3 lingkungan kerja) tidak dicari lagi: untuk kerja kantor, Permenkes 48/2016 lebih
  spesifik dan PDF resminya sudah dibaca.
