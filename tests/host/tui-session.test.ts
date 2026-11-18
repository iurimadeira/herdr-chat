// Continue as chat asks the host which session a running agent TUI has open
// (`herdr-chat-host tui-session`), each agent its own way: Pi's lock-extension
// label, Claude Code's live-process registry, Codex's rollout it has open, else
// its newest rollout in the TUI's folder since it started (one in another
// folder, or older, isn't it). Claude Code's and Codex's files are in the agent
// home the TUI process itself uses (CLAUDE_CONFIG_DIR / CODEX_HOME in its
// environment, else ~/.claude / ~/.codex), not the host's; the chat's agent
// inherits that home (`home`, given to serve as --agent-home, as the mod does).
// The TUI is a real process (sleep), so its pid, start time and environment are real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { HOST_ENTRY, HOST_NODE, idle, sleep, startHost } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { codexHost } from "../fake-codex/host.ts";
import { agentHome, psVariable, treeHomes, type ReadVariable } from "../../host/providers/tui.ts";
import { parseArgs } from "../../host/args.ts";
import { planSubagent } from "../../host/subagent.ts";
import { readChatConfig } from "../../host/settings.ts";

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function ask(provider: string, pid: number, cwd: string, env: Record<string, string>, label?: string) {
  const r = spawnSync(HOST_NODE, [HOST_ENTRY, "tui-session", "--provider", provider, "--pid", String(pid), "--cwd", cwd, ...(label ? ["--label", label] : [])],
    { encoding: "utf8", env: { ...process.env, ...env } });
  return r.status === 0 ? { ok: JSON.parse(r.stdout) } : { error: r.stderr.trim() };
}

/** What the mod gives the chat's host for a TUI's home (new-chat continueAsChat, chat connection.js). */
const agentHomeArg = (home: string | null) => [`--agent-home=${home ?? ""}`];

/** The test runner's environment without the agent homes (the runner may itself be an agent with one set). */
function bareEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR"]) if (!(k in extra)) delete env[k];
  return env;
}

/** A TUI stand-in: a real process with its own environment (and `sh` redirections, e.g. a file held open). */
function startTui(env: Record<string, string>, script = "exec sleep 30"): ChildProcess {
  return spawn("sh", ["-c", script], { stdio: "ignore", env: bareEnv(env) });
}

const exited = (p: ChildProcess) => new Promise((r) => (p.exitCode !== null || p.signalCode !== null ? r(null) : p.once("exit", r)));

const ymd = () => {
  const now = new Date(); // Codex files rollouts by the day they started, and looks back only so far
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0"));
};

/** A rollout in <home>/sessions/YYYY/MM/DD, last written `ageS` ago. */
function rollout(home: string, id: string, folder: string, model: string, ageS: number): string {
  const day = join(home, "sessions", ...ymd());
  mkdirSync(day, { recursive: true });
  const f = join(day, `rollout-${ymd().join("-")}T10-00-00-${id}.jsonl`);
  writeFileSync(f, jsonl([{ type: "session_meta", payload: { id, cwd: folder } }, { type: "turn_context", payload: { model, effort: "high" } }]));
  const t = new Date(Date.now() - ageS * 1000);
  utimesSync(f, t, t);
  return f;
}

/** A Claude Code home with this pid registered on session `id` in `cwd`, and its transcript (one prompt). */
function claudeHome(home: string, pid: number, id: string, cwd: string, prompt = "hi"): string {
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd }));
  const project = join(home, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const file = join(project, `${id}.jsonl`);
  writeFileSync(file, jsonl([{ type: "user", uuid: "u1", cwd, sessionId: id, message: { role: "user", content: prompt } }]));
  return file;
}

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "herdr-chat-tui-")));

