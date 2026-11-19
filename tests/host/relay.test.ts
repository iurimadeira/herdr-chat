// A remote chat end to end (protocol.md "Relay and bridge"): the mod's WebSocket → the relay →
// herdr-core A → machine link (`--via` a shell) → core B → the bridge's PTY → the host's Unix socket.
// Two private hc sessions on this box stand in for the Mac and the remote machine. The hosts run
// --socket-only, as a remote chat's host does. The cores' HOME is the hosts' temp dir, and the
// relay names the remote state dir relative to it, as its default does.
import { test, before, after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, writeFileSync, mkdtempSync, readFileSync, realpathSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHost, idle, sleep, ROOT, HOST_ENTRY, HOST_NODE, tcpListening } from "./harness.ts";
import type { Host } from "./harness.ts";
import { WsClient, withoutPings, withoutSeq } from "./wsclient.ts";
import type { Rec } from "./wsclient.ts";
import { Rig, HC, hcUnusable } from "./hcrig.ts";
import { LINK_WINDOW } from "../../host/relaylink.ts";
import { CoreClient } from "../../host/hccore.ts";
import type { Stream } from "../../host/hccore.ts";

const PING_MS = 300;
const DEAD_MS = 2500;

let skip: string | null = hcUnusable();
let rig: Rig | null = null;
/** The hosts' temp dir, and the cores' HOME: the relay reads registries under `state` there on machine B. */
let shared = "";
const hosts: Host[] = [];
const relays: ChildProcess[] = [];

before(() => {
  if (skip) return;
  shared = realpathSync(mkdtempSync(join(tmpdir(), "pich-relay-")));
  try {
    rig = new Rig({ home: shared }).start();
  } catch (e) {
    skip = `hc sessions don't start here: ${e instanceof Error ? e.message.split("\n")[0] : e}`;
    rig?.stop();
    rig = null;
  }
});

after(async () => {
  for (const r of relays) r.kill("SIGKILL");
  for (const h of hosts) await h.stop();
  rig?.stop();
  if (shared) rmSync(shared, { recursive: true, force: true });
});

/** Skips the test (at run time: `before` decides) when hc can't run here. */
function skipped(t: TestContext): boolean {
  if (!skip) return false;
  t.skip(skip);
  return true;
}

let chats = 0;
async function host(): Promise<Host> {
  const h = await startHost({ name: "relay", dir: shared, chat: `c-r${++chats}`, speed: 5, socketOnly: true });
  hosts.push(h);
  await h.client.waitFor(idle, 10_000, "idle");
  return h;
}

