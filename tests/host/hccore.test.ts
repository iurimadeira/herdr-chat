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
  const { hc, dir } = fake(`read line\necho '{"jsonrpc":"2.0","id":0,"result":{}}'\nexec sleep 30`);
  try {
    const c = await CoreClient.open(hc, process.env, 3000);
    const t0 = Date.now();
    await assert.rejects(c.call("terminal.kill", { terminal: "x" }, 200), /terminal\.kill: no answer/);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(c.closed, false, "a slow call leaves the client usable");
    c.end();
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    assert.ok(await gone(pid, 3000), "end kills the child");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hccore: an attach core never answers rejects after its timeout and holds nothing", async () => {
  const { hc, dir } = fake(`read line\necho '{"jsonrpc":"2.0","id":0,"result":{}}'\nexec sleep 30`);
  try {
    const c = await CoreClient.open(hc, process.env, 3000);
    await assert.rejects(c.attach("rb/t1", { timeoutMs: 200 }), /terminal\.attach: no answer in 200 ms/);
    assert.equal(c.channels, 0);
    assert.equal(c.closed, false, "the client stays usable");
    c.end();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
