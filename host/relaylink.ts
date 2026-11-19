// The line protocol between the relay and the bridge, over a terminal's PTY that herdr-core carries
// across its machine link (protocol.md "Relay and bridge"). The PTY and the link may inject bytes
// (a repaint after the link drops, a key typed into the terminal) or lose some; every line is
// checked, and anything unexpected breaks the link: the relay then resyncs.
//
// Every line is one JSON object in printable ASCII (0x20-0x7e) ended by LF. After SYNCED every line
// carries `s`, 1, 2, 3… per direction. A record (one JSONL line of the chat protocol, without its
// LF) goes as base64 in data lines of at most LINK_CHUNK bytes each, `c:1` on all but the last.
// The sender keeps at most LINK_WINDOW bytes of data lines unacknowledged: core replaces a stream
// more than ~4 MiB behind its viewer with a repaint.
import { MAX_RECORD_BYTES } from "./framing.ts";

export const LINK_WINDOW = 1 << 20;
export const LINK_CHUNK = 192 * 1024;
/** A data line holds LINK_CHUNK as base64 plus the JSON around it. */
export const LINK_MAX_LINE = 512 * 1024;
const ACK_EVERY = 64 * 1024;

export type LinkTimes = { pingMs: number; deadMs: number };
export const DEFAULT_LINK_TIMES: LinkTimes = { pingMs: 5000, deadMs: 20_000 };

/** What the bridge prints once its PTY is raw, before anything else. */
export const READY_LINE = '{"t":"ready","v":1}';
/** What the bridge prints instead when no host serves the chat: the relay refuses the mod (4003). */
export const NOHOST_LINE = '{"t":"nohost","v":1}';
export const syncLine = (nonce: string): string => `{"t":"sync","n":"${nonce}"}`;
export const syncedLine = (nonce: string): string => `{"t":"synced","n":"${nonce}"}`;
export const SYNC_RE = /\{"t":"sync","n":"([A-Za-z0-9]{8,64})"\}\n/;

/** Splits bytes into lines; any byte outside 0x20-0x7e but LF, or an over-long line, is bad. */
export class LinkLines {
  onLine: (line: string) => void = () => {};
  onBad: (why: string) => void = () => {};
  private parts: Buffer[] = [];
  private len = 0;
  private bad = false;

  push(b: Buffer): void {
    let start = 0;
    for (let i = 0; i < b.length && !this.bad; i++) {
      const c = b[i]!;
      if (c === 10) {
        this.parts.push(b.subarray(start, i));
        const line = Buffer.concat(this.parts).toString("latin1");
        this.parts = [];
        this.len = 0;
        start = i + 1;
        this.onLine(line);
      } else if (c < 0x20 || c > 0x7e) {
        this.fail(`control or non-ASCII byte 0x${c.toString(16).padStart(2, "0")}`);
      } else if (this.len + (i - start) >= LINK_MAX_LINE) {
        this.fail("line too long");
      }
    }
    if (this.bad) return;
    if (start < b.length) {
      this.parts.push(b.subarray(start));
      this.len += b.length - start;
    }
  }

  private fail(why: string): void {
    this.bad = true;
    this.onBad(why);
  }
}

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A line's length as out() writes it: `{"s":<seq>,` + body + LF. */
const lineBytes = (seq: number, body: string): number => 6 + String(seq).length + body.length + 1;

/** One side of a synced link: records out (windowed), records in (reassembled, acknowledged). */
export class Link {
  onRecord: (text: string) => void = () => {};
  onBroken: (why: string) => void = () => {};
  /** Called when the queue of records not yet sent drops under LINK_WINDOW. */
  onQueueLow: () => void = () => {};
  /** Whether the consumer of our records keeps up: acks wait while it doesn't. */
  canAck: () => boolean = () => true;
  /** The window filled with records still queued: the bytes in flight then (at most LINK_WINDOW). */
  onWindowFull: (inFlight: number) => void = () => {};
  broken = false;
  private full = false;

  private write: (line: string) => void;
  private times: LinkTimes;
  private lines = new LinkLines();
  private outSeq = 0;
  private inSeq = 0;
  private sent = 0;
  private acked = 0;
  private received = 0;
  private ackedIn = 0;
  private queue: string[] = [];
  private queuedBytes = 0;
  private parts: Buffer[] = [];
  private partBytes = 0;
  private lastIn = Date.now();
  private lastOut = Date.now();
  private timer: NodeJS.Timeout | null = null;

