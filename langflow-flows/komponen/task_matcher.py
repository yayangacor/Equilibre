# Task Matcher: the custom component of the Langflow flow rencana_kerja (plan P20 W2.4, research report §3.4,
# NOTES D-83, D-84, D-90). It picks the next hour's steps and task from the energy phase and the abstract tasks
# t1..tn; the LLM after it only explains this choice in words and never makes its own.
#
# A port of web/src/taskMatcher.ts, rule for rule. Both are tested on web/src/taskMatcher.fixtures.json
# (here: langflow-flows/uji-task-matcher.py). Change the rules in both files and in the fixtures together.
#
#   skor(t) = 3·cocok(sifat, beban, row) + 2·urgensi(hari_ke_tenggat) + 1·urutan(posisi),  urutan = 1 − posisi/(n−1)
#
# Readings where the report is silent are the ones written at the top of taskMatcher.ts (row per phase, walk
# first, "belum dinilai" = 0.5, one task = urutan 1, integer ranking key, minutes, reason codes).
#
# The file is stored whole in the flow (the node's code field), and Langflow 1.12.2 keeps only the top-level
# imports, assignments, functions and classes of it (lfx/custom/validate.py prepare_global_scope): a guarded
# import (try/except, if) would be dropped there. So the lfx imports are plain, and the rules are plain
# functions that never touch them; uji-task-matcher.py runs the file without its lfx imports and component class.

import json

from lfx.custom.custom_component.component import Component
from lfx.io import MessageTextInput, Output
from lfx.schema.message import Message

NOT_ASSESSED = "belum dinilai"  # taskTagger.ts NOT_ASSESSED
DUE_SOON_DAYS = 3  # taskTagger.ts DUE_SOON_DAYS: "≤ 3 hari"
PHASES = ("siap fokus", "biasa", "rendah ringan", "rendah berat", "tidak tahu")
SIFAT = ("aktif", "monoton", NOT_ASSESSED)
BEBAN = ("berat", "ringan", NOT_ASSESSED)
TUGAS_FIELDS = {"id", "sifat", "beban", "hari_ke_tenggat", "posisi"}  # server/src/rencana.ts TUGAS_FIELDS

# ⚠️ Research report §3.4, not tuned with users yet. In tenths, so the ranking key stays an integer.
# "rawan" is the report's row "Rendah ringan / jam rawan".
FIT = {
    "siap fokus": {"aktif berat": 10, "aktif ringan": 6, "monoton berat": 5, "monoton ringan": 2},
    "biasa": {"aktif berat": 5, "aktif ringan": 5, "monoton berat": 5, "monoton ringan": 5},
    "rawan": {"aktif berat": 10, "aktif ringan": 9, "monoton berat": 1, "monoton ringan": 2},
}
FIT_UNASSESSED = 5  # ⚠️ tenths: "belum dinilai"
# ⚠️ §3.4, in tenths: due today or overdue 1, tomorrow 0.6, in ≤ 3 days 0.3, later or no date 0.
URGENCY = {"hari_ini": 10, "besok": 6, "dekat": 3, "lainnya": 0}
WEIGHT = {"cocok": 3, "urgensi": 2, "urutan": 1}  # ⚠️ §3.4
# ⚠️ Minutes: walk 5 (D-84), break 10, task block 25 in the low row; the walk is due after 30 minutes without one.
PLAN = {"walk_minutes": 5, "break_minutes": 10, "low_block_minutes": 25, "walk_due_minutes": 30}

# The knowledge base search for each cocok row (None = the break of "rendah berat"). The rencana_kerja flow sends
# it to the Knowledge node, so the notes that back the rule reach the prompt. ⚠️ Wording not tuned on the
# knowledge base yet (cek-retrieval.mts runs searches without an LLM). Never sleep or a nap (NOTES D-27).
KUERI = {
    None: "jeda aktif saat sangat mengantuk: jalan cepat singkat, cahaya terang",
    "rawan": "penurunan kewaspadaan siang hari, jalan singkat 5 sampai 10 menit, tugas aktif bukan tugas monoton saat mengantuk",
    "siap fokus": "tugas aktif yang menantang dikerjakan saat segar, tugas monoton memperlihatkan kantuk",
    "biasa": "jeda gerak singkat yang rutin mengurangi rasa lelah saat bekerja di depan layar",
}
SKOR_UNTUK_LLM = 3  # the LLM sees the top scores only (50 tasks would be about 4 kB of numbers)


def fit_row(fase, jam_rawan):
    if fase == "rendah berat":
        return None
    if fase == "rendah ringan" or jam_rawan:
        return "rawan"
    return "siap fokus" if fase == "siap fokus" else "biasa"


