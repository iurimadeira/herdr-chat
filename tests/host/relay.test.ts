// A remote chat end to end (protocol.md "Relay and bridge"): the mod's WebSocket → the relay →
// herdr-core A → machine link (`--via` a shell) → core B → the bridge's PTY → the host's Unix socket.
// Two private hc sessions on this box stand in for the Mac and the remote machine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHost, idle, sleep, ROOT, HOST_ENTRY, HOST_NODE } from "./harness.ts";
import type { Host } from "./harness.ts";
import { WsClient, withoutPings, withoutSeq } from "./wsclient.ts";
import type { Rec } from "./wsclient.ts";
import { Rig, HC, hcUnusable } from "./hcrig.ts";

const PING_MS = 300;
const DEAD_MS = 2500;

let skip: string | false = hcUnusable() ?? false;
let rig: Rig | null = null;
/** The hosts' shared state dir: the relay reads registries under it on machine B. */
let shared = "";
const hosts: Host[] = [];
const relays: ChildProcess[] = [];

before(() => {
  if (skip) return;
  try {
    rig = new Rig().start();
  } catch (e) {
    skip = `hc sessions don't start here: ${e instanceof Error ? e.message.split("\n")[0] : e}`;
    rig?.stop();
    rig = null;
  }
  shared = realpathSync(mkdtempSync(join(tmpdir(), "pich-relay-")));
});

after(async () => {
  for (const r of relays) r.kill("SIGKILL");
  for (const h of hosts) await h.stop();
  rig?.stop();
});

let chats = 0;
async function host(): Promise<Host> {
  const h = await startHost({ name: "relay", dir: shared, chat: `c-r${++chats}`, speed: 5 });
  hosts.push(h);
  await h.client.waitFor(idle, 10_000, "idle");
  return h;
}

const macState = (): string => join(rig!.dir, "mac");

