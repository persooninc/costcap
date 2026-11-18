// Regenerates src/hosted/og.png (1200x630 Open Graph card) with no dependencies.
// Usage: node scripts/og-image.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 1200, H = 630;
const FONT = {
  A: ["01110","10001","10001","11111","10001","10001","10001"], C: ["01110","10001","10000","10000","10000","10001","01110"],
  D: ["11110","10001","10001","10001","10001","10001","11110"], E: ["11111","10000","10000","11110","10000","10000","11111"],
  F: ["11111","10000","10000","11110","10000","10000","10000"], G: ["01110","10001","10000","10111","10001","10001","01111"],
  I: ["01110","00100","00100","00100","00100","00100","01110"], L: ["10000","10000","10000","10000","10000","10000","11111"],
  M: ["10001","11011","10101","10101","10001","10001","10001"], N: ["10001","11001","10101","10011","10001","10001","10001"],
  O: ["01110","10001","10001","10001","10001","10001","01110"], P: ["11110","10001","10001","11110","10000","10000","10000"],
  R: ["11110","10001","10001","11110","10100","10010","10001"], S: ["01111","10000","10000","01110","00001","00001","11110"],
  T: ["11111","00100","00100","00100","00100","00100","00100"], U: ["10001","10001","10001","10001","10001","10001","01110"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"], ",": ["00000","00000","00000","00000","01100","00100","01000"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
};
const px = Buffer.alloc(W * H * 3);
const fill = (x0, y0, w, h, [r, g, b]) => {
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++) for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
    const i = (y * W + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
};
const text = (s, x, y, scale, color) => {
  for (const ch of s) {
    const g = FONT[ch];
    if (!g) throw new Error(`no glyph for ${ch}`);
    g.forEach((row, ry) => [...row].forEach((bit, rx) => { if (bit === "1") fill(x + rx * scale, y + ry * scale, scale, scale, color); }));
    x += 6 * scale;
  }
};
fill(0, 0, W, H, [15, 23, 42]);
fill(0, 0, W, 16, [34, 197, 94]);
text("COSTCAP", 80, 150, 22, [255, 255, 255]);
text("SPEND CAPS FOR AI AGENTS", 80, 360, 7, [134, 239, 172]);
text("GUARDRAILS, NOT GUARANTEES.", 80, 470, 5, [148, 163, 184]);

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
writeFileSync(new URL("../src/hosted/og.png", import.meta.url), png);
console.log(`og.png ${png.length} bytes`);
