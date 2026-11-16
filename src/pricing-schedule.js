// Effective-dated pricing schedules (#236). Pure helpers shared by pricing.js and the digest check.

// #236: effective-dated rows. A model row may carry `effective: [{from: "YYYY-MM-DD", ...rates}]`
// (ascending); from 00:00 UTC on `from` the listed fields replace the base row's. An entry
// `{from, billed_as: id}` prices the model exactly as that id at the same instant.
export function dayOf(at) {
  const d = at === undefined || at === null ? new Date() : new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid pricing instant: ${at}`);
  return d.toISOString().slice(0, 10);
}

/** The row in effect for table id on a UTC day: { row, rates_effective_from, billed_as }. Pure. */
export function datedRow(tbl, id, day, depth = 0) {
  const { effective, ...base } = tbl.models[id];
  let row = base, from = null, billed = null;
  if (!Array.isArray(effective)) return { row, rates_effective_from: null, billed_as: null };
  for (const e of effective) {
    if (e.from > day) break;
    const { from: f, billed_as: b, ...rates } = e;
    if (b !== undefined) {
      if (depth > 16) throw new Error(`pricing table: billed_as chain too deep at ${id}`);
      const t = datedRow(tbl, b, day, depth + 1);
      row = { ...t.row, ...rates };
      billed = b;
      from = t.rates_effective_from && t.rates_effective_from > f ? t.rates_effective_from : f;
    } else { row = { ...row, ...rates }; from = f; }
  }
  return { row, rates_effective_from: from, billed_as: billed };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDay = (s) => {
  if (typeof s !== "string" || !ISO_DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Validates every `effective` schedule. Returns null or an error string. Pure. */
export function validateSchedules(tbl) {
  const models = tbl?.models && typeof tbl.models === "object" ? tbl.models : {};
  const edges = {};
  for (const [id, row] of Object.entries(models)) {
    if (row?.effective === undefined) continue;
    if (!Array.isArray(row.effective) || !row.effective.length) return `${id}: effective must be a non-empty array`;
    let prev = null;
    for (const e of row.effective) {
      if (!e || typeof e !== "object" || Array.isArray(e)) return `${id}: effective entries must be objects`;
      if (!isIsoDay(e.from)) return `${id}: effective from "${e?.from}" is not an ISO date (YYYY-MM-DD)`;
      if (prev !== null && e.from === prev) return `${id}: duplicate effective from ${e.from}`;
      if (prev !== null && e.from < prev) return `${id}: effective from ${e.from} is not in ascending order`;
      prev = e.from;
      const rest = Object.keys(e).filter((k) => k !== "from" && k !== "billed_as");
      if (e.billed_as !== undefined) {
        if (typeof e.billed_as !== "string" || !Object.hasOwn(models, e.billed_as)) return `${id}: billed_as "${e.billed_as}" is not a model in the table`;
        (edges[id] ??= []).push(e.billed_as);
      } else if (!rest.length) return `${id}: effective entry from ${e.from} has neither rates nor billed_as`;
    }
  }
  const state = {};
  const visit = (id, path) => {
    if (state[id] === 1) return `billed_as cycle: ${[...path, id].join(" -> ")}`;
    if (state[id] === 2) return null;
    state[id] = 1;
    for (const n of edges[id] ?? []) { const err = visit(n, [...path, id]); if (err) return err; }
    state[id] = 2;
    return null;
  };
  for (const id of Object.keys(edges)) { const err = visit(id, []); if (err) return err; }
  return null;
}
