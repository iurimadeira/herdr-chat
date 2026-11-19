// The host's Unix socket (protocol.md "Transport"): the remote path's only way in, beside the loopback ports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { ChatClient } from "../../host/client.ts";
import { dirname, join } from "node:path";
import { startHost, idle, sleep, Host } from "./harness.ts";
import { LineFramer } from "../../host/framing.ts";

type Rec = Record<string, any>;

function unixClient(path: string, hello: Rec): { records: Rec[]; closed: Promise<void>; send: (r: Rec) => void } {
  const records: Rec[] = [];
  const s = connect(path);
  const framer = new LineFramer();
  framer.onLine = (l) => records.push(JSON.parse(l));
  s.on("data", (d) => framer.push(d));
  s.on("error", () => {});
  s.on("connect", () => s.write(JSON.stringify(hello) + "\n"));
  const closed = new Promise<void>((r) => s.on("close", () => r()));
  return { records, closed, send: (r) => s.write(JSON.stringify(r) + "\n") };
}

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(20);
  }
}

test("unix socket: 0600 beside the registry entry, the same records as TCP, gone when the host exits", async () => {
  const h = await startHost({ name: "unix-sock", speed: 5 });
  try {
    await h.client.waitFor(idle, 10_000, "idle");
    const reg = h.registry!;
    assert.equal(reg.socket, join(h.stateDir, "chats", `${h.chat}.${reg.pid}.sock`), "beside the registry entry, named by the host pid");
    assert.equal(dirname(reg.socket!), join(h.stateDir, "chats"));
    const st = statSync(reg.socket!);
    assert.ok(st.isSocket(), "a socket");
    assert.equal(st.mode & 0o777, 0o600, `mode ${(st.mode & 0o777).toString(8)}`);
    assert.ok(reg.port && reg.wsPort, "the loopback ports stay for local chats");

    const u = unixClient(reg.socket!, { t: "hello", v: 1, token: reg.token, client: "test" });
    await until(() => u.records.some((r) => r.t === "snapshot"), 5000, "welcome and snapshot");
    assert.deepEqual(u.records.slice(0, 2).map((r) => r.t), ["welcome", "snapshot"]);
    u.send({ t: "req", id: "u1", op: "send", text: "over the socket" });
    await until(() => u.records.some((r) => r.t === "res" && r.id === "u1"), 5000, "the reply");
    await h.client.waitFor((c) => idle(c) && c.items.some((i) => i.kind === "assistant" && i.text === "ok: over the socket"), 10_000, "the turn");

    const bad = unixClient(reg.socket!, { t: "hello", v: 1, token: "0".repeat(64), client: "test" });
    await bad.closed;
    assert.deepEqual(bad.records, [], "a wrong token gets nothing");

    await h.stop();
    assert.equal(h.registry!.socket, null, "the registry forgets it");
    assert.ok(!existsSync(reg.socket!), "the socket file is removed");
  } finally {
    await h.stop();
  }
});

/** A socket file left behind as by a SIGKILLed host: the process is dead, the file stays. */
async function staleSocket(path: string): Promise<void> {
  const p = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((r) => p.stdout!.once("data", () => r()));
  p.kill("SIGKILL");
  await new Promise<void>((r) => p.on("exit", () => r()));
}

const listening = (pid: number): string[] => {
  try {
    return execFileSync("ss", ["-ltnpH"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`pid=${pid},`));
  } catch {
    return [];
  }
};

test("unix socket: a new host removes only dead hosts' sockets, never a live one's or a non-socket, and stopping one host leaves the other's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unix-two-"));
  const chats = join(dir, "state", "chats");
  mkdirSync(chats, { recursive: true, mode: 0o700 });
  const chat = "c-two";
  const dead = join(chats, `${chat}.999999.sock`);
  const legacy = join(chats, `${chat}.sock`);
  const notSocket = join(chats, `${chat}.999998.sock`);
  const other = join(chats, `c-other.999997.sock`);
  await staleSocket(dead);
  await staleSocket(legacy);
  await staleSocket(other);
  writeFileSync(notSocket, "not a socket");
  const a = await startHost({ name: "unix-two-a", dir, chat, speed: 5 });
  let b: Host | null = null;
  try {
    assert.ok(!existsSync(dead), "a dead host's socket of this chat is removed");
    assert.ok(!existsSync(legacy), "the pre-pid name of a dead host too");
    assert.ok(existsSync(notSocket), "a file that isn't a socket stays");
    assert.ok(existsSync(other), "another chat's socket stays");
    const aSock = a.registry!.socket!;
    b = await new Host({ name: "unix-two-b", dir, chat, speed: 5 }).start();
    const bSock = b.registry!.socket!;
    const bToken = b.registry!.token;
    assert.notEqual(aSock, bSock);
    assert.ok(statSync(aSock).isSocket(), "the live host's socket survives the new host's start");
    await a.stop();
    assert.ok(!existsSync(aSock), "a host removes its own socket");
    assert.ok(statSync(bSock).isSocket(), "the old host's exit leaves the new host's socket");
    assert.equal(b.registry!.pid, b.proc.pid, "the old host leaves the new one's registry entry");
    const u = unixClient(bSock, { t: "hello", v: 1, token: bToken, client: "test" });
    await until(() => u.records.some((r) => r.t === "snapshot"), 5000, "the new host still serves");
  } finally {
    await a.stop();
    await b?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unix socket: serve --socket-only listens on no port at all; a client reaches it by the socket", async () => {
  const h = await startHost({ name: "unix-only", speed: 5, socketOnly: true });
  try {
    await h.client.waitFor(idle, 10_000, "idle over the socket");
    const reg = h.registry!;
    assert.equal(reg.port, null);
    assert.equal(reg.wsPort, null);
    assert.ok(statSync(reg.socket!).isSocket());
    assert.deepEqual(listening(reg.pid!), [], "no TCP listener");
    const c = await ChatClient.fromRegistry(h.stateDir, h.chat, "test");
    c.close();
  } finally {
    await h.stop();
  }
});
