# Decisions

Append-only. Rules live in `CONTEXT.md`; this log records why.

## 2026-11-18 — Chats in remote spaces (docs/specs/remote-spaces.md)

- **Host on the space's machine.** Rejected: a host on the Mac proxying every
  spawn and file read to the remote machine; the host does ~11k lines of
  synchronous local file, git and process work.
- **Direct WebSocket from the mod to the remote host.** Rejected: an `ssh -L`
  tunnel kept as a second local terminal (extra process and port
  supervision); streaming through `exec`/`hc` (they return only at exit,
  600 s cap); herdr-core `terminal.attach` (not reachable from mods).
- **Remote host listens only on the tailnet address, token mandatory.**
  Rejected: `0.0.0.0` and LAN addresses, which expose the port beyond the
  tailnet; Tailscale Funnel. WireGuard encrypts the link, so plain `ws://` on
  the tailnet address is acceptable.
- **Account routing by the configured agent command (`acc`/`aco`).**
  Rejected: herdr-chat picking an agent home itself, which would bypass the
  router's failover and folder pins.

## 2026-11-18 — Continuing a TUI inherits the session's agent home (#9)

- **Continuing a TUI inherits the session's agent home; herdr-chat still never
  chooses a home.** Continue as chat finds the session in the agent home the
  TUI's process uses (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`, else the default),
  and the chat's agent runs in that same home (`serve --agent-home`). This
  keeps the choice made by whatever launched the TUI (e.g. the router), so it
  is consistent with "Account routing by the configured agent command": the
  home is never picked by herdr-chat, and a configured `acc`/`aco` command
  still has the last word. Rejected: resuming in the host's own home (the
  session, its registry and its login are in another home, so the resume
  fails or runs under another account); herdr-chat routing the account itself.
