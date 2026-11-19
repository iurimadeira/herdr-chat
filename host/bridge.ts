// `herdr-chat-host bridge <chat>`: runs on the chat's machine in a core terminal the relay starts
// (relay.ts), and joins that terminal's PTY to the host's Unix socket. Records cross the PTY in the
// link protocol (relaylink.ts); the host sees an ordinary JSONL client.
//
// No live host in the registry: it says NOHOST (the relay closes the mod 4004, no host). Else READY,
// and SYNC must come within deadMs; then it connects to the host's socket (NOHOST when it can't) and
// answers SYNCED. It exits when the host socket closes, when the link breaks, when no line came for
// deadMs (the relay is gone), or when it is killed.
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
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
/** READY (or NOHOST) goes out again this often until the relay answers. */
const ANNOUNCE_MS = 250;

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

  // Raw: no echo, no CR added, no signal keys; Node's raw mode keeps ONLCR, stty doesn't.
  try {
    execFileSync("stty", ["raw", "-echo"], { stdio: ["inherit", "ignore", "pipe"] });
  } catch (e) {
    exit(2, `stty: ${e instanceof Error ? e.message : e}`);
  }

  // Until it is killed, its input ends or deadMs pass, it says NOHOST again and again: the relay's
  // attach may land after the first one (a slow link), and a bridge that had exited would leave it
  // nothing to attach to.
  let nohost: string | null = null;
  const noHost = (why: string): void => {
    nohost = why;
    clearInterval(announce);
    clearTimeout(deadline);
    out(NOHOST_LINE + "\n");
    setInterval(() => out(NOHOST_LINE + "\n"), ANNOUNCE_MS);
    setTimeout(() => exit(4, `${why} (no relay in ${opts.times.deadMs} ms)`), opts.times.deadMs);
  };
  const ended = (why: string): never => (nohost ? exit(4, `${nohost} (${why})`) : exit(0, why));
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(sig, () => ended(sig));

  let link: Link | null = null;
  let announce: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let pre = "";
  const presync = (d: Buffer): void => {
    if (nohost || !announce) return;
    // Before SYNC anything may arrive (a key, a terminal's reply): look for the line only.
    pre = (pre + d.toString("latin1")).slice(-PRESYNC_MAX);
    const m = SYNC_RE.exec(pre);
    if (!m) return;
    clearInterval(announce);
    announce = undefined;
    connectHost(m[1]!, Buffer.from(pre.slice(m.index + m[0].length), "latin1"));
  };
  process.stdin.on("data", (d: Buffer) => (link ? link.push(d) : presync(d)));
  process.stdin.on("end", () => ended("terminal input ended"));

  log(`bridge chat=${opts.chat}`);
  const pid = readRegistry(opts.stateDir, opts.chat)?.pid;
  if (!pid || !pidAlive(pid)) return noHost("no host serves the chat");
  // READY until SYNC, as the relay's attach may land after the first one.
  out(READY_LINE + "\n");
  announce = setInterval(() => out(READY_LINE + "\n"), ANNOUNCE_MS);
  deadline = setTimeout(() => exit(8, `no sync in ${opts.times.deadMs} ms`), opts.times.deadMs);

  // The host's socket only once SYNC came: the host's hello timeout starts at the connect, and the
  // relay sends the mod's hello right after SYNCED, however long the relay's setup took.
  const connectHost = (nonce: string, rest: Buffer): void => {
    // The path this host's pid names, not whatever the entry says.
    const sock = connect(socketPath(opts.stateDir, opts.chat, pid));
    sock.pause();
    let connected = false;
    sock.on("error", (e) => {
      // Only a host that can't be reached is "no host"; a socket error once connected is not.
      if (!connected) return noHost(`no host serves the chat (host socket: ${e.message})`);
      exit(5, `host socket: ${e.message}`);
    });
    sock.on("close", () => connected && exit(0, "host socket closed"));
    sock.on("connect", () => {
      clearTimeout(deadline);
      connected = true;
      start(sock, nonce, rest);
    });
  };

  const start = (sock: Socket, nonce: string, rest: Buffer): void => {
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
