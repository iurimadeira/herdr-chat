// The chat mod's remote-space logic that runs outside the app (herdr-app/mods/chat/remote.js):
// a chat whose host runs on another machine, reached through the Mac's relay for that machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  machineConfig, remoteRegistryPath, remoteEntry, remoteHostArgs, relayStartArgs, relayStart, relayEntry,
  relayHello, closeAction, onMachine, chatHost, RELAY_ALREADY_SERVES,
} from "../../herdr-app/mods/chat/remote.js";
import { RELAY_ALREADY_SERVES as HOST_ALREADY_SERVES } from "../../host/relaylock.ts";
import { CLOSE_RESYNC, CLOSE_REFUSED, CLOSE_NO_HOST, CLOSE_SETUP, CLOSE_BUSY, CLOSE_STOPPING } from "../../host/relay.ts";

const LAB = {
  host: "/home/me/herdr-chat/bin/herdr-chat-host",
  node: "/home/me/.asdf/shims/node",
  hc: "/home/me/.local/bin/hc",
  agents: { claude: "/home/me/.local/bin/acc", codex: "/home/me/.local/bin/aco" },
};
const lab = (over = {}) => machineConfig({ machines: { lab: { ...LAB, ...over } } }, "lab");

test("a machine's entry: its host, node, hc, state dir and agent commands; nothing of the Mac's", () => {
  const m = machineConfig({ machines: { lab: { ...LAB, stateDir: "/srv/s" } }, env: { SECRET: "x" } }, "lab");
  assert.equal(m.error, undefined);
  assert.equal(m.name, "lab");
  assert.equal(m.host, LAB.host);
  assert.equal(m.node, LAB.node);
  assert.equal(m.hc, LAB.hc);
  assert.equal(m.stateDir, "/srv/s");
  assert.equal(m.agent("claude"), "/home/me/.local/bin/acc");
  assert.equal(m.agent("codex"), "/home/me/.local/bin/aco");
  assert.equal(m.agent("pi"), null);
  assert.equal(lab().stateDir, null);
});

test("a machine without an entry or a host, or with a relative state dir: a clear error naming it", () => {
  assert.match(machineConfig({}, "lab").error, /^lab: herdr-chat host not configured \(machines\.lab in settings\.json: no entry\)/);
  assert.match(machineConfig(null, "lab").error, /no entry/);
  assert.match(machineConfig({ machines: { lab: "x" } }, "lab").error, /no entry/);
  assert.match(machineConfig({ machines: { lab: { host: "" } } }, "lab").error, /host missing/);
  // The host resolves a relative --state-dir from its folder, the relay and the mod from the home.
  assert.match(lab({ stateDir: "state" }).error, /^lab: machines\.lab\.stateDir must be an absolute path/);
});

test("the registry entry on the machine: the host's default state dir from its home, else the configured one", () => {
  assert.equal(remoteRegistryPath(lab(), "c-1"), ".local/state/herdr-chat/chats/c-1.json");
  assert.equal(remoteRegistryPath(lab({ stateDir: "/srv/s" }), "c-1"), "/srv/s/chats/c-1.json");
});

test("a registry entry is used only when it's this chat's, with a token; its pid and socket say whether a host serves it", () => {
  const ok = { v: 1, chat: "c-1", pid: 42, token: "t".repeat(64), socket: "/s/c-1.42.sock", port: null, wsPort: null };
  assert.deepEqual(remoteEntry(JSON.stringify(ok), "c-1"), ok);
  assert.equal(remoteEntry(JSON.stringify({ ...ok, socket: null }), "c-1").socket, null, "a host still binding its socket");
  assert.equal(remoteEntry(JSON.stringify({ ...ok, pid: null }), "c-1").pid, null, "a host that exited");
  for (const bad of [null, "", "{", "[]", "1", JSON.stringify({ ...ok, chat: "c-2" }), JSON.stringify({ ...ok, token: "" }),
    JSON.stringify({ ...ok, token: 5 }), JSON.stringify({ ...ok, pid: "42" }), JSON.stringify({ ...ok, socket: 7 })]) {
    assert.equal(remoteEntry(bad, "c-1"), null, `rejects ${bad}`);
  }
});

