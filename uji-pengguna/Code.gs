// Equilibre — receiver for the remote user test (plans/P08, NOTES D-57).
// Bound to the developer's own Google Sheet (Extensions → Apps Script), deployed as a web app.
// The app (?kode=EQ-XXXX) posts one JSON submission per tester: labels, numbers, KSS, feedback.
// No video, images or face landmarks ever arrive here. A submission is stored only when its code
// is listed in the "kode" sheet with "aktif" ticked. Setup: README.md next to this file.

const APP_URL = "https://equilibre-orcin.vercel.app/";
const MAX_CHARS = 2000000;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I: codes are read out and typed

const HEADERS = {
  kode: ["kode", "aktif", "link", "catatan (jangan tulis nama kalau Sheet dibagikan)"],
  kiriman: [
    "id", "diterima", "kode", "duplikat", "app", "mulai", "selesai", "durasi_menit", "selesai_awal",
    "kacamata", "kamera", "cahaya", "dahi_tertutup", "jam_tidur",
    "label_sesuai", "alarm_palsu", "kantuk_terlewat", "mengganggu", "mau_pakai", "komentar",
    "browser", "os", "kamera_resolusi", "fps_rata",
    "baseline_kedip_per_menit", "baseline_durasi_kedip_ms", "baseline_ear_terbuka", "baseline_ear_terpejam",
    "n_evaluasi", "n_kss", "n_koreksi", "n_jeda",
  ],
  evaluasi: [
    "id_kiriman", "kode", "sesi", "t", "waktu", "label", "label_mentah", "dinilai", "sebab_ditahan", "skor", "poin",
    "tanda", "perclos", "kedip_per_menit", "durasi_kedip_ms", "mata_tertutup_lama", "menguap",
    "pct_kepala_menunduk", "pct_wajah_hilang", "menit_sejak_jeda", "menit_lelah_60", "hemat_daya",
  ],
  kss: ["id_kiriman", "kode", "sesi", "t", "waktu", "kss", "label_tampil", "pengingat"],
  koreksi_label: ["id_kiriman", "kode", "sesi", "t", "waktu", "label_tampil", "label_koreksi", "skor", "alasan"],
  jeda: ["id_kiriman", "kode", "sesi", "mulai", "selesai", "menit", "pemicu"],
};
const DATA_SHEETS = ["kiriman", "evaluasi", "kss", "koreksi_label", "jeda"];

// ── Web app ─────────────────────────────────────────────────────────────────────

function doGet() {
  return json_({ ok: true, layanan: "equilibre-uji" });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: "Penerima sedang sibuk, coba lagi sebentar." });
  try {
    const raw = e && e.postData ? e.postData.contents : "";
    if (!raw || raw.length > MAX_CHARS) return json_({ ok: false, error: "Kiriman kosong atau terlalu besar." });
    let sub;
    try {
      sub = JSON.parse(raw);
    } catch (err) {
      return json_({ ok: false, error: "Kiriman bukan JSON." });
    }
    if (!sub || sub.format !== "equilibre-uji" || sub.versi !== 1) {
      return json_({ ok: false, error: "Format kiriman tidak dikenal." });
    }
    const kode = String(sub.kode || "").trim().toUpperCase();
    if (!activeCode_(kode)) return json_({ ok: false, error: "Kode uji tidak terdaftar atau sudah tidak aktif." });
    for (const name of ["evaluasi", "kss", "koreksi_label", "jeda"]) {
      if (!Array.isArray(sub[name])) return json_({ ok: false, error: "Bagian " + name + " tidak ada." });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sent = sheet_(ss, "kiriman");
    // A second submission with the same code is kept but marked, so the analysis can use the first one.
    const duplikat =
      sent.getLastRow() > 1 && sent.getRange(2, 3, sent.getLastRow() - 1, 1).getValues().some((r) => r[0] === kode);
    const id = Utilities.getUuid();
    const i = sub.isian || {};
    const f = sub.feedback || {};
    const p = sub.perangkat || {};
    const b = sub.baseline || {};
    append_(ss, "kiriman", [[
      id, new Date(), kode, duplikat, sub.app, time_(sub.mulai), time_(sub.selesai), sub.durasi_menit, sub.selesai_awal,
      i.kacamata, i.kamera, i.cahaya, i.dahi_tertutup, i.jam_tidur,
      f.label_sesuai, f.alarm_palsu, f.kantuk_terlewat, f.mengganggu, f.mau_pakai, f.komentar,
      p.browser, p.os, p.kamera, p.fps_rata,
      b.kedip_per_menit, b.durasi_kedip_ms, b.ear_terbuka, b.ear_terpejam,
      sub.evaluasi.length, sub.kss.length, sub.koreksi_label.length, sub.jeda.length,
    ]]);
    append_(ss, "evaluasi", sub.evaluasi.map((r) => [
      id, kode, r.sesi, r.t, time_(r.t), r.label, r.label_mentah, r.dinilai, r.sebab_ditahan, r.skor, r.poin,
      Array.isArray(r.tanda) ? r.tanda.join(" ") : "", r.perclos, r.kedip_per_menit, r.durasi_kedip_ms,
      r.mata_tertutup_lama, r.menguap, r.pct_kepala_menunduk, r.pct_wajah_hilang, r.menit_sejak_jeda,
      r.menit_lelah_60, r.hemat_daya,
    ]));
    append_(ss, "kss", sub.kss.map((r) => [id, kode, r.sesi, r.t, time_(r.t), r.kss, r.label_tampil, r.pengingat]));
    append_(ss, "koreksi_label", sub.koreksi_label.map((r) => [
      id, kode, r.sesi, r.t, time_(r.t), r.label_tampil, r.label_koreksi, r.skor,
      Array.isArray(r.alasan) ? r.alasan.join(" | ") : "",
    ]));
    append_(ss, "jeda", sub.jeda.map((r) => [id, kode, r.sesi, time_(r.mulai), time_(r.selesai), r.menit, r.pemicu]));
    return json_({ ok: true, id: id, duplikat: duplikat });
  } catch (err) {
    return json_({ ok: false, error: "Penerima gagal menyimpan: " + err.message });
  } finally {
    lock.releaseLock();
  }
}

