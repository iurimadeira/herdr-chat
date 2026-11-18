// Where a host listens (--listen) and who may connect: a chat in a remote space
// (docs/specs/remote-spaces.md) reaches its host over the tailnet, a local one
// over 127.0.0.1 as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";
import WebSocket from "ws";
import { startHost, idle, sleep, Host } from "./harness.ts";
import { registryPath } from "../../host/registry.ts";

type Rec = Record<string, any>;
const HEADER = "x-herdr-chat-token";

/** A WebSocket client of the host: what it received, whether its upgrade went through. */
function wsClient(address: string, port: number, headers: Record<string, string> = {}) {
  const host = address.includes(":") ? `[${address}]` : address;
  const ws = new WebSocket(`ws://${host}:${port}/`, { headers });
  const c = { ws, records: [] as Rec[], upgraded: false, closed: false, status: 0 };
  ws.on("upgrade", () => (c.upgraded = true));
  ws.on("unexpected-response", (_req, res) => {
    c.status = res.statusCode ?? 0;
    c.closed = true;
    ws.terminate();
  });
  ws.on("message", (data) => {
    ws.send(JSON.stringify({ t: "ack" }));
    for (const text of String(data).split("\n")) c.records.push(JSON.parse(text));
  });
  ws.on("error", () => {});
  ws.on("close", () => (c.closed = true));
  return c;
}

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleep(20);
  }
}

/** This machine's tailnet address, when it has one (lab does; CI doesn't). */
function tailnetAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) return a.address;
  }
  return null;
}

test("refused: a host given 0.0.0.0, ::, a LAN or a public address never starts and writes no registry entry", async () => {
  for (const listen of ["0.0.0.0", "::", "192.168.0.33", "10.0.0.7", "8.8.8.8", "100.128.0.1", "127.0.0.2", "fd7a:115c:a1e1::1"]) {
    const h = new Host({ name: "listen-refused", hostArgs: ["--listen", listen] });
    await assert.rejects(h.start(), (e: Error) => {
      assert.match(e.message, new RegExp(`refusing to listen on ${listen.replace(/\./g, "\\.")}`), listen);
      assert.match(e.message, /tailnet/);
      return true;
    });
    assert.equal(await h.exited, 2, `${listen}: exits 2`);
    assert.equal(existsSync(registryPath(h.stateDir, h.chat)), false, `${listen}: no registry entry`);
  }
});

test("local by default: the host listens on 127.0.0.1 and advertises it", async () => {
  const h = await startHost({ name: "listen-local" });
  try {
    assert.equal(h.registry!.address, "127.0.0.1");
    assert.ok(h.registry!.wsPort! > 0);
  } finally {
    await h.stop();
  }
});

test("a name is resolved: --listen localhost advertises 127.0.0.1", async () => {
  const h = await startHost({ name: "listen-name", hostArgs: ["--listen", "localhost"] });
  try {
    assert.equal(h.registry!.address, "127.0.0.1");
  } finally {
    await h.stop();
  }
});

test("on 127.0.0.1 the token header is optional, but a wrong one is refused before anything is sent", async () => {
  const h = await startHost({ name: "listen-local-header", speed: 4 });
  try {
    const { address, wsPort, token } = h.registry!;
    const wrong = wsClient(address!, wsPort!, { [HEADER]: "0".repeat(64) });
    await until(() => wrong.closed, 3000, "a wrong header is refused");
    assert.equal(wrong.upgraded, false);
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.records, []);

    for (const headers of [{ [HEADER]: token }, {}] as Record<string, string>[]) {
      const ok = wsClient(address!, wsPort!, headers);
      await until(() => ok.upgraded, 3000, "upgraded");
      ok.ws.send(JSON.stringify({ t: "hello", v: 1, token, client: "mod" }));
      await until(() => ok.records.some((r) => r.t === "snapshot"), 5000, `welcome with ${JSON.stringify(Object.keys(headers))}`);
      assert.equal(ok.records[0]!.t, "welcome");
      ok.ws.terminate();
    }
  } finally {
    await h.stop();
  }
});

const TAILNET = tailnetAddress();

test("on the tailnet: the host advertises its tailnet address, and a connection without the token header is closed and gets nothing", { skip: TAILNET ? false : "no tailnet address on this machine" }, async () => {
  const h = await startHost({ name: "listen-tailnet", speed: 4, hostArgs: ["--listen", TAILNET!] });
  try {
    const { address, wsPort, token } = h.registry!;
    assert.equal(address, TAILNET);
    await h.client.waitFor(idle, 10_000, "the local JSONL client still connects on 127.0.0.1");

    const bare = wsClient(address!, wsPort!);
    await until(() => bare.closed, 3000, "no header is refused");
    assert.equal(bare.upgraded, false);
    assert.equal(bare.status, 401);
    assert.deepEqual(bare.records, []);

    const wrong = wsClient(address!, wsPort!, { [HEADER]: "0".repeat(64) });
    await until(() => wrong.closed, 3000, "a wrong header is refused");
    assert.equal(wrong.upgraded, false);
    assert.deepEqual(wrong.records, []);

    const loop = wsClient("127.0.0.1", wsPort!, { [HEADER]: token });
    await until(() => loop.closed, 3000, "nothing listens on 127.0.0.1 at the WebSocket port");
    assert.equal(loop.upgraded, false);

    const ok = wsClient(address!, wsPort!, { [HEADER]: token });
    await until(() => ok.upgraded, 3000, "upgraded");
    ok.ws.send(JSON.stringify({ t: "hello", v: 1, token, client: "mod" }));
    await until(() => ok.records.some((r) => r.t === "snapshot"), 5000, "welcome and snapshot");
    assert.deepEqual(ok.records.slice(0, 2).map((r) => r.t), ["welcome", "snapshot"]);
    ok.ws.terminate();
  } finally {
    await h.stop();
  }
});
