// What export.mjs writes for a flow, and the field-by-field comparison cek-flow.mjs --penuh makes
// between a live flow and its export. The live side goes through exportedPart too, so a live flow
// that equals its export compares equal.

// Langflow keys (sk-...), OpenRouter keys (sk-or-...), Google AI Studio keys (AIza... and the newer
// AQ.... format), bearer tokens.
export const KEY_PATTERN = /sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{35}|AQ\.[A-Za-z0-9_-]{30,}|Bearer\s+[A-Za-z0-9._-]{20,}/;

// The exported fields of a flow. Password fields either reference a Global Variable by name
// (load_from_db) or hold a raw secret: the references stay, raw secrets are blanked in place.
export function exportedPart(flow) {
  let blanked = 0;
  for (const node of flow.data?.nodes ?? []) {
    for (const field of Object.values(node.data?.node?.template ?? {})) {
      if (field && typeof field === "object" && field.password && !field.load_from_db && field.value) {
        field.value = "";
        blanked++;
      }
    }
  }
  const { id, name, description, data, endpoint_name, mcp_enabled, action_name, action_description } = flow;
  return { part: { id, name, description, endpoint_name, mcp_enabled, action_name, action_description, data }, blanked };
}

// Every value that differs between two exported parts, and how many values were compared. Nodes and
// edges are matched by id, not by position, so a path reads
// "nodes.Knowledge-panduan.data.node.template.include_metadata.show". The canvas viewport is left
// out: panning the editor moves it and nothing reads it at run time. An array whose length changed
// counts as one value.
export function diffFlows(live, exported) {
  const diffs = [];
  let compared = 0;
  const walk = (a, b, path) => {
    const objects = a !== null && b !== null && typeof a === "object" && typeof b === "object";
    if (!objects || Array.isArray(a) !== Array.isArray(b) || (Array.isArray(a) && a.length !== b.length)) {
      compared++;
      if (!Object.is(a, b)) diffs.push({ path, live: a, ekspor: b });
      return;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${path}.${k}`);
  };
  const byId = (items) => Object.fromEntries((items ?? []).map((x) => [x.id, x]));
  const split = ({ data = {}, ...flow }) => {
    const { nodes, edges, viewport: _viewport, ...rest } = data;
    return { flow: { ...flow, data: rest }, nodes: byId(nodes), edges: byId(edges) };
  };
  const l = split(live);
  const e = split(exported);
  walk(l.flow, e.flow, "flow");
  walk(l.nodes, e.nodes, "nodes");
  walk(l.edges, e.edges, "edges");
  return { diffs, compared };
}

const SECRET_NAME = /api_?key|token|password|secret/i;
const KEY_PATTERN_ALL = new RegExp(KEY_PATTERN.source, "g");

// A value as printed next to a difference: no text under a secret-named field, nothing shaped like
// a key, at most 90 characters. Booleans and numbers (a flipped `show`) are always printed.
export function describeValue(path, value) {
  if (value === undefined) return "(tidak ada)";
  if (SECRET_NAME.test(path) && (typeof value === "string" || typeof value === "object")) return "(field rahasia, tidak dicetak)";
  const hide = (key, v) => (SECRET_NAME.test(key) && typeof v !== "boolean" && typeof v !== "number" ? "(rahasia)" : v);
  const s = JSON.stringify(value, hide).replace(KEY_PATTERN_ALL, "[mirip API key]");
  if (s.length <= 90) return s;
  return `${s.slice(0, 90)}… (${Array.isArray(value) ? `${value.length} item` : `${s.length} karakter`})`;
}