const macState = (): string => join(rig!.dir, "mac");
const relayLog = (machine = rig!.machine): string => {
  const p = join(macState(), "relays", `${machine}.log`);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

type Relay = { proc: ChildProcess; port: number; log: () => string; exited: Promise<number | null> };

type RelayOpts = {
  /** The hc the relay runs (slowHc's, to slow or stall core's path). */
  hc?: string;
  machine?: string;
  deadMs?: number;
  env?: NodeJS.ProcessEnv;
};

function spawnRelay(opts: RelayOpts = {}): { proc: ChildProcess; out: () => string; exited: Promise<number | null> } {
  const r = rig!;
  const proc = spawn(HOST_NODE, [
    HOST_ENTRY, "relay", "--machine", opts.machine ?? r.machine, "--state-dir", macState(),
    "--host", join(ROOT, "bin", "herdr-chat-host"), "--node", HOST_NODE, "--remote-state-dir", "state",
    "--hc", opts.hc ?? HC, "--ping-ms", String(PING_MS), "--dead-ms", String(opts.deadMs ?? DEAD_MS),
  ], { env: { ...r.env(r.a), ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  relays.push(proc);
  const exited = new Promise<number | null>((res) => proc.on("exit", (code) => res(code)));
  return { proc, out: () => out, exited };
}

/** Starts a relay for machine B; its registry gives the port. */
async function startRelay(opts: RelayOpts = {}): Promise<Relay> {
  const { proc, out, exited } = spawnRelay(opts);
  const regPath = join(macState(), "relays", `${opts.machine ?? rig!.machine}.json`);
  const t0 = Date.now();
  for (;;) {
    try {
      const e = JSON.parse(readFileSync(regPath, "utf8"));
      if (e.pid === proc.pid && e.wsPort) {
        const mine = `[${proc.pid}]`;
        return { proc, port: e.wsPort, exited, log: () => relayLog(opts.machine).split("\n").filter((l) => l.includes(mine)).join("\n") };
      }
    } catch {}
    if (proc.exitCode !== null || Date.now() - t0 > 10_000) throw new Error(`relay did not start: ${out()}`);
    await sleep(20);
  }
}

/**
 * An hc for the relay whose `connect` is slow or stalls (tests/fake-hc/slow-connect.mjs): every byte
 * from core `delayMs` late; the `stall` methods never answered while the returned `stallFile` exists.
 */
function slowHc(name: string, o: { delayMs?: number; stall?: string[] }): { hc: string; stallFile: string } {
  const hc = join(shared, `${name}-hc`);
  const stallFile = join(shared, `${name}-stall`);
  const env = [
    `SLOW_HC_REAL='${HC}'`, `SLOW_HC_DELAY_MS='${o.delayMs ?? 0}'`,
    `SLOW_HC_STALL='${(o.stall ?? []).join(",")}'`, `SLOW_HC_STALL_FILE='${stallFile}'`,
  ];
  writeFileSync(hc, `#!/bin/sh\nexec env ${env.join(" ")} '${HOST_NODE}' '${join(ROOT, "tests", "fake-hc", "slow-connect.mjs")}' "$@"\n`);
  chmodSync(hc, 0o755);
  return { hc, stallFile };
}

/** SIGKILL, and wait until it is gone: the next relay takes its lock over. */
async function killRelay(r: Relay): Promise<void> {
  r.proc.kill("SIGKILL");
  await r.exited;
}

async function joinRelay(port: number, h: Host, token = h.registry!.token): Promise<WsClient> {
  const ws = new WsClient(port);
  await ws.opened();
  ws.send({ t: "hello", v: 1, token, client: "mod", chat: h.chat });
  return ws;
}

async function welcomed(ws: WsClient, ms = 15_000): Promise<void> {
  await ws.until(() => ws.records.some((r) => r.t === "snapshot"), ms, "welcome and snapshot through the relay");
  assert.deepEqual(ws.records.slice(0, 2).map((r) => r.t), ["welcome", "snapshot"]);
}

/** Live bridge terminals for `chat` on machine B. */
function bridges(chat: string): Rec[] {
  return rig!.terminals(`herdr-chat.bridge=${chat}`).filter((t) => t.state === "live");
}

/** The records of one turn as the direct client got them and as the relayed one did. */
async function sameTurn(h: Host, ws: WsClient, text: string): Promise<void> {
  const tcp = h.client;
  const wsFrom = ws.records.length;
  const tcpFrom = tcp.records.length;
  const res = await ws.req("send", { text });
  assert.equal(res.ok, true, JSON.stringify(res).slice(0, 300));
  await tcp.waitFor((c) => idle(c) && c.items.some((i) => i.kind === "assistant" && i.text === `ok: ${text.slice(0, 60)}`), 30_000, "the turn ends");
  const tcpTurn = withoutPings(tcp.records.slice(tcpFrom));
  const wsTurnOf = (): Rec[] => withoutPings(ws.records.slice(wsFrom)).filter((r) => r.t !== "res");
  await ws.until(() => wsTurnOf().length >= tcpTurn.length, 15_000, "the relayed client catches up");
  // A usage patch may follow idle: the relayed client may already have it, the direct one not yet.
  assert.deepEqual(wsTurnOf().slice(0, tcpTurn.length).map(withoutSeq), tcpTurn.map(withoutSeq));
  assert.deepEqual(ws.nonJson, []);
  const prompt = h.piCommands().findLast((c) => c.type === "prompt");
  assert.ok(prompt?.message === text, `the prompt reached the agent byte for byte (${prompt?.message?.length} of ${text.length} chars)`);
}

function closedCode(ws: WsClient): Promise<number> {
  return new Promise((resolve) => {
    if (ws.closed) return resolve(-1);
    ws.ws.once("close", (code) => resolve(code));
  });
}

/** The bridge's log on machine B. */
const bridgeLog = (chat: string): string => {
  const p = join(shared, "state", "chats", `${chat}.bridge.log`);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}

test("relay: a chat's records round-trip byte for byte, unicode, control characters and a 1 MiB line; the bridge is no chat to the mod", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  try {
    await welcomed(ws);
    const [b] = bridges(h.chat);
    assert.equal(bridges(h.chat).length, 1, "one bridge on machine B");
    const got = JSON.parse(rig!.hc(["get", b!.address, "--json"], rig!.b));
    assert.equal(got.parent, null, "no parent (no_parent)");
    assert.equal(got.notify, false, "no notes (no_notify)");
    assert.deepEqual(got.labels, { "herdr-chat.role": "bridge", "herdr-chat.bridge": h.chat });
    // The mod finds a chat's host (and sweeps orphans) by herdr-chat.chat: a bridge must not match.
    assert.deepEqual(rig!.terminals(`herdr-chat.chat=${h.chat}`), [], "no B terminal carries the chat's label");
    await sameTurn(h, ws, "héllo 漢字 🙂 \u0001\u0003\u0007\u0018\u001b[31m red\u001b[0m \u007f \u0085   tab\t cr\r lf\n end \\ \" '");
    const big = ("1 MiB: é漢🙂\u001b\u0000 ").repeat(1024) + "z".repeat((1 << 20) - 20 * 1024);
    await sameTurn(h, ws, big);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    ws.ws.close();
    await killRelay(r);
  }
});

test("relay: a 6 MiB record from the mod crosses to the host in one go, no resync", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  try {
    await welcomed(ws);
    // Over the link window and core's ~4 MiB: it crosses only window by window.
    const text = "mod to host " + "é漢🙂x".repeat(640 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify({ text })) > 6 << 20);
    await sameTurn(h, ws, text);
    assert.ok(!ws.closed, "no resync");
    assert.doesNotMatch(r.log(), /link:|bridge ended/);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    ws.ws.close();
    await killRelay(r);
  }
});

test("relay: a wrong token, a chat that does not exist, a malformed entry or a hello without a chat is refused alike, and nothing starts on the machine", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay();
  try {
    const reasons: string[] = [];
    const refused = async (ws: WsClient): Promise<void> => {
      const reason = new Promise<string>((res) => ws.ws.once("close", (_c, why) => res(String(why))));
      assert.equal(await closedCode(ws), 4003);
      reasons.push(await reason);
      assert.deepEqual(ws.records, []);
    };
    await refused(await joinRelay(r.port, h, "0".repeat(64)));
    const ghost = new WsClient(r.port);
    await ghost.opened();
    ghost.send({ t: "hello", v: 1, token: h.registry!.token, client: "mod", chat: "c-no-such-chat" });
    await refused(ghost);
    const noChat = new WsClient(r.port);
    await noChat.opened();
    noChat.send({ t: "hello", v: 1, token: h.registry!.token, client: "mod" });
    await refused(noChat);
    writeFileSync(join(shared, "state", "chats", "c-malformed.json"), "{ not json", { mode: 0o600 });
    const malformed = new WsClient(r.port);
    await malformed.opened();
    malformed.send({ t: "hello", v: 1, token: h.registry!.token, client: "mod", chat: "c-malformed" });
    await refused(malformed);
    assert.deepEqual(reasons, ["refused", "refused", "refused", "refused"], "the reason says nothing of the chat or its path");
    const log = r.log();
    assert.match(log, /c-r\d+: a wrong token/);
    assert.match(log, /c-no-such-chat: no registry entry/);
    assert.match(log, /c-malformed: a malformed registry entry/);
    assert.match(log, /a bad hello/);
    assert.doesNotMatch(log, /starting a bridge/, "no bridge for a refused client");
    assert.equal(bridges(h.chat).length + bridges("c-no-such-chat").length, 0);
  } finally {
    await killRelay(r);
  }
});