test("tui-session: Pi by its label (with the session's model and thinking), Claude Code by its registry, Codex by its newest rollout in the folder", async () => {
  const d = tmp();
  const cwd = join(d, "repo");
  mkdirSync(cwd);
  const claude = join(d, "claude");
  const codex = join(d, "codex");
  const tui = startTui({ CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex });
  const pid = tui.pid!;
  await sleep(1200); // its start time before the Codex rollouts' writes
  try {
    // Pi: the label is the session; no label, a reason.
    const pi = join(d, "pi.jsonl");
    writeFileSync(pi, jsonl([{ type: "session", id: "s" }, { type: "model_change", provider: "anthropic", modelId: "claude-haiku-4-5" }, { type: "thinking_level_change", thinkingLevel: "low" }]));
    assert.deepEqual(ask("pi", pid, cwd, {}, pi).ok, { session: pi, model: "anthropic/claude-haiku-4-5", thinking: "low", args: ["--model", "anthropic/claude-haiku-4-5", "--thinking", "low"] });
    assert.match(ask("pi", pid, cwd, {}).error!, /restart it to load the herdr-chat-lock extension/);

    // Claude Code: <config>/sessions/<pid>.json → its transcript; none written yet, a reason.
    mkdirSync(join(claude, "sessions"), { recursive: true });
    writeFileSync(join(claude, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: "abc-123", cwd }));
    assert.match(ask("claude", pid, cwd, {}).error!, /no messages yet/);
    const project = join(claude, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "abc-123.jsonl"), jsonl([{ type: "user", message: { role: "user", content: "hi" } }]));
    assert.deepEqual(ask("claude", pid, cwd, {}).ok, { session: join(project, "abc-123.jsonl"), home: claude });
    const other = startTui({ CLAUDE_CONFIG_DIR: claude });
    try {
      assert.equal(ask("claude", other.pid!, cwd, {}).error, `herdr-chat-host: Claude Code didn't register this process (no ${claude}/sessions/${other.pid}.json)`);
    } finally {
      other.kill();
    }

    // Codex: the newest rollout in this folder written since the TUI started.
    rollout(codex, "old", cwd, "gpt-old", 3600); // before the TUI started
    rollout(codex, "other", join(d, "elsewhere"), "gpt-other", 0); // another folder
    const mine = rollout(codex, "mine", cwd, "gpt-5.6-luna", 0);
    assert.deepEqual(ask("codex", pid, cwd, {}).ok, {
      session: mine, home: codex, model: "openai/gpt-5.6-luna", thinking: "high", args: ["-c", 'model="gpt-5.6-luna"', "-c", 'model_reasoning_effort="high"'],
    });
  } finally {
    tui.kill();
  }
});

test("tui-session: a Claude Code TUI with its own CLAUDE_CONFIG_DIR continues as a chat on its own session, its agent in the TUI's home, not the host's", async () => {
  const d = tmp();
  const cwd = join(d, "repo");
  mkdirSync(cwd);
  const mine = join(d, "claude-alt"), hosts = join(d, "claude-host");
  const tui = startTui({ CLAUDE_CONFIG_DIR: mine });
  try {
    const file = claudeHome(mine, tui.pid!, "11111111-1111-4111-8111-111111111111", cwd, "the TUI's own prompt");
    // The host's own home has this pid registered too, on another session: not the TUI's.
    claudeHome(hosts, tui.pid!, "22222222-2222-4222-8222-222222222222", cwd, "another home's prompt");
    const found = ask("claude", tui.pid!, cwd, { CLAUDE_CONFIG_DIR: hosts }).ok;
    assert.deepEqual(found, { session: file, home: mine });

    // The TUI quits (the hand-off). The chat's host runs in another home (the
    // harness's own CLAUDE_CONFIG_DIR); its agent gets the TUI's, from tui-session.
    tui.kill();
    await exited(tui);
    const h = await startClaude({ name: "tui-home-claude", cwd, session: found.session, hostArgs: agentHomeArg(found.home) });
    try {
      assert.notEqual(h.configDir, mine);
      await h.client.waitFor(idle, 10_000);
      assert.deepEqual(h.items("user").map((i) => i.text), ["the TUI's own prompt"]);
      const start = h.inputs()[0];
      assert.equal(start?.env?.CLAUDE_CONFIG_DIR, mine, "claude runs in the TUI's home");
      assert.ok(start?.argv?.join(" ").includes("--resume 11111111-1111-4111-8111-111111111111"), "claude ran with --resume on the TUI's session");
      // The home is the chat's: in its registry entry (a restore without the pane's props) and its state (the mod's /tui, /login, new chats).
      assert.equal(h.registry?.agentHome, mine);
      assert.deepEqual(h.client.state.agentHome, { variable: "CLAUDE_CONFIG_DIR", value: mine });
    } finally {
      await h.stop();
    }
  } finally {
    tui.kill();
  }
});

