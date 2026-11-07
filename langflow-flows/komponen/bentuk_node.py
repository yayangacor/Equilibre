# Prints the Langflow node (frontend node dict) for a custom component file, as Langflow 1.12.2 builds it when
# the code is pasted into a Custom Component: lfx's own build_custom_component_template, the function behind
# POST /api/v1/custom_component. Runs in the Python of the Langflow install (it needs lfx), offline: no
# Langflow server, no database, no network, no LLM. buat-rencana.mjs calls it to put the Task Matcher node into
# rencana_kerja.json, so the template, outputs and code hash in the export are the ones Langflow would make.
# Usage: <Langflow venv python> -I langflow-flows/komponen/bentuk_node.py langflow-flows/komponen/task_matcher.py
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("DO_NOT_TRACK", "true")
os.environ.setdefault("LANGFLOW_DO_NOT_TRACK", "true")

from lfx.custom.custom_component.component import Component  # noqa: E402
from lfx.custom.utils import build_custom_component_template  # noqa: E402

code = Path(sys.argv[1]).read_text(encoding="utf-8")
node, instance = build_custom_component_template(Component(_code=code))
node_type = instance.name or type(instance).__name__
json.dump({"type": node_type, "node": node}, sys.stdout, ensure_ascii=True)
