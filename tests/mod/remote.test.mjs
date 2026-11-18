// The chat mod's remote-space logic that runs outside the app (herdr-app/mods/chat/remote.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { machineConfig, remoteRegistryPath, remoteStartArgs, wsUrl } from "../../herdr-app/mods/chat/remote.js";

const LAB = {
  address: "lab.tailfd0955.ts.net",
  host: "/home/me/herdr-chat/bin/herdr-chat-host",
  node: "/home/me/.asdf/shims/node",
  agents: { claude: "/home/me/.local/bin/acc", codex: "/home/me/.local/bin/aco" },
};

test("a machine's entry: its address, host, node and agent commands; nothing else", () => {
  const m = machineConfig({ machines: { lab: LAB }, env: { SECRET: "x" } }, "lab");
  assert.equal(m.error, undefined);
  assert.equal(m.name, "lab");
  assert.equal(m.address, LAB.address);
  assert.equal(m.host, LAB.host);
  assert.equal(m.node, LAB.node);
  assert.equal(m.stateDir, null);
  assert.equal(m.agent("claude"), "/home/me/.local/bin/acc");
  assert.equal(m.agent("codex"), "/home/me/.local/bin/aco");
  assert.equal(m.agent("pi"), null);
});

test("a machine without an entry, an address or a host: a clear error naming it", () => {
  assert.match(machineConfig({}, "lab").error, /^lab: herdr-chat host not configured .*no entry/);
  assert.match(machineConfig(null, "lab").error, /no entry/);
  assert.match(machineConfig({ machines: { lab: { host: "/h" } } }, "lab").error, /address missing/);
  assert.match(machineConfig({ machines: { lab: { address: "lab" } } }, "lab").error, /host missing/);
  assert.match(machineConfig({ machines: { lab: { address: "", host: "" } } }, "lab").error, /address and host missing/);
});

test("the remote start: hc run --on the machine, in the space's folder, listening on its address, with its agent command", () => {
  const machine = machineConfig({ machines: { lab: LAB } }, "lab");
  const args = remoteStartArgs({ machine, chat: "c-1", cwd: "/home/me/proj", provider: "claude", session: null });
  assert.deepEqual(args, [
    "run", "--on", "lab", "--bg", "--json", "--keep", "--no-parent", "--cwd", "/home/me/proj",
    "--label", "herdr-chat.chat=c-1", "--label", "herdr-chat.role=host",
    "--", "/usr/bin/env", `HERDR_CHAT_NODE=${LAB.node}`,
    LAB.host, "serve", "--chat", "c-1", "--cwd", "/home/me/proj",
    "--listen", LAB.address, "--provider", "claude", "--claude", "/home/me/.local/bin/acc",
  ]);
});

test("the remote start without a folder, node or agent command: the machine's home and the host's defaults; a session and a state dir pass through", () => {
  const machine = machineConfig({ machines: { lab: { address: "100.68.69.106", host: "herdr-chat-host", stateDir: "/srv/chat-state" } } }, "lab");
  const args = remoteStartArgs({ machine, chat: "c-2", cwd: null, provider: "pi", session: "/home/me/s.jsonl" });
  assert.deepEqual(args, [
    "run", "--on", "lab", "--bg", "--json", "--keep", "--no-parent",
    "--label", "herdr-chat.chat=c-2", "--label", "herdr-chat.role=host",
    "--", "/usr/bin/env",
    "herdr-chat-host", "serve", "--chat", "c-2", "--state-dir", "/srv/chat-state",
    "--listen", "100.68.69.106", "--provider", "pi", "--session", "/home/me/s.jsonl",
  ]);
});

test("the registry entry on the machine: under the host's default state dir from its home, else the configured one", () => {
  assert.equal(remoteRegistryPath(machineConfig({ machines: { lab: LAB } }, "lab"), "c-1"), ".local/state/herdr-chat/chats/c-1.json");
  assert.equal(remoteRegistryPath(machineConfig({ machines: { lab: { ...LAB, stateDir: "/srv/s" } } }, "lab"), "c-1"), "/srv/s/chats/c-1.json");
});

test("the WebSocket URL: the advertised address, an IPv6 one in brackets", () => {
  assert.equal(wsUrl("100.68.69.106", 4000), "ws://100.68.69.106:4000/");
  assert.equal(wsUrl("fd7a:115c:a1e0::cf3a:456a", 4000), "ws://[fd7a:115c:a1e0::cf3a:456a]:4000/");
});