def fit_tenths(row, task):
    if task["sifat"] == NOT_ASSESSED or task["beban"] == NOT_ASSESSED:
        return FIT_UNASSESSED
    return FIT[row][task["sifat"] + " " + task["beban"]]


def urgency_tenths(hari_ke_tenggat):
    if hari_ke_tenggat is None:
        return URGENCY["lainnya"]
    if hari_ke_tenggat <= 0:
        return URGENCY["hari_ini"]
    if hari_ke_tenggat <= 1:
        return URGENCY["besok"]
    return URGENCY["dekat"] if hari_ke_tenggat <= DUE_SOON_DAYS else URGENCY["lainnya"]


def rank_tasks(tugas, row):
    # Each task with its fit and urgency in tenths and two integer keys: key with the fit term, base without it.
    # Best first by a key: the larger key, then the user's order (as byRank in taskMatcher.ts).
    d = max(1, len(tugas) - 1)
    ranked = []
    for task in tugas:
        fit = fit_tenths(row, task)
        urgency = urgency_tenths(task["hari_ke_tenggat"])
        order = WEIGHT["urutan"] * 10 * (d - task["posisi"])
        ranked.append({
            "task": task,
            "fit": fit,
            "urgency": urgency,
            "key": d * (WEIGHT["cocok"] * fit + WEIGHT["urgensi"] * urgency) + order,
            "base": d * WEIGHT["urgensi"] * urgency + order,
        })
    return ranked, d


def best_first(ranked, key_name):
    return sorted(ranked, key=lambda r: (-r[key_name], r["task"]["posisi"]))


def match_tasks(masukan):
    # taskMatcher.ts matchTasks: {baris, langkah, tugas_id, kode, skor}, the shape of the fixtures' "keluaran".
    row = fit_row(masukan["fase"], masukan["jam_rawan"])
    if row is None:
        jeda = {"jenis": "jeda", "menit": PLAN["break_minutes"], "tugas_id": None, "kode": ["JEDA_DULU"]}
        return {"baris": None, "langkah": [jeda], "tugas_id": None, "kode": ["JEDA_DULU"], "skor": []}

    ranked, d = rank_tasks(masukan["tugas"], row)
    best = best_first(ranked, "key")
    chosen = best[0]["task"] if best else None
    without_fit = best_first(ranked, "base")[0]["task"] if ranked else None

    langkah = []
    menit = masukan["menit_sejak_jeda"]
    walk_due = menit is None or menit >= PLAN["walk_due_minutes"]
    if masukan["fase"] == "rendah ringan" or (row == "rawan" and walk_due):
        langkah.append({"jenis": "jalan", "menit": PLAN["walk_minutes"], "tugas_id": None, "kode": ["JALAN_DULU"]})
    if chosen is not None:
        hari = chosen["hari_ke_tenggat"]
        kode = []
        if row == "rawan" and chosen["sifat"] == "aktif":
            kode.append("AKTIF_SAAT_RAWAN")
        if row == "rawan" and without_fit is not None and without_fit["sifat"] == "monoton" and without_fit["id"] != chosen["id"]:
            kode.append("HINDARI_MONOTON")
        if row == "siap fokus" and chosen["sifat"] == "aktif" and chosen["beban"] == "berat":
            kode.append("SIAP_FOKUS")
        if hari is not None and hari <= 0:
            kode.append("TENGGAT_HARI_INI")
        if hari is not None and 1 <= hari <= DUE_SOON_DAYS:
            kode.append("TENGGAT_DEKAT")
        if chosen["posisi"] == 0:
            kode.append("URUTAN_PENGGUNA")
        if chosen["sifat"] == NOT_ASSESSED or chosen["beban"] == NOT_ASSESSED:
            kode.append("BELUM_DINILAI")
        block = PLAN["low_block_minutes"] if row == "rawan" else None
        langkah.append({"jenis": "tugas", "menit": block, "tugas_id": chosen["id"], "kode": kode})

    kode = ["KAMERA_TIDAK_MENILAI"] if masukan["fase"] == "tidak tahu" else []
    for step in langkah:
        kode.extend(step["kode"])
    if chosen is None:
        kode.append("TIDAK_ADA_TUGAS")
    skor = [
        {
            "id": r["task"]["id"],
            "cocok": r["fit"] / 10,
            "urgensi": r["urgency"] / 10,
            "urutan": (d - r["task"]["posisi"]) / d,
            "skor": r["key"] / (10 * d),
        }
        for r in best
    ]
    return {"baris": row, "langkah": langkah, "tugas_id": chosen["id"] if chosen else None, "kode": kode, "skor": skor}


