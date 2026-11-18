// A chat in a remote space (docs/specs/remote-spaces.md): its host runs on the
// space's machine, started with `hc run --on`, listening on the address the
// Mac reaches it at, and the mod connects to the address its registry entry
// advertises. Pure: no `herdr` import, so tests/mod runs it under Node.

/** The WebSocket header that carries the chat token (protocol.md "Transport"). */
export const TOKEN_HEADER = "x-herdr-chat-token";

/** The host's own default state dir, relative to the machine's home (host/main.ts defaultStateDir). */
const DEFAULT_STATE_DIR = ".local/state/herdr-chat";

const str = (v) => (typeof v === "string" && v ? v : null);

/**
 * The machine's entry in the person's settings: `machines.<name> = {address, host, node?, stateDir?, agents: {claude?, codex?, pi?}}`.
 * `{error}` when it's missing what a start needs.
 */
export function machineConfig(settings, name) {
  const m = settings?.machines?.[name];
  const address = str(m?.address);
  const host = str(m?.host);
  if (!m || typeof m !== "object" || !address || !host) {
    const missing = !m || typeof m !== "object" ? "no entry" : [!address && "address", !host && "host"].filter(Boolean).join(" and ") + " missing";
    return { error: `${name}: herdr-chat host not configured (machines.${name} in settings.json: ${missing})` };
  }
  const agents = m.agents && typeof m.agents === "object" ? m.agents : {};
  return {
    name,
    address,
    host,
    node: str(m.node),
    stateDir: str(m.stateDir),
    agent: (provider) => str(agents[provider]),
  };
}

/** Where the host's registry entry is on the machine; a relative path is read from its home. */
export function remoteRegistryPath(machine, chat) {
  return `${machine.stateDir ?? DEFAULT_STATE_DIR}/chats/${chat}.json`;
}

/**
 * `hc` arguments that start the chat's host on the machine. Nothing of the Mac's (its state dir,
 * app home, node, agent commands or environment) goes along: only the machine's entry. No
 * `cwd`: the machine's home. No state dir: the host's default there.
 */
export function remoteStartArgs({ machine, chat, cwd, provider, session }) {
  const agent = machine.agent(provider);
  return [
    "run", "--on", machine.name, "--bg", "--json", "--keep", "--no-parent",
    ...(cwd ? ["--cwd", cwd] : []),
    "--label", `herdr-chat.chat=${chat}`, "--label", "herdr-chat.role=host",
    "--", "/usr/bin/env", ...(machine.node ? [`HERDR_CHAT_NODE=${machine.node}`] : []),
    machine.host, "serve", "--chat", chat,
    ...(cwd ? ["--cwd", cwd] : []),
    ...(machine.stateDir ? ["--state-dir", machine.stateDir] : []),
    "--listen", machine.address, "--provider", provider,
    ...(session ? ["--session", session] : []),
    ...(agent ? [`--${provider}`, agent] : []),
  ];
}

/** The WebSocket URL for a registry entry's advertised address (an IPv6 one in brackets). */
export function wsUrl(address, port) {
  const host = address.includes(":") ? `[${address}]` : address;
  return `ws://${host}:${port}/`;
}