// ── Run from the editor ─────────────────────────────────────────────────────────

// Creates the sheets, 10 new codes with their links, and EQ-TEST for checking the flow (left out of the analysis).
function siapkan() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const name of DATA_SHEETS) sheet_(ss, name);
  const codes = sheet_(ss, "kode");
  const existing = new Set(codes.getLastRow() > 1 ? codes.getRange(2, 1, codes.getLastRow() - 1, 1).getValues().map((r) => r[0]) : []);
  const rows = [];
  if (!existing.has("EQ-TEST")) rows.push(["EQ-TEST", true, APP_URL + "?kode=EQ-TEST&calib=30", "uji alur, tidak dianalisis"]);
  while (rows.length < 10 + (existing.has("EQ-TEST") ? 0 : 1)) {
    let code = "EQ-";
    for (let k = 0; k < 4; k++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (existing.has(code) || rows.some((r) => r[0] === code)) continue;
    rows.push([code, true, APP_URL + "?kode=" + code, ""]);
  }
  const start = codes.getLastRow() + 1;
  codes.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
  // insertCheckboxes() resets the cells to false, so tick the new rows afterwards; codes unticked by hand stay unticked.
  codes.getRange(start, 2, rows.length, 1).insertCheckboxes().check();
}

// Deletes every row of one code from the data sheets (a tester asked for it). The code row itself stays, unticked.
function hapusKode(kode) {
  const target = String(kode || "").trim().toUpperCase();
  if (!target) throw new Error("Isi kodenya, mis. hapusKode('EQ-7K2M').");
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (const name of DATA_SHEETS) {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) continue;
    const col = HEADERS[name].indexOf("kode") + 1;
    const values = sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues();
    for (let r = values.length - 1; r >= 0; r--) if (values[r][0] === target) sh.deleteRow(r + 2);
  }
  const codes = ss.getSheetByName("kode");
  if (codes && codes.getLastRow() > 1) {
    const values = codes.getRange(2, 1, codes.getLastRow() - 1, 1).getValues();
    values.forEach((r, k) => {
      if (r[0] === target) codes.getRange(k + 2, 2).setValue(false);
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function activeCode_(kode) {
  if (!/^EQ-[A-Z0-9]{4,8}$/.test(kode)) return false;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("kode");
  if (!sh || sh.getLastRow() < 2) return false;
  return sh
    .getRange(2, 1, sh.getLastRow() - 1, 2)
    .getValues()
    .some((r) => String(r[0]).trim().toUpperCase() === kode && (r[1] === true || String(r[1]).toUpperCase() === "TRUE"));
}

function sheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

function append_(ss, name, rows) {
  if (rows.length === 0) return;
  const sh = sheet_(ss, name);
  const width = HEADERS[name].length;
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, width).setValues(rows.map((r) => r.slice(0, width).map(cell_)));
}

// Free text from testers must never become a formula (=IMPORTXML(...) and the like).
function cell_(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean" || v instanceof Date) return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s.slice(0, 5000);
}

function time_(ms) {
  return typeof ms === "number" && isFinite(ms) ? new Date(ms) : "";
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
