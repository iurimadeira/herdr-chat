// Continue as chat: the session a running agent TUI has open, so a chat can
// take it over (mod new-chat continueAsChat, via `herdr-chat-host tui-session`).
// Each agent's module says how it finds it (providers/index.ts `tuiSession`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { AGENT_HOMES, homeOf } from "./env.ts";

/**
 * session: the file a chat resumes; model ("provider/id") and thinking: the
 * TUI's, for a chat taking over in place; args: the agent's own arguments for
 * the same, for a sub-agent's new host (its command line is all it gets);
 * home: the agent home the TUI's process used (its CLAUDE_CONFIG_DIR /
 * CODEX_HOME; null: unset), for the chat's agent to inherit (serve --agent-home).
 */
export type TuiSession = { session: string; model?: string | null; thinking?: string | null; args?: string[]; home?: string | null };
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

/**
 * One variable of a process's environment: its value, null when unset (or
 * empty), undefined when the environment can't be read. Only that variable
 * is kept: an environment holds tokens.
 */
export type ReadVariable = (pid: number, name: string) => string | null | undefined;

export const processVariable: ReadVariable = (pid, name) => {
  if (process.platform === "linux") {
    let raw: Buffer;
    try {
      raw = readFileSync(`/proc/${pid}/environ`);
    } catch {
      return undefined; // gone (a child that exited after pgrep), or not ours
    }
    const prefix = `${name}=`;
    for (const entry of raw.toString("utf8").split("\0")) if (entry.startsWith(prefix)) return entry.slice(prefix.length) || null;
    return null;
  }
  // macOS: `ps -E` appends the environment to the command line `ps` alone shows.
  const ps = (flags: string[]) => execFileSync("ps", [...flags, "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).replace(/\n$/, "");
  try {
    return psVariable(ps([]), ps(["-E"]), name);
  } catch {
    return undefined;
  }
};

/**
 * Pure: a variable from `ps -E`'s line (`withEnv`), read only after the
 * command line (`command`, from `ps` without -E), so an argument like NAME=x
 * isn't taken for it. Undefined (can't tell) when the line doesn't start with
 * the command, shows no environment (no PATH or HOME: not the user's process),
 * holds the variable twice, or its value was cut at a space (the next word isn't VAR=).
 */
export function psVariable(command: string, withEnv: string, name: string): string | null | undefined {
  if (!withEnv.startsWith(command)) return undefined;
  const words = withEnv.slice(command.length).split(" ").filter(Boolean);
  if (!words.some((w) => w.startsWith("PATH=") || w.startsWith("HOME="))) return undefined;
  const at = words.flatMap((w, i) => (w.startsWith(`${name}=`) ? [i] : []));
  if (at.length === 0) return null;
  if (at.length > 1) return undefined;
  const next = words[at[0]! + 1];
  if (next !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(next)) return undefined;
  return words[at[0]!]!.slice(name.length + 1) || null;
}

/**
 * The agent home a process uses: `dir`, from its CLAUDE_CONFIG_DIR / CODEX_HOME
 * (`home`; null: unset), else the default (~/.claude, ~/.codex). Null when its
 * environment can't be read: it tells nothing (never the host's own instead).
 */
export function agentHome(pid: number, agent: "claude" | "codex", read: ReadVariable = processVariable): { dir: string; home: string | null } | null {
  const value = read(pid, AGENT_HOMES[agent].variable);
  return value === undefined ? null : { dir: homeOf(value, agent), home: value || null };
}

/**
 * Each process's home, in tree order: a process whose environment can't be
 * read has none, except the TUI's own (the root), which then has the default.
 */
export function treeHomes(tree: number[], agent: "claude" | "codex", read: ReadVariable = processVariable): { pid: number; dir: string; home: string | null }[] {
  return tree.flatMap((pid, i) => {
    const h = agentHome(pid, agent, read) ?? (i === 0 ? { dir: homeOf(null, agent), home: null } : null);
    return h ? [{ pid, ...h }] : [];
  });
}

/** The files the processes have open (`lsof`), each with the process holding it, or []. */
export function openFiles(pids: number[]): { pid: number; file: string }[] {
  let out: string;
  try {
    out = execFileSync("lsof", ["-p", pids.join(","), "-Fpn"], { encoding: "utf8", timeout: 5000 });
  } catch (e) {
    const o = (e as { stdout?: string }).stdout;
    if (typeof o !== "string") return [];
    out = o;
  }
  const files: { pid: number; file: string }[] = [];
  let pid = 0;
  for (const l of out.split("\n")) {
    if (l.startsWith("p")) pid = Number(l.slice(1));
    else if (l.startsWith("n")) files.push({ pid, file: l.slice(1) });
  }
  return files;
}