def read_masukan(text):
    # The JSON the server sends (server/src/rencana.ts parseRencana has checked it). Checked again for the fields
    # the rules read, so a wrong input fails here with a plain message instead of a KeyError deep in the rules.
    try:
        masukan = json.loads(text)
    except (TypeError, ValueError) as err:
        raise ValueError(f"Task Matcher: the input is not JSON ({err}).") from err
    if not isinstance(masukan, dict):
        raise ValueError("Task Matcher: the input must be a JSON object.")
    if masukan.get("fase") not in PHASES:
        raise ValueError("Task Matcher: fase must be one of " + ", ".join(PHASES) + ".")
    if not isinstance(masukan.get("jam_rawan"), bool):
        raise ValueError("Task Matcher: jam_rawan must be true or false.")
    menit = masukan.get("menit_sejak_jeda")
    if menit is not None and (isinstance(menit, bool) or not isinstance(menit, int | float)):
        raise ValueError("Task Matcher: menit_sejak_jeda must be a number or null.")
    tugas = masukan.get("tugas")
    if not isinstance(tugas, list):
        raise ValueError("Task Matcher: tugas must be a list.")
    for i, t in enumerate(tugas):
        hari = t.get("hari_ke_tenggat") if isinstance(t, dict) else None
        if (
            not isinstance(t, dict)
            or not TUGAS_FIELDS <= set(t)
            or t.get("id") != f"t{i + 1}"
            or t.get("posisi") != i
            or t.get("sifat") not in SIFAT
            or t.get("beban") not in BEBAN
            or (hari is not None and (isinstance(hari, bool) or not isinstance(hari, int)))
        ):
            raise ValueError(f"Task Matcher: tugas[{i}] must be {{id: t{i + 1}, sifat, beban, hari_ke_tenggat, posisi: {i}}}.")
    return {"fase": masukan["fase"], "jam_rawan": masukan["jam_rawan"], "menit_sejak_jeda": menit, "tugas": tugas}


def untuk_llm(masukan, hasil):
    # What the LLM reads as the user message: the state, the Task Matcher's steps and codes to copy, the chosen
    # task's abstract attributes, and the monotone task the energy fit moved down (only with HINDARI_MONOTON).
    by_id = {t["id"]: t for t in masukan["tugas"]}
    chosen = by_id.get(hasil["tugas_id"])
    dihindari = None
    if "HINDARI_MONOTON" in hasil["kode"]:
        ranked, _ = rank_tasks(masukan["tugas"], hasil["baris"])
        dihindari = best_first(ranked, "base")[0]["task"]["id"]
    return {
        "fase": masukan["fase"],
        "jam_rawan": masukan["jam_rawan"],
        "menit_sejak_jeda": masukan["menit_sejak_jeda"],
        "jumlah_tugas": len(masukan["tugas"]),
        "langkah": hasil["langkah"],
        "tugas_id": hasil["tugas_id"],
        "tugas_terpilih": chosen,
        "tugas_monoton_dihindari": dihindari,
        "kode": hasil["kode"],
        "skor_teratas": hasil["skor"][:SKOR_UNTUK_LLM],
    }


def kueri_kb(hasil):
    return KUERI[hasil["baris"]]


class TaskMatcherComponent(Component):
    display_name = "Task Matcher"
    description = (
        "Equilibre: picks the next hour's steps and task from the energy phase and the abstract tasks t1..tn "
        "(rules and a transparent score, research report §3.4). The LLM after it only explains the choice."
    )
    icon = "list-checks"
    name = "TaskMatcher"

    inputs = [
        MessageTextInput(
            name="masukan",
            display_name="Input (JSON)",
            info="The body of /api/rencana: fase, jam_rawan, menit_sejak_jeda, tugas [{id, sifat, beban, hari_ke_tenggat, posisi}].",
            required=True,
        ),
    ]
    outputs = [
        Output(display_name="Plan (JSON)", name="rencana", method="build_rencana", group_outputs=True),
        Output(display_name="Knowledge search", name="kueri", method="build_kueri", group_outputs=True),
    ]

    def _input_text(self):
        value = self.masukan
        return value.text if isinstance(value, Message) else str(value or "")

    def build_rencana(self) -> Message:
        masukan = read_masukan(self._input_text())
        hasil = match_tasks(masukan)
        self.status = hasil
        return Message(text=json.dumps(untuk_llm(masukan, hasil), ensure_ascii=False))

    def build_kueri(self) -> Message:
        hasil = match_tasks(read_masukan(self._input_text()))
        return Message(text=kueri_kb(hasil))