test("relay: a chat whose host is gone closes 4004 (no host, retry once a host serves it), not refused: exited, nothing starts; killed, the bridge reports no host", async (t) => {
  if (skipped(t)) return;
  const r = await startRelay();
  try {
    const exited = await host();
    const token = exited.registry!.token;
    await exited.stop();
    assert.equal(exited.registry!.pid, null);
    const a = await joinRelay(r.port, exited, token);
    assert.equal(await closedCode(a), 4004);
    assert.match(r.log(), /no host: the chat's host has exited/);
    assert.doesNotMatch(r.log(), /starting a bridge/);

    const killed = await host();
    const ktoken = killed.registry!.token;
    killed.proc.kill("SIGKILL");
    await killed.exited;
    assert.ok(killed.registry!.pid, "a SIGKILLed host leaves its entry");
    const b = await joinRelay(r.port, killed, ktoken);
    assert.equal(await closedCode(b), 4004);
    assert.match(r.log(), /no host: the bridge found none/);
    assert.match(bridgeLog(killed.chat), /exit 4: no host serves the chat/);
    await until(() => bridges(killed.chat).length === 0, 10_000, "the bridge gone");
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    await killRelay(r);
  }
});

test("relay: a registry read that fails for another reason than a missing file closes 1011 (retry), not 4003; once readable the chat is served", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay();
  const reg = join(shared, "state", "chats", `${h.chat}.json`);
  const token = h.registry!.token;
  try {
    // Core reaches the machine, but the read fails there (EACCES: core's `io`).
    chmodSync(reg, 0);
    const ws = await joinRelay(r.port, h, token);
    const reason = new Promise<string>((res) => ws.ws.once("close", (_c, why) => res(String(why))));
    assert.equal(await closedCode(ws), 1011);
    assert.equal(await reason, "setup failed");
    assert.match(r.log(), /registry read failed: .*Permission denied/);
    assert.doesNotMatch(r.log(), /starting a bridge/);
    chmodSync(reg, 0o600);
    const again = await joinRelay(r.port, h);
    await welcomed(again);
    again.ws.close();
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    chmodSync(reg, 0o600);
    await killRelay(r);
  }
});

