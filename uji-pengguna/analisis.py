"""Analysis of the remote user test (plans/P08, "Analisis", fixed before any data came in).

Input: the Google Sheet downloaded as .xlsx (File > Download > Microsoft Excel).
Usage:  python -I analisis.py "<path>.xlsx" [--timeline]

Standard library only (no openpyxl). Excluded before counting: EQ-TEST and submissions marked duplikat.
KSS taps less than 60 s apart are one rating (the last tap counts): the scale stores every tap.
"""
import datetime
import re
import statistics as st
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
WIB = datetime.timezone(datetime.timedelta(hours=7))
RANK = {"tidak di depan layar": -1, "normal": 0, "lelah ringan": 1, "lelah": 2, "tertidur": 3}
FATIGUE = ("lelah ringan", "lelah", "tertidur")
KSS_WINDOW_MS = 5 * 60_000  # a rating covers the 5 minutes before it (kss.ts)
KSS_SAME_RATING_MS = 60_000
SHORT = {"normal": "n", "lelah ringan": "r", "lelah": "L", "tertidur": "T", "tidak di depan layar": "-"}


def column(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def cell(c, strings):
    kind, v = c.get("t"), c.find("m:v", NS)
    if kind == "s":
        return strings[int(v.text)]
    if kind == "inlineStr":
        return "".join(x.text or "" for x in c.iter("{%s}t" % NS["m"]))
    if v is None:
        return None
    if kind == "b":
        return v.text == "1"
    if kind == "str":
        return v.text
    x = float(v.text)
    return int(x) if x.is_integer() else x


def load(path):
    z = zipfile.ZipFile(path)
    strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            strings.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheets = {}
    for s in ET.fromstring(z.read("xl/workbook.xml")).find("m:sheets", NS):
        target = rels[s.get("{%s}id" % NS["r"])].lstrip("/")
        target = target if target.startswith("xl/") else "xl/" + target
        table = []
        for row in ET.fromstring(z.read(target)).iter("{%s}row" % NS["m"]):
            values = {column(c.get("r")): cell(c, strings) for c in row.findall("m:c", NS)}
            table.append([values.get(i) for i in range(max(values) + 1)] if values else [])
        if table:
            header = table[0]
            sheets[s.get("name")] = [dict(zip(header, r + [None] * (len(header) - len(r)))) for r in table[1:] if r]
    return sheets


def clock(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, WIB).strftime("%m-%d %H:%M:%S")


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def is_true(v):
    return v is True or str(v).lower() in ("true", "1")


def main(path, timeline):
    sh = load(path)
    sent = [k for k in sh["kiriman"] if k["kode"] != "EQ-TEST" and not is_true(k["duplikat"])]
    code_of = {k["id"]: k["kode"] for k in sent}
    by = {name: defaultdict(list) for name in ("evaluasi", "kss", "koreksi_label", "jeda")}
    for name, groups in by.items():
        for r in sh.get(name, []):
            if r["id_kiriman"] in code_of:
                groups[code_of[r["id_kiriman"]]].append(r)

    print(f"Penguji (tanpa EQ-TEST/duplikat): {len(sent)}")
    totals = Counter()
    for k in sent:
        code = k["kode"]
        evals = sorted(by["evaluasi"][code], key=lambda r: int(r["t"]))
        for r in evals:
            r["t"] = int(r["t"])
        face = [r for r in evals if RANK.get(r["label"], -2) >= 0]
        tired = [r for r in face if r["label"] in FATIGUE]
        print(f"\n## {code}  durasi {k['durasi_menit']} mnt  fps {k['fps_rata']}  {k['browser']} / {k['os']}")
        print(f"  isian: kacamata={k['kacamata']} kamera={k['kamera']} cahaya={k['cahaya']} dahi={k['dahi_tertutup']} tidur={k['jam_tidur']}")
        ear_open, ear_closed = num(k["baseline_ear_terbuka"]), num(k["baseline_ear_terpejam"])
        if ear_open is not None and ear_closed is not None:
            print(f"  baseline EAR terbuka {ear_open:.3f} terpejam {ear_closed:.3f} -> ambang PERCLOS {ear_closed + 0.08 * (ear_open - ear_closed):.3f}"
                  f"  kedip {k['baseline_kedip_per_menit']}/mnt {k['baseline_durasi_kedip_ms']} ms")
        print(f"  evaluasi {len(evals)}: {dict(Counter(r['label'] for r in evals))}")
        print(f"  ditahan: {dict(Counter(r['sebab_ditahan'] for r in evals if not is_true(r['dinilai'])))}")
        print(f"  porsi >= lelah ringan saat wajah ada: {len(tired)}/{len(face)} = {len(tired) / max(1, len(face)):.1%}")
        print(f"  tanda saat lelah+: {dict(Counter(r['tanda'] for r in tired).most_common(5))}")

        ratings = []
        for r in sorted(by["kss"][code], key=lambda r: int(r["t"])):
            if ratings and int(r["t"]) - int(ratings[-1]["t"]) <= KSS_SAME_RATING_MS:
                ratings[-1] = r
            else:
                ratings.append(r)
        print(f"  KSS: {len(by['kss'][code])} ketukan -> {len(ratings)} isian; dari pengingat: {sum(is_true(r['pengingat']) for r in ratings)}")
        for r in ratings:
            t, kss = int(r["t"]), int(r["kss"])
            window = [e["label"] for e in evals if t - KSS_WINDOW_MS < e["t"] <= t]
            top = max(window, key=lambda l: RANK.get(l, -2)) if window else None
            share = sum(l in FATIGUE for l in window) / len(window) if window else 0
            kind = ("alarm palsu" if kss <= 5 else "tangkapan" if kss >= 7 else "antara") if top in FATIGUE else (
                "terlewat" if kss >= 7 else "benar normal" if kss <= 5 else "antara")
            totals[kind] += 1
            print(f"    KSS {kss} @ {clock(t)}: 5 mnt sebelumnya n={len(window)}, tertinggi {top}, porsi lelah+ {share:.0%} -> {kind}")
        if all(int(r["kss"]) <= 4 for r in ratings) and ratings:
            print(f"  KONTROL SEGAR (semua KSS <= 4): alarm palsu murni {len(tired)}/{len(face)} = {len(tired) / max(1, len(face)):.1%}")
        for r in by["koreksi_label"][code]:
            print(f"  koreksi {clock(int(r['t']))}: {r['label_tampil']} -> {r['label_koreksi']}")
        for r in by["jeda"][code]:
            print(f"  jeda {r['pemicu']}: {r['menit']} mnt")
        if timeline:
            print("  per 5 menit (n normal, r lelah ringan, L lelah, - tidak di depan layar, h ditahan):")
            bins = defaultdict(list)
            for r in evals:
                bins[(r["t"] - evals[0]["t"]) // 300_000].append(r)
            for b in sorted(bins):
                rows = bins[b]
                marks = "".join(SHORT.get(r["label"], "?") if is_true(r["dinilai"]) else "h" for r in rows)
                gone = [v for v in (num(r["pct_wajah_hilang"]) for r in rows) if v is not None]
                print(f"    {clock(rows[0]['t'])[6:11]} {marks:<31} wajah hilang {st.mean(gone) if gone else 0:.2f}")

    print(f"\n## KSS (semua penguji): {dict(totals)}")
    print("## Feedback")
    for key in ("label_sesuai", "mengganggu", "mau_pakai"):
        values = [int(k[key]) for k in sent]
        print(f"  {key}: {values} median {st.median(values)}")
    # manfaat: asked from app uji-2 (28 Oct); empty or absent in earlier submissions and Sheets.
    benefit = [int(k["manfaat"]) for k in sent if str(k.get("manfaat") or "").strip()]
    print(f"  manfaat: {benefit} median {st.median(benefit) if benefit else '-'} | app {dict(Counter(k.get('app') for k in sent))}")
    for key in ("alarm_palsu", "kantuk_terlewat"):
        print(f"  {key}: {dict(Counter(k[key] for k in sent))}")
    for k in sent:
        if k["komentar"]:
            print(f"  komentar {k['kode']}: {k['komentar']!r}")


if __name__ == "__main__":
    main(sys.argv[1], "--timeline" in sys.argv[2:])
