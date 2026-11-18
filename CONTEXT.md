# herdr-chat

A native chat UI in the Herdr app for coding agents (Claude Code, Codex, Pi):
a mod draws the chat, a host process per chat drives the agent.

## Language

**Chat**: One conversation with one agent session, drawn by the `chat` mod and driven by one host.
_Avoid_: Session (that is the agent's file), tab

**Host**: The `herdr-chat-host` process of one chat, running in a hidden herdr-core terminal on the chat's machine.
_Avoid_: Server, daemon

**Machine**: A computer Herdr reaches through herdr-core; the Mac running the app is the local machine.
_Avoid_: Remote, box

**Remote space**: A Herdr space whose machine is not the local one; its layout lives in that machine's core document.

**Machine entry**: The settings for one machine in herdr-chat's settings on the local machine: address, host command, agent commands.

**Advertised address**: The address a host writes into its registry entry for the mod to connect to; for a remote host, the machine's tailnet address.
_Avoid_: Bind address (the address it listens on; for a remote host they are the same)

**Agent home**: The config directory an agent process uses (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`), read from that process's environment.

## Relationships

- A **Chat** has exactly one **Host**; the **Host** runs on the **Machine** of the chat's space.
- A **Remote space**'s chat is configured by exactly one **Machine entry**.

## Rules

- A remote host listens only on its machine's tailnet address, never on `0.0.0.0` or a LAN address, and every connection must carry the chat token.
- Local chats keep listening on `127.0.0.1`.
