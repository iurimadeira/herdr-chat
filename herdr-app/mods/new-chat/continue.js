// Continue as chat's launch arguments, from tui-session's answer (`found`:
// {session, home, model, thinking, args}; `home` only for Claude Code and
// Codex, null: none set). No Herdr imports: tests/mod runs these on Node.

const homeArgs = (found) => ("home" in found ? [`--agent-home=${found.home ?? ""}`] : []);

/** A sub-agent's host in the TUI's place: bin/herdr-chat-subagent's argv. */
export function subagentArgs({ launcher, agent, found }) {
  const args = found.args ?? [];
  return [launcher, "--provider", agent, "--session", found.session, ...homeArgs(found), ...(args.length ? ["--", ...args] : [])];
}

/** A top-level TUI's chat pane: its props ("" for no home set, so a restore never reads null as unknown). */
export function inPlaceProps({ chat, agent, pid, cwd, found }) {
  return { chat, provider: agent, session: found.session, afterPid: pid, cwd, ...("home" in found ? { agentHome: found.home ?? "" } : {}),
    ...(found.model ? { model: found.model } : {}), ...(found.thinking ? { thinking: found.thinking } : {}) };
}
