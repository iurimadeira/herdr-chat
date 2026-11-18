# Chats in remote spaces

Status: approved

## Problem statement

The Herdr app runs on a Mac, but the spaces, agents, code and session logs
live on another machine (here `lab`, a Linux server added to Herdr as a
machine). herdr-chat works only in local spaces:
in a space whose machine is remote, ⌘I and "Open as chat" do nothing useful,
and the agent's TUI is the only way to talk to it (README "Spaces on other
machines still open the agent's TUI").

## Solution

A chat in a remote space looks and behaves like a chat in a local space. The
chat UI (mod) keeps running in the Mac app; the host, the agent it starts,
the session files, git and file completion all live on the space's machine.
The mod starts the host on that machine through herdr-core and talks to it
through herdr-core's own machine link, so herdr-chat never knows how the
machine is reached (SSH, `--via`, VPN, Tor or anything else). Local spaces
behave exactly as today.

## User stories

1. As a person working in a lab space, I want ⌘I (here `cmd-shift-i`) to open
   a Claude, Codex or Pi chat that runs on lab in that space's folder, so that
   I get the chat UI for remote work.
2. As that person, I want the chat to use the same account routing as my
   terminal (`acc`/`aco`), so that pinned folders and account failover still
   apply.
3. As that person, I want `/resume`, "Continue as chat" and "Open as chat" to
   find sessions on lab, in whichever agent home they were written, so that
   remote sessions are not invisible.
4. As that person, I want to paste or drop an image into a remote chat and see
   image thumbnails and viewers, so that images work as they do locally.
5. As that person, I want "open file" from a remote chat to open the file in
   an editor on lab, so that file links point at the real files.
6. As that person, I want chat sub-agents started by agents on lab to show up
   as chats I can open from the Mac.
7. As a maintainer, I want the remote path to be opt-in per machine and to
   leave local behavior untouched, so that it can go upstream piece by piece.

## Behavior and acceptance

Machine configuration
- A chat in a remote space uses that machine's entry in the herdr-chat
  settings on the Mac (`<appHome>/data/herdr-chat/settings.json`):
  `machines.<name> = {host, node?, stateDir?, agents: {claude?, codex?, pi?}}`.
  `host` is the host command on that machine; `agents` maps a provider to
  the command to start on that machine (lab: `acc`, `aco`). The machine is
  whatever Herdr has added under that name; herdr-chat stores nothing about
  how it is reached.
- The host's state directory on that machine is `~/.local/state/herdr-chat`,
  overridden by `stateDir`, which must be an absolute path (a relative one is
  a configuration error shown in the chat).
- A missing `host` or agent command is looked up on that machine through its
  login shell (`command -v`). A host installed with `--host-only` is not on
  PATH, so that machine's entry sets `host` to the path the installer prints.
  A machine where no host is found shows a clear error in the chat
  ("lab: herdr-chat host not configured"), never a hang at "Starting…".

Starting and connecting
- Opening a chat in a remote space starts the host on that machine as a
  herdr-core terminal (`hc run --on <machine>`) in the space's folder on that
  machine, with that machine's state directory. Its registry entry is read
  from the Mac with `readTextFile(..., {on})`.
- A remote host listens only on a Unix socket with mode 0600 in its state
  directory on that machine, recorded in its registry entry. Nothing listens
  on any network port on the remote machine.
- The chat's bytes travel: mod → WebSocket on `127.0.0.1` on the Mac with the
  per-chat token in `hello` → a relay process on the Mac → the Mac core's
  `terminal.attach` on `machine/tN` (framed API, via `hc connect`) →
  herdr-core's machine link → the remote core → a bridge terminal on the
  remote machine → the host's Unix socket.
- The relay is started by the mod with a local `hc run --bg` and is
  long-lived. A connection without the right token gets nothing and is
  closed.
- The relay starts one bridge terminal per connection on the remote machine,
  with `--no-parent --no-notify`, in raw mode (`stty raw -echo`); the bridge
  connects to the host's socket and ends when its connection ends.
- Relay wire rules: one JSON record per `\n`-terminated line, carrying a
  sequence number or per-attach epoch; at most 1 MiB unacknowledged per
  direction (below core's 4 MiB repaint threshold); a SYNC/SYNCED nonce
  handshake on each attach, with everything before SYNCED discarded; input
  is sent as DATA.
- An unexpected control byte, a bad frame, a repaint or a link drop forces a
  resync: the relay reattaches, and each resync is a fresh host session that
  recovers by snapshot, as reconnect does today.
- Local chats are unchanged: the host listens on `127.0.0.1`, the mod
  connects directly with the token in `hello`, and no relay is involved.
- Streaming, steering, follow-ups, stop, model, effort and mode, dialogs and
  permission prompts behave as in a local chat. A dropped link reconnects
  with backoff and resumes from a snapshot, as today.
- The host's terminal is a hidden pane of the chat's tab in that machine's
  layout document, so Herdr lists the chat as the tab's agent (status dots,
  toasts, `cmd-]`/`cmd-[`) and never draws the host pane.
