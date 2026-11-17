// #194: fake OpenAI Realtime upstream on node:http `upgrade` plus a tiny client (Node 20 has no global WebSocket).
import http from "node:http";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { createFrameParser, encodeFrame } from "../../src/realtime.js";

const accept = (key) => createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC11B65").digest("base64");

/**
 * startRealtimeUpstream({ onSession(conn, req) }) -> { url, port, upgrades, requests, sessions, close }.
 * conn.send(obj | Buffer raw) writes server frames; conn.received holds client messages; conn.closed resolves on close.
 */
export async function startRealtimeUpstream({ onSession = () => {}, onMessage = () => {}, reject = null, maxMessageBytes } = {}) {
  const state = { upgrades: 0, requests: 0, sessions: [], handshakes: [] };
  // Plain HTTP calls (e.g. chat completions) get a small metered body so one host serves both.
  const server = http.createServer((req, res) => {
    state.requests++;
    req.resume();
    req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "gpt-4o-mini", usage: { prompt_tokens: 1, completion_tokens: 1 } })); });
  });
  server.on("upgrade", (req, socket) => {
    state.handshakes.push({ url: req.url, headers: req.headers });
    if (reject) { socket.end(`HTTP/1.1 ${reject.status} X\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify(reject.body)}`); return; }
    state.upgrades++;
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept(req.headers["sec-websocket-key"])}`, "", ""].join("\r\n"));
    const parser = createFrameParser(maxMessageBytes ? { maxMessageBytes } : {});
    let resolveClosed;
    const conn = {
      socket, received: [], frames: [], req,
      closed: new Promise((r) => { resolveClosed = r; }),
      send(ev) { if (!socket.destroyed) socket.write(Buffer.isBuffer(ev) ? ev : encodeFrame(1, JSON.stringify(ev))); },
    };
    socket.on("data", (b) => {
      for (const f of parser.push(b)) {
        conn.frames.push(f);
        if (f.message?.opcode === 1) { const m = JSON.parse(f.message.data.toString()); conn.received.push(m); onMessage(conn, m); }
        if (f.opcode === 8 && !socket.destroyed) socket.end();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => resolveClosed());
    state.sessions.push(conn);
    onSession(conn, req);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return Object.assign(state, { port, url: `http://127.0.0.1:${port}`,
    close: () => { for (const s of state.sessions) s.socket.destroy(); server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } });
}

/** Minimal client: connect(port, path, headers) -> { status, headers, body, messages, frames, send, close, closed, waitFor }. */
export function connectRealtime(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const key = randomBytes(16).toString("base64");
    socket.on("error", reject);
    socket.on("connect", () => {
      const h = { Host: `127.0.0.1:${port}`, Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13", ...headers };
      socket.write(`GET ${path} HTTP/1.1\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), handshake = null;
    const parser = createFrameParser();
    let resolveClosed;
    const c = { socket, messages: [], frames: [], rawBytes: [], closeCode: null, closed: new Promise((r) => { resolveClosed = r; }),
      send(ev) { socket.write(encodeFrame(1, JSON.stringify(ev), { mask: true })); },
      close() { socket.destroy(); },
      waitFor(pred, ms = 3000) {
        return new Promise((res, rej) => {
          const t0 = Date.now();
          const tick = () => { const m = c.messages.find(pred); if (m) return res(m); if (Date.now() - t0 > ms) return rej(new Error("timeout waiting for message")); setTimeout(tick, 10); };
          tick();
        });
      } };
    const onFrames = (bytes) => {
      c.rawBytes.push(bytes);
      for (const f of parser.push(bytes)) {
        c.frames.push(f);
        if (f.message?.opcode === 1) { try { c.messages.push(JSON.parse(f.message.data.toString())); } catch { /* non-JSON text */ } }
        if (f.opcode === 8) c.closeCode = f.payload.readUInt16BE(0);
      }
    };
    socket.on("data", (b) => {
      if (handshake) return onFrames(b);
      buf = Buffer.concat([buf, b]);
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      const [statusLine, ...lines] = buf.subarray(0, i).toString().split("\r\n");
      const status = Number(statusLine.split(" ")[1]);
      const hdrs = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      handshake = { status, headers: hdrs };
      const rest = buf.subarray(i + 4);
      Object.assign(c, handshake);
      if (status !== 101) {
        let body = rest;
        socket.on("data", (more) => { body = Buffer.concat([body, more]); });
        socket.on("close", () => { c.body = JSON.parse(body.toString() || "null"); resolve(c); });
        return;
      }
      resolve(c);
      if (rest.length) onFrames(rest);
    });
    socket.on("close", () => resolveClosed());
  });
}
