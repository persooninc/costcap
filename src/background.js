// OpenAI Responses background mode (#196). Pure helpers: exact-path matchers,
// body status/id classification and an SSE tracker for response ids and status.
// A queued/in_progress create has no usage; its cost is known only when a read
// (retrieve, cancel or resumed stream) returns a terminal status.

const unsafe = (pathname) => /%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname);
const pathOf = (rawUrl) => {
  if (typeof rawUrl !== "string") return null;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  return unsafe(pathname) ? null : pathname;
};
const ID_RE = /^[A-Za-z0-9_-]+$/;

export const PENDING_STATUSES = new Set(["queued", "in_progress"]);
export const TERMINAL_STATUSES = new Set(["completed", "incomplete", "failed", "cancelled"]);

/** True for an exact OpenAI Responses create (POST /openai/v1/responses). */
export function isResponsesCreate(method, rawUrl) {
  return method === "POST" && pathOf(rawUrl) === "/openai/v1/responses";
}

/** { kind: "retrieve" | "cancel", id } for a Responses read that can settle a background response, else null. */
export function responsesReadPath(method, rawUrl) {
  const p = pathOf(rawUrl);
  if (!p) return null;
  let m;
  if (method === "GET" && (m = /^\/openai\/v1\/responses\/([A-Za-z0-9_-]+)$/.exec(p)) && m[1] !== "input_tokens") return { kind: "retrieve", id: m[1] };
  if (method === "POST" && (m = /^\/openai\/v1\/responses\/([A-Za-z0-9_-]+)\/cancel$/.exec(p))) return { kind: "cancel", id: m[1] };
  return null;
}

/** True when a request body asks for background mode. */
export function requestsBackground(body) {
  try { return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body))?.background === true; } catch { return false; }
}

/** { id, status } from a Responses object body (id null when missing/unsafe). */
export function responseState(raw) {
  let b;
  try { b = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw)); } catch { return { id: null, status: null }; }
  return { id: typeof b?.id === "string" && ID_RE.test(b.id) ? b.id : null, status: typeof b?.status === "string" ? b.status : null };
}

/** Tracks a Responses SSE stream: the response id (from any event's `response`) and the terminal status. */
export function createResponsesStreamTracker() {
  let buf = "", id = null, terminal = null;
  const take = (event) => {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      let c;
      try { c = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (!c || typeof c.type !== "string") continue;
      const r = c.response;
      if (!id && typeof r?.id === "string" && ID_RE.test(r.id)) id = r.id;
      const m = /^response\.(completed|incomplete|failed|cancelled)$/.exec(c.type);
      if (m) terminal = m[1];
    }
  };
  return {
    push(text) {
      buf += text;
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) break;
        take(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
      }
      if (buf.length > 1 << 20) buf = "";
    },
    end() { if (buf) take(buf); buf = ""; },
    get id() { return id; },
    get terminal() { return terminal; },
  };
}
