// A Codex TUI's session: the rollout file it has open (`codex --no-daemon`;
// seen live with codex-cli 0.167: the TUI process itself holds
// <sessions>/YYYY/MM/DD/rollout-<ts>-<thread id>.jsonl open, its real path even
// when <home>/sessions is a link to a shared tree), else the newest rollout in
// its folder written since it started, under the home it uses (its CODEX_HOME,
// else ~/.codex; a TUI on the shared daemon leaves the file to the daemon).
// The model and effort are the last turn's (`turn_context`). The chat's agent
// inherits the home of the process that has it open (`home`), else the scanned home's.
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { openFiles, processStart, processTree, treeHomes, type TuiQuery, type TuiSession } from "../tui.ts";

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Rollout files under <home>/sessions/YYYY/MM/DD, newest days first, as far back as `since`. */
function rollouts(home: string, since: number): string[] {
  const root = join(home, "sessions");
  const out: string[] = [];
  const dirs = (p: string) => {
    try {
      return readdirSync(p).filter((n) => /^\d+$/.test(n)).sort().reverse();
    } catch {
      return [];
    }
  };
  const oldest = new Date(since - 86_400_000);
  for (const y of dirs(root)) for (const m of dirs(join(root, y))) for (const d of dirs(join(root, y, m))) {
    if (new Date(`${y}-${m}-${d}T23:59:59`) < oldest) return out;
    for (const f of readdirSync(join(root, y, m, d))) if (/^rollout-.*\.jsonl$/.test(f)) out.push(join(root, y, m, d, f));
  }
  return out;
}

function meta(file: string): { cwd: string | null; model: string | null; effort: string | null } {
  let cwd: string | null = null, model: string | null = null, effort: string | null = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "session_meta" && typeof e.payload?.cwd === "string") cwd ??= e.payload.cwd;
      if (e.type === "turn_context") {
        if (typeof e.payload?.model === "string") model = e.payload.model;
        if (typeof e.payload?.effort === "string") effort = e.payload.effort;
      }
    } catch {}
  }
  return { cwd, model, effort };
}

export function codexTuiSession(q: TuiQuery): TuiSession {
  const tree = processTree(q.pid);
  const homes = treeHomes(tree, "codex");
  const open = openFiles(tree).find((o) => /\/rollout-[^/]*\.jsonl$/.test(o.file));
  // The holder's home; one whose environment can't be read, the TUI's (the root's).
  let found = open ? { file: open.file, home: (homes.find((h) => h.pid === open.pid) ?? homes[0]!).home } : null;
  if (!found) {
    const since = (processStart(q.pid) ?? Date.now() - 86_400_000) - 5000;
    const cwd = real(q.cwd);
    let best: { file: string; home: string | null; t: number } | null = null;
    const seen = new Set<string>();
    for (const h of homes) {
      if (seen.has(h.dir)) continue;
      seen.add(h.dir);
      for (const f of rollouts(h.dir, since)) {
        const t = statSync(f).mtimeMs;
        if (t < since || (best && t <= best.t)) continue;
        const m = meta(f);
        if (m.cwd && real(m.cwd) === cwd) best = { file: f, home: h.home, t };
      }
    }
    found = best;
  }
  if (!found) throw new Error("no Codex session in this folder since it started: send it a message first");
  const file = found.file;
  const m = meta(file);
  return {
    session: file, home: found.home, model: m.model ? `openai/${m.model}` : null, thinking: m.effort,
    args: [...(m.model ? ["-c", `model=${JSON.stringify(m.model)}`] : []), ...(m.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(m.effort)}`] : [])],
  };
}
