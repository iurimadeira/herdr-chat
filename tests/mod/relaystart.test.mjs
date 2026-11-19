// The mod's relay start (chat/remote.js relayStartArgs + relayStart) against a real `hc run`: two
// private herdr-core sessions (tests/host/hcrig.ts) stand in for the Mac and the remote machine.
// Skips without hc (CI is macOS).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Rig, HC, hcUnusable } from "../host/hcrig.ts";
import { ROOT, HOST_NODE } from "../host/harness.ts";
import { machineConfig, relayEntry, relayStart, relayStartArgs } from "../../herdr-app/mods/chat/remote.js";

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
  // The Mac state dir exists before any chat (the app's install writes config.json there): the run's --cwd.
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
