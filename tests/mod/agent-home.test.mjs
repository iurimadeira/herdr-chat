// The agent home a continued chat inherits (#9), through the mods' own code:
// the hand-off's terminal, the host's start, a new chat from this one, and Continue as chat.
import test from "node:test";
import assert from "node:assert/strict";
import { handoffArgv, agentHomeArgs, chatHome, carriedHome, newChatProps } from "../../herdr-app/mods/chat/agenthome.js";
import { subagentArgs, inPlaceProps } from "../../herdr-app/mods/new-chat/continue.js";

const CLAUDE = (value) => ({ variable: "CLAUDE_CONFIG_DIR", value });

test("hand-off: /tui and /login run in the chat's agent home, or with it unset, else as they are", () => {
  const argv = ["claude", "--resume", "abc"];
  assert.deepEqual(handoffArgv(argv, CLAUDE("/h/alt")), ["/usr/bin/env", "CLAUDE_CONFIG_DIR=/h/alt", "claude", "--resume", "abc"]);
  assert.deepEqual(handoffArgv(argv, CLAUDE("")), ["/usr/bin/env", "-u", "CLAUDE_CONFIG_DIR", "claude", "--resume", "abc"]);
  assert.deepEqual(handoffArgv(argv, null), argv);
  assert.deepEqual(handoffArgv(argv, undefined), argv);
});

test("host start: --agent-home for a continued chat (null, an old prop: none set), nothing otherwise", () => {
  assert.deepEqual(agentHomeArgs("/h/alt"), ["--agent-home=/h/alt"]);
  assert.deepEqual(agentHomeArgs(""), ["--agent-home="]);
  assert.deepEqual(agentHomeArgs(null), ["--agent-home="]);
  assert.deepEqual(agentHomeArgs(undefined), []);
});

test("restore: the pane's prop, else the registry entry's home for the same agent", () => {
  assert.equal(chatHome("/h/p", { provider: "claude", agentHome: "/h/r" }, "claude"), "/h/p");
  assert.equal(chatHome(undefined, { provider: "claude", agentHome: "/h/r" }, "claude"), "/h/r");
  assert.equal(chatHome(undefined, { provider: "claude", agentHome: "" }, "claude"), "");
  assert.equal(chatHome(undefined, { provider: "codex", agentHome: "/h/r" }, "claude"), undefined);
  assert.equal(chatHome(undefined, { provider: "claude" }, "claude"), undefined);
  assert.equal(chatHome(undefined, null, "claude"), undefined);
});

test("new chat: carries the source chat's home (the host's state, else its prop), with or without a session", () => {
  assert.equal(carriedHome({ agentHome: CLAUDE("/h/alt") }, undefined), "/h/alt");
  assert.equal(carriedHome({ agentHome: CLAUDE("") }, "/h/stale"), "");
  assert.equal(carriedHome({ agentHome: null }, undefined), undefined);
  assert.equal(carriedHome({}, "/h/prop"), "/h/prop");
  assert.equal(carriedHome({}, null), "");
  const base = { chat: "c-1", provider: "claude", cwd: "/w" };
  assert.deepEqual(newChatProps({ ...base, agentHome: "/h/alt" }), { ...base, agentHome: "/h/alt" });
  assert.deepEqual(newChatProps({ ...base, session: "/s.jsonl", agentHome: "" }), { ...base, session: "/s.jsonl", agentHome: "" });
  assert.deepEqual(newChatProps({ ...base, session: null, hostEnv: null, agentHome: undefined }), base);
});

test("Continue as chat: a sub-agent's launcher and a top-level chat's pane get the TUI's home", () => {
  assert.deepEqual(subagentArgs({ launcher: "/b/herdr-chat-subagent", agent: "claude", found: { session: "/s", home: "/h/alt", args: [] } }),
    ["/b/herdr-chat-subagent", "--provider", "claude", "--session", "/s", "--agent-home=/h/alt"]);
  assert.deepEqual(subagentArgs({ launcher: "/b/l", agent: "codex", found: { session: "/s", home: null, args: ["-m", "x"] } }),
    ["/b/l", "--provider", "codex", "--session", "/s", "--agent-home=", "--", "-m", "x"]);
  assert.deepEqual(subagentArgs({ launcher: "/b/l", agent: "pi", found: { session: "/s" } }), ["/b/l", "--provider", "pi", "--session", "/s"]);
  const p = inPlaceProps({ chat: "c-1", agent: "claude", pid: 7, cwd: "/w", found: { session: "/s", home: null, model: "m" } });
  assert.deepEqual(p, { chat: "c-1", provider: "claude", session: "/s", afterPid: 7, cwd: "/w", agentHome: "", model: "m" });
  assert.equal("agentHome" in inPlaceProps({ chat: "c", agent: "pi", pid: 1, cwd: "/", found: { session: "/s" } }), false);
});