test("relay: one relay per machine: a second refuses while the first lives; one after a SIGKILL takes over; a stop clears only its own entry", async (t) => {
  if (skipped(t)) return;
  const regPath = join(macState(), "relays", `${rig!.machine}.json`);
  const r1 = await startRelay();
  const second = spawnRelay();
  assert.notEqual(await second.exited, 0, "the second relay exits");
  assert.match(second.out(), /already serves machine/);
  assert.equal(JSON.parse(readFileSync(regPath, "utf8")).pid, r1.proc.pid, "the first keeps the entry");
  await killRelay(r1);
  const r2 = await startRelay();
  assert.equal(JSON.parse(readFileSync(regPath, "utf8")).pid, r2.proc.pid);
  r2.proc.kill("SIGTERM");
  assert.equal(await r2.exited, 0);
  assert.equal(JSON.parse(readFileSync(regPath, "utf8")).pid, null, "a stopped relay clears its entry");
  // And frees the machine at once: the next relay takes it.
  const r3 = await startRelay();
  r3.proc.kill("SIGTERM");
  assert.equal(await r3.exited, 0);
});

test("relay: a burst over 4 MiB while the mod holds its acks arrives intact; the bridge never has more than the window in flight", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  try {
    await welcomed(ws);
    const tcp = await h.connect();
    const wsFrom = ws.records.length;
    const tcpFrom = tcp.records.length;
    const held = ws.messages;
    ws.holding = true;
    const prompt = (i: number): string => `burst ${i} ` + "é🙂b".repeat(1 << 18);
    for (let i = 0; i < 18; i++) {
      const res = await tcp.req("send", { text: prompt(i) });
      assert.equal(res.disposition, "started");
      await tcp.waitFor((c) => idle(c) && c.items.filter((x) => x.kind === "assistant").length === i + 1, 20_000, `turn ${i}`);
    }
    // The sender alone gets its replies.
    const tcpBurst = withoutPings(tcp.records.slice(tcpFrom)).filter((x) => x.t !== "res");
    const burstBytes = tcpBurst.reduce((n, x) => n + Buffer.byteLength(JSON.stringify(x)), 0);
    assert.ok(burstBytes > 4 << 20, `the burst is ${burstBytes} bytes`);
    assert.ok(ws.messages - held <= 4, `the held client got at most its window (${ws.messages - held} messages)`);
    ws.resume();
    const wsBurstOf = (): Rec[] => withoutPings(ws.records.slice(wsFrom));
    await ws.until(() => wsBurstOf().length >= tcpBurst.length, 30_000, "the held burst arrives").catch((e) => {
      throw new Error(`${e.message}: ${wsBurstOf().length} of ${tcpBurst.length} records, ${ws.messages} messages, closed=${ws.closed}`);
    });
    assert.deepEqual(wsBurstOf().map(withoutSeq), tcpBurst.map(withoutSeq));
    assert.ok(!ws.closed, "no resync");
    assert.doesNotMatch(r.log(), /link:|bridge ended/);

    // A reconnect's snapshot is one record of several MiB: the other way, over the window too.
    ws.ws.close();
    // The closed connection's bridge is killed and logs what its window did.
    await until(() => /exit 0: SIG\w+ \(window filled/.test(bridgeLog(h.chat)), 10_000, "the first bridge's exit");
    const m = /exit 0: SIG\w+ \(window filled (\d+) times, at most (\d+) bytes in flight\)/.exec(bridgeLog(h.chat))!;
    assert.ok(Number(m[1]) >= 1, "the held mod filled the window");
    assert.ok(Number(m[2]) <= LINK_WINDOW, `at most the window in flight (${m[2]})`);
    const again = await joinRelay(r.port, h);
    await welcomed(again, 30_000);
    const snap = again.records.find((x) => x.t === "snapshot")!;
    assert.ok(Buffer.byteLength(JSON.stringify(snap)) > 4 << 20, "a snapshot over 4 MiB");
    assert.deepEqual(snap.items, tcp.items);
    again.ws.close();
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    ws.ws.close();
    await killRelay(r);
  }
});