test("the remote host: hc run --on the machine, in the space's folder, socket only, with that machine's agent command", () => {
  const args = remoteHostArgs({ machine: lab(), chat: "c-1", cwd: "/home/me/proj", provider: "claude", session: null });
  assert.deepEqual(args, [
    "run", "--on", "lab", "--bg", "--json", "--keep", "--no-parent", "--cwd", "/home/me/proj",
    "--label", "herdr-chat.chat=c-1", "--label", "herdr-chat.role=host",
    "--", "/usr/bin/env", `HERDR_CHAT_NODE=${LAB.node}`, `HERDR_CHAT_HC=${LAB.hc}`,
    LAB.host, "serve", "--socket-only", "--chat", "c-1", "--cwd", "/home/me/proj",
    "--provider", "claude", "--claude", "/home/me/.local/bin/acc",
  ]);
});

test("the remote host without a folder, node or agent command: the machine's home and the host's defaults; a session, state dir, home and test env pass", () => {
  const machine = machineConfig({ machines: { lab: { host: "herdr-chat-host", stateDir: "/srv/s" } } }, "lab");
  const args = remoteHostArgs({ machine, chat: "c-2", cwd: null, provider: "codex", session: "/home/me/s.jsonl", agentHome: "", hostEnv: { FAKE: "1" } });
  assert.deepEqual(args, [
    "run", "--on", "lab", "--bg", "--json", "--keep", "--no-parent",
    "--label", "herdr-chat.chat=c-2", "--label", "herdr-chat.role=host",
    "--", "/usr/bin/env", "FAKE=1",
    "herdr-chat-host", "serve", "--socket-only", "--chat", "c-2", "--state-dir", "/srv/s",
    "--provider", "codex", "--session", "/home/me/s.jsonl", "--agent-home=",
  ]);
});

test("the relay: a Mac core terminal that waits 2 s for an exit, labeled, running the Mac's host with the machine's settings", () => {
  const cfg = { host: "/mac/bin/herdr-chat-host", node: "/mac/node", hc: "/mac/hc" };
  assert.deepEqual(relayStartArgs({ machine: lab({ stateDir: "/srv/s" }), cfg, stateDir: "/mac/state" }), [
    "run", "--json", "--no-parent", "--rm", "--timeout", "2", "--cwd", "/mac/state",
    "--label", "herdr-chat.role=relay", "--label", "herdr-chat.machine=lab",
    "--", "/usr/bin/env", "HERDR_CHAT_NODE=/mac/node",
    "/mac/bin/herdr-chat-host", "relay", "--machine", "lab", "--state-dir", "/mac/state", "--hc", "/mac/hc",
    "--host", LAB.host, "--node", LAB.node, "--remote-state-dir", "/srv/s",
  ]);
  assert.deepEqual(relayStartArgs({ machine: machineConfig({ machines: { lab: { host: "h" } } }, "lab"), cfg: { host: "/mac/h" }, stateDir: "/st" }), [
    "run", "--json", "--no-parent", "--rm", "--timeout", "2", "--cwd", "/st",
    "--label", "herdr-chat.role=relay", "--label", "herdr-chat.machine=lab",
    "--", "/usr/bin/env", "/mac/h", "relay", "--machine", "lab", "--state-dir", "/st", "--host", "h",
  ]);
});

test("the relay's exit code for a served machine is the host's", () => {
  assert.equal(RELAY_ALREADY_SERVES, HOST_ALREADY_SERVES);
});

