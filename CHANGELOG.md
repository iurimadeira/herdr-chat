# Changelog

## [0.6.0](https://github.com/iurimadeira/herdr-chat/compare/v0.5.0...v0.6.0) (2026-11-19)


### Features

* **host:** continue as chat finds the session in the agent home the TUI uses ([d226116](https://github.com/iurimadeira/herdr-chat/commit/d2261165f0bb962ddbb19373ed3468abf057a0ca)), closes [#9](https://github.com/iurimadeira/herdr-chat/issues/9)
* **host:** relay and bridge carry a remote chat over herdr-core's machine link ([0fa0076](https://github.com/iurimadeira/herdr-chat/commit/0fa007631d38f35e63c85da41b4031b08e4830dd)), closes [#19](https://github.com/iurimadeira/herdr-chat/issues/19)
* **host:** serve the chat on a 0600 Unix socket beside its registry entry ([3e9b704](https://github.com/iurimadeira/herdr-chat/commit/3e9b7040ce159a09b08824d79d430e0a3888c14a)), closes [#19](https://github.com/iurimadeira/herdr-chat/issues/19)
* **install:** --host-only installs the host and chat templates on a machine without the Herdr app ([b6676d1](https://github.com/iurimadeira/herdr-chat/commit/b6676d1767f6d3f909bfe3e6221ad0a47fde3c77)), closes [#14](https://github.com/iurimadeira/herdr-chat/issues/14)
* **install:** install.sh --host-only installs the chat host without the Herdr app ([7b3227c](https://github.com/iurimadeira/herdr-chat/commit/7b3227caf34a975747da59414a6a6203e2408ec0))
* remote chats ride herdr-core's machine link through a relay and a bridge ([b65ede5](https://github.com/iurimadeira/herdr-chat/commit/b65ede53cd8cf2cbf496b02e78027c8e8fb55725))


### Bug Fixes

* **chat:** a continued chat's agent home reaches /tui, /login, new chats and restores ([c083b3b](https://github.com/iurimadeira/herdr-chat/commit/c083b3ba33c1711b3c48ec1078641e2b9d3841f0)), closes [#9](https://github.com/iurimadeira/herdr-chat/issues/9)
* continue as chat uses the agent home the TUI runs in ([3b33027](https://github.com/iurimadeira/herdr-chat/commit/3b330276a84fddc49ab0d5ef2b05e9484867fc6a))
* **host:** 4003 only for a client that never gets in; no host is 4004, a failed registry read 1011 ([c42b993](https://github.com/iurimadeira/herdr-chat/commit/c42b993072a319a8e7b98dbb8af6925a956526ca)), closes [#19](https://github.com/iurimadeira/herdr-chat/issues/19)
* **host:** a relay connection frees its setup slot when it ends ([#23](https://github.com/iurimadeira/herdr-chat/issues/23)) ([efd9ec8](https://github.com/iurimadeira/herdr-chat/commit/efd9ec89f4253d1c0e410b6b497fb5d725f6ba5e))
* **host:** a slow link connects; a bridge's READY and NOHOST outlast a late attach ([#23](https://github.com/iurimadeira/herdr-chat/issues/23)) ([0e7add6](https://github.com/iurimadeira/herdr-chat/commit/0e7add626f90cd8dfa1072b7f935298934714264))
* **host:** an environment ps doesn't show leaves the host's agent home on macOS ([fb0fa73](https://github.com/iurimadeira/herdr-chat/commit/fb0fa73cdd522f8cf183594834afb47c4a8c5683)), closes [#9](https://github.com/iurimadeira/herdr-chat/issues/9)
* **host:** an exiting bridge queues nothing new, so its PTY drain ends ([0694278](https://github.com/iurimadeira/herdr-chat/commit/0694278bbe94fbb28a41254d05d03de95ac00f81)), closes [#19](https://github.com/iurimadeira/herdr-chat/issues/19)
* **host:** an over-long socket path fails with a clear error ([#23](https://github.com/iurimadeira/herdr-chat/issues/23)) ([63d3300](https://github.com/iurimadeira/herdr-chat/commit/63d33009f10d065f7cde7ebbf7ac19606029b01b))
* **host:** continue as chat runs the chat's agent in the TUI's agent home ([f967d11](https://github.com/iurimadeira/herdr-chat/commit/f967d11a4550c7c5b03910c79588f6dee339eb26)), closes [#9](https://github.com/iurimadeira/herdr-chat/issues/9)
* **host:** one relay per machine under races and reused pids ([#23](https://github.com/iurimadeira/herdr-chat/issues/23)) ([ad6c1ad](https://github.com/iurimadeira/herdr-chat/commit/ad6c1adf744dfa2709fe1f1dd0096f3ec56c43ff))
* **host:** relay lock fails closed on unknown start times, withdraws a swept claim ([#23](https://github.com/iurimadeira/herdr-chat/issues/23)) ([002d2a3](https://github.com/iurimadeira/herdr-chat/commit/002d2a337f695455c6c4aca8fda0c7e8bfd74a7d))
* **host:** review of the relay and bridge: socket-only remote hosts, no leaked bridges, refusals that end ([6e2aed2](https://github.com/iurimadeira/herdr-chat/commit/6e2aed23667c51b4635b8a594287fa86ebab24aa))
* **host:** review remediation for relay robustness ([#23](https://github.com/iurimadeira/herdr-chat/issues/23)) ([9ea19f1](https://github.com/iurimadeira/herdr-chat/commit/9ea19f11899fd8e8c0f7c021ce1ed043732c59dd))
* **host:** the core client forgets ended streams and bounds attach ([#23](https://github.com/iurimadeira/herdr-chat/issues/23)) ([515a0bf](https://github.com/iurimadeira/herdr-chat/commit/515a0bf0c27f05aa6e5b6530de9de9ba0c870e54))
* **install:** --host-only writes no templates and refuses a release of the other target ([e04cbb6](https://github.com/iurimadeira/herdr-chat/commit/e04cbb64952f4f94b423633f1f50f581bd1460fc)), closes [#14](https://github.com/iurimadeira/herdr-chat/issues/14)
* relay and bridge survive slow links, stalled cores and racing starts ([3c60bab](https://github.com/iurimadeira/herdr-chat/commit/3c60babccffecdda9f846c64d950e6011ef0c216))

## [0.5.0](https://github.com/ChmaraX/herdr-chat/compare/v0.4.0...v0.5.0) (2026-11-17)


### Features

* **chat:** /resume lists every session, for every agent, with This folder / All folders ([#25](https://github.com/ChmaraX/herdr-chat/issues/25)) ([478786b](https://github.com/ChmaraX/herdr-chat/commit/478786be5264d7a37c09fb94f6a9225904c1a8a2))
* **chat:** the model picker has a tab per model provider, so two logins of one service are two tabs ([#26](https://github.com/ChmaraX/herdr-chat/issues/26)) ([e44a0ef](https://github.com/ChmaraX/herdr-chat/commit/e44a0ef900dd25315369fa4a45654141dbb053f9))

## [0.4.0](https://github.com/ChmaraX/herdr-chat/compare/v0.3.0...v0.4.0) (2026-11-15)


### Features

* **chat:** answer question cards from the keyboard (↑↓, Enter, Space) ([#22](https://github.com/ChmaraX/herdr-chat/issues/22)) ([ed6e88f](https://github.com/ChmaraX/herdr-chat/commit/ed6e88fa6673dfd25ffd67165129737881f40b21))
* **chat:** pasted and dropped images show as thumbnails in the composer ([#23](https://github.com/ChmaraX/herdr-chat/issues/23)) ([7d42f60](https://github.com/ChmaraX/herdr-chat/commit/7d42f60ceeba48afb69b42d4008905312276dd2d))
* **chat:** the agent's plan in a strip above the composer; Claude's task list feeds it ([#20](https://github.com/ChmaraX/herdr-chat/issues/20)) ([63e4d64](https://github.com/ChmaraX/herdr-chat/commit/63e4d64bb3c630b58d52c49b73fbbeebefa232d6))


### Bug Fixes

* **chat:** a sent image appears once, at its real aspect ratio, with no jump ([#24](https://github.com/ChmaraX/herdr-chat/issues/24)) ([a5810ee](https://github.com/ChmaraX/herdr-chat/commit/a5810ee9da2b5a283b18ec6b95e79bffaba6ade9))
* **chat:** the thinking timer shows once, not twice ([#21](https://github.com/ChmaraX/herdr-chat/issues/21)) ([ba0db69](https://github.com/ChmaraX/herdr-chat/commit/ba0db699906b13f5b6e336cfe9cd22d77c84d6dd))
* installs and closed chats no longer leak sockets until every chat sticks at "Starting…" ([#17](https://github.com/ChmaraX/herdr-chat/issues/17)) ([ae28634](https://github.com/ChmaraX/herdr-chat/commit/ae28634258ffa9b5b1749bf11ff134ca9cb25659))

## [0.3.0](https://github.com/ChmaraX/herdr-chat/compare/v0.2.0...v0.3.0) (2026-11-12)


### Features

* offer updates, and restart open chats on the new version ([#10](https://github.com/ChmaraX/herdr-chat/issues/10)) ([20205cc](https://github.com/ChmaraX/herdr-chat/commit/20205cc9a54d4739678020cfd1bf0706fa983338))
* the branch under the composer, a click copies it ([#9](https://github.com/ChmaraX/herdr-chat/issues/9)) ([fcdd5bc](https://github.com/ChmaraX/herdr-chat/commit/fcdd5bc1c5b81c35c4d0441d6c2f8cd368b7b610))


### Bug Fixes

* chat keys keep working after Herdr's keys.json is saved ([#7](https://github.com/ChmaraX/herdr-chat/issues/7)) ([de073ca](https://github.com/ChmaraX/herdr-chat/commit/de073ca1a930a5cee73b02e16e19b2b2ea4a336f))

## [0.2.0](https://github.com/ChmaraX/herdr-chat/compare/v0.1.3...v0.2.0) (2026-11-10)


### Features

* code blocks scroll sideways by their scrollbar and select text for ⌘C ([ebbd5e1](https://github.com/ChmaraX/herdr-chat/commit/ebbd5e149b8da8cffbde0ba8277afc025ba77995))


### Bug Fixes

* a chat in a folder that doesn't exist says so and stops retrying ([6fef487](https://github.com/ChmaraX/herdr-chat/commit/6fef4876e36fbd465ef524d8e9706851d9ea7cff))

## [0.1.3](https://github.com/ChmaraX/herdr-chat/compare/v0.1.2...v0.1.3) (2026-11-10)


### Bug Fixes

* a chat whose host became a shell starts a new host ([e7023a5](https://github.com/ChmaraX/herdr-chat/commit/e7023a5d697b1d1b0f9012fe725880d4ec372493))

## [0.1.2](https://github.com/ChmaraX/herdr-chat/compare/v0.1.1...v0.1.2) (2026-11-09)


### Bug Fixes

* a turn's last answer is in the terminal before it reports done ([eca95ee](https://github.com/ChmaraX/herdr-chat/commit/eca95eeeb9562abeec8fd3433352e411a87a3d58))
* the mods live in herdr-app/mods, so herdr.dev/mods lists herdr-chat ([f09eb19](https://github.com/ChmaraX/herdr-chat/commit/f09eb19bfe095c9c639e9e6393a6db47068f1eab))

## [0.1.1](https://github.com/ChmaraX/herdr-chat/compare/v0.1.0...v0.1.1) (2026-11-09)


### Bug Fixes

* works with Herdr 0.1.14: sub-agent rows open as chats again, and no newer-than-tested warning ([e5b1f2a](https://github.com/ChmaraX/herdr-chat/commit/e5b1f2a941e090a70ce5c87b4c5b54d0b8a5f609))

## 0.1.0 (2026-11-09)


### Features

* `/tui` opens the agent's own TUI on the same session; quit it and the chat continues. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* A chat is a normal Herdr agent: its status shows in the agents list and tab bar, other agents can `hc send` to it, and `hc read` shows a transcript. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* A click on a diagram or image opens it in a viewer with zoom and pan: ⌘ or Ctrl + scroll zooms around the pointer, `+` `-` `0` (fit) `1` (100 %) and the header's buttons too, from 10 % to 800 %; scroll or drag pans. Diagrams stay sharp when zoomed. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* A native chat in a Herdr tab for Pi, Claude Code and Codex. Each runs as the CLI you already use, with your login, settings, extensions, skills and sessions. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* an edit waiting for approval shows its diff in the approval card ([bfeaac4](https://github.com/ChmaraX/herdr-chat/commit/bfeaac47415cdd1cce1df82462860b2efaa21831))
* Continue as chat for Claude Code and Codex TUIs, and every agent's terminal-only commands in the / menu ([31657f8](https://github.com/ChmaraX/herdr-chat/commit/31657f88128b89332820a4e59a1f10d0c3c41836))
* Continue as chat: an idle Pi TUI, a sub-agent or a top-level one, becomes a chat on the same session. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Keys: ⌘I opens the "New chat…" launcher (⌘J A when ⌘I is taken). You can bind keys for a Pi, Claude Code or Codex chat, and for Continue as chat. The chat's own keys can be rebound. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Pickers for the model, thinking effort and permission mode, a `/` command menu, `@` file mentions, and pasted or dropped images. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* skill pills, terminal commands in a dialog, and /fork for Pi, Claude Code and Codex ([152de44](https://github.com/ChmaraX/herdr-chat/commit/152de4459cfdef7bedefd9faf85b90b315c7e52f))
* Streaming answers with highlighted code and Mermaid diagrams, tool cards with diffs, and approval cards: allow once, always, or deny with a reason. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Sub-agent chats: `hc run … pi-chat`, `claude-chat` or `codex-chat` starts a helper that opens as a chat from its row in the agents list or from the right-click menu. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* The install checks Herdr's version: it warns on a Herdr newer than the tested 0.1.13 and refuses one older than 0.1.12. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* The install leaves another plugin's agents list or right-click menu alone and says what that costs. `--take-agents-slot` and `--take-menu` take them anyway, and uninstall gives them back. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* The one-line install, `curl -fsSL https://raw.githubusercontent.com/ChmaraX/herdr-chat/main/install.sh | sh -s -- --app`, downloads the release, checks it against the release's SHA256SUMS and installs it: no clone, no npm install, Node 20 or later. It adds the mods, keys, layout edits, hc templates and a small Pi extension that keeps a TUI from writing a session a chat has open. Run it again to update. `--uninstall` puts back exactly what it changed. In a clone, `./install.sh` does the same from the clone. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))
* Two queues above the composer: Enter steers the current run, Alt+Enter queues a follow-up for after it. Click a queued message to edit it, move it to the other queue, or remove it. ([eab837c](https://github.com/ChmaraX/herdr-chat/commit/eab837c43580be88f170f5ac70e5a2b76ca8d722))


### Bug Fixes

* a startup dialog the agent resolved by its timeout closes when the agent starts ([d731b0b](https://github.com/ChmaraX/herdr-chat/commit/d731b0b57df195d6dd6f598d8625e57cfb62f0a6))