/** Joins until welcomed: the machine link may still be coming back after a drop. */
async function rejoin(port: number, h: Host): Promise<WsClient> {
  const t0 = Date.now();
  for (;;) {
    const ws = await joinRelay(port, h);
    try {
      await welcomed(ws, 10_000);
      return ws;
    } catch (e) {
      ws.ws.close();
      if (Date.now() - t0 > 60_000) throw e;
      await sleep(500);
    }
  }
}

/** Big turns sent by the host's direct client, each waited for. */
function turns(h: Host): (i: number) => Promise<void> {
  return async (i) => {
    const res = await h.client.req("send", { text: `turn ${i} ` + "é🙂".repeat(1 << 17) });
    assert.equal(res.disposition, "started");
    await h.client.waitFor((c) => idle(c) && c.items.filter((x) => x.kind === "assistant").length === i + 1, 20_000, `turn ${i}`);
  };
}

function everyTurnOnce(snap: Rec, h: Host, n: number): void {
  assert.deepEqual(snap.items, h.client.items);
  const users = (snap.items as Rec[]).filter((x) => x.kind === "user").map((x) => String(x.text).split(" ").slice(0, 2).join(" "));
  assert.deepEqual(users, Array.from({ length: n }, (_, i) => `turn ${i}`), "every turn once, in order");
}

test("relay: the machine link held down mid-stream closes the mod with 4001; a reconnect's snapshot has every turn once", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  try {
    await welcomed(ws);
    const turn = turns(h);
    // Records wait in the link's window and queue when the link goes.
    ws.holding = true;
    for (let i = 0; i < 3; i++) await turn(i);
    const closed = closedCode(ws);
    rig!.drop(true);
    assert.equal(await closed, 4001);
    assert.match(r.log(), /c-r\d+: (link: |core link closed|bridge ended)/, "the relay saw the link break");
    // The chat goes on without the mod.
    for (let i = 3; i < 5; i++) await turn(i);
    assert.equal(h.proc.exitCode, null, "the host lives");
    rig!.up();

    const again = await rejoin(r.port, h);
    everyTurnOnce(again.records.find((x) => x.t === "snapshot")!, h, 5);
    await sameTurn(h, again, "after the resync 🙂");
    again.ws.close();
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    rig!.up();
    ws.ws.close();
    await killRelay(r);
  }
});

