# Cross-check of the Langflow component Task Matcher (komponen/task_matcher.py) against the reference cases in
# web/src/taskMatcher.fixtures.json, which web/src/taskMatcher.ts passes too (taskMatcher.test.ts). No Langflow,
# no LLM, no network: the component file is run without its lfx imports and its component class, the way
# Langflow 1.12.2 runs its top-level functions (lfx/custom/validate.py prepare_global_scope), so a rule that
# needed lfx would fail here.
# Usage (from equilibre/): python -I langflow-flows/uji-task-matcher.py [path to a task_matcher.py]
#   the path is for the mutation check (a copy with one rule broken must fail)
import ast
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMPONENT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE / "komponen" / "task_matcher.py"
FIXTURES = HERE.parent / "web" / "src" / "taskMatcher.fixtures.json"


def load_rules(path):
    module = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    kept = []
    dropped = []
    for node in module.body:
        is_lfx = isinstance(node, ast.ImportFrom) and (node.module or "").split(".")[0] == "lfx"
        is_component = isinstance(node, ast.ClassDef) and any(
            isinstance(b, ast.Name) and "Component" in b.id for b in node.bases
        )
        if is_lfx or is_component:
            dropped.append(node)
        else:
            kept.append(node)
    if not any(isinstance(n, ast.ClassDef) for n in dropped) or not any(isinstance(n, ast.ImportFrom) for n in dropped):
        sys.exit(f"{path}: expected the lfx imports and one Component class to drop")
    scope = {"__name__": "task_matcher_rules"}
    exec(compile(ast.Module(body=kept, type_ignores=[]), str(path), "exec"), scope)
    return scope


def same(a, b):
    # Exact equality, with JSON's 1 equal to Python's 1.0 but true never equal to 1 (bool is an int in Python).
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b and type(a) in (int, float, str, type(None)) and type(b) in (int, float, str, type(None))


rules = load_rules(COMPONENT)
cases = json.loads(FIXTURES.read_text(encoding="utf-8"))["kasus"]
failed = []
for case in cases:
    masukan = case["masukan"]
    # Through the component's own input reading, as in Langflow: the server sends JSON text.
    got = rules["match_tasks"](rules["read_masukan"](json.dumps(masukan)))
    if not same(got, case["keluaran"]):
        failed.append(case["nama"])
        print(f"BEDA  {case['nama']}\n  python: {json.dumps(got, ensure_ascii=False)}\n  fixture: {json.dumps(case['keluaran'], ensure_ascii=False)}")
        continue
    # What the LLM reads must carry the steps and the task as chosen, and the search must be one of the four.
    llm = rules["untuk_llm"](masukan, got)
    assert llm["langkah"] == got["langkah"] and llm["tugas_id"] == got["tugas_id"], case["nama"]
    assert (llm["tugas_monoton_dihindari"] is not None) == ("HINDARI_MONOTON" in got["kode"]), case["nama"]
    assert rules["kueri_kb"](got) in rules["KUERI"].values(), case["nama"]
    json.dumps(llm)

# Negative controls for the input check: each must be refused with a ValueError, not scored.
base = cases[0]["masukan"]
bad = {
    "not JSON": "{fase: siap fokus}",
    "unknown phase": json.dumps({**base, "fase": "capek"}),
    "jam_rawan as text": json.dumps({**base, "jam_rawan": "ya"}),
    "id out of order": json.dumps({**base, "tugas": [{**base["tugas"][0], "id": "t2"}]}),
    "a title riding along as sifat": json.dumps({**base, "tugas": [{**base["tugas"][0], "sifat": "Write the Q3 report"}]}),
    "missing hari_ke_tenggat": json.dumps({**base, "tugas": [{k: v for k, v in base["tugas"][0].items() if k != "hari_ke_tenggat"}]}),
}
not_refused = []
for name, text in bad.items():
    try:
        rules["read_masukan"](text)
        not_refused.append(name)
    except ValueError:
        pass

ok = len(cases) - len(failed)
print(f"Task Matcher Python vs fixtures: {ok}/{len(cases)} sama; input buruk ditolak {len(bad) - len(not_refused)}/{len(bad)}"
      + (f"; TIDAK ditolak: {', '.join(not_refused)}" if not_refused else ""))
sys.exit(1 if failed or not_refused else 0)
