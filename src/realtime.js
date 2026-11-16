// #194: OpenAI Realtime API (/v1/realtime WebSocket) support. Node built-ins only.
// A minimal RFC 6455 frame codec used as a side tap: frames are relayed byte-for-byte,
// and complete text messages are parsed to meter `response.done` usage.

export const REALTIME_PATH = /^\/openai\/v1\/realtime\/?$/;

import { randomBytes } from "node:crypto";

const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Encodes one frame. Client-to-server frames must be masked (RFC 6455 5.3). */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  const head = [((fin ? 0x80 : 0) | (opcode & 0x0f))];
  const m = mask ? 0x80 : 0;
  let ext = Buffer.alloc(0);
  if (len < 126) head.push(m | len);
  else if (len < 65536) { head.push(m | 126); ext = Buffer.alloc(2); ext.writeUInt16BE(len); }
  else { head.push(m | 127); ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(len)); }
  if (!mask) return Buffer.concat([Buffer.from(head), ext, data]);
  const key = randomBytes(4);
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i & 3];
  return Buffer.concat([Buffer.from(head), ext, key, out]);
}

/** Close frame payload: 2-byte code plus a UTF-8 reason (truncated to fit 125 bytes). */
export function closePayload(code, reason = "") {
  const r = Buffer.from(reason).subarray(0, 123);
  const b = Buffer.alloc(2 + r.length);
  b.writeUInt16BE(code);
  r.copy(b, 2);
  return b;
}

/**
 * Incremental frame parser. push(bytes) returns the complete frames found so far, each
 * { raw, fin, opcode, payload, message } where `message` is set on the frame that completes
 * a (possibly fragmented) data message: { opcode, data }. Partial frames stay buffered.
 */
export function createFrameParser({ maxMessageBytes = 16 * 1024 * 1024 } = {}) {
  let buf = Buffer.alloc(0);
  let fragOpcode = null, frags = [], fragSize = 0;
  let corrupt = false;
  const push = (bytes) => {
    if (corrupt) return [];
    buf = buf.length ? Buffer.concat([buf, bytes]) : Buffer.from(bytes);
    const frames = [];
    for (;;) {
      if (buf.length < 2) break;
      const b0 = buf[0], b1 = buf[1];
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (buf.length < 10) break;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(maxMessageBytes)) { corrupt = true; break; }
        len = Number(big); off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const keyOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) break;
      const raw = buf.subarray(0, off + len);
      let payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) { const key = buf.subarray(keyOff, keyOff + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3]; }
      buf = buf.subarray(off + len);
      const fin = (b0 & 0x80) !== 0, opcode = b0 & 0x0f;
      const frame = { raw: Buffer.from(raw), fin, opcode, payload };
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        if (opcode !== 0x0) { fragOpcode = opcode; frags = []; fragSize = 0; }
        if (fragOpcode !== null) {
          frags.push(payload);
          fragSize += payload.length;
          if (fragSize > maxMessageBytes) { corrupt = true; frames.push(frame); break; }
          if (fin) { frame.message = { opcode: fragOpcode, data: Buffer.concat(frags) }; fragOpcode = null; frags = []; fragSize = 0; }
        }
      }
      frames.push(frame);
    }
    return frames;
  };
  return { push, get corrupt() { return corrupt; }, get pending() { return buf.length; } };
}

/**
 * Realtime usage (response.done `response.usage`) -> the proxy's usage shape. Realtime uses
 * input_token_details / output_token_details (singular "token") with a cached_tokens_details
 * split. Returns null when the required counters are missing.
 */
export function realtimeUsage(u) {
  if (!u || typeof u !== "object" || !isCount(u.input_tokens) || !isCount(u.output_tokens)) return null;
  const n = (v) => (isCount(v) ? v : 0);
  const itd = u.input_token_details && typeof u.input_token_details === "object" ? u.input_token_details : {};
  const otd = u.output_token_details && typeof u.output_token_details === "object" ? u.output_token_details : {};
  const cached = Math.min(n(itd.cached_tokens), u.input_tokens);
  const ctd = itd.cached_tokens_details && typeof itd.cached_tokens_details === "object" ? itd.cached_tokens_details : null;
  const cAudio = ctd ? n(ctd.audio_tokens) : 0, cImage = ctd ? n(ctd.image_tokens) : 0;
  const cachedSlice = { text: Math.max(0, cached - cAudio - cImage), image: cImage, audio: cAudio, video: 0 };
  const iAudio = n(itd.audio_tokens), iImage = n(itd.image_tokens);
  const allSlice = { text: Math.max(0, u.input_tokens - iAudio - iImage), image: iImage, audio: iAudio, video: 0 };
  const input = Object.fromEntries(Object.keys(allSlice).map((k) => [k, Math.max(0, allSlice[k] - cachedSlice[k])]));
  const oAudio = n(otd.audio_tokens);
  const output = { text: Math.max(0, u.output_tokens - oAudio), image: 0, audio: oAudio, video: 0 };
  const usage = { input_tokens: u.input_tokens - cached, cached_input_tokens: cached, output_tokens: u.output_tokens };
  const nonText = (s) => s.image + s.audio + s.video;
  if (nonText(input) + nonText(cachedSlice) + nonText(output) > 0) usage.modality_tokens = { input, cached_input: cachedSlice, output };
  return usage;
}

/** Writes a plain HTTP JSON response on a raw upgrade socket and closes it. */
export function writeHttpJson(socket, status, body, headers = {}) {
  if (socket.destroyed) return;
  const text = JSON.stringify(body);
  const reason = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable" }[status] ?? "Error";
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  socket.end(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(text)}\r\nconnection: close\r\n${extra}\r\n${text}`);
}
