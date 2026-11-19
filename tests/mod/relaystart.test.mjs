// The mod's relay start (chat/remote.js relayStartArgs + relayStart) against a real `hc run`: two
// private herdr-core sessions (tests/host/hcrig.ts) stand in for the Mac and the remote machine.
// Skips without hc (CI is macOS).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { Rig, HC, hcUnusable } from "../host/hcrig.ts";
import { ROOT, HOST_NODE, FAKE_PI } from "../host/harness.ts";
import {
  chatHost, machineConfig, relayEntry, relayStart, relayStartArgs, remoteEntry, remoteHostArgs, remoteRegistryPath,
} from "../../herdr-app/mods/chat/remote.js";

let skip = hcUnusable();
let rig = null;
let home = "";

before(() => {
  if (skip) return;
  home = realpathSync(mkdtempSync(join(tmpdir(), "relaystart-")));
  try {
    rig = new Rig({ home }).start();
  } catch (e) {
    skip = `hc sessions don't start here: ${e instanceof Error ? e.message.split("\n")[0] : e}`;
    rig?.stop();
    rig = null;
  }
});

after(() => {
  rig?.stop();
  if (home) rmSync(home, { recursive: true, force: true });
});

test("the relay start: the first runs on after its wait, a second exits 3, and both read as up", (t) => {
  if (skip) return t.skip(skip);
  const host = join(ROOT, "bin", "herdr-chat-host");
  const machine = machineConfig({ machines: { [rig.machine]: { host, node: HOST_NODE, stateDir: join(home, "state") } } }, rig.machine);
  // The Mac state dir exists before any remote chat (install writes install.json there, and
  // machines.<name> is in its settings.json): the run's --cwd.
  const stateDir = join(home, "mac");
  mkdirSync(stateDir, { recursive: true });
  const args = relayStartArgs({ machine, cfg: { host, node: HOST_NODE, hc: HC }, stateDir });
  // The mod's `hc`: the Mac core's client (the app's HC_SESSION).
  const start = () => {
    const r = spawnSync(HC, args, { env: rig.env(rig.a), encoding: "utf8", timeout: 30_000 });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const first = start();
  assert.deepEqual(relayStart(rig.machine, first), { up: true, started: true }, JSON.stringify(first));
  const entry = relayEntry(readFileSync(join(stateDir, "relays", `${rig.machine}.json`), "utf8"), rig.machine);
  assert.ok(entry?.wsPort, "the relay wrote its entry");
  const second = start();
  assert.deepEqual(relayStart(rig.machine, second), { up: true, started: false }, JSON.stringify(second));
  assert.deepEqual(relayEntry(readFileSync(join(stateDir, "relays", `${rig.machine}.json`), "utf8"), rig.machine), entry,
    "the first relay still serves");
});

test("the remote host start: hc run --on starts serve --socket-only there; the mod finds its entry and its terminal", async (t) => {
  if (skip) return t.skip(skip);
  const host = join(ROOT, "bin", "herdr-chat-host");
  const remoteState = join(home, "state");
  const cwd = join(home, "work");
  mkdirSync(cwd, { recursive: true });
  const machine = machineConfig({ machines: { [rig.machine]: { host, node: HOST_NODE, stateDir: remoteState, agents: { pi: FAKE_PI } } } }, rig.machine);
  const chat = "c-remote1";
  const args = remoteHostArgs({ machine, chat, cwd, provider: "pi", agentHome: undefined, hostEnv: { FAKE_PI_SPEED: "4" } });
  const r = spawnSync(HC, args, { env: rig.env(rig.a), encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  // The mod's readTextFile(remoteRegistryPath(...), {on}) reads this file on the machine.
  const path = remoteRegistryPath(machine, chat);
  let entry = null;
  for (let i = 0; i < 150 && !entry?.socket; i++) {
    entry = existsSync(path) ? remoteEntry(readFileSync(path, "utf8"), chat) : null;
    if (!entry?.socket) await sleep(100);
  }
  assert.ok(entry?.pid && entry.socket, `the host's entry with its socket: ${existsSync(path) ? readFileSync(path, "utf8") : "none"}`);
  assert.equal(entry.port ?? null, null, "socket only: no TCP port");
  // The mod's terminals(): the Mac core's view, with the machine's terminals as <machine>/tN.
  const listed = JSON.parse(rig.hc(["ls", "--json", "--all"]));
  // `hc ls` lists address and state; `hc get` has the labels and argv terminals() carries.
  const rows = (Array.isArray(listed) ? listed : listed.terminals ?? []).map((row) => JSON.parse(rig.hc(["get", row.address, "--json"])));
  assert.ok(rows.some((row) => chatHost(row, chat, rig.machine)), `a live host row for ${chat} on ${rig.machine}: ${JSON.stringify(rows)}`);
  assert.ok(!rows.some((row) => chatHost(row, chat, null)), "not this Mac's");
});
