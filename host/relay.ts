// `herdr-chat-host relay --machine <name>`: runs where the Herdr app runs, one per machine, and gives
// the chat mod the same WebSocket a local host gives it, on 127.0.0.1. Each WebSocket connection
// gets its own bridge (bridge.ts) on that machine, started and attached through herdr-core: no port
// opens on the machine, and the chat's bytes travel only over core's machine link.
//
// A connection: the mod's hello (with `chat`) → the chat's registry entry read on the machine
// (file.read) and its token checked → `herdr-chat-host bridge <chat>` run there (terminal.run) and
// attached → READY, SYNC/SYNCED → the hello forwarded, then records both ways. Anything wrong on the
// link closes the WebSocket (code 4001): the mod reconnects as after any drop and starts again from
// a snapshot, through a new bridge.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { MAX_RECORD_BYTES } from "./framing.ts";
import { CoreClient } from "./hccore.ts";
import type { Stream } from "./hccore.ts";
import { atomicWrite } from "./registry.ts";
import { tokenMatches, wsPeer, WS_ACK } from "./peer.ts";
import { Link, LINK_WINDOW, READY_LINE, syncLine, syncedLine } from "./relaylink.ts";
import type { LinkTimes } from "./relaylink.ts";
import { hostBuild } from "./build.ts";

const HELLO_TIMEOUT_MS = 5000;
const SETUP_TIMEOUT_MS = Number(process.env.HERDR_CHAT_RELAY_SETUP_MS ?? "20000") || 20_000;
/** The mod's records held for the link past this: it isn't reading the bridge's acks. */
const MAX_QUEUED = 64 << 20;
const PRESYNC_MAX = 64 * 1024;

export const CLOSE_RESYNC = 4001;
export const CLOSE_REFUSED = 4003;
export const CLOSE_SETUP = 1011;

export type RelayOptions = {
  machine: string;
  stateDir: string;
  /** The host command on the machine (its `herdr-chat-host`). */
  host: string;
  /** HERDR_CHAT_NODE for it, when set. */
  node: string | null;
  /** The host's state dir there; relative to that machine's home. */
  remoteStateDir: string;
  hc: string;
  times: LinkTimes;
  log: (m: string) => void;
};

export type RelayEntry = { v: 1; machine: string; pid: number | null; wsPort: number | null; startedAt: number; version: string; build: string };

export function relayPath(stateDir: string, machine: string): string {
  return join(stateDir, "relays", `${machine}.json`);
}

export class Relay {
  o: RelayOptions;
  wss: WebSocketServer | null = null;
  wsPort = 0;
  private sessions = new Set<() => void>();

  constructor(o: RelayOptions) {
    this.o = o;
  }

