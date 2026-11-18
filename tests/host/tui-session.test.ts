// Continue as chat asks the host which session a running agent TUI has open
// (`herdr-chat-host tui-session`), each agent its own way: Pi's lock-extension
// label, Claude Code's live-process registry, Codex's rollout it has open, else
// its newest rollout in the TUI's folder since it started (one in another
// folder, or older, isn't it). Claude Code's and Codex's files are in the agent
// home the TUI process itself uses (CLAUDE_CONFIG_DIR / CODEX_HOME in its
// environment, else ~/.claude / ~/.codex), not the host's.
// The TUI is a real process (sleep), so its pid, start time and environment are real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HOST_ENTRY, HOST_NODE, idle, sleep } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";
import { codexHost } from "../fake-codex/host.ts";

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function ask(provider: string, pid: number, cwd: string, env: Record<string, string>, label?: string) {
  const r = spawnSync(HOST_NODE, [HOST_ENTRY, "tui-session", "--provider", provider, "--pid", String(pid), "--cwd", cwd, ...(label ? ["--label", label] : [])],
    { encoding: "utf8", env: { ...process.env, ...env } });
  return r.status === 0 ? { ok: JSON.parse(r.stdout) } : { error: r.stderr.trim() };
}

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
    assert.equal(ask("claude", pid, cwd, {}).ok?.session, join(project, "abc-123.jsonl"));
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
      session: mine, model: "openai/gpt-5.6-luna", thinking: "high", args: ["-c", 'model="gpt-5.6-luna"', "-c", 'model_reasoning_effort="high"'],
    });
  } finally {
    tui.kill();
  }
});

test("tui-session: a Claude Code TUI with its own CLAUDE_CONFIG_DIR continues as a chat on its own session, not the host's home's", async () => {
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
    assert.deepEqual(found, { session: file });

    // The TUI quits (the hand-off), and the chat resumes its session in the home
    // its agent runs in (the router picks it by folder: the same one here).
    tui.kill();
    await new Promise((r) => (tui.exitCode !== null || tui.signalCode !== null ? r(null) : tui.once("exit", r)));
    const h = await startClaude({ name: "tui-home-claude", cwd, session: found.session, env: { CLAUDE_CONFIG_DIR: mine } });
    try {
      await h.client.waitFor(idle, 10_000);
      assert.deepEqual(h.items("user").map((i) => i.text), ["the TUI's own prompt"]);
      assert.ok(h.inputs()[0]?.argv?.join(" ").includes("--resume 11111111-1111-4111-8111-111111111111"), "claude ran with --resume on the TUI's session");
    } finally {
      await h.stop();
    }
  } finally {
    tui.kill();
  }
});

test("tui-session: a launcher's child agent is found in the child's own home", async () => {
  const d = tmp();
  const cwd = join(d, "repo");
  mkdirSync(cwd);
  const home = join(d, "claude-child");
  // The terminal's process is the launcher (no CLAUDE_CONFIG_DIR); its child, the agent, has one.
  const tui = startTui({}, `CLAUDE_CONFIG_DIR="${home}" sleep 30; true`);
  try {
    let child = 0;
    for (let i = 0; i < 50 && !child; i++) {
      child = Number(spawnSync("pgrep", ["-P", String(tui.pid)], { encoding: "utf8" }).stdout.trim()) || 0;
      if (!child) await sleep(50);
    }
    assert.ok(child > 0, "the launcher's child");
    const file = claudeHome(home, child, "33333333-3333-4333-8333-333333333333", cwd);
    assert.deepEqual(ask("claude", tui.pid!, cwd, {}).ok, { session: file });
  } finally {
    tui.kill();
  }
});

test("tui-session: a Codex TUI with its own CODEX_HOME continues as a chat on its own rollout: the one it has open, else its home's newest in the folder", async () => {
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
    assert.equal(found?.model, "openai/gpt-5.6-luna");

    // The chat resumes that rollout by its path (Codex homes may share one sessions tree).
    // (What the fake then makes of a real rollout's records isn't this test's.)
    tui.kill();
    const h = await codexHost({ name: "tui-home-codex", cwd, session: found.session });
    try {
      for (let i = 0; i < 100 && !h.requests("thread/resume").length; i++) await sleep(50);
      assert.deepEqual(h.requests("thread/resume").map((r) => [r.params.threadId, r.params.path]), [[id, own]]);
    } finally {
      await h.stop();
    }
  } finally {
    tui.kill();
  }

  // The rollout the TUI process has open is its session, whichever home it is in and whatever is newer.
  const held = rollout(join(d, "shared-history"), "019a0000-0000-7000-8000-00000000000c", cwd, "gpt-held", 60);
  const holder = startTui({ CODEX_HOME: mine }, `exec 3<"${held}"; exec sleep 30`);
  try {
    await sleep(300);
    assert.equal(ask("codex", holder.pid!, cwd, { CODEX_HOME: hosts }).ok?.session, held);
  } finally {
    holder.kill();
  }
});

test("tui-session: a TUI with no CLAUDE_CONFIG_DIR / CODEX_HOME uses ~/.claude / ~/.codex, even when the host has them set", async () => {
  const d = tmp();
  const cwd = join(d, "repo");
  mkdirSync(cwd);
  const home = join(d, "home");
  const tui = startTui({ HOME: home });
  await sleep(1200);
  try {
    const file = claudeHome(join(home, ".claude"), tui.pid!, "44444444-4444-4444-8444-444444444444", cwd);
    claudeHome(join(d, "decoy-claude"), tui.pid!, "55555555-5555-4555-8555-555555555555", cwd);
    assert.deepEqual(ask("claude", tui.pid!, cwd, { HOME: home, CLAUDE_CONFIG_DIR: join(d, "decoy-claude") }).ok, { session: file });

    const own = rollout(join(home, ".codex"), "019a0000-0000-7000-8000-00000000000d", cwd, "gpt-default", 0);
    rollout(join(d, "decoy-codex"), "019a0000-0000-7000-8000-00000000000e", cwd, "gpt-decoy", 0);
    assert.equal(ask("codex", tui.pid!, cwd, { HOME: home, CODEX_HOME: join(d, "decoy-codex") }).ok?.session, own);
  } finally {
    tui.kill();
  }
});
