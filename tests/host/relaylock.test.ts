// One relay per machine (protocol.md "relay"): its lock under races and stale holders. No hc
// needed: a relay takes its lock and listens before it ever reaches core.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TMP, HOST_ENTRY, HOST_NODE, sleep } from "./harness.ts";

const dirs: string[] = [];
const procs: ChildProcess[] = [];

after(() => {
  for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function stateDir(): string {
  const d = realpathSync(mkdtempSync(join(TMP, "pich-relaylock-")));
  dirs.push(d);
  return d;
}

type R = { proc: ChildProcess; out: () => string; exited: Promise<number | null> };

function relay(dir: string): R {
  const proc = spawn(HOST_NODE, [HOST_ENTRY, "relay", "--machine", "m", "--state-dir", dir, "--hc", "/nonexistent/hc"], { stdio: ["ignore", "pipe", "pipe"] });
  procs.push(proc);
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((res) => proc.on("exit", (code) => res(code)));
  return { proc, out: () => out, exited };
}

const entry = (dir: string): { pid: number | null; wsPort: number | null } | null => {
  try {
    return JSON.parse(readFileSync(join(dir, "relays", "m.json"), "utf8"));
  } catch {
    return null;
  }
};

async function serving(dir: string, r: R): Promise<void> {
  const t0 = Date.now();
  while (entry(dir)?.pid !== r.proc.pid) {
    if (r.proc.exitCode !== null || Date.now() - t0 > 10_000) throw new Error(`relay did not start: ${r.out()}`);
    await sleep(20);
  }
}

async function kill9(r: R): Promise<void> {
  r.proc.kill("SIGKILL");
  await r.exited;
}

test("relay lock: many relays started at once over a SIGKILLed holder: exactly one serves, every round", async () => {
  const dir = stateDir();
  let holder = relay(dir);
  await serving(dir, holder);
  for (let round = 0; round < 6; round++) {
    await kill9(holder);
    const rs = Array.from({ length: 8 }, () => relay(dir));
    // The losers exit; the winner keeps serving (and stays up a while after).
    const t0 = Date.now();
    while (rs.filter((r) => r.proc.exitCode === null).length > 1 && Date.now() - t0 < 30_000) await sleep(50);
    await sleep(500);
    const live = rs.filter((r) => r.proc.exitCode === null);
    assert.equal(live.length, 1, `round ${round}: ${live.length} relays serve machine m\n${rs.map((r) => r.out()).join("\n")}`);
    for (const r of rs.filter((x) => x !== live[0])) assert.match(r.out(), /already serves machine m/);
    holder = live[0]!;
    assert.equal(entry(dir)?.pid, holder.proc.pid, `round ${round}: the entry names the one that serves`);
  }
  holder.proc.kill("SIGTERM");
  assert.equal(await holder.exited, 0);
});

test("relay lock: a stopped relay frees the machine at once; a holder whose pid now names another process is taken over", async () => {
  const dir = stateDir();
  const r1 = relay(dir);
  await serving(dir, r1);
  r1.proc.kill("SIGTERM");
  assert.equal(await r1.exited, 0);
  assert.deepEqual([entry(dir)?.pid, entry(dir)?.wsPort], [null, null], "a stopped relay clears its entry");
  const r2 = relay(dir);
  await serving(dir, r2);
  // r2's pid reused by another program after a SIGKILL: its lock names a live pid that is no relay.
  // Simulated by naming a live process (this test runner) that started at another time than recorded.
  const locks = join(dir, "relays", "m.locks");
  await kill9(r2);
  const gens = readdirSync(locks).filter((n) => /^\d+$/.test(n)).map(Number);
  const top = Math.max(...gens);
  writeFileSync(join(locks, String(top)), JSON.stringify({ pid: process.pid, start: "Thu Jan  1 00:00:00 1970" }));
  const r3 = relay(dir);
  await serving(dir, r3);
  r3.proc.kill("SIGTERM");
  assert.equal(await r3.exited, 0);
});

test("relay lock: a live relay holds the machine against 40 challengers over several seconds", async () => {
  const dir = stateDir();
  const r1 = relay(dir);
  await serving(dir, r1);
  const all: R[] = [];
  for (let wave = 0; wave < 8; wave++) {
    for (let i = 0; i < 5; i++) all.push(relay(dir));
    await sleep(700);
  }
  const codes = await Promise.all(all.map((r) => r.exited));
  for (const [i, r] of all.entries()) {
    assert.notEqual(codes[i], 0, r.out());
    assert.match(r.out(), new RegExp(`relay pid ${r1.proc.pid} already serves machine m`));
  }
  assert.equal(entry(dir)?.pid, r1.proc.pid);
  assert.equal(r1.proc.exitCode, null);
  r1.proc.kill("SIGTERM");
  assert.equal(await r1.exited, 0);
});

test("relay lock: a live relay's lock is honoured, whatever else is in the directory", async () => {
  const dir = stateDir();
  const r1 = relay(dir);
  await serving(dir, r1);
  mkdirSync(join(dir, "relays", "m.locks"), { recursive: true });
  writeFileSync(join(dir, "relays", "m.locks", "junk"), "x");
  const second = relay(dir);
  assert.notEqual(await second.exited, 0);
  assert.match(second.out(), /already serves machine m/);
  r1.proc.kill("SIGTERM");
  assert.equal(await r1.exited, 0);
});
