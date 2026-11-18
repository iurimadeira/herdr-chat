// A Claude Code TUI's session: Claude Code registers each live process in
// <home>/sessions/<pid>.json ({pid, sessionId, cwd}), in the home that process
// uses (its CLAUDE_CONFIG_DIR, else ~/.claude); the transcript is
// <home>/projects/<project>/<sessionId>.jsonl, written once the session has a
// message. The chat's agent inherits that home (`home`).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { subdirs } from "../../jsonl.ts";
import { processTree, treeHomes, type TuiQuery, type TuiSession } from "../tui.ts";

export function claudeTuiSession(q: TuiQuery): TuiSession {
  // A launcher and the agent it runs may have different homes: each process's own.
  const homes = treeHomes(processTree(q.pid), "claude");
  for (const { pid, dir, home } of homes) {
    let r: Record<string, any>;
    try {
      r = JSON.parse(readFileSync(join(dir, "sessions", `${pid}.json`), "utf8"));
    } catch {
      continue;
    }
    if (typeof r?.sessionId !== "string") continue;
    const file = subdirs(join(dir, "projects")).map((p) => join(p, `${r.sessionId}.jsonl`)).find((f) => existsSync(f));
    if (!file) throw new Error("this Claude Code session has no messages yet: nothing to continue");
    return { session: file, home };
  }
  throw new Error(`Claude Code didn't register this process (no ${join(homes[0]!.dir, "sessions", `${q.pid}.json`)})`);
}
