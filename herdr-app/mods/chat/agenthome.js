// The agent home a continued chat inherits from its TUI (Continue as chat:
// tui-session's `home`, serve --agent-home). A value is a path, "" for none
// set (the agent's default home), undefined for a chat that continued no TUI.
// No Herdr imports: tests/mod runs these on Node.

/** `/usr/bin/env` arguments putting the agent in `home` ({variable, value}, the host's state): set, unset, or nothing. */
export function homeEnv(home) {
  if (!home) return [];
  return home.value ? [`${home.variable}=${home.value}`] : ["-u", home.variable];
}

/** A terminal of the chat's agent (/tui, /login): its argv run in the chat's agent home. */
export function handoffArgv(argv, home) {
  const env = homeEnv(home);
  return env.length ? ["/usr/bin/env", ...env, ...argv] : argv;
}

/** serve's --agent-home for a continued chat (null, an older pane's prop: none set). */
export function agentHomeArgs(home) {
  return home === undefined ? [] : [`--agent-home=${home ?? ""}`];
}

/** The chat's home at its host's start: the pane's prop, else (a restore without props) the registry entry's for the same agent. */
export function chatHome(prop, entry, provider) {
  if (prop !== undefined) return prop;
  return entry?.provider === provider && typeof entry.agentHome === "string" ? entry.agentHome : undefined;
}

/** The home a new chat from this one carries (same agent, same account): the host's state, else (not connected yet) the pane's prop. */
export function carriedHome(state, prop) {
  if (state?.agentHome !== undefined) return state.agentHome?.value;
  return prop === undefined ? undefined : prop ?? "";
}

/** A new chat tab's props. */
export function newChatProps({ chat, provider, cwd, session, hostEnv, agentHome }) {
  return { chat, provider, ...(cwd ? { cwd } : {}), ...(session ? { session } : {}), ...(hostEnv ? { hostEnv } : {}),
    ...(agentHome !== undefined ? { agentHome } : {}) };
}
