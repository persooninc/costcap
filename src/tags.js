// Issue #169: cost attribution tags. Pure helpers shared by the CLI, the
// proxy and the hosted service. Keys [a-z0-9_.-]{1,32}; values 1-64
// printable characters; at most 10 tags per receipt.

export const TAG_KEY = /^[a-z0-9_.-]{1,32}$/;
export const TAG_VALUE = /^[\x20-\x7e]{1,64}$/;
export const MAX_TAGS = 10;
export const TAG_HEADER = "x-costcap-tag";
export const TAG_RULE = `tag keys match [a-z0-9_.-]{1,32}, values are 1-64 printable characters, at most ${MAX_TAGS} tags`;

const fail = (msg) => { const e = new Error(`${msg} (${TAG_RULE})`); e.code = "invalid_tags"; throw e; };

/** Parse one "k=v" pair. Throws with the rule on a bad key or value. */
export function parseTagPair(text) {
  const s = String(text ?? "");
  const i = s.indexOf("=");
  if (i < 0) fail(`tag "${s}" must be key=value`);
  const key = s.slice(0, i).trim(), value = s.slice(i + 1).trim();
  if (!TAG_KEY.test(key)) fail(`invalid tag key "${key}"`);
  if (!TAG_VALUE.test(value)) fail(`invalid value for tag "${key}"`);
  return [key, value];
}

/** Parse a list of "k=v" pairs into an object. Later duplicates win. */
export function parseTagList(pairs) {
  const out = {};
  for (const p of pairs) { const [k, v] = parseTagPair(p); out[k] = v; }
  if (Object.keys(out).length > MAX_TAGS) fail(`too many tags (${Object.keys(out).length})`);
  return out;
}

/** Parse an x-costcap-tag header value: "k=v[,k=v]". Repeated headers arrive comma-joined. */
export function parseTagHeader(value) {
  if (value === undefined || value === null) return null;
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) fail("empty x-costcap-tag header");
  if (parts.length > MAX_TAGS) fail(`too many tags (${parts.length})`);
  return parseTagList(parts);
}

/** Wrapper tags win on a key clash, so an agent cannot relabel what the operator set. */
export function mergeTags(wrapperTags, requestTags) {
  const merged = { ...(requestTags ?? {}), ...(wrapperTags ?? {}) };
  if (Object.keys(merged).length > MAX_TAGS) fail(`too many tags (${Object.keys(merged).length})`);
  return Object.keys(merged).length ? merged : null;
}

/** True when `tags` is absent or a valid tag object (hosted ingest). */
export function validTags(tags) {
  if (tags === undefined) return true;
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return false;
  const entries = Object.entries(tags);
  if (entries.length > MAX_TAGS) return false;
  return entries.every(([k, v]) => TAG_KEY.test(k) && typeof v === "string" && TAG_VALUE.test(v));
}

/** CSV form: k=v;k=v sorted by key. Empty string when untagged. */
export function tagsCell(tags) {
  if (!tags || typeof tags !== "object") return "";
  return Object.keys(tags).sort().map((k) => `${k}=${tags[k]}`).join(";");
}

/** Filter helper: receipt matches every k=v in `want`. */
export function tagsMatch(tags, want) {
  if (!want) return true;
  return Object.entries(want).every(([k, v]) => tags?.[k] === v);
}
