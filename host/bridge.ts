// `herdr-chat-host bridge <chat>`: runs on the chat's machine in a core terminal the relay starts
// (relay.ts), and joins that terminal's PTY to the host's Unix socket. Records cross the PTY in the
// link protocol (relaylink.ts); the host sees an ordinary JSONL client. It exits when the host
// socket closes, when the link breaks, or when no line came for deadMs (the relay is gone).
import { execFileSync } from "node:child_process";
import { appendFileSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { LineFramer } from "./framing.ts";
import { readRegistry } from "./registry.ts";
import { Link, READY_LINE, SYNC_RE, syncedLine } from "./relaylink.ts";
import type { LinkTimes } from "./relaylink.ts";

/** The host socket's records held for the link past this: stop reading the socket. */
const HOLD = 4 << 20;
const PRESYNC_MAX = 64 * 1024;

export function runBridge(opts: { chat: string; stateDir: string; times: LinkTimes }): void {
  const logFile = join(opts.stateDir, "chats", `${opts.chat}.bridge.log`);
  const log = (m: string): void => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${m}\n`, { mode: 0o600 });
    } catch {}
  };
  const exit = (code: number, why: string): never => {
    log(`exit ${code}: ${why}`);
    process.exit(code);
  };

  // Raw: no echo, no CR added, no signal keys; Node's raw mode keeps ONLCR, stty doesn't.
  try {
    execFileSync("stty", ["raw", "-echo"], { stdio: ["inherit", "ignore", "pipe"] });
  } catch (e) {
    exit(2, `stty: ${e instanceof Error ? e.message : e}`);
  }
  // stdout is the PTY; a write may meet EAGAIN while core reads it, never a partial line lost.
  const out = (s: string): void => {
    const b = Buffer.from(s, "latin1");
    for (let off = 0; off < b.length; ) {
      try {
        off += writeSync(1, b, off);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EAGAIN") exit(3, `stdout: ${(e as Error).message}`);
      }
    }
  };
  log(`bridge chat=${opts.chat}`);
  out(READY_LINE + "\n");

  let pre = "";
  let link: Link | null = null;
  const presync = (d: Buffer): void => {
    // Before SYNC anything may arrive (a key, a terminal's reply): look for the line only.
    pre = (pre + d.toString("latin1")).slice(-PRESYNC_MAX);
    const m = SYNC_RE.exec(pre);
    if (!m) return;
    process.stdin.pause();
    const rest = Buffer.from(pre.slice(m.index + m[0].length), "latin1");
    pre = "";
    open(m[1]!, rest);
  };
  process.stdin.on("data", (d: Buffer) => (link ? link.push(d) : presync(d)));
  process.stdin.on("end", () => exit(0, "terminal input ended"));

  const open = (nonce: string, rest: Buffer): void => {
    const entry = readRegistry(opts.stateDir, opts.chat);
    const path = entry?.pid ? entry.socket : null;
    if (!path) return exit(4, "the chat's host serves no socket");
    const sock = connect(path);
    sock.on("error", (e) => exit(5, `host socket: ${e.message}`));
    sock.on("close", () => exit(0, "host socket closed"));
    sock.on("connect", () => {
      const l = new Link(out, opts.times);
      link = l;
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
      process.stdin.resume();
      if (rest.length) l.push(rest);
    });
  };
}
