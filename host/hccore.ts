// A herdr-core client over `hc connect` (its framed API): JSON-RPC on channel 0, and terminal
// streams on their own channels. The relay (relay.ts) uses it to run and attach the bridge on
// another machine; core carries those bytes over its machine link.
//
// A frame is [channel u32 LE][kind u8][len u32 LE][payload].
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** An error core answered with; `kind` is its error data's (`not_found`, `io`, `machine_unknown`…). */
export class CoreError extends Error {
  kind: string | null;
  constructor(message: string, kind: unknown) {
    super(message);
    this.kind = typeof kind === "string" ? kind : null;
  }
}

export const KIND = { DATA: 0, CREDIT: 1, CLOSE: 2 } as const;
const MAX_FRAME = 1 << 20;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** One terminal stream: the program's output in, keys (bytes) out. Credit is paid as bytes arrive. */
export class Stream {
  onData: (b: Buffer) => void = () => {};
  onClose: (why: string) => void = () => {};
  closed = false;
  private core: CoreClient;
  readonly channel: number;
  constructor(core: CoreClient, channel: number) {
    this.core = core;
    this.channel = channel;
  }

  write(b: Buffer): void {
    for (let o = 0; o < b.length; o += MAX_FRAME) this.core.frame(this.channel, KIND.DATA, b.subarray(o, o + MAX_FRAME));
  }

  /** @internal */
  frameIn(kind: number, p: Buffer): void {
    if (this.closed) return;
    if (kind === KIND.DATA) {
      const c = Buffer.alloc(4);
      c.writeUInt32LE(p.length);
      this.core.frame(this.channel, KIND.CREDIT, c);
      this.onData(p);
    } else if (kind === KIND.CLOSE) {
      this.end(p.length ? p.toString() : "closed");
    }
  }

  /** @internal */
  end(why: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(why);
  }
}

export class CoreClient {
  onClose: (why: string) => void = () => {};
  closed = false;
  private buf: Buffer = Buffer.alloc(0);
  private framed = false;
  private id = 0;
  private pending = new Map<number, Pending>();
  private streams = new Map<number, Stream>();
  private early = new Map<number, { kind: number; p: Buffer }[]>();

  private proc: ChildProcessWithoutNullStreams;
  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;
  }

  /** Spawns `<hc> connect` (HC_SESSION and HC_SOCKET from `env` pick the core) and says hello. */
  static async open(hc: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 10_000): Promise<CoreClient> {
    const proc = spawn(hc, ["connect"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const c = new CoreClient(proc);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    proc.stdout.on("data", (d: Buffer) => c.onData(d));
    proc.stdin.on("error", () => {});
    const gone = (why: string): void => c.shut(`${why}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    proc.on("error", (e) => gone(`hc connect: ${e.message}`));
    proc.on("close", (code) => gone(`hc connect exited (${code})`));
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { framed: true, generation: 1 } }) + "\n");
    const hello = new Promise((resolve, reject) => c.pending.set(0, { resolve, reject }));
    const timer = setTimeout(() => gone("hc connect: no hello"), timeoutMs);
    try {
      await hello;
    } catch (e) {
      // No hello (or a bad one): the child must not outlive the attempt.
      c.end();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    return c;
  }

  /** With `timeoutMs`, rejects when core doesn't answer in time; the client stays usable. */
  call(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    if (this.closed) return Promise.reject(new Error(`${method}: core link closed`));
    const id = ++this.id;
    this.frame(0, KIND.DATA, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    return new Promise((resolve, reject) => {
      if (timeoutMs === undefined) return this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
    });
  }

  async attach(terminal: string, cols = 200, rows = 50): Promise<Stream> {
    const r = await this.call("terminal.attach", { terminal, cols, rows, history: 0 });
    const s = new Stream(this, r.channel);
    this.streams.set(r.channel, s);
    for (const f of this.early.get(r.channel) ?? []) s.frameIn(f.kind, f.p);
    this.early.delete(r.channel);
    return s;
  }

  end(): void {
    this.shut("ended");
    this.proc.kill();
  }

  /** @internal */
  frame(ch: number, kind: number, payload: Buffer): void {
    if (this.closed) return;
    const h = Buffer.alloc(9);
    h.writeUInt32LE(ch, 0);
    h[4] = kind;
    h.writeUInt32LE(payload.length, 5);
    this.proc.stdin.write(Buffer.concat([h, payload]));
  }

  private shut(why: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error(why));
    this.pending.clear();
    for (const [, s] of this.streams) s.end(why);
    this.onClose(why);
  }

  private settle(msg: any): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new CoreError(`${msg.error.message ?? "error"}${msg.error.data ? ` ${JSON.stringify(msg.error.data)}` : ""}`, msg.error.data?.kind));
    else p.resolve(msg.result);
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (!this.framed) {
        const i = this.buf.indexOf(10);
        if (i < 0) return;
        const line = this.buf.subarray(0, i).toString();
        this.buf = this.buf.subarray(i + 1);
        this.framed = true;
        try {
          this.settle(JSON.parse(line));
        } catch {
          this.shut(`hc connect: bad hello reply`);
          return;
        }
        continue;
      }
      if (this.buf.length < 9) return;
      const ch = this.buf.readUInt32LE(0);
      const kind = this.buf[4]!;
      const len = this.buf.readUInt32LE(5);
      if (this.buf.length < 9 + len) return;
      const p = Buffer.from(this.buf.subarray(9, 9 + len));
      this.buf = this.buf.subarray(9 + len);
      if (ch === 0) {
        try {
          this.settle(JSON.parse(p.toString()));
        } catch {}
        continue;
      }
      const s = this.streams.get(ch);
      if (s) s.frameIn(kind, p);
      else this.early.set(ch, [...(this.early.get(ch) ?? []), { kind, p }]);
    }
  }
}
