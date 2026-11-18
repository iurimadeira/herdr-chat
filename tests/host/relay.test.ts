// A remote chat end to end (protocol.md "Relay and bridge"): the mod's WebSocket → the relay →
// herdr-core A → machine link (`--via` a shell) → core B → the bridge's PTY → the host's Unix socket.
// Two private hc sessions on this box stand in for the Mac and the remote machine.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
        return { proc, port: e.wsPort, log: () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "") };
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