test("tui-session: the chat's guard sees a Claude Code process registered in the session's home, not only the host's", async () => {
  const d = tmp();
  const cwd = join(d, "repo");
  mkdirSync(cwd);
  const mine = join(d, "claude-alt");
  const id = "66666666-6666-4666-8666-666666666666";
  // Another live Claude Code (this test process) has the session open, registered in its home only.
  const file = claudeHome(mine, process.pid, id, cwd);
  const h = await startClaude({ name: "tui-home-guard", cwd, session: file });
  try {
    assert.notEqual(h.configDir, mine);
    await h.client.waitFor((x) => x.state.phase === "conflict", 10_000);
    assert.deepEqual(h.client.state.conflict, { chat: null, terminal: null, pid: process.pid });
    assert.equal(h.inputs().length, 0, "Claude Code never started");
    // Not a continued chat: no home of its own.
    assert.equal(h.registry?.agentHome, undefined);
    assert.equal(h.client.state.agentHome, null);
  } finally {
    await h.stop();
  }
});

test("tui-session: a launcher's child agent is found in the child's own home", async () => {
  const d = tmp();
  const cwd = join(d, "repo");
  mkdirSync(cwd);
  const home = join(d, "claude-child");
  // The terminal's process is the launcher (no CLAUDE_CONFIG_DIR); its child, the agent, has one.
  const tui = startTui({}, `CLAUDE_CONFIG_DIR="${home}" sleep 30; true`);
  let child = 0;
  try {
    for (let i = 0; i < 50 && !child; i++) {
      child = Number(spawnSync("pgrep", ["-P", String(tui.pid)], { encoding: "utf8" }).stdout.trim()) || 0;
      if (!child) await sleep(50);
    }
    assert.ok(child > 0, "the launcher's child");
    const file = claudeHome(home, child, "33333333-3333-4333-8333-333333333333", cwd);
    assert.deepEqual(ask("claude", tui.pid!, cwd, {}).ok, { session: file, home });
  } finally {
    if (child) process.kill(child);
    tui.kill();
  }
});

