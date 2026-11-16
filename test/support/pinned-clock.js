// #237: pin the clock for tests whose expectations use today's price of a model
// that has an effective-dated row (gemini-2.5-pro/2.5-flash from 2026-12-01,
// gemini-3.8-flash from 2027-01-01). Importing this module shifts Date to start at
// PINNED_AT and keep ticking on one shared timeline (timeouts and elapsed-time checks still work), and
// adds itself to NODE_OPTIONS so spawned `costcap wrap` / proxy children price at
// the same instant. Production code is untouched; only test expectations are pinned.
import { fileURLToPath } from "node:url";

export const PINNED_AT = "2026-11-16T12:00:00.000Z";

const RealDate = globalThis.Date;
if (!RealDate.__costcapPinned) {
  // One offset per test process, shared with children, so runs spawned later in a
  // test still sort after earlier ones (every process sees the same timeline).
  const inherited = Number(process.env.COSTCAP_TEST_CLOCK_OFFSET_MS);
  const offset = Number.isFinite(inherited) && process.env.COSTCAP_TEST_CLOCK_OFFSET_MS !== "" ? inherited : RealDate.parse(PINNED_AT) - RealDate.now();
  process.env.COSTCAP_TEST_CLOCK_OFFSET_MS = String(offset);
  class PinnedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(RealDate.now() + offset); else super(...args); }
    static now() { return RealDate.now() + offset; }
  }
  PinnedDate.__costcapPinned = true;
  globalThis.Date = PinnedDate;
  const self = `--import=${fileURLToPath(import.meta.url)}`;
  const opts = process.env.NODE_OPTIONS || "";
  if (!opts.includes(self)) process.env.NODE_OPTIONS = `${opts} ${self}`.trim();
}