test("the relay start: running after its wait, or already serving, is up; any other exit is an error", () => {
  const run = (wait, code = 0, stderr = "") => ({ code, stdout: JSON.stringify({ address: "t9", wait }), stderr });
  assert.deepEqual(relayStart("lab", run({ ended: false, exit_code: null, reason: "timeout" })), { up: true, started: true });
  assert.deepEqual(relayStart("lab", run({ ended: true, exit_code: RELAY_ALREADY_SERVES, reason: "exit" })), { up: true, started: false });
  // --rm can remove an instant exit before its code is read: the relay entry tells.
  assert.deepEqual(relayStart("lab", run({ ended: true, exit_code: null, reason: "exit" })), { up: true, started: false });
  assert.match(relayStart("lab", run({ ended: true, exit_code: 2, reason: "exit" })).error, /the relay for lab exited 2/);
  assert.match(relayStart("lab", run({ ended: true, exit_code: 1, reason: "exit" })).error, /exited 1/);
  assert.match(relayStart("lab", { code: 1, stdout: "", stderr: "no core" }).error, /couldn't start the relay for lab: no core/);
  assert.match(relayStart("lab", { code: 0, stdout: "nonsense", stderr: "" }).error, /couldn't start the relay for lab: nonsense/);
  // (The machine's name comes from the caller.)
  assert.match(relayStart("rb", { code: 1, stdout: "", stderr: "x" }).error, /relay for rb/);
});

test("the relay entry: its port when it's the machine's and a relay serves it", () => {
  const ok = { v: 1, machine: "lab", pid: 7, wsPort: 4100, startedAt: 1, version: "0.4.0", build: "b" };
  assert.deepEqual(relayEntry(JSON.stringify(ok), "lab"), { pid: 7, wsPort: 4100 });
  for (const bad of [null, "", "{", JSON.stringify({ ...ok, machine: "rb" }), JSON.stringify({ ...ok, pid: null }),
    JSON.stringify({ ...ok, wsPort: null }), JSON.stringify({ ...ok, wsPort: 70000 }), JSON.stringify({ ...ok, v: 2 })]) {
    assert.equal(relayEntry(bad, "lab"), null, `rejects ${bad}`);
  }
});

test("the relay's hello names the chat", () => {
  assert.deepEqual(relayHello("tok", "c-1"), { t: "hello", v: 1, token: "tok", client: "mod", chat: "c-1" });
});

test("the relay's close codes: resync at once, a refusal is final, the rest back off", () => {
  assert.equal(closeAction(CLOSE_RESYNC), "now");
  assert.equal(closeAction(CLOSE_REFUSED), "stop");
  for (const c of [CLOSE_NO_HOST, CLOSE_SETUP, CLOSE_BUSY, CLOSE_STOPPING, 1006, null]) assert.equal(closeAction(c), "backoff", String(c));
});

test("a terminal is a machine's when its address is that machine's; a local chat's has no machine", () => {
  assert.equal(onMachine("lab/t7", "lab"), true);
  assert.equal(onMachine("lab2/t7", "lab"), false);
  assert.equal(onMachine("t7", "lab"), false);
  assert.equal(onMachine("t7", null), true);
  assert.equal(onMachine("lab/t7", null), false);
});

test("the chat's host terminal: live, running the host, labeled host or sub-agent for this chat, on the chat's machine; never a bridge", () => {
  const t = (address, labels, over = {}) => ({ address, state: "live", argv: ["/usr/bin/env", "/x/bin/herdr-chat-host", "serve"], labels, ...over });
  const host = { "herdr-chat.chat": "c-1", "herdr-chat.role": "host" };
  assert.equal(chatHost(t("t1", host), "c-1", null), true);
  assert.equal(chatHost(t("lab/t1", host), "c-1", "lab"), true);
  assert.equal(chatHost(t("lab/t1", host), "c-1", null), false, "a local chat never takes another machine's");
  assert.equal(chatHost(t("t1", host), "c-1", "lab"), false, "a remote chat never takes this Mac's");
  assert.equal(chatHost(t("t1", { ...host, "herdr-chat.role": "subagent" }), "c-1", null), true, "a sub-agent's host (its chat attaches only)");
  assert.equal(chatHost(t("lab/t2", { "herdr-chat.chat": "c-1", "herdr-chat.role": "bridge" }), "c-1", "lab"), false);
  assert.equal(chatHost(t("lab/t2", { "herdr-chat.chat": "c-1" }), "c-1", "lab"), false, "no role: not a host");
  assert.equal(chatHost(t("t1", { ...host, "herdr-chat.chat": "c-2" }), "c-1", null), false);
  assert.equal(chatHost(t("t1", host, { state: "exited" }), "c-1", null), false);
  assert.equal(chatHost(t("t1", host, { argv: ["/bin/zsh", "-l"] }), "c-1", null), false, "the shell core restored in its place");
  assert.equal(chatHost(t("t1", host, { argv: undefined }), "c-1", null), true, "a terminal whose argv isn't known");
});