- Closing the chat pane ends the host and its hidden pane on the remote
  machine, as it does locally.
- The app being closed or the Mac sleeping leaves the host and the agent
  running on the remote machine; reopening the chat reconnects.

Agent homes and sessions
- The agent a remote chat starts is the configured command for that machine
  (`acc -p --output-format stream-json …`, `aco … app-server`), in the space's
  folder, so the router picks the account by that folder.
- "Continue as chat" finds a running agent's session through the agent
  process's own `CLAUDE_CONFIG_DIR` / `CODEX_HOME` from its environment, then
  `<home>/sessions/<pid>.json` for Claude's session id, falling back to
  `~/.claude` / `~/.codex` when unset. The chat that takes the session over
  inherits that home (the session's home; herdr-chat still never picks one).
  This applies to local chats too (it fixes multi-home setups locally).
  "Open as chat" connects to an existing chat's host and looks up no session.
- `/resume` on a remote chat lists sessions from every agent home on that
  machine that the configured agents use, for This folder / All folders.

Images
- Pasting or dropping an image in a remote chat sends its bytes to the host,
  which stores it beside the chat on that machine and attaches it.
- Image thumbnails and the image viewer show images the host has on the
  remote machine: their bytes are copied to the Mac's app-home cache first.
- Clipboard image paste in a remote chat reads the Mac's clipboard (not the
  remote machine's).

Files and editor
- "Open file" in a remote chat opens the file on the remote machine: in
  herdr-nvim when it is installed for that machine, else in `$EDITOR` in a
  new terminal tab of that remote space.

Install
- `install.sh --host-only` installs the host (release or checkout link) on a
  machine without the Herdr app and prints the host command's path; it writes
  no hc chat templates and touches no app home, layout or keys.
- The Mac install respects preset keys (`open: cmd-shift-i`,
  `focusComposer: null`) and `--no-subagents`, so its only edits to
  chezmoi-managed files are `layouts/iuri.json` and `keys.json`, which are
  then captured at source with `chezmoi re-add`.

Sub-agents
- The sub-agent note (use `hc run --bg --name X claude-chat "<task>"`) and
  the hc chat templates on lab are delivered through the dotfiles source
  (chezmoi), not by the installer writing managed files.

## Implementation decisions

- Host placement: the host runs on the space's machine, next to the agent
  and its files. Rejected: a host on the Mac proxying every file read and
  spawn to the remote machine (the host does ~11k lines of synchronous local
  file, git and process work).
- Transport: herdr-core `terminal.attach` on a remote bridge terminal,
  reached through a relay process on the Mac (mods cannot use the framed API
  themselves, so the relay does it for them). It rides herdr-core's machine
  link and is connection-agnostic; herdr-chat has no knowledge of Tailscale
  and no network address for a machine. `terminal.attach` is the only
  streaming channel core offers; the relay spike measured it byte-exact for
  all 256 byte values and 8 MiB lines, at 220-310 MB/s with an ack window.
  Rejected: a direct WebSocket from the mod to the host over a routable or
  tailnet address (ties herdr-chat to one network, opens a port on the
  remote machine, excludes `--via` machines); an `ssh -L` tunnel kept as a
  second local terminal (extra process and port supervision, SSH only);
  streaming through `exec`/`hc` (they return only at exit, 600 s cap);
  `hc attach` as the relay (needs a TTY).
- Ack window: without it, a burst more than ~4 MiB past what the viewer has
  consumed is replaced by a repaint and lost (spike, local and remote); a
  32 MiB window lost data on a 5 s stall, a 1 MiB window did not.
- Bridge in raw mode: core's VT relay answers terminal queries and types the
  replies into the bridge's stdin, and Node's raw mode keeps ONLCR. The JSON
  lines contain no raw byte below `0x20`, so they never form a query; any
  stray control byte is treated as corruption (resync).
- A remote space's layout lives in that machine's core document; the mod
  reads and writes it through the Mac core with `doc.get`/`doc.set` and
  `on: <machine>`. A terminal's pane must be on its own machine, so the host
  terminal of a remote chat runs on that machine.
- Pane-close handling for a remote host cannot use `herdr-app.sock` (a Mac
  socket); it uses the remote machine's core and document instead.
- Remote ids are `machine/<id>` in the app and bare inside the machine's
  document; code that skips ids containing `/` (`hostpane.js` `inStep`,
  `main.js` `guessPlace`) handles both forms instead.
- Account routing is done by the configured agent command (`acc`/`aco`
  exec the provider with `CLAUDE_CONFIG_DIR`/`CODEX_HOME` set, print nothing
  to stdout and need no TTY), not by herdr-chat choosing a home.
- Wire protocol additions (image upload, image fetch, relay framing and
  SYNC handshake) change host, relay and mod together, with
  `docs/dev/protocol.md` updated.

## Testing decisions

- Host end-to-end tests (`npm test`, fake Pi/Claude/Codex) — prove: a remote
  host listening on a 0600 Unix socket and recording it in the registry; no
  network listener for a remote host; image upload and fetch ops; session discovery from an agent
  process's environment home and `sessions/<pid>.json`; `--host-only`
  install. Prior art: `tests/host/` scenarios, `tests/host/FAILURE-MODES.md`.
- Relay/bridge end-to-end tests with two private hc sessions linked by
  `hc machine add --via 'sh -c'` (as in the relay spike, scratch XDG dirs):
  byte integrity (all byte values, unicode, base64); long lines (4097 B,
  1 MiB, 8 MiB); the ack window under a stalled reader; a machine-link drop
  and a bad frame forcing a resync that recovers by snapshot; the host and
  agent staying alive when the relay is killed, and a new relay reconnecting.
- `npx tsc --noEmit -p .` on every change.
- Mod logic that can run outside the app (machine config resolution, remote
  id handling, document edits for a remote tab) — unit tests next to the
  existing mod tests.
- Manual Mac proof in an isolated Herdr app home (`HERDR_APP_HOME` separate
  from `~/.config/herdr-app`), driven by a script the person runs on the Mac:
  open a chat in a lab space, stream a reply, close it, reopen and reconnect.
  This is the spike that proves the Mac→lab link before the rest is built,
  including how the relay finds the Mac app's core socket.

## Failure, compatibility, and rollout

- Local spaces: no behavior change; the host listens on `127.0.0.1` and the
  token goes in `hello`.
- Machine unreachable or host missing on it: the chat shows the error and a
  retry, never an endless "Starting…".
- Mac and remote host versions differ: a remote chat shows the version
  mismatch without offering a restart (restarting would rerun the remote
  machine's own install). Updating a remote host is a separate ticket.
- Relay dies or the app closes: the host and agent keep running on the
  remote machine; the mod restarts the relay and the chat reconnects by
  snapshot.
- Exposure (accepted and documented): the bridge's bytes land in the remote
  core's saved screen and history, readable with `hc read`, so trust equals
  access to that core, the same exposure the agent's TUI already has. The
  host's socket is 0600 and no network port is opened on the remote machine.
  The token guards only the Mac relay on `127.0.0.1`. Never bind `0.0.0.0`
  or a LAN address; never use Tailscale Funnel.
- Rollout: PRs to the fork per ticket; upstream PRs piece by piece, each with
  its text approved first. The real Mac install (keys preset, `chezmoi re-add`
  of `layouts/iuri.json` and `keys.json`) happens only after the Mac proof
  passes.

## Out of scope

- A host on the Mac proxying a remote machine.
- Remote spaces on Windows machines.
- Changes to herdr-core or the Herdr app.

## Further notes

- Lab facts: `hc` 0.1.21, Node 24, `acc`/`aco` in `~/.local/bin`; agent
  homes `~/.claude-main`, `~/.claude-alt` (shared history), `~/.claude-truckstop`
  (isolated history), plain `~/.claude` (separate, stale); Codex homes share
  `history/codex/sessions`. Codex process → rollout mapping was not verified
  live.
- herdr-nvim's remote work has the same session-home problem and today
  hardcodes `~/.claude`; the environment-based discovery above is the method
  to share with it.
- Herdr API facts were read from herdr-app v0.1.16 / herdr-core v0.1.21
  source; the Mac app's installed version was not confirmed.
- Relay spike (lab, hc 0.1.21): the remote leg was two sessions on one box
  linked by `--via 'sh -c'`, so no real network latency was measured. Not
  tested: a slow-reading bridge (inbound backpressure), `hc send`/`hc keys`
  racing the relay's input, CPR and OSC 7501 replies.
- Unverified: how the relay finds the Mac app's core socket (session name,
  `HC_SOCKET`, app-bundled hc), and the Mac core's version; the Mac proof
  checks both.
