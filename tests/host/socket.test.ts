// The host's Unix socket (protocol.md "Transport"): the remote path's only way in, beside the loopback ports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { startHost, idle, sleep } from "./harness.ts";
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
    assert.equal(reg.socket, join(h.stateDir, "chats", `${h.chat}.sock`), "recorded beside the registry entry");
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