test("relay: a stray control byte typed into the bridge's terminal breaks the link: 4001, then a snapshot through a new bridge", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  try {
    await welcomed(ws);
    await sameTurn(h, ws, "before the stray byte");
    const [b] = bridges(h.chat);
    const closed = closedCode(ws);
    // Another core A client attached to the bridge's terminal writes one byte: across the machine
    // link and core B into the PTY the bridge reads the relay's lines from. (`hc keys` stalls in core
    // on a terminal that carried this much.)
    const other = await CoreClient.open(HC, rig!.env(rig!.a));
    try {
      const s = await other.attach(`${rig!.machine}/${b!.address}`);
      s.write(Buffer.from([0x18]));
      assert.equal(await closed, 4001);
    } finally {
      other.end();
    }
    assert.match(bridgeLog(h.chat), /exit 6: link: control or non-ASCII byte 0x18/);
    assert.match(r.log(), /bridge ended/);
    await turns(h)(1);
    const again = await rejoin(r.port, h);
    assert.deepEqual(again.records.find((x) => x.t === "snapshot")!.items, h.client.items, "the snapshot has all, the turn after the break too");
    await sameTurn(h, again, "after the stray byte");
    again.ws.close();
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    ws.ws.close();
    await killRelay(r);
  }
});

// Not a failure mode with one outcome: core may carry the link over a quick drop intact or repaint
// (a resync). Either way no record arrives corrupt, twice or out of order.
test("relay: the machine link killed and back at once mid-stream: whatever arrives arrives in order, and a resync recovers it all", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  try {
    await welcomed(ws);
    const turn = turns(h);
    const from = ws.records.length;
    const tcpFrom = h.client.records.length;
    ws.holding = true;
    for (let i = 0; i < 3; i++) await turn(i);
    rig!.drop();
    for (let i = 3; i < 5; i++) await turn(i);
    ws.resume();
    const want = withoutPings(h.client.records.slice(tcpFrom)).filter((x) => x.t !== "res");
    const got = (): Rec[] => withoutPings(ws.records.slice(from));
    await ws.until(() => ws.closed || got().length >= want.length, 30_000, "the records or a resync");
    if (!ws.closed) {
      assert.deepEqual(got().map(withoutSeq), want.map(withoutSeq));
      await sameTurn(h, ws, "after the drop 🙂");
    } else {
      assert.ok(got().every((x, i) => JSON.stringify(withoutSeq(x)) === JSON.stringify(withoutSeq(want[i]!))), "what came before the resync came in order");
      const again = await rejoin(r.port, h);
      everyTurnOnce(again.records.find((x) => x.t === "snapshot")!, h, 5);
      again.ws.close();
    }
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    ws.ws.close();
    await killRelay(r);
  }
});

