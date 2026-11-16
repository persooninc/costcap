// Issue #220: a small Prometheus text-format (0.0.4) parser/validator for tests.
// Throws on any malformed line; returns [{ name, labels, value }].
const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function parseProm(text) {
  if (!text.endsWith("\n")) throw new Error("body must end with a newline");
  const out = [], typed = new Map(), helped = new Set(), seen = new Set();
  for (const line of text.slice(0, -1).split("\n")) {
    if (line.startsWith("# HELP ")) { const n = line.slice(7).split(" ")[0]; if (!NAME.test(n)) throw new Error(`bad HELP ${line}`); helped.add(n); continue; }
    if (line.startsWith("# TYPE ")) {
      const [n, t] = line.slice(7).split(" ");
      if (!NAME.test(n) || !["gauge", "counter", "untyped", "summary", "histogram"].includes(t)) throw new Error(`bad TYPE ${line}`);
      if (typed.has(n)) throw new Error(`duplicate TYPE ${n}`);
      typed.set(n, t); continue;
    }
    if (line === "" || line.startsWith("#")) throw new Error(`unexpected line ${JSON.stringify(line)}`);
    let i = 0;
    while (i < line.length && line[i] !== "{" && line[i] !== " ") i += 1;
    const name = line.slice(0, i);
    if (!NAME.test(name)) throw new Error(`bad name ${line}`);
    if (!typed.has(name) || !helped.has(name)) throw new Error(`${name} has no HELP/TYPE`);
    const labels = {};
    if (line[i] === "{") {
      i += 1;
      while (line[i] !== "}") {
        const eq = line.indexOf("=", i);
        const key = line.slice(i, eq);
        if (!LABEL.test(key) || line[eq + 1] !== '"') throw new Error(`bad label ${line}`);
        let j = eq + 2, v = "";
        for (;;) {
          const c = line[j];
          if (c === undefined) throw new Error(`unterminated label ${line}`);
          if (c === "\\") { const e = line[j + 1]; if (e === "n") v += "\n"; else if (e === "\\" || e === '"') v += e; else throw new Error(`bad escape ${line}`); j += 2; continue; }
          if (c === '"') break;
          v += c; j += 1;
        }
        labels[key] = v;
        i = j + 1;
        if (line[i] === ",") i += 1;
        else if (line[i] !== "}") throw new Error(`bad label separator ${line}`);
      }
      i += 1;
    }
    if (line[i] !== " ") throw new Error(`missing value ${line}`);
    const raw = line.slice(i + 1);
    const value = raw === "+Inf" ? Infinity : raw === "-Inf" ? -Infinity : Number(raw);
    if (raw === "" || (Number.isNaN(value) && raw !== "NaN")) throw new Error(`bad value ${line}`);
    const id = `${name}${JSON.stringify(Object.entries(labels).sort())}`;
    if (seen.has(id)) throw new Error(`duplicate series ${line}`);
    seen.add(id);
    out.push({ name, labels, value });
  }
  return out;
}

export function find(rows, name, labels = {}) {
  return rows.filter((r) => r.name === name && Object.entries(labels).every(([k, v]) => r.labels[k] === v));
}
export function value(rows, name, labels) {
  const hits = find(rows, name, labels);
  if (hits.length !== 1) throw new Error(`${name} ${JSON.stringify(labels)} matched ${hits.length}`);
  return hits[0].value;
}
