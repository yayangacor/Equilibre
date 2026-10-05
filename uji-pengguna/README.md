# Uji pengguna jarak jauh

Penguji membuka demo online di laptopnya sendiri dengan link pribadi (`?kode=EQ-XXXX`), menyetujui uji, kalibrasi, bekerja seperti
biasa 60 menit (boleh berhenti setelah menit 30) sambil mengisi KSS tiap 15 menit, lalu mengisi feedback dan menekan Kirim. Satu
kiriman berisi label dan angka ringkasan tiap 10 detik, isian KSS, koreksi label, jeda, angka kalibrasi, jenis browser/OS, isian
awal, dan feedback. Video, gambar, titik wajah, nama, dan email tidak pernah dikirim. Kode di app: `web/src/userTest.ts`
(isi kiriman, whitelist field) dan `web/src/userTestPanel.ts` (kartu "Uji coba").

`Code.gs` di folder ini menerima kiriman di Google Sheet milik pengembang. Kiriman hanya disimpan kalau kodenya ada di sheet `kode`
dengan kolom `aktif` dicentang; kiriman kedua dengan kode yang sama tetap disimpan tetapi ditandai `duplikat`.

## Memasang penerima (±10 menit)

1. Buat Google Sheet baru, mis. "Equilibre — hasil uji". **File → Settings → Time zone: (GMT+07:00) Jakarta**.
2. **Extensions → Apps Script**. Hapus isi `Code.gs` di editor, tempel isi `Code.gs` dari folder ini, simpan.
3. Di editor pilih fungsi `siapkan` → **Run** → izinkan akses untuk akun sendiri. Sheet `kode` terisi `EQ-TEST` (uji alur) dan 10
   kode baru beserta link-nya; sheet data dibuat dengan baris judul.
4. **Deploy → New deployment →** jenis **Web app**. *Execute as:* **Me**. *Who has access:* **Anyone**. Deploy, salin **Web app
   URL** (berakhiran `/exec`).
5. Buka URL itu di browser: harus muncul `{"ok":true,"layanan":"equilibre-uji"}`.
6. Isi URL ke `UJI_URL` di `web/src/userTest.ts`, `npm run build:demo`, commit, lalu fast-forward branch `deploy`.

"Anyone" diperlukan supaya browser penguji bisa mengirim tanpa login Google; penjaganya adalah daftar kode. Kode tidak disimpan di
repo ini.

## Selama uji

- Bagikan link dari kolom `link` sheet `kode`, satu kode per orang. Pemetaan kode → nama simpan sendiri, di luar Sheet kalau Sheet
  dibagikan.
- Menonaktifkan kode: hapus centang `aktif`.
- Penguji minta datanya dihapus: di editor Apps Script jalankan `hapusKode('EQ-XXXX')` (semua baris kode itu dihapus dari sheet data,
  kodenya dinonaktifkan).
- Data uji dihapus paling lambat 31 Oktober 2026 (janji di layar persetujuan).

## Sheet

| Sheet | Satu baris = | Kolom penting |
|---|---|---|
| `kiriman` | satu kiriman | `kode`, `duplikat`, `durasi_menit`, isian awal, feedback, perangkat, baseline, jumlah baris |
| `evaluasi` | satu evaluasi (tiap 10 detik) | `label`, `label_mentah`, `dinilai`, angka payload, `tanda`, `hemat_daya` |
| `kss` | satu isian KSS | `kss` (1–9, mencakup 5 menit sebelumnya), `label_tampil`, `pengingat` |
| `koreksi_label` | satu koreksi | `label_tampil`, `label_koreksi`, `alasan` |
| `jeda` | satu jeda | `mulai`, `selesai`, `menit`, `pemicu` |

Semua tabel data punya `id_kiriman` dan `kode`. Teks bebas dari penguji yang diawali `=`, `+`, `-`, atau `@` disimpan sebagai teks,
bukan rumus.