/** The bridge's pid, from its log on machine B. */
function bridgePid(chat: string): number {
  const m = [...bridgeLog(chat).matchAll(/\[(\d+)\] bridge chat=/g)].pop();
  assert.ok(m, "the bridge logged its start");
  return Number(m[1]);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("relay: killing the relay leaves the host and its agent running; the bridge goes, a new relay serves the chat", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  await welcomed(ws);
  await sameTurn(h, ws, "before the relay dies");
  const bridge = bridgePid(h.chat);
  // The hosts share one pi-commands log: count agent starts across the kill.
  const starts = (): number => h.piCommands().filter((c) => c.type === "_start").length;
  const started = starts();
  await killRelay(r);
  const t0 = Date.now();
  while (alive(bridge) && Date.now() - t0 < DEAD_MS * 4) await sleep(100);
  assert.ok(!alive(bridge), "the bridge exits once its relay stops pinging");
  assert.equal(bridges(h.chat).length, 0, "no bridge terminal left");
  assert.equal(h.proc.exitCode, null, "the host lives");

  const r2 = await startRelay();
  try {
    const again = await joinRelay(r2.port, h);
    await welcomed(again);
    const snap = again.records.find((x) => x.t === "snapshot")!;
    assert.deepEqual(snap.items, h.client.items);
    await sameTurn(h, again, "after a new relay");
    assert.equal(starts(), started, "the same agent all along");
    again.ws.close();
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r2.log()}`);
  } finally {
    await killRelay(r2);
  }
});

test("relay: no TCP port opens on the chat's machine (the host serves only its socket); the relay listens on 127.0.0.1 only", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  try {
    await welcomed(ws);
    const bridge = bridgePid(h.chat);
    // The relay's own port is the control: a tool that sees nothing fails here, not passes below.
    const relayPorts = tcpListening(r.proc.pid!);
    if (relayPorts === null) {
      t.skip("neither lsof nor ss here: the listener checks are skipped");
    } else {
      assert.deepEqual(relayPorts, [`127.0.0.1:${r.port}`], "the relay listens on loopback only");
      assert.deepEqual(tcpListening(bridge), [], "the bridge listens on nothing");
      assert.deepEqual(tcpListening(h.proc.pid!), [], "the host listens on no TCP port");
    }
    const reg = JSON.parse(readFileSync(join(shared, "state", "chats", `${h.chat}.json`), "utf8"));
    assert.equal(reg.port, null);
    assert.equal(reg.wsPort, null);
    assert.equal(reg.socket, join(shared, "state", "chats", `${h.chat}.${h.proc.pid}.sock`));
  } finally {
    ws.ws.close();
    await killRelay(r);
  }
});

test("relay: over a slow link (setup over 5 s, past the host's hello timeout) the chat still connects and carries a turn", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  // Every byte from core 1.5 s late: the registry read, the bridge's start, its attach, READY and SYNCED each wait.
  const { hc } = slowHc("slow-link", { delayMs: 1500 });
  const r = await startRelay({ hc, deadMs: 10_000 });
  const t0 = Date.now();
  const ws = await joinRelay(r.port, h);
  try {
    await welcomed(ws, 30_000);
    assert.ok(Date.now() - t0 > 5000, `the setup took ${Date.now() - t0} ms`);
    await sameTurn(h, ws, "over a slow link");
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}\nbridge log:\n${bridgeLog(h.chat)}`);
  } finally {
    ws.ws.close();
    await killRelay(r);
  }
});

