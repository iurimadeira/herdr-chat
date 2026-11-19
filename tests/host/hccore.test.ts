// The herdr-core client against fake `hc connect` programs: no hello, or a core that never answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreClient } from "../../host/hccore.ts";

function fake(body: string): { hc: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "hccore-"));
  const hc = join(dir, "hc");
  writeFileSync(hc, `#!/bin/sh\necho $$ > "${dir}/pid"\n${body}\n`);
  chmodSync(hc, 0o755);
  return { hc, dir };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (alive(pid) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}

test("hccore: no hello in time rejects and kills the hc connect child", async () => {
  const { hc, dir } = fake("exec sleep 30");
  try {
    await assert.rejects(CoreClient.open(hc, process.env, 300), /no hello/);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    assert.ok(await gone(pid, 3000), "the child is killed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hccore: a call core never answers rejects after its timeout", async () => {
  const f = fake(`read line\necho '{"jsonrpc":"2.0","id":0,"result":{}}'\nexec sleep 30`);
  await withClient(f, async (c) => {
    const t0 = Date.now();
    await assert.rejects(c.call("terminal.kill", { terminal: "x" }, 200), /terminal\.kill: no answer/);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(c.closed, false, "a slow call leaves the client usable");
    c.end();
    const pid = Number(readFileSync(join(f.dir, "pid"), "utf8"));
    assert.ok(await gone(pid, 3000), "end kills the child");
  });
});

/**
 * A core in node: answers hello, then each `terminal.attach` by its plan (in order): first sends
 * `before` frames (DATA on a channel, `n` frames of `size` bytes), then after `delayMs` answers with
 * `channel` (never, without one), and `after` frames 100 ms after that answer. Every CLOSE frame it
 * gets is logged to `<dir>/closes`. It ends with its stdin, and after 20 s in any case, so a failed
 * test can't hang the file on it.
 */
type Frames = { ch: number; n: number; size: number }[];
type Plan = { channel?: number; delayMs?: number; before?: Frames; after?: Frames }[];
function fakeCore(plan: Plan): { hc: string; dir: string; closes: () => number[] } {
  const dir = mkdtempSync(join(tmpdir(), "hccore-"));
  const hc = join(dir, "hc");
  writeFileSync(hc, `#!${process.execPath}
const fs = require("fs");
const plan = ${JSON.stringify(plan)};
const out = (ch, kind, p) => { const h = Buffer.alloc(9); h.writeUInt32LE(ch, 0); h[4] = kind; h.writeUInt32LE(p.length, 5); process.stdout.write(Buffer.concat([h, p])); };
let buf = Buffer.alloc(0), framed = false, n = 0;
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (!framed) {
      const i = buf.indexOf(10); if (i < 0) return;
      buf = buf.subarray(i + 1); framed = true;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }) + "\\n");
      continue;
    }
    if (buf.length < 9) return;
    const ch = buf.readUInt32LE(0), kind = buf[4], len = buf.readUInt32LE(5);
    if (buf.length < 9 + len) return;
    const p = buf.subarray(9, 9 + len); buf = buf.subarray(9 + len);
    if (kind === 2) fs.appendFileSync(${JSON.stringify(dir)} + "/closes", ch + "\\n");
    if (ch !== 0 || kind !== 0) continue;
    const m = JSON.parse(p.toString());
    if (m.method !== "terminal.attach") continue;
    const step = plan[n++] ?? {};
    const send = (frames) => { for (const b of frames ?? []) for (let k = 0; k < b.n; k++) out(b.ch, 0, Buffer.alloc(b.size, 97)); };
    send(step.before);
    if (step.channel !== undefined) setTimeout(() => {
      out(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { channel: step.channel } })));
      setTimeout(() => send(step.after), 100);
    }, step.delayMs ?? 0);
  }
});
process.stdin.on("end", () => process.exit(0));
setTimeout(() => process.exit(0), 20_000);
`);
  chmodSync(hc, 0o755);
  const closes = (): number[] => {
    try {
      return readFileSync(join(dir, "closes"), "utf8").trim().split("\n").filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
  return { hc, dir, closes };
}

async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
  return pred();
}

/** A client of the fake `hc`, ended (and the fake's dir removed) however `body` ends. */
async function withClient({ hc, dir }: { hc: string; dir: string }, body: (c: CoreClient) => Promise<void>): Promise<void> {
  let c: CoreClient | undefined;
  try {
    c = await CoreClient.open(hc, process.env, 3000);
    await body(c);
  } finally {
    c?.end();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("hccore: an attach answered after its timeout has its channel closed, its call is not held, and its frames are dropped", async () => {
  const core = fakeCore([
    // Frames on 7 after its late answer, while the next attach is pending (so frames would be held).
    { channel: 7, delayMs: 600, after: [{ ch: 7, n: 4, size: 100 }] },
    { channel: 8, delayMs: 1500 },
  ]);
  await withClient(core, async (c) => {
    await assert.rejects(c.attach("rb/t1", { timeoutMs: 200, lateMs: 2000 }), /no answer in 200 ms/);
    const second = c.attach("rb/t2", { timeoutMs: 3000 });
    assert.ok(await until(() => core.closes().includes(7), 3000), "the late channel is closed");
    assert.equal(c.calls, 1, "the late answer settled its call; only the second attach's is held");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.earlyBytes, 0, "the late channel's frames are not held");
    assert.equal(c.channels, 0);
    await second;
  });
});

test("hccore: an attach never answered is forgotten after its late window", async () => {
  await withClient(fakeCore([{}, {}, {}]), async (c) => {
    for (let i = 0; i < 3; i++) await assert.rejects(c.attach("rb/t1", { timeoutMs: 100, lateMs: 300 }), /no answer/);
    assert.ok(await until(() => c.calls === 0, 2000), `calls held: ${c.calls}`);
    assert.equal(c.closed, false);
  });
});

test("hccore: a closed channel's late frames are dropped while another attach is pending, and held frames are bounded", async () => {
  const core = fakeCore([
    { channel: 5 },
    // Late frames for 5 (closed below), early ones for 6 (its own), and 2 MiB for nobody's 9.
    { channel: 6, delayMs: 800, before: [{ ch: 5, n: 50, size: 1000 }, { ch: 6, n: 2, size: 10 }, { ch: 9, n: 32, size: 64 << 10 }] },
  ]);
  await withClient(core, async (c) => {
    const s5 = await c.attach("rb/t1", { timeoutMs: 2000 });
    s5.close();
    const second = c.attach("rb/t2", { timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(c.earlyBytes <= 256 << 10, `held ${c.earlyBytes} bytes`);
    assert.ok(c.earlyBytes >= 20, "the pending attach's own early frames are held");
    assert.equal(c.channels, 2, "frames held for 6 and 9, none for the closed 5");
    await second;
    assert.equal(c.channels, 1, "only the new stream");
    assert.equal(c.earlyBytes, 0);
  });
});

test("hccore: an attach core never answers rejects after its timeout and holds nothing", async () => {
  await withClient(fake(`read line\necho '{"jsonrpc":"2.0","id":0,"result":{}}'\nexec sleep 30`), async (c) => {
    await assert.rejects(c.attach("rb/t1", { timeoutMs: 200 }), /terminal\.attach: no answer in 200 ms/);
    assert.equal(c.channels, 0);
    assert.equal(c.closed, false, "the client stays usable");
  });
});