  async listen(): Promise<number> {
    const wss = new WebSocketServer({
      host: "127.0.0.1", port: 0, maxPayload: MAX_RECORD_BYTES, perMessageDeflate: false,
      verifyClient: (info: { origin?: string }) => !info.origin,
    });
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      wss.once("error", reject);
      wss.once("listening", () => resolve());
    });
    wss.on("connection", (ws) => this.accept(ws));
    const addr = wss.address();
    this.wsPort = typeof addr === "object" && addr ? addr.port : 0;
    this.save(process.pid, this.wsPort);
    return this.wsPort;
  }

  save(pid: number | null, wsPort: number | null): void {
    const b = hostBuild();
    const entry: RelayEntry = { v: 1, machine: this.o.machine, pid, wsPort, startedAt: Math.round(performance.timeOrigin), version: b.version, build: b.build };
    mkdirSync(join(this.o.stateDir, "relays"), { recursive: true, mode: 0o700 });
    atomicWrite(relayPath(this.o.stateDir, this.o.machine), JSON.stringify(entry, null, 2) + "\n");
  }

  async close(): Promise<void> {
    for (const end of this.sessions) end();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.save(null, null);
  }

  private accept(ws: WebSocket): void {
    const o = this.o;
    const peer = wsPeer(ws);
    let ended = false;
    let core: CoreClient | null = null;
    let bridge: string | null = null;
    let link: Link | null = null;
    let tag = "?";
    const end = (code: number, why: string): void => {
      if (ended) return;
      ended = true;
      this.sessions.delete(stop);
      o.log(`${tag}: ${why}`);
      clearTimeout(helloTimer);
      link?.stop();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, why.slice(0, 120));
      release();
    };
    // The bridge and the core link go with the connection; setup calls it again for what it made after an end.
    const release = (): void => {
      const c = core;
      const b = bridge;
      core = null;
      bridge = null;
      if (c && b) void c.call("terminal.kill", { terminal: b }).catch(() => {}).finally(() => c.end());
      else c?.end();
    };
    const stop = (): void => end(1001, "relay stopping");
    this.sessions.add(stop);
    const helloTimer = setTimeout(() => end(CLOSE_REFUSED, "no hello"), HELLO_TIMEOUT_MS);
    let hello: string | null = null;
    const early: string[] = [];

    ws.on("error", () => {});
    ws.on("close", () => end(1000, "the mod closed"));
    ws.on("message", (data, isBinary) => {
      if (isBinary || ended) return;
      const text = String(data);
      if (text === WS_ACK) {
        peer.acked();
        link?.drained();
        return;
      }
      if (hello === null) {
        hello = text;
        clearTimeout(helloTimer);
        void setup(text).catch((e) => end(CLOSE_SETUP, `setup: ${e instanceof Error ? e.message : e}`));
        return;
      }
      if (!link) {
        early.push(text);
        return;
      }
      link.send(text);
      if (link.queued() > MAX_QUEUED) end(CLOSE_RESYNC, "the bridge stopped reading");
    });

    const setup = async (helloText: string): Promise<void> => {
      let h: any;
      try {
        h = JSON.parse(helloText);
      } catch {}
      if (h?.t !== "hello" || typeof h.chat !== "string" || !/^[\w.-]+$/.test(h.chat) || typeof h.token !== "string") {
        return end(CLOSE_REFUSED, "a bad hello");
      }
      tag = `${o.machine}/${h.chat}`;
      const deadline = setTimeout(() => end(CLOSE_SETUP, "setup timed out"), SETUP_TIMEOUT_MS);
      try {
        const c = await CoreClient.open(o.hc);
        core = c;
        if (ended) return release();
        c.onClose = (why) => end(CLOSE_RESYNC, `core: ${why}`);
        const regPath = `${o.remoteStateDir.replace(/\/+$/, "")}/chats/${h.chat}.json`;
        const read = await c.call("file.read", { path: regPath, on: o.machine });
        let entry: any = null;
        try {
          entry = JSON.parse(read.text);
        } catch {}
        // The token first: nothing starts on the machine for a client that doesn't know it.
        if (!entry || !tokenMatches(h.token, String(entry.token ?? ""))) return end(CLOSE_REFUSED, "a wrong token");
        if (!entry.socket || !entry.pid) return end(CLOSE_REFUSED, "the chat's host isn't serving its socket");
        if (ended) return;
        const argv = [
          ...(o.node ? ["/usr/bin/env", `HERDR_CHAT_NODE=${o.node}`] : []),
          o.host, "bridge", h.chat, "--state-dir", o.remoteStateDir,
          "--ping-ms", String(o.times.pingMs), "--dead-ms", String(o.times.deadMs),
        ];
        o.log(`${tag}: starting a bridge`);
        const run = await c.call("terminal.run", {
          on: o.machine, argv, no_parent: true, no_notify: true, rm: true,
          labels: { "herdr-chat.chat": h.chat, "herdr-chat.role": "bridge" },
        });
        const address = String(run.address).includes("/") ? String(run.address) : `${o.machine}/${run.address}`;
        bridge = address;
        if (ended) return release();
        const stream = await c.attach(address);
        const rest = await this.sync(stream);
        if (ended) return;
        const l = new Link((line) => stream.write(Buffer.from(line, "latin1")), o.times);
        link = l;
        l.onBroken = (why) => end(CLOSE_RESYNC, `link: ${why}`);
        l.onRecord = (text) => peer.send(text);
        l.canAck = () => peer.buffered() <= LINK_WINDOW;
        stream.onData = (d) => l.push(d);
        stream.onClose = (why) => end(CLOSE_RESYNC, `bridge ended: ${why}`);
        l.start();
        if (rest.length) l.push(rest);
        l.send(helloText);
        for (const t of early.splice(0)) l.send(t);
        o.log(`${tag}: bridge ${bridge} synced`);
      } finally {
        clearTimeout(deadline);
      }
    };
  }

  /** Waits for the bridge's READY, then SYNC until SYNCED: what came before is the terminal's, not ours. */
  private async sync(stream: Stream): Promise<Buffer> {
    const nonce = randomBytes(12).toString("hex");
    let seen = "";
    let ready = false;
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const done = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
    const synced = syncedLine(nonce) + "\n";
    let after: Buffer | null = null;
    stream.onClose = (why) => reject(new Error(`bridge ended before sync: ${why}`));
    stream.onData = (d) => {
      seen = (seen + d.toString("latin1")).slice(-PRESYNC_MAX);
      if (!ready) {
        if (!seen.includes(READY_LINE)) return;
        ready = true;
        seen = "";
        stream.write(Buffer.from(syncLine(nonce) + "\n", "latin1"));
        return;
      }
      const i = seen.indexOf(synced);
      if (i < 0) return;
      after = Buffer.from(seen.slice(i + synced.length), "latin1");
      resolve();
    };
    await done;
    stream.onData = () => {};
    // Bytes after SYNCED are already the link's.
    return after ?? Buffer.alloc(0);
  }
}
