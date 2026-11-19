// `herdr-chat-host relay --machine <name>`: runs where the Herdr app runs, one per machine, and gives
// the chat mod the same WebSocket a local host gives it, on 127.0.0.1. Each WebSocket connection
// gets its own bridge (bridge.ts) on that machine, started and attached through herdr-core: no port
// opens on the machine, and the chat's bytes travel only over core's machine link.
//
// A connection: the mod's hello (with `chat`) → the chat's registry entry read on the machine
// (file.read) and its token checked → `herdr-chat-host bridge <chat>` run there (terminal.run) and
// attached → READY, SYNC/SYNCED → the hello forwarded, then records both ways. Anything wrong on the
// link closes the WebSocket (code 4001): the mod reconnects as after any drop and starts again from
// a snapshot, through a new bridge. One core client serves every connection.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { MAX_RECORD_BYTES } from "./framing.ts";
import { CoreClient, CoreError } from "./hccore.ts";
import type { Stream } from "./hccore.ts";
import { atomicWrite, pidAlive } from "./registry.ts";
import { tokenMatches, wsPeer, WS_ACK } from "./peer.ts";
import { Link, LINK_WINDOW, NOHOST_LINE, READY_LINE, syncLine, syncedLine } from "./relaylink.ts";
import type { LinkTimes } from "./relaylink.ts";
import { hostBuild } from "./build.ts";

const HELLO_TIMEOUT_MS = 5000;
const SETUP_TIMEOUT_MS = Number(process.env.HERDR_CHAT_RELAY_SETUP_MS ?? "20000") || 20_000;
/** A core call that doesn't answer in this long is given up on (the bridge then exits on its own). */
const CALL_TIMEOUT_MS = 10_000;
/** The mod's records held for the link past this: it isn't reading the bridge's acks. */
const MAX_QUEUED = 64 << 20;
const PRESYNC_MAX = 64 * 1024;
/** What a connection may send between its hello and its token's check. */
const MAX_EARLY = 1 << 20;
/** Connections between hello and a synced bridge at once. */
const MAX_SETUPS = 8;

export const CLOSE_RESYNC = 4001;
export const CLOSE_REFUSED = 4003;
/** No host serves the chat now (it exited, or is restarting): retry once the registry names a live host. */
export const CLOSE_NO_HOST = 4004;
export const CLOSE_SETUP = 1011;
export const CLOSE_BUSY = 1013;
export const CLOSE_STOPPING = 1001;

/** The WebSocket's close reason is fixed per code; the detail goes to the relay's log only. */
const REASON: Record<number, string> = {
  [CLOSE_RESYNC]: "resync",
  [CLOSE_REFUSED]: "refused",
  [CLOSE_NO_HOST]: "no host",
  [CLOSE_SETUP]: "setup failed",
  [CLOSE_BUSY]: "busy",
  [CLOSE_STOPPING]: "relay stopping",
};

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

export function relayLockPath(stateDir: string, machine: string): string {
  return join(stateDir, "relays", `${machine}.lock`);
}

/** The bridge printed NOHOST: no host serves the chat. */
class NoHost extends Error {}

export class Relay {
  o: RelayOptions;
  wss: WebSocketServer | null = null;
  wsPort = 0;
  private sessions = new Map<() => void, () => void>();
  private setups = 0;
  private core: CoreClient | null = null;
  private opening: Promise<CoreClient> | null = null;
  private kills = new Set<Promise<unknown>>();
  private locked = false;

  constructor(o: RelayOptions) {
    this.o = o;
  }