test("relay: a killed host gives 4004 even when the bridge finds no host before its attach lands", async (t) => {
  if (skipped(t)) return;
  const killed = await host();
  const token = killed.registry!.token;
  killed.proc.kill("SIGKILL");
  await killed.exited;
  const { hc } = slowHc("late-attach", { delayMs: 1500 });
  const r = await startRelay({ hc, deadMs: 10_000 });
  try {
    const ws = await joinRelay(r.port, killed, token);
    assert.equal(await closedCode(ws), 4004);
    assert.match(r.log(), /no host: the bridge found none/);
    await until(() => /exit 4: no host serves the chat/.test(bridgeLog(killed.chat)), 10_000, "the bridge's exit");
    await until(() => bridges(killed.chat).length === 0, 10_000, "the bridge gone");
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}\nbridge log:\n${bridgeLog(killed.chat)}`);
  } finally {
    await killRelay(r);
  }
});

test("core client: streams closed here or ended by core leave nothing behind, however many come and go", async (t) => {
  if (skipped(t)) return;
  const c = await CoreClient.open(HC, rig!.env(rig!.a));
  const run = async (): Promise<string> => {
    const r = await c.call("terminal.run", {
      on: rig!.machine, argv: ["sh", "-c", "while :; do echo tick; sleep 0.02; done"],
      no_parent: true, no_notify: true, rm: true, labels: { "herdr-chat.test": "leak" },
    }, 10_000);
    return String(r.address).includes("/") ? String(r.address) : `${rig!.machine}/${r.address}`;
  };
  const data = (s: Stream): Promise<void> => new Promise((res) => (s.onData = () => res()));
  try {
    const t1 = await run();
    for (let i = 0; i < 15; i++) {
      const s = await c.attach(t1);
      await data(s);
      s.close();
    }
    for (let i = 0; i < 5; i++) {
      const addr = await run();
      const s = await c.attach(addr);
      await data(s);
      const gone = new Promise<void>((res) => (s.onClose = () => res()));
      // With rm, core may answer that the terminal is already removed.
      await c.call("terminal.kill", { terminal: addr }, 10_000).catch(() => {});
      await gone;
    }
    await sleep(500);
    assert.equal(c.channels, 0, "no stream or held frame left");
  } finally {
    c.end();
    for (const x of rig!.terminals("herdr-chat.test=leak")) if (x.state === "live") try { rig!.hc(["kill", x.address], rig!.b); } catch {}
  }
});

test("relay: 8 setups at once, the ninth busy (1013); an attach core never answers frees its slot at the setup deadline (1011)", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const { hc, stallFile } = slowHc("stall-attach", { stall: ["terminal.attach"] });
  writeFileSync(stallFile, "");
  const r = await startRelay({ hc, env: { HERDR_CHAT_RELAY_SETUP_MS: "1500" } });
  const open: WsClient[] = [];
  try {
    for (let i = 0; i < 8; i++) open.push(await joinRelay(r.port, h));
    await until(() => (r.log().match(/starting a bridge/g) ?? []).length === 8, 10_000, "8 bridges starting");
    const ninth = await joinRelay(r.port, h);
    assert.equal(await closedCode(ninth), 1013);
    assert.deepEqual(await Promise.all(open.map(closedCode)), Array(8).fill(1011));
    // Every slot is free again: the next connection sets up (and stalls) instead of being busy.
    const again = await joinRelay(r.port, h);
    assert.equal(await closedCode(again), 1011);
    await until(() => bridges(h.chat).length === 0, 15_000, "the stalled bridges killed");
    rmSync(stallFile);
    const ws = await joinRelay(r.port, h);
    await welcomed(ws);
    ws.ws.close();
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    for (const w of open) w.ws.close();
    await killRelay(r);
  }
});

test("relay: over 1 MiB from the mod before its link is up closes 4003, and its bridge goes", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  // The attach never answers: the link never comes up, so everything after the hello is held.
  const { hc, stallFile } = slowHc("early-bytes", { stall: ["terminal.attach"] });
  writeFileSync(stallFile, "");
  const r = await startRelay({ hc });
  try {
    const ws = await joinRelay(r.port, h);
    const code = closedCode(ws);
    const chunk = JSON.stringify({ t: "req", id: 1, op: "send", text: "x".repeat(300 * 1024) });
    for (let i = 0; i < 4; i++) ws.ws.send(chunk);
    assert.equal(await code, 4003);
    assert.match(r.log(), /bytes before the link was up/);
    await until(() => bridges(h.chat).length === 0, 15_000, "its bridge killed");
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    rmSync(stallFile, { force: true });
    await killRelay(r);
  }
});

test("relay: a machine core doesn't know closes 1011 (retry), not refused", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const r = await startRelay({ machine: "nosuch" });
  try {
    const ws = await joinRelay(r.port, h);
    assert.equal(await closedCode(ws), 1011);
    assert.match(r.log(), /registry read failed: .*nosuch/);
  } finally {
    await killRelay(r);
  }
});

test("relay: a registry read core never answers closes 1011 (retry) at the call's timeout", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  const { hc, stallFile } = slowHc("stall-read", { stall: ["file.read"] });
  writeFileSync(stallFile, "");
  const r = await startRelay({ hc });
  try {
    const t0 = Date.now();
    const ws = await joinRelay(r.port, h);
    assert.equal(await closedCode(ws), 1011);
    assert.ok(Date.now() - t0 < 19_000, "the call's timeout, before the setup deadline");
    assert.match(r.log(), /registry read failed: .*no answer/);
    assert.equal(bridges(h.chat).length, 0, "nothing started on the machine");
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${r.log()}`);
  } finally {
    rmSync(stallFile, { force: true });
    await killRelay(r);
  }
});

test("bridge: no SYNC within --dead-ms exits 8, and the host lives on", async (t) => {
  if (skipped(t)) return;
  const h = await host();
  // As the relay starts it, in a terminal on the machine, but nobody answers its READY.
  rig!.hc([
    "run", "--bg", "--no-parent", "--no-notify", "--label", `herdr-chat.bridge=${h.chat}`, "--",
    HOST_NODE, HOST_ENTRY, "bridge", h.chat, "--state-dir", join(shared, "state"), "--ping-ms", "100", "--dead-ms", "800",
  ], rig!.b);
  await until(() => /exit 8: no sync in 800 ms/.test(bridgeLog(h.chat)), 10_000, "the bridge's exit 8");
  await until(() => bridges(h.chat).length === 0, 10_000, "the bridge gone");
  assert.equal(h.proc.exitCode, null, "the host lives");
});
