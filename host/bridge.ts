// `herdr-chat-host bridge <chat>`: runs on the chat's machine in a core terminal the relay starts
// (relay.ts), and joins that terminal's PTY to the host's Unix socket. Records cross the PTY in the
// link protocol (relaylink.ts); the host sees an ordinary JSONL client.
//
// It connects to the host first: no host there, it prints NOHOST and exits (the relay closes the
// mod 4004, no host). Then READY, and SYNC must come within deadMs. It exits when the host socket closes, when
// the link breaks, when no line came for deadMs (the relay is gone), or when it is killed.
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { LineFramer } from "./framing.ts";
import { pidAlive, readRegistry, socketPath } from "./registry.ts";
import { Link, NOHOST_LINE, READY_LINE, SYNC_RE, syncedLine } from "./relaylink.ts";
import type { LinkTimes } from "./relaylink.ts";
import { cappedLog } from "./logfile.ts";

/** The host socket's records held for the link past this: stop reading the socket. */
const HOLD = 4 << 20;
const PRESYNC_MAX = 64 * 1024;
const EXIT_DRAIN_MS = 2000;

export function runBridge(opts: { chat: string; stateDir: string; times: LinkTimes }): void {
  const log = cappedLog(join(opts.stateDir, "chats", `${opts.chat}.bridge.log`), () => `[${process.pid}] `);
  let stats = "";
  // stdout is the PTY, non-blocking: a write meeting EAGAIN (core not reading yet) waits and
  // retries, never spinning; the link window bounds what waits here.
  const pending: Buffer[] = [];
  let waiting = false;
  let backoff = 1;
  const flush = (): void => {
    while (pending.length) {
      const b = pending[0]!;
      let n: number;
      try {
        n = writeSync(1, b);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EAGAIN") return exit(3, `stdout: ${(e as Error).message}`);
        waiting = true;
        setTimeout(() => {
          waiting = false;
          flush();
        }, backoff);
        backoff = Math.min(50, backoff * 2);
        return;
      }
      backoff = 1;
      if (n < b.length) pending[0] = b.subarray(n);
      else pending.shift();
    }
    drained?.();
  };
  const out = (s: string): void => {
    // Exiting: what is queued drains, nothing new joins it.
    if (exiting) return;
    pending.push(Buffer.from(s, "latin1"));
    if (!waiting) flush();
  };

  // Exiting waits for the PTY queue to drain (a NOHOST or a last record must reach the relay),
  // at most EXIT_DRAIN_MS; the first exit decides the code.
  let exiting = false;
  let drained: (() => void) | null = null;
  const exit = (code: number, why: string): never => {
    if (exiting) return undefined as never;
    exiting = true;
    log(`exit ${code}: ${why}${stats}`);
    if (!pending.length || code === 3) process.exit(code);
    const cap = setTimeout(() => process.exit(code), EXIT_DRAIN_MS);
    drained = () => {
      if (pending.length) return;
      clearTimeout(cap);
      process.exit(code);
    };
    return undefined as never;
  };
  // Nothing but link lines may reach the PTY: a stray stderr write would break the link.
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    log(`stderr: ${String(chunk).trimEnd()}`);
    return true;
  }) as typeof process.stderr.write;
  process.on("uncaughtException", (e) => exit(7, `uncaught: ${e?.stack ?? e}`));
  process.on("unhandledRejection", (e) => exit(7, `unhandled rejection: ${(e as Error)?.stack ?? e}`));
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(sig, () => exit(0, sig));

  // Raw: no echo, no CR added, no signal keys; Node's raw mode keeps ONLCR, stty doesn't.
  try {
    execFileSync("stty", ["raw", "-echo"], { stdio: ["inherit", "ignore", "pipe"] });
  } catch (e) {
    exit(2, `stty: ${e instanceof Error ? e.message : e}`);
  }

  log(`bridge chat=${opts.chat}`);
  const entry = readRegistry(opts.stateDir, opts.chat);
  const pid = entry?.pid;
  if (!pid || !pidAlive(pid)) {
    out(NOHOST_LINE + "\n");
    return exit(4, "no host serves the chat");
  }
  // The path this host's pid names, not whatever the entry says.
  const sock = connect(socketPath(opts.stateDir, opts.chat, pid));
  sock.pause();
  let link: Link | null = null;
  let connected = false;
  sock.on("error", (e) => {
    // Only a host that can't be reached is "no host"; a socket error once connected is not.
    if (!connected) out(NOHOST_LINE + "\n");
    exit(connected ? 5 : 4, `host socket: ${e.message}`);
  });
  sock.on("close", () => exit(0, "host socket closed"));

  sock.on("connect", () => {
    connected = true;
    out(READY_LINE + "\n");
    const deadline = setTimeout(() => exit(8, `no sync in ${opts.times.deadMs} ms`), opts.times.deadMs);
    let pre = "";
    const presync = (d: Buffer): void => {
      // Before SYNC anything may arrive (a key, a terminal's reply): look for the line only.
      pre = (pre + d.toString("latin1")).slice(-PRESYNC_MAX);
      const m = SYNC_RE.exec(pre);
      if (!m) return;
      clearTimeout(deadline);
      const rest = Buffer.from(pre.slice(m.index + m[0].length), "latin1");
      pre = "";
      start(m[1]!, rest);
    };
    process.stdin.on("data", (d: Buffer) => (link ? link.push(d) : presync(d)));
    process.stdin.on("end", () => exit(0, "terminal input ended"));
  });

  const start = (nonce: string, rest: Buffer): void => {
    const l = new Link(out, opts.times);
    link = l;
    let fills = 0;
    let most = 0;
    l.onWindowFull = (n) => {
      fills++;
      most = Math.max(most, n);
      stats = ` (window filled ${fills} times, at most ${most} bytes in flight)`;
    };
    l.onBroken = (why) => exit(6, `link: ${why}`);
    l.onRecord = (text) => {
      sock.write(text + "\n");
    };
    l.canAck = () => sock.writableLength < HOLD;
    sock.on("drain", () => l.drained());
    l.onQueueLow = () => sock.resume();
    const framer = new LineFramer();
    framer.onOversized = (o) => log(`dropped an oversized host record (${o.size} bytes)`);
    framer.onLine = (line) => {
      l.send(line);
      if (l.queued() > HOLD) sock.pause();
    };
    sock.on("data", (d) => framer.push(d));
    out(syncedLine(nonce) + "\n");
    l.start();
    log("synced");
    sock.resume();
    if (rest.length) l.push(rest);
  };
}
