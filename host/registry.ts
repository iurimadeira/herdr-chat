// The chat registry (<stateDir>/chats/<chat>.json) and the session lock
// (<sessionFile>.herdr-chat.lock).
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync, chmodSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";

export type RegistryEntry = {
  v: 1;
  chat: string;
  /** The provider (pi, claude, codex); reopening the chat uses the same one. Absent in entries written before v3 (= pi). */
  provider?: string;
  pid: number | null;
  /** JSONL over TCP (the CLI, tests, other hosts). */
  port: number | null;
  /** WebSocket, for the Herdr mod (protocol.md "Transport"). Absent before 0.4: such a host speaks only JSONL. */
  wsPort?: number | null;
  /** JSONL over a Unix socket (mode 0600, `<stateDir>/chats/<chat>.<pid>.sock`): what a remote chat's bridge connects to. Absent in entries written before protocol v3.8; null while no host runs. */
  socket?: string | null;
  token: string;
  cwd: string;
  sessionFile: string | null;
  terminal: string | null;
  startedAt: number;
  agentVersion: string | null;
  /** The host's herdr-chat version and build (build.ts): the chat asks for a restart when the install's differs. Absent before 0.3. */
  version?: string;
  build?: string;
};

export function registryPath(stateDir: string, chat: string): string {
  return join(stateDir, "chats", `${chat}.json`);
}

/**
 * The Unix socket of the chat's host with that pid, beside its registry entry. Named by pid: a
 * host's exit unlinks its own path, never a newer host's of the same chat.
 */
export function socketPath(stateDir: string, chat: string, pid: number): string {
  return join(stateDir, "chats", `${chat}.${pid}.sock`);
}

/**
 * Removes the sockets of this chat's hosts that died without removing theirs (SIGKILL): only
 * sockets (lstat, so never a link's target), only of a dead pid, never another chat's. Also the
 * single `<chat>.sock` an older host used.
 */
export function sweepSockets(stateDir: string, chat: string): void {
  const dir = join(stateDir, "chats");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${chat}.`) || !name.endsWith(".sock")) continue;
    const mid = name.slice(chat.length + 1, -".sock".length);
    if (mid !== "" && !/^\d+$/.test(mid)) continue;
    if (mid !== "" && pidAlive(Number(mid))) continue;
    const path = join(dir, name);
    try {
      if (lstatSync(path).isSocket()) unlinkSync(path);
    } catch {}
  }
}

export function atomicWrite(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function writeRegistry(stateDir: string, entry: RegistryEntry): void {
  atomicWrite(registryPath(stateDir, entry.chat), JSON.stringify(entry, null, 2) + "\n");
}

export function readRegistry(stateDir: string, chat: string): RegistryEntry | null {
  try {
    return JSON.parse(readFileSync(registryPath(stateDir, chat), "utf8"));
  } catch {
    return null;
  }
}

export type LockInfo = { pid: number; chat: string; terminal: string | null; startedAt: number };

export function lockPath(sessionFile: string): string {
  return `${sessionFile}.herdr-chat.lock`;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(sessionFile: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(lockPath(sessionFile), "utf8"));
  } catch {
    return null;
  }
}

/** Takes the lock. Returns the other live holder if there is one (the lock is taken anyway). */
export function takeLock(sessionFile: string, info: LockInfo): LockInfo | null {
  const prev = readLock(sessionFile);
  const other = prev && prev.pid !== info.pid && pidAlive(prev.pid) ? prev : null;
  try {
    atomicWrite(lockPath(sessionFile), JSON.stringify(info) + "\n", 0o644);
  } catch {}
  return other;
}

/** Removes the lock only if this process holds it. */
export function releaseLock(sessionFile: string, pid = process.pid): void {
  const prev = readLock(sessionFile);
  if (prev && prev.pid !== pid) return;
  try {
    unlinkSync(lockPath(sessionFile));
  } catch {}
}