test("tui-session: a Codex TUI with its own CODEX_HOME continues as a chat on its own rollout (the one it has open, else its home's newest in the folder), its agent in the TUI's home", async () => {
  const d = tmp();
  const cwd = join(d, "repo");
  mkdirSync(cwd);
  const mine = join(d, "codex-alt"), hosts = join(d, "codex-host");
  const id = "019a0000-0000-7000-8000-00000000000a";
  const tui = startTui({ CODEX_HOME: mine });
  await sleep(1200); // its start time before the rollouts' writes
  try {
    const own = rollout(mine, id, cwd, "gpt-5.6-luna", 0);
    const newer = rollout(hosts, "019a0000-0000-7000-8000-00000000000b", cwd, "gpt-host", 0); // the host's home, same folder, newer
    utimesSync(newer, new Date(), new Date(Date.now() + 5000));
    const found = ask("codex", tui.pid!, cwd, { CODEX_HOME: hosts }).ok;
    assert.equal(found?.session, own);
    assert.equal(found?.home, mine);
    assert.equal(found?.model, "openai/gpt-5.6-luna");

    // The chat resumes that rollout by its path, its agent in the TUI's home (the harness's is another).
    // (What the fake then makes of a real rollout's records isn't this test's.)
    tui.kill();
    const h = await codexHost({ name: "tui-home-codex", cwd, session: found.session, hostArgs: agentHomeArg(found.home) });
    try {
      for (let i = 0; i < 100 && !h.requests("thread/resume").length; i++) await sleep(50);
      assert.deepEqual(h.requests("thread/resume").map((r) => [r.params.threadId, r.params.path]), [[id, own]]);
      assert.notEqual(h.codexHome, mine);
      assert.equal(h.codexMessages().find((m) => m._start)?.env?.CODEX_HOME, mine, "codex runs in the TUI's home");
      assert.equal(h.registry?.agentHome, mine);
      assert.deepEqual(h.client.state.agentHome, { variable: "CODEX_HOME", value: mine });
    } finally {
      await h.stop();
    }
  } finally {
    tui.kill();
  }

  // The rollout the TUI process has open is its session, whichever home it is in and whatever
  // is newer; the home is that process's.
  const held = rollout(join(d, "shared-history"), "019a0000-0000-7000-8000-00000000000c", cwd, "gpt-held", 60);
  const holder = startTui({ CODEX_HOME: mine }, `exec 3<"${held}"; exec sleep 30`);
  try {
    await sleep(300);
    const r = ask("codex", holder.pid!, cwd, { CODEX_HOME: hosts }).ok;
    assert.equal(r?.session, held);
    assert.equal(r?.home, mine);
  } finally {
    holder.kill();
  }
});

test("tui-session: a TUI with no CLAUDE_CONFIG_DIR / CODEX_HOME uses ~/.claude / ~/.codex, even when the host has them set, and so does the chat's agent", async () => {
  const d = tmp();
  const cwd = join(d, "repo");
  mkdirSync(cwd);
  const home = join(d, "home");
  const tui = startTui({ HOME: home });
  await sleep(1200);
  try {
    const file = claudeHome(join(home, ".claude"), tui.pid!, "44444444-4444-4444-8444-444444444444", cwd, "the default home's prompt");
    claudeHome(join(d, "decoy-claude"), tui.pid!, "55555555-5555-4555-8555-555555555555", cwd);
    const found = ask("claude", tui.pid!, cwd, { HOME: home, CLAUDE_CONFIG_DIR: join(d, "decoy-claude") }).ok;
    assert.deepEqual(found, { session: file, home: null });

    const own = rollout(join(home, ".codex"), "019a0000-0000-7000-8000-00000000000d", cwd, "gpt-default", 0);
    rollout(join(d, "decoy-codex"), "019a0000-0000-7000-8000-00000000000e", cwd, "gpt-decoy", 0);
    const codex = ask("codex", tui.pid!, cwd, { HOME: home, CODEX_HOME: join(d, "decoy-codex") }).ok;
    assert.equal(codex?.session, own);
    assert.equal(codex?.home, null);

    // The chat's host has CLAUDE_CONFIG_DIR set; its agent runs without it, as the TUI did.
    tui.kill();
    await exited(tui);
    const h = await startClaude({ name: "tui-home-default", cwd, session: found.session, env: { HOME: home }, hostArgs: agentHomeArg(found.home) });
    try {
      await h.client.waitFor(idle, 10_000);
      assert.deepEqual(h.items("user").map((i) => i.text), ["the default home's prompt"]);
      assert.equal(h.inputs()[0]?.env?.CLAUDE_CONFIG_DIR, null, "claude runs with no CLAUDE_CONFIG_DIR");
      assert.equal(h.registry?.agentHome, "", "none, recorded as such");
      assert.deepEqual(h.client.state.agentHome, { variable: "CLAUDE_CONFIG_DIR", value: "" });
    } finally {
      await h.stop();
    }
  } finally {
    tui.kill();
  }
});

