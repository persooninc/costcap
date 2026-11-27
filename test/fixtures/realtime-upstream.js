// #194: fake OpenAI Realtime upstream (node:http `upgrade`) and a minimal WebSocket client.
// Node 20 has no global WebSocket, so both sides use the codec in src/realtime.js.
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { OP, closePayload, createFrameParser, encodeFrame } from "../../src/realtime.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptFor = (key) => createHash("sha1").update(key + GUID).digest("base64");

/**
 * startRealtimeUpstream({ onSession(conn, req) }) -> { url, port, upgrades, requests, sessions, close }.
 * conn.send(obj | Buffer raw) writes server frames; conn.received holds client messages; conn.closed resolves on close.
 * #273: serves /v1/live/sessions too; set conn.closeSeconds = () => n to answer session.close with session.closed.
 */
export async function startRealtimeUpstream({ onSession = () => {}, reject = null } = {}) {
  const state = { upgrades: 0, requests: 0, sessions: [], handshakes: [] };
  // Plain HTTP calls (e.g. chat completions) get a small metered body so one host serves both.
  const server = http.createServer((req, res) => {
    state.requests++;
    req.resume();
    req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
  });
  server.on("upgrade", (req, socket) => {
    state.upgrades++;
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept(req.headers["sec-websocket-key"])}`, "", ""].join("\r\n"));
    const parser = createFrameParser();
    let resolveClosed;
    const conn = {
      socket, received: [], frames: [], req,
      closed: new Promise((r) => { resolveClosed = r; }),
      send(ev) { if (!socket.destroyed) socket.write(Buffer.isBuffer(ev) ? ev : encodeFrame(1, JSON.stringify(ev))); },
    };
    socket.on("data", (b) => {
      for (const f of parser.push(b)) {
        conn.frames.push(f);
        if (f.message?.opcode === 1) {
          const msg = JSON.parse(f.message.data.toString());
          conn.received.push(msg);
          // #273: a GPT-Live upstream answers session.close with session.closed (usage.seconds).
          if (msg.type === "session.close" && typeof conn.closeSeconds === "function") {
            const s = conn.closeSeconds();
            if (s != null) conn.send({ type: "session.closed", session: { id: conn.sessionId ?? "sess_live" }, usage: { seconds: s } });
          }
        }
        if (f.opcode === 8 && !socket.destroyed) socket.end();
      }
    });
    socket.on("error", () => {});
    if (reject) {
      const body = JSON.stringify(reject.body ?? { error: { message: "bad key" } });
      socket.end(`HTTP/1.1 ${reject.status} Rejected\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      return;
    }
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptFor(req.headers["sec-websocket-key"])}`, "", ""].join("\r\n"));
    const conn = { messages: [], closed: false, socket, req };
    conn.send = (msg) => { if (!socket.destroyed) socket.write(Buffer.isBuffer(msg) ? msg : encodeFrame(OP.TEXT, JSON.stringify(msg))); };
    conn.close = () => socket.end(encodeFrame(OP.CLOSE, closePayload(1000)));
    const parser = createFrameParser((op, payload) => {
      if (op === OP.TEXT) conn.messages.push(JSON.parse(payload.toString("utf8")));
      if (op === OP.CLOSE) conn.gotClose = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    });
    socket.on("data", (c) => parser.push(c));
    socket.on("end", () => socket.end());
    socket.on("close", () => { conn.closed = true; });
    state.conns.push(conn);
    onConnection(conn, req);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { ...state, state, port: server.address().port, url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections?.(); for (const c of state.conns) c.socket.destroy(); server.close(); } };
}

// Raw client handshake. Resolves with { status, headers, body } for a refusal or an open socket client.
export function connectRealtime(port, path = "/openai/v1/realtime?model=gpt-realtime", extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    const headers = { Host: `127.0.0.1:${port}`, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13",
      Authorization: "Bearer sk-test", "OpenAI-Beta": "realtime=v1", ...extraHeaders };
    socket.write([`GET ${path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n"));
    let buf = Buffer.alloc(0), settled = false;
    const client = { raw: [], messages: [], frames: [], closeCode: null, socket };
    const parser = createFrameParser((op, payload) => {
      client.frames.push({ op, payload });
      if (op === OP.TEXT) client.messages.push(JSON.parse(payload.toString("utf8")));
      if (op === OP.CLOSE) client.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    });
    client.closed = new Promise((r) => socket.on("close", r));
    client.send = (obj) => socket.write(encodeFrame(OP.TEXT, JSON.stringify(obj), { mask: true }));
    client.waitFor = async (pred, ms = 3000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (pred(client)) return true; await new Promise((r) => setTimeout(r, 10)); }
      throw new Error("timed out waiting for client condition");
    };
    socket.on("error", (e) => { if (!settled) { settled = true; reject(e); } });
    socket.on("data", (chunk) => {
      if (settled && client.status === 101) { client.raw.push(chunk); parser.push(chunk); return; }
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const [statusLine, ...lines] = buf.subarray(0, end).toString("latin1").split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      const hdrs = Object.fromEntries(lines.map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; }));
      const rest = buf.subarray(end + 4);
      if (status === 101) {
        settled = true;
        Object.assign(client, { status, headers: hdrs, accepted: hdrs["sec-websocket-accept"] === acceptFor(key) });
        if (rest.length) { client.raw.push(rest); parser.push(rest); }
        resolve(client);
      } else {
        const len = Number(hdrs["content-length"] ?? 0);
        if (rest.length < len) return;
        settled = true;
        socket.destroy();
        resolve({ status, headers: hdrs, body: JSON.parse(rest.subarray(0, len).toString("utf8") || "null") });
      }
    });
  });
}

// AC1 usage: $0.053800 on gpt-realtime.
export const AC1_USAGE = {
  total_tokens: 1900, input_tokens: 1300, output_tokens: 600,
  input_token_details: { text_tokens: 300, audio_tokens: 1000, image_tokens: 0, cached_tokens: 500, cached_tokens_details: { text_tokens: 100, audio_tokens: 400, image_tokens: 0 } },
  output_token_details: { text_tokens: 100, audio_tokens: 500 },
};
export const responseDone = (id, usage = AC1_USAGE) => ({ type: "response.done", event_id: `ev_${id}`, response: { id, object: "realtime.response", status: "completed", usage } });
