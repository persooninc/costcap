// #194: OpenAI Realtime API (/v1/realtime WebSocket) support, Node built-ins only.
// The proxy relays bytes unchanged both ways; this module holds the RFC 6455 frame
// codec used to tap the upstream's messages (response.done etc.) and to write
// CostCap's own error/close frames.
import { randomBytes } from "node:crypto";

export const REALTIME_PATH = /^\/openai\/v1\/realtime$/;
export const OP = Object.freeze({ CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa });
// A tapped message larger than this is not parsed (it is still relayed unchanged).
export const MAX_TAP_MESSAGE_BYTES = 16 * 1024 * 1024;

export function isRealtimePath(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const pathname = rawUrl.split(/[?#]/, 1)[0];
  if (/%|\\|\/\.{1,2}(?:\/|$)|\/\//.test(pathname)) return false;
  return REALTIME_PATH.test(pathname);
}

// Incremental frame parser: push() raw TCP chunks; onMessage(opcode, payload) fires for
// each complete (defragmented, unmasked) data message and for every control frame.
export function createFrameParser(onMessage, { maxMessageBytes = MAX_TAP_MESSAGE_BYTES } = {}) {
  let buf = Buffer.alloc(0);
  let fragOpcode = null, fragParts = [], fragSize = 0, fragTooBig = false;
  let broken = false;
  const push = (chunk) => {
    if (broken) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) { broken = true; return; }
        len = Number(big); off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const key = buf.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      }
      buf = buf.subarray(off + len);
      if (opcode >= 0x8) { onMessage(opcode, Buffer.from(payload)); continue; }
      if (opcode === OP.CONT) {
        if (fragOpcode === null) continue; // stray continuation: ignore
      } else {
        fragOpcode = opcode; fragParts = []; fragSize = 0; fragTooBig = false;
      }
      fragSize += payload.length;
      if (fragSize > maxMessageBytes) { fragTooBig = true; fragParts = []; }
      else if (!fragTooBig) fragParts.push(Buffer.from(payload));
      if (fin) {
        const op = fragOpcode;
        const whole = fragTooBig ? null : Buffer.concat(fragParts);
        fragOpcode = null; fragParts = []; fragSize = 0; fragTooBig = false;
        if (whole) onMessage(op, whole);
      }
    }
  };
  return { push, get broken() { return broken; } };
}

// One complete frame. Client-to-server frames must be masked (RFC 6455 5.3).
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false, fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = data.length;
  const head = [(fin ? 0x80 : 0) | opcode];
  let ext = Buffer.alloc(0);
  if (len < 126) head.push((mask ? 0x80 : 0) | len);
  else if (len < 65536) { head.push((mask ? 0x80 : 0) | 126); ext = Buffer.alloc(2); ext.writeUInt16BE(len); }
  else { head.push((mask ? 0x80 : 0) | 127); ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(len)); }
  if (!mask) return Buffer.concat([Buffer.from(head), ext, data]);
  const key = randomBytes(4);
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(head), ext, key, out]);
}

export function closePayload(code, reason = "") {
  const r = Buffer.from(reason, "utf8").subarray(0, 123);
  const b = Buffer.alloc(2 + r.length);
  b.writeUInt16BE(code);
  r.copy(b, 2);
  return b;
}

export function costcapErrorEvent(code, message) {
  return JSON.stringify({ type: "error", error: { type: "costcap", code, ...(message && { message }) } });
}

// Headers forwarded to the upstream handshake: x-costcap-* and Sec-WebSocket-Extensions
// are stripped (no permessage-deflate, so the tap can read frames); Host is the upstream's.
export function upstreamHandshakeHeaders(headers, host) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key.startsWith("x-costcap-") || key === "sec-websocket-extensions" || key === "host" || key === "content-length") continue;
    out[key] = v;
  }
  out.host = host;
  return out;
}

// Raw HTTP response on a socket that never upgraded (refusals, 501, upstream rejections).
export function writeHttpResponse(socket, status, body, headers = {}) {
  if (socket.destroyed) return;
  const text = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const data = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const reason = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable" }[status] ?? "Error";
  const all = { "content-type": "application/json", ...headers, "content-length": String(data.length), connection: "close" };
  const lines = [`HTTP/1.1 ${status} ${reason}`, ...Object.entries(all).map(([k, v]) => `${k}: ${v}`), "", ""];
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), data]));
}