  constructor(write: (line: string) => void, times: LinkTimes = DEFAULT_LINK_TIMES) {
    this.write = write;
    this.times = times;
    this.lines.onLine = (l) => this.line(l);
    this.lines.onBad = (why) => this.break(why);
  }

  start(): void {
    this.lastIn = this.lastOut = Date.now();
    this.timer = setInterval(() => this.tick(), Math.max(50, Math.min(this.times.pingMs, this.times.deadMs / 4)));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Bytes of records waiting for the window. */
  queued(): number {
    return this.queuedBytes;
  }

  send(record: string): void {
    if (this.broken) return;
    const b = Buffer.from(record, "utf8");
    for (let o = 0; o < b.length || o === 0; o += LINK_CHUNK) {
      const end = Math.min(b.length, o + LINK_CHUNK);
      const d = b.subarray(o, end).toString("base64");
      this.queue.push(end < b.length ? `"d":"${d}","c":1}` : `"d":"${d}"}`);
      this.queuedBytes += this.queue[this.queue.length - 1]!.length;
      if (end >= b.length) break;
    }
    this.pump();
  }

  push(b: Buffer): void {
    if (this.broken) return;
    this.lines.push(b);
    this.maybeAck();
  }

  /** The consumer caught up: acknowledge what it took. */
  drained(): void {
    this.maybeAck();
  }

  break(why: string): void {
    if (this.broken) return;
    this.broken = true;
    this.stop();
    this.onBroken(why);
  }

  private out(body: string): number {
    const line = `{"s":${++this.outSeq},${body}\n`;
    this.lastOut = Date.now();
    this.write(line);
    return line.length;
  }

  private pump(): void {
    const before = this.queuedBytes;
    // The whole line fits in the window before it goes: never more than LINK_WINDOW in flight.
    while (!this.broken && this.queue.length && this.sent - this.acked + lineBytes(this.outSeq + 1, this.queue[0]!) <= LINK_WINDOW) {
      const body = this.queue.shift()!;
      this.queuedBytes -= body.length;
      this.sent += this.out(body);
    }
    if (this.queue.length && !this.broken) {
      if (!this.full) this.onWindowFull(this.sent - this.acked);
      this.full = true;
    } else this.full = false;
    if (before >= LINK_WINDOW && this.queuedBytes < LINK_WINDOW) this.onQueueLow();
  }

  private maybeAck(): void {
    if (this.broken || this.received === this.ackedIn || !this.canAck()) return;
    if (this.received - this.ackedIn < ACK_EVERY && this.parts.length) return;
    this.ackedIn = this.received;
    this.out(`"t":"ack","n":${this.received}}`);
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastIn > this.times.deadMs) return this.break(`no line for ${now - this.lastIn} ms`);
    // An ack held back while the consumer lagged, when nothing else would send it.
    this.maybeAck();
    if (now - this.lastOut >= this.times.pingMs) this.out(`"t":"ping"}`);
  }

  private line(l: string): void {
    if (this.broken) return;
    let m: any;
    try {
      m = JSON.parse(l);
    } catch {
      return this.break("not JSON");
    }
    if (!m || typeof m !== "object" || Array.isArray(m)) return this.break("not an object");
    if (m.s !== this.inSeq + 1) return this.break(`sequence ${m.s} after ${this.inSeq}`);
    this.inSeq = m.s;
    this.lastIn = Date.now();
    const keys = Object.keys(m).sort().join(",");
    if (typeof m.d === "string") {
      if (!(keys === "d,s" || (keys === "c,d,s" && m.c === 1)) || m.d.length % 4 || !B64.test(m.d)) return this.break("bad data line");
      this.received += l.length + 1;
      const chunk = Buffer.from(m.d, "base64");
      this.partBytes += chunk.length;
      if (this.partBytes > MAX_RECORD_BYTES) return this.break("record too large");
      this.parts.push(chunk);
      if (m.c === 1) return;
      const text = Buffer.concat(this.parts).toString("utf8");
      this.parts = [];
      this.partBytes = 0;
      this.onRecord(text);
    } else if (m.t === "ack" && keys === "n,s,t") {
      if (!Number.isInteger(m.n) || m.n < this.acked || m.n > this.sent) return this.break(`bad ack ${m.n}`);
      this.acked = m.n;
      this.pump();
    } else if (m.t === "ping" && keys === "s,t") {
      // Only proves the other side lives.
    } else {
      this.break("unknown line");
    }
  }
}