  /** Takes the machine's lock (one relay per machine; a dead holder's lock is taken over), then listens. */
  async listen(): Promise<number> {
    this.lock();
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

  private lock(): void {
    const path = relayLockPath(this.o.stateDir, this.o.machine);
    mkdirSync(join(this.o.stateDir, "relays"), { recursive: true, mode: 0o700 });
    for (let tries = 0; ; tries++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        writeSync(fd, `${process.pid}\n`);
        closeSync(fd);
        this.locked = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || tries > 2) throw e;
      }
      const holder = Number(readFileSync(path, "utf8").trim()) || 0;
      if (holder && holder !== process.pid && pidAlive(holder)) throw new Error(`relay pid ${holder} already serves machine ${this.o.machine}`);
      // Its holder died (SIGKILL): the lock and the entry are stale.
      try {
        unlinkSync(path);
      } catch {}
    }
  }

  save(pid: number | null, wsPort: number | null): void {
    const b = hostBuild();
    const entry: RelayEntry = { v: 1, machine: this.o.machine, pid, wsPort, startedAt: Math.round(performance.timeOrigin), version: b.version, build: b.build };
    mkdirSync(join(this.o.stateDir, "relays"), { recursive: true, mode: 0o700 });
    atomicWrite(relayPath(this.o.stateDir, this.o.machine), JSON.stringify(entry, null, 2) + "\n");
  }

  async close(): Promise<void> {
    for (const stop of [...this.sessions.keys()]) stop();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    // The bridges' kills go out before the core link does.
    await Promise.allSettled([...this.kills]);
    this.core?.end();
    if (this.locked) {
      // Only what is ours: another relay may hold the machine by now.
      const path = relayLockPath(this.o.stateDir, this.o.machine);
      let holder = 0;
      try {
        holder = Number(readFileSync(path, "utf8").trim()) || 0;
      } catch {}
      if (holder === process.pid) {
        this.save(null, null);
        try {
          unlinkSync(path);
        } catch {}
      }
      this.locked = false;
    }
  }

  /** The relay's one core client, opened on first use and again after it closes. */
  private coreClient(): Promise<CoreClient> {
    if (this.core && !this.core.closed) return Promise.resolve(this.core);
    if (!this.opening) {
      this.opening = CoreClient.open(this.o.hc)
        .then((c) => {
          this.core = c;
          c.onClose = (why) => {
            if (this.core === c) this.core = null;
            for (const gone of [...this.sessions.values()]) gone();
            this.o.log(`core link closed: ${why}`);
          };
          return c;
        })
        .finally(() => (this.opening = null));
    }
    return this.opening;
  }

  /** Kills a bridge terminal; waits for core's answer (bounded) before the relay may exit. */
  private kill(c: CoreClient, bridge: string, tag: string): void {
    const p = c.call("terminal.kill", { terminal: bridge }, CALL_TIMEOUT_MS).catch((e) => this.o.log(`${tag}: kill ${bridge}: ${e instanceof Error ? e.message : e}`));
    this.kills.add(p);
    void p.finally(() => this.kills.delete(p));
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
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(code, REASON[code] ?? "");
      release();
    };
    // The bridge goes with the connection; setup calls it again for a bridge it learns of after an end.
    const release = (): void => {
      if (core && bridge && !core.closed) this.kill(core, bridge, tag);
      bridge = null;
    };
    const stop = (): void => end(CLOSE_STOPPING, "relay stopping");
    this.sessions.set(stop, () => {
      if (core) end(CLOSE_RESYNC, "core link closed");
    });
    const helloTimer = setTimeout(() => end(CLOSE_REFUSED, "no hello"), HELLO_TIMEOUT_MS);
    let hello: string | null = null;
    const early: string[] = [];
    let earlyBytes = 0;

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
        if (this.setups >= MAX_SETUPS) return end(CLOSE_BUSY, `busy: ${this.setups} connections setting up`);
        this.setups++;
        void setup(text)
          .catch((e) => end(e instanceof NoHost ? CLOSE_NO_HOST : CLOSE_SETUP, `setup: ${e instanceof Error ? e.message : e}`))
          .finally(() => {
            this.setups--;
          });
        return;
      }
      if (!link) {
        // Held until the token is checked and the bridge synced: bounded, for a client not yet known.
        earlyBytes += text.length;
        if (earlyBytes > MAX_EARLY) return end(CLOSE_REFUSED, `${earlyBytes} bytes before the link was up`);
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
        const c = await this.coreClient();
        core = c;
        if (ended) return;
        const regPath = `${o.remoteStateDir.replace(/\/+$/, "")}/chats/${h.chat}.json`;
        let text: string;
        try {
          text = (await c.call("file.read", { path: regPath, on: o.machine }, CALL_TIMEOUT_MS)).text;
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          // Only a missing file says the client will never get in; told apart from a wrong token
          // only in the log, so the mod learns nothing of which chats exist.
          if (e instanceof CoreError && e.kind === "not_found") return end(CLOSE_REFUSED, `no registry entry: ${why}`);
          // A timeout, an unreachable machine, a read that failed there: worth a retry.
          return end(CLOSE_SETUP, `registry read failed: ${why}`);
        }
        let entry: any = null;
        try {
          entry = JSON.parse(text);
        } catch {}
        if (!entry || typeof entry !== "object") return end(CLOSE_REFUSED, "a malformed registry entry");
        // The token first: nothing starts on the machine for a client that doesn't know it.
        if (!tokenMatches(h.token, typeof entry.token === "string" ? entry.token : "")) return end(CLOSE_REFUSED, "a wrong token");
        if (!entry.pid) return end(CLOSE_NO_HOST, "no host: the chat's host has exited");
        if (ended) return;
        const argv = [
          ...(o.node ? ["/usr/bin/env", `HERDR_CHAT_NODE=${o.node}`] : []),
          o.host, "bridge", h.chat, "--state-dir", o.remoteStateDir,
          "--ping-ms", String(o.times.pingMs), "--dead-ms", String(o.times.deadMs),
        ];
        o.log(`${tag}: starting a bridge`);
        // Not labelled herdr-chat.chat: the mod finds a chat's host by that label.
        const run = await c.call("terminal.run", {
          on: o.machine, argv, no_parent: true, no_notify: true, rm: true,
          labels: { "herdr-chat.bridge": h.chat, "herdr-chat.role": "bridge" },
        }, CALL_TIMEOUT_MS);
        bridge = String(run.address).includes("/") ? String(run.address) : `${o.machine}/${run.address}`;
        // Ended while core started it: kill it now that its address is known.
        if (ended) return release();
        const stream = await c.attach(bridge);
        if (ended) return release();
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

  /** Waits for the bridge's READY, then SYNC until SYNCED or NOHOST: what came before READY is the terminal's, not ours. */
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
      // NOHOST before READY (no live host in the registry) or after it (its socket refused the bridge).
      if (seen.includes(NOHOST_LINE)) return reject(new NoHost("no host: the bridge found none"));
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
