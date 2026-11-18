// The environment an agent CLI runs in under the chat host.
import { homedir } from "node:os";
import { join } from "node:path";

/** Each agent's home: the variable that sets it, else the default under ~. */
export const AGENT_HOMES = {
  claude: { variable: "CLAUDE_CONFIG_DIR", fallback: [".claude"] },
  codex: { variable: "CODEX_HOME", fallback: [".codex"] },
  pi: { variable: "PI_CODING_AGENT_DIR", fallback: [".pi", "agent"] },
} as const;
export type HomeAgent = keyof typeof AGENT_HOMES;

/** An agent home from its variable's value: an empty value counts as unset (the default). */
export function homeOf(value: string | null | undefined, agent: HomeAgent): string {
  return value || join(homedir(), ...AGENT_HOMES[agent].fallback);
}

/**
 * Marked as run by the host (HERDR_CHAT_HOST), without Herdr's hook variables: the
 * agent's own Herdr hook would report this host's pane status beside our OSC 7501.
 * An empty home variable is dropped: unset, for the agent as for the host.
 */
export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HERDR_CHAT_HOST: "1", ...extra };
  delete env.HERDR_PANE_ID;
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_ENV;
  for (const { variable } of Object.values(AGENT_HOMES)) if (!env[variable]) delete env[variable];
  return env;
}
