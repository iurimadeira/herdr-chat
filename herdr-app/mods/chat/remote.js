// A chat in a remote space (docs/dev/architecture.md "Remote chats"): its host runs
// on the space's machine (`hc run --on`, `serve --socket-only`), and the mod reaches it
// only through this Mac's relay for that machine (`herdr-chat-host relay`, a WebSocket
// on 127.0.0.1), which carries the bytes over herdr-core's machine link. The mod reads
// the host's registry entry on the machine (readTextFile `on`) for its token, and the
// relay's entry here for its port. Pure: no `herdr` import, so tests/mod runs it on Node.

import { agentHomeArgs } from "./agenthome.js";

/** The host's default state dir, relative to the machine's home (host/main.ts defaultStateDir). */
const DEFAULT_STATE_DIR = ".local/state/herdr-chat";

/** A relay's exit when another relay already serves the machine (host/relaylock.ts; protocol.md "relay"). */
export const RELAY_ALREADY_SERVES = 3;

/** How long `hc run` waits for the relay to exit before taking it as started (seconds). */
const RELAY_WAIT_S = 2;

const str = (v) => (typeof v === "string" && v ? v : null);
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

function parse(text) {
  try {
    return obj(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The machine's entry in the person's settings (README "Configuration"):
 * `machines.<name> = {host, node?, hc?, stateDir?, agents?: {claude?, codex?, pi?}}`.
 * `{error}` when it can't start a host.
 */
export function machineConfig(settings, name) {
  const m = obj(obj(settings)?.machines?.[name]);
  const host = str(m?.host);
  if (!m || !host) {
    return { error: `${name}: herdr-chat host not configured (machines.${name} in settings.json: ${m ? "host missing" : "no entry"})` };
  }
  const stateDir = str(m.stateDir);
  // The host resolves a relative --state-dir from its folder; the relay and the mod read from the home.
  if (stateDir && !stateDir.startsWith("/")) return { error: `${name}: machines.${name}.stateDir must be an absolute path (it is ${stateDir})` };
  const agents = obj(m.agents) ?? {};
  return { name, host, node: str(m.node), hc: str(m.hc), stateDir, agent: (provider) => str(agents[provider]) };
}

/** Where the host's registry entry is on the machine; a relative path is read from its home. */
export function remoteRegistryPath(machine, chat) {
  return `${machine.stateDir ?? DEFAULT_STATE_DIR}/chats/${chat}.json`;
}

/**
 * The chat's registry entry from the machine, or null when it isn't one this chat can use:
 * malformed, another chat's, or without a token. `pid` null: its host exited; `socket` null:
 * a host still binding its socket (the relay has nothing to join yet).
 */
export function remoteEntry(text, chat) {
  const e = text ? parse(text) : null;
  if (!e || e.chat !== chat || !str(e.token)) return null;
  if (e.pid !== null && !(Number.isInteger(e.pid) && e.pid > 0)) return null;
  if (e.socket !== null && e.socket !== undefined && !str(e.socket)) return null;
  return e;
}

/**
 * `hc` arguments that start the chat's host on the machine: in the space's folder there
 * (else the machine's home), on its Unix socket only, with the machine's own settings.
 * Nothing of the Mac's (its state dir, app home, node, agents, environment) goes along.
 */
export function remoteHostArgs({ machine, chat, cwd, provider, session = null, agentHome, hostEnv = null }) {
  const agent = machine.agent(provider);
  const env = { ...(hostEnv ?? {}), ...(machine.node ? { HERDR_CHAT_NODE: machine.node } : {}), ...(machine.hc ? { HERDR_CHAT_HC: machine.hc } : {}) };
  return [
    "run", "--on", machine.name, "--bg", "--json", "--keep", "--no-parent",
    ...(cwd ? ["--cwd", cwd] : []),
    "--label", `herdr-chat.chat=${chat}`, "--label", "herdr-chat.role=host",
    "--", "/usr/bin/env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
    machine.host, "serve", "--socket-only", "--chat", chat,
    ...(cwd ? ["--cwd", cwd] : []),
    ...(machine.stateDir ? ["--state-dir", machine.stateDir] : []),
    "--provider", provider,
    ...(session ? ["--session", session] : []),
    ...agentHomeArgs(agentHome),
    ...(agent ? [`--${provider}`, agent] : []),
  ];
}

/**
 * `hc` arguments that start this Mac's relay for the machine, as a core terminal here: `hc run`
 * waits RELAY_WAIT_S for it to exit (relayStart reads the outcome); still running, it's the relay.
 * `cfg`: the install's (config.json: this Mac's host, node, hc).
 */
export function relayStartArgs({ machine, cfg, stateDir }) {
  return [
    "run", "--json", "--no-parent", "--rm", "--timeout", String(RELAY_WAIT_S), "--cwd", stateDir,
    "--label", "herdr-chat.role=relay", "--label", `herdr-chat.machine=${machine.name}`,
    "--", "/usr/bin/env", ...(cfg.node ? [`HERDR_CHAT_NODE=${cfg.node}`] : []),
    cfg.host, "relay", "--machine", machine.name, "--state-dir", stateDir,
    ...(cfg.hc ? ["--hc", cfg.hc] : []),
    "--host", machine.host,
    ...(machine.node ? ["--node", machine.node] : []),
    ...(machine.stateDir ? ["--remote-state-dir", machine.stateDir] : []),
  ];
}

/**
 * What `hc run` said of the relay's start: `{up, started}` when a relay serves the machine
 * (this one, still running after the wait, or another: it exited RELAY_ALREADY_SERVES), else
 * `{error}`. An exit with no code (--rm removed it first) counts as up: the relay entry tells.
 */
export function relayStart(name, r) {
  const out = r.code === 0 ? parse(r.stdout) : null;
  const wait = obj(out?.wait);
  if (!wait) return { error: `couldn't start the relay for ${name}: ${(r.stderr || r.stdout).trim()}` };
  if (!wait.ended) return { up: true, started: true };
  if (wait.exit_code === RELAY_ALREADY_SERVES || wait.exit_code === null || wait.exit_code === undefined) return { up: true, started: false };
  return { error: `the relay for ${name} exited ${wait.exit_code}` };
}

/** The relay's entry (relays/<machine>.json): `{pid, wsPort}` while a relay serves the machine, else null. */
export function relayEntry(text, name) {
  const e = text ? parse(text) : null;
  if (!e || e.v !== 1 || e.machine !== name) return null;
  if (!(Number.isInteger(e.pid) && e.pid > 0) || !(Number.isInteger(e.wsPort) && e.wsPort > 0 && e.wsPort < 65536)) return null;
  return { pid: e.pid, wsPort: e.wsPort };
}

/** The relay's hello: the host's, with the chat it is for (the relay serves every chat of the machine). */
export function relayHello(token, chat) {
  return { t: "hello", v: 1, token, client: "mod", chat };
}

/**
 * What a relay's close code asks of the mod (protocol.md "relay"): 4001 reconnect at once;
 * 4003 a refusal, final (the error shows, no retries); anything else (4004 no host, 1011, 1013,
 * 1001, a dropped link, or no code) retry with backoff.
 */
export function closeAction(code) {
  if (code === 4001) return "now";
  if (code === 4003) return "stop";
  return "backoff";
}

/** Whether a core terminal is on `machine` (`machine/t7`); null: this Mac's (`t7`). */
export function onMachine(address, machine) {
  const a = String(address);
  return machine ? a.startsWith(`${machine}/`) : !a.includes("/");
}

// Whether a terminal runs a host (herdr-chat-host, or herdr-chat-subagent for a
// sub-agent; a template runs it as `sh -c '…/herdr-chat-subagent …'`). After
// herdr-core restarts, it brings a kept terminal back as a login shell with
// the same labels: that shell is no host. An unknown argv counts as a host.
const HOST_BIN = /herdr-chat-(host|subagent)\b/;
export function runsHost(t) {
  return !Array.isArray(t.argv) || t.argv.some((a) => HOST_BIN.test(a));
}

/**
 * Whether a core terminal is the live host of `chat` on `machine` (null: this Mac): labeled
 * for the chat as its host or a sub-agent's, never a relay's bridge (role `bridge`, which
 * also runs herdr-chat-host on the machine).
 */
export function chatHost(t, chat, machine) {
  const role = t.labels?.["herdr-chat.role"];
  return t.labels?.["herdr-chat.chat"] === chat && (role === "host" || role === "subagent")
    && t.state === "live" && onMachine(t.address, machine) && runsHost(t);
}

/** How long a just-started host may take to show up before its chat starts another (or fails). */
export const HOST_START_MS = 8000;

/**
 * What a chat with no host answering does next. `once` (a remote chat): a host it started that
 * died before it answered is not started again ("failed", until Retry): `hc run --on` returns 0
 * whether or not the host lives, and each start leaves a kept terminal on the machine.
 */
export function hostStep({ live, startedAt, now, autoStart, once }) {
  if (live || now - startedAt < HOST_START_MS) return "wait";
  if (!autoStart) return "stopped";
  return once && startedAt ? "failed" : "start";
}
