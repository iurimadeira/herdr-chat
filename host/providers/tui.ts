// Continue as chat: the session a running agent TUI has open, so a chat can
// take it over (mod new-chat continueAsChat, via `herdr-chat-host tui-session`).
// Each agent's module says how it finds it (providers/index.ts `tuiSession`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * session: the file a chat resumes; model ("provider/id") and thinking: the
 * TUI's, for a chat taking over in place; args: the agent's own arguments for
 * the same, for a sub-agent's new host (its command line is all it gets).
 */
export type TuiSession = { session: string; model?: string | null; thinking?: string | null; args?: string[] };
/** pid: the TUI's process (the terminal's foreground); cwd: its folder; label: the terminal's `herdr-chat.session` label, if any. */
export type TuiQuery = { pid: number; cwd: string; label: string | null };

/** The process and its descendants (an agent's launcher may run the real one as a child). */
export function processTree(pid: number): number[] {
  const out = [pid];
  for (let i = 0; i < out.length && out.length < 64; i++) {
    try {
      for (const c of execFileSync("pgrep", ["-P", String(out[i])], { encoding: "utf8", timeout: 3000 }).split("\n")) if (Number(c) > 0) out.push(Number(c));
    } catch {} // pgrep exits 1 with no children
  }
  return out;
}

/** When the process started (ms), or null. */
export function processStart(pid: number): number | null {
  try {
    const s = Number(execFileSync("ps", ["-o", "etime=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim().replace(/^(\d+)-/, (_m, d) => `${d * 24}:`).split(":").reduce((a, x) => a * 60 + Number(x), 0));
    return Number.isFinite(s) ? Date.now() - s * 1000 : null;
  } catch {
    return null;
  }
}

const HOMES = {
  claude: { variable: "CLAUDE_CONFIG_DIR", fallback: [".claude"] },
  codex: { variable: "CODEX_HOME", fallback: [".codex"] },
  pi: { variable: "PI_CODING_AGENT_DIR", fallback: [".pi", "agent"] },
} as const;

/**
 * One variable of a process's environment: its value, null when unset (or
 * empty), undefined when the environment can't be read. Only that variable
 * is kept: an environment holds tokens.
 */
function processVariable(pid: number, name: string): string | null | undefined {
  const prefix = `${name}=`;
  if (process.platform === "linux") {
    let raw: Buffer;
    try {
      raw = readFileSync(`/proc/${pid}/environ`);
    } catch {
      return undefined;
    }
    for (const entry of raw.toString("utf8").split("\0")) if (entry.startsWith(prefix)) return entry.slice(prefix.length) || null;
    return null;
  }
  // macOS: `ps -E` appends a process's environment to its command line, for
  // the user's own processes (a value with a space is cut there).
  let line: string;
  try {
    line = execFileSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 });
  } catch {
    return undefined;
  }
  if (!line.trim()) return undefined;
  const m = new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(line);
  return m?.[1] || null;
}

/**
 * The agent home a process uses: its CLAUDE_CONFIG_DIR / CODEX_HOME /
 * PI_CODING_AGENT_DIR, else the default (~/.claude, ~/.codex, ~/.pi/agent).
 * An environment that can't be read leaves the host's own (as before).
 */
export function agentHome(pid: number, agent: keyof typeof HOMES): string {
  const { variable, fallback } = HOMES[agent];
  const own = processVariable(pid, variable);
  const value = own === undefined ? process.env[variable] || null : own;
  return value ?? join(homedir(), ...fallback);
}

/** The files the processes have open (`lsof`), or []. */
export function openFiles(pids: number[]): string[] {
  try {
    return execFileSync("lsof", ["-p", pids.join(","), "-Fn"], { encoding: "utf8", timeout: 5000 }).split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1));
  } catch (e) {
    const out = (e as { stdout?: string }).stdout;
    return typeof out === "string" ? out.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1)) : [];
  }
}
