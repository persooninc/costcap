// FA-CC-04: maps the hosted store state to (kind, id, orgId, body) records and back.
// Pure and portable: no I/O. Used by the Postgres adapter; any row store can reuse it.
//
// State shape: { version, <kind>: { [id]: body } | body[] }. Object maps become one
// record per key. Arrays (the append-only audit log) become one record per index.
// Scalars live under kind "_meta". Every record carries the organization it belongs
// to (null for system records such as sessions and sign-in challenges) so the
// database can enforce tenant isolation with row-level security.

export const META_KIND = "_meta";
const PAD = 12;

/** Organization a record belongs to, or null for system records. */
export function recordOrg(kind, id, body) {
  if (kind === "orgs") return String(id);
  const org = body?.orgId ?? body?.org_id;
  return typeof org === "string" && org ? org : null;
}

/** @returns {Map<string, { kind: string, id: string, orgId: string|null, body: any, json: string }>} keyed by `${kind}\u0000${id}` */
export function toRecords(state) {
  const out = new Map();
  const put = (kind, id, body) => {
    const json = JSON.stringify(body);
    out.set(`${kind}\u0000${id}`, { kind, id, orgId: recordOrg(kind, id, body), body, json });
  };
  for (const [kind, value] of Object.entries(state)) {
    if (Array.isArray(value)) value.forEach((body, i) => put(kind, `#${String(i).padStart(PAD, "0")}`, body));
    else if (value && typeof value === "object") for (const [id, body] of Object.entries(value)) put(kind, id, body);
    else put(META_KIND, kind, value);
  }
  return out;
}

/** Rebuild state from rows ({ kind, id, body }). `empty` supplies collections that have no rows yet. */
export function fromRecords(rows, empty) {
  const state = structuredClone(empty);
  const arrays = new Map();
  for (const { kind, id, body } of rows) {
    if (kind === META_KIND) { state[id] = body; continue; }
    if (id.startsWith("#")) {
      if (!arrays.has(kind)) arrays.set(kind, []);
      arrays.get(kind).push([id, body]);
      continue;
    }
    if (!state[kind] || Array.isArray(state[kind])) state[kind] = {};
    state[kind][id] = body;
  }
  for (const [kind, items] of arrays) state[kind] = items.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, body]) => body);
  return state;
}

/**
 * Changes from `prev` to `next`.
 * @returns {{ upserts: Array<{kind,id,orgId,body,json}>, deletes: Array<{kind,id,orgId}> }}
 */
export function diffRecords(prev, next) {
  const upserts = [], deletes = [];
  for (const [key, rec] of next) {
    const old = prev.get(key);
    // A record that moves between organizations is deleted under the old scope first,
    // because row-level security never lets one tenant scope rewrite another's row.
    if (old && old.orgId !== rec.orgId) deletes.push({ kind: old.kind, id: old.id, orgId: old.orgId });
    if (!old || old.json !== rec.json || old.orgId !== rec.orgId) upserts.push(rec);
  }
  for (const [key, old] of prev) if (!next.has(key)) deletes.push({ kind: old.kind, id: old.id, orgId: old.orgId });
  return { upserts, deletes };
}