test("tui-session: a process whose environment can't be read gives no home; the TUI's own then has the default", async () => {
  const unreadable = new Set([1, 3]);
  const read: ReadVariable = (pid) => (unreadable.has(pid) ? undefined : pid === 2 ? "/alt" : null);
  assert.deepEqual(treeHomes([1, 2, 3, 4], "claude", read), [
    { pid: 1, dir: join(homedir(), ".claude"), home: null }, // the root: the default, never the host's own
    { pid: 2, dir: "/alt", home: "/alt" },
    // 3: none
    { pid: 4, dir: join(homedir(), ".claude"), home: null },
  ]);
  assert.equal(agentHome(3, "codex", read), null);
  assert.deepEqual(agentHome(4, "codex", (_p, name) => (name === "CODEX_HOME" ? "" : "x")), { dir: join(homedir(), ".codex"), home: null }, "empty is unset");

  // A child that exited between pgrep and the read: its environment is gone.
  const gone = spawn("true");
  await exited(gone);
  assert.equal(agentHome(gone.pid!, "claude"), null);
});

test("tui-session: macOS `ps -E`: the variable only from the environment after the command line, else can't tell", () => {
  const cmd = "/usr/local/bin/claude --flag CLAUDE_CONFIG_DIR=/from-argv HOME=/argv-home";
  const env = (rest: string) => `${cmd} ${rest}`;
  // An argument that looks like the variable isn't it.
  assert.equal(psVariable(cmd, env("PATH=/bin HOME=/Users/me TERM=x"), "CLAUDE_CONFIG_DIR"), null);
  assert.equal(psVariable(cmd, env("PATH=/bin CLAUDE_CONFIG_DIR=/Users/me/.claude-alt HOME=/Users/me"), "CLAUDE_CONFIG_DIR"), "/Users/me/.claude-alt");
  assert.equal(psVariable(cmd, env("PATH=/bin CLAUDE_CONFIG_DIR=/last"), "CLAUDE_CONFIG_DIR"), "/last");
  assert.equal(psVariable(cmd, env("PATH=/bin CLAUDE_CONFIG_DIR= HOME=/h"), "CLAUDE_CONFIG_DIR"), null, "empty is unset");
  // No environment shown (the HOME= in argv doesn't count): another user's process.
  assert.equal(psVariable(cmd, cmd, "CLAUDE_CONFIG_DIR"), undefined);
  // Cut at a space, twice, or not this command line: can't tell.
  assert.equal(psVariable(cmd, env("PATH=/bin CLAUDE_CONFIG_DIR=/Users/me/My Homes HOME=/h"), "CLAUDE_CONFIG_DIR"), undefined);
  assert.equal(psVariable(cmd, env("PATH=/bin CLAUDE_CONFIG_DIR=/a CLAUDE_CONFIG_DIR=/b"), "CLAUDE_CONFIG_DIR"), undefined);
  assert.equal(psVariable(cmd, "/usr/local/bin/claude PATH=/bin CLAUDE_CONFIG_DIR=/x", "CLAUDE_CONFIG_DIR"), undefined);
});

test("tui-session: a sub-agent's host gets the TUI's home too (herdr-chat-subagent --agent-home)", () => {
  const plan = (argv: string[]) => planSubagent({ args: parseArgs(["run", ...argv]), env: {}, cwd: "/w", home: "/h", config: readChatConfig(join(tmp(), "app")), chat: "c-x" });
  assert.deepEqual(plan(["--provider", "claude", "--session", "/s.jsonl", "--agent-home=/alt"]).serve.flags.get("agent-home"), ["/alt"]);
  assert.deepEqual(plan(["--provider", "claude", "--session", "/s.jsonl", "--agent-home="]).serve.flags.get("agent-home"), [""]);
  assert.equal(plan(["--provider", "claude"]).serve.flags.get("agent-home"), undefined);
});

test("tui-session: serve ignores --agent-home for Pi (its home is never looked for), and records nothing", async () => {
  const h = await startHost({ name: "tui-home-pi", hostArgs: ["--agent-home=/nowhere"] });
  try {
    await h.client.waitFor(idle, 10_000);
    assert.equal(h.registry?.agentHome, undefined);
    assert.equal(h.client.state.agentHome, null);
  } finally {
    await h.stop();
  }
});