/** Starts a relay for machine B; its registry gives the port. */
async function startRelay(): Promise<{ proc: ChildProcess; port: number; log: () => string }> {
  const r = rig!;
  const proc = spawn(HOST_NODE, [
    HOST_ENTRY, "relay", "--machine", r.machine, "--state-dir", macState(),
    "--host", join(ROOT, "bin", "herdr-chat-host"), "--node", HOST_NODE, "--remote-state-dir", join(shared, "state"),
    "--hc", HC, "--ping-ms", String(PING_MS), "--dead-ms", String(DEAD_MS),
  ], { env: r.env(r.a), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  relays.push(proc);
  const regPath = join(macState(), "relays", `${r.machine}.json`);
  const t0 = Date.now();
  for (;;) {
    try {
      const e = JSON.parse(readFileSync(regPath, "utf8"));
      if (e.pid === proc.pid && e.wsPort) {
        const logPath = join(macState(), "relays", `${r.machine}.log`);
        const mine = `[${proc.pid}]`;
        return { proc, port: e.wsPort, log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes(mine)).join("\n") : "") };
      }
    } catch {}
    if (proc.exitCode !== null || Date.now() - t0 > 10_000) throw new Error(`relay did not start: ${out}`);
    await sleep(20);
  }
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

/** Live bridge terminals on machine B. */
function bridges(): Rec[] {
  return rig!.terminals("herdr-chat.role=bridge").filter((t) => t.state === "live");
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
  assert.deepEqual(wsTurnOf().map(withoutSeq), tcpTurn.map(withoutSeq));
  assert.deepEqual(ws.nonJson, []);
  const prompt = h.piCommands().findLast((c) => c.type === "prompt");
  assert.ok(prompt?.message === text, `the prompt reached the agent byte for byte (${prompt?.message?.length} of ${text.length} chars)`);
}

test("relay: a chat's records round-trip byte for byte, unicode, control characters and a 1 MiB line", { skip }, async () => {
  const h = await host();
  const { port, log } = await startRelay();
  const ws = await joinRelay(port, h);
  try {
    await welcomed(ws);
    assert.equal(bridges().length, 1, "one bridge on machine B");
    await sameTurn(h, ws, "héllo 漢字 🙂 \u0001\u0003\u0007\u0018\u001b[31m red\u001b[0m \u007f \u0085   tab\t cr\r lf\n end \\ \" '");
    const big = ("1 MiB: é漢🙂\u001b\u0000 ").repeat(1024) + "z".repeat((1 << 20) - 20 * 1024);
    await sameTurn(h, ws, big);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrelay log:\n${log()}`);
  } finally {
    ws.ws.close();
  }
});

function closedCode(ws: WsClient): Promise<number> {
  return new Promise((resolve) => {
    if (ws.closed) return resolve(-1);
    ws.ws.once("close", (code) => resolve(code));
  });
}

test("relay: a wrong token or a hello without a chat is closed, and nothing starts on the machine", { skip }, async () => {
  const h = await host();
  const r = await startRelay();
  try {
    const wrong = await joinRelay(r.port, h, "0".repeat(64));
    assert.equal(await closedCode(wrong), 4003);
    assert.deepEqual(wrong.records, [], "a wrong token gets nothing");
    const noChat = new WsClient(r.port);
    await noChat.opened();
    noChat.send({ t: "hello", v: 1, token: h.registry!.token, client: "mod" });
    assert.equal(await closedCode(noChat), 4003);
    const log = r.log();
    assert.match(log, /c-r\d+: a wrong token/);
    assert.match(log, /a bad hello/);
    assert.doesNotMatch(log, /starting a bridge/, "no bridge for a refused client");
    assert.equal(bridges().length, 0);
  } finally {
    r.proc.kill("SIGKILL");
  }
});

test("relay: a burst over 4 MiB while the mod holds its acks arrives intact (the window holds it back)", { skip }, async () => {
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  try {
    await welcomed(ws);
    const tcp = h.client;
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
    r.proc.kill("SIGKILL");
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

/** Big turns sent by the TCP client, each waited for. */
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

test("relay: the machine link held down mid-stream closes the mod with 4001; a reconnect's snapshot has every turn once", { skip }, async () => {
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
    assert.match(r.log(), /c-r\d+: (link: |core:|bridge ended)/, "the relay saw the link break");
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
    r.proc.kill("SIGKILL");
  }
});

test("relay: the machine link killed and back at once mid-stream: the records arrive intact, or the mod resyncs", { skip }, async () => {
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
      // Core carried the link over without a gap.
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
    r.proc.kill("SIGKILL");
  }
});

/** The bridge's pid, from its log on machine B. */
function bridgePid(chat: string): number {
  const log = readFileSync(join(shared, "state", "chats", `${chat}.bridge.log`), "utf8");
  const m = [...log.matchAll(/\[(\d+)\] bridge chat=/g)].pop();
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

/** TCP sockets listening for `pid`: local addresses. */
function listening(pid: number): string[] {
  const out = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" });
  return out.split("\n").filter((l) => l.includes(`pid=${pid},`)).map((l) => l.trim().split(/\s+/)[3]!);
}

test("relay: killing the relay leaves the host and its agent running; the bridge goes, a new relay serves the chat", { skip }, async () => {
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  await welcomed(ws);
  await sameTurn(h, ws, "before the relay dies");
  const bridge = bridgePid(h.chat);
  // The hosts share one pi-commands log: count agent starts across the kill.
  const starts = (): number => h.piCommands().filter((c) => c.type === "_start").length;
  const started = starts();
  r.proc.kill("SIGKILL");
  const t0 = Date.now();
  while (alive(bridge) && Date.now() - t0 < DEAD_MS * 4) await sleep(100);
  assert.ok(!alive(bridge), "the bridge exits once its relay stops pinging");
  assert.equal(bridges().length, 0, "no bridge terminal left");
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
    r2.proc.kill("SIGKILL");
  }
});

test("relay: no TCP port opens on the chat's machine; the relay listens on 127.0.0.1 only", { skip }, async () => {
  const h = await host();
  const r = await startRelay();
  const ws = await joinRelay(r.port, h);
  try {
    await welcomed(ws);
    const bridge = bridgePid(h.chat);
    assert.deepEqual(listening(bridge), [], "the bridge listens on nothing");
    assert.deepEqual(listening(h.proc.pid!).sort(), [`127.0.0.1:${h.registry!.port}`, `127.0.0.1:${h.registry!.wsPort}`].sort(), "the host has only its loopback ports");
    assert.deepEqual(listening(r.proc.pid!), [`127.0.0.1:${r.port}`], "the relay listens on loopback only");
    const reg = JSON.parse(readFileSync(join(shared, "state", "chats", `${h.chat}.json`), "utf8"));
    assert.equal(reg.socket, join(shared, "state", "chats", `${h.chat}.sock`));
  } finally {
    ws.ws.close();
    r.proc.kill("SIGKILL");
  }
});
