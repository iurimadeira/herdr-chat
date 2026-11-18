#!/usr/bin/env bash
# Install herdr-chat's host on a machine without the Herdr app: the machine of a
# remote space, where the Mac's chat starts the host through herdr-core.
# The root install.sh runs this for --host-only: from a clone (./install.sh --host-only),
# or from a release it downloaded and unpacked.
#
#   ./install.sh --host-only               the host's dependencies and the hc chat templates
#   ./install.sh --host-only --uninstall   takes the templates out
#
# Options:
#   --no-subagents     no hc templates (--no-templates: the same)
#
# It writes nothing in a Herdr app home (no mods, layout, keys or settings) and
# no sub-agents note in an agent's instruction file. What it does:
#   - a clone: the host's runtime dependencies (npm install --omit=dev) when missing;
#     a release has them bundled
#   - in herdr-core's templates ($XDG_CONFIG_HOME, else ~/.config, /herdr-core/templates):
#     pi-chat.md, claude-chat.md, codex-chat.md (each agent found on PATH), only over
#     files it wrote
#   - prints the host command's path: the machine's "host" in the Mac's
#     herdr-chat settings (machines.<name>.host)
set -euo pipefail

# ROOT: the tree to install from (a clone, or an unpacked release). LINK: the path
# the templates and the printed host name for it: for a release, the "current" link.
ROOT="${HERDR_CHAT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LINK="${HERDR_CHAT_LINK:-$ROOT}"
if [ -f "$ROOT/host/main.js" ]; then EXT=js; else EXT=ts; fi

say() { printf 'herdr-chat: %s\n' "$*"; }
die() { printf 'herdr-chat: %s\n' "$*" >&2; exit 1; }

UNINSTALL=0 SUBAGENTS=1
TPL_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core/templates"
TPL_MARK="installed-by: herdr-chat"
PROVIDERS="pi claude codex"
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --no-subagents|--no-templates) SUBAGENTS=0 ;;
    -h|--help) awk 'NR > 1 && /^set -e/ { exit } NR > 1' "$0"; exit 0 ;;
    *) die "unknown option $1 (with --host-only: --no-subagents, --uninstall)" ;;
  esac
  shift
done

if [ "$UNINSTALL" = 1 ]; then
  for p in $PROVIDERS; do
    f="$TPL_DIR/$p-chat.md"
    if [ -f "$f" ] && grep -qx "$TPL_MARK" "$f"; then rm -f "$f"; say "removed $f"; fi
  done
  say "uninstalled the host's templates (running chats keep running until closed)"
  exit 0
fi

# --- requirements ------------------------------------------------------------------
command -v hc >/dev/null || die "hc (herdr-core) not on PATH: the chat starts the host in a herdr-core terminal"
NODE="$(command -v node || true)"; [ -n "$NODE" ] || die "node not on PATH"
NODE_MIN=$(sed -n 's/.*"node": *">= *\([0-9][0-9]*\).*/\1/p' "$ROOT/package.json" | head -1)
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= +process.argv[1] ? 0 : 1)' "${NODE_MIN:-24}" ||
  die "node >= ${NODE_MIN:-24} needed$([ "$EXT" = ts ] && echo " to install from a clone (it runs the TypeScript)"), have $("$NODE" --version) ($NODE)"
VERSION=$("$NODE" -e 'process.stdout.write(require(process.argv[1]).version)' "$ROOT/package.json")

# --- the host's runtime dependencies (package.json "dependencies") ------------------
if [ "$EXT" = ts ] && "$NODE" -e 'const d=Object.keys(require(process.argv[1]).dependencies||{}); process.exit(d.length?0:1)' "$ROOT/package.json"; then
  if ! (cd "$ROOT" && "$NODE" -e 'const fs=require("fs"); for (const d of Object.keys(require("./package.json").dependencies)) if (!fs.existsSync("node_modules/"+d+"/package.json")) process.exit(1)') 2>/dev/null; then
    say "installing the host's dependencies (npm install --omit=dev)"
    (cd "$ROOT" && npm install --omit=dev --no-audit --no-fund --loglevel=error) || die "npm install failed"
  fi
fi
HOST="$LINK/bin/herdr-chat-host"
"$HOST" build >/dev/null || die "the host doesn't run ($HOST build)"

# --- hc templates: sub-agents that open as chats -----------------------------------
# The same templates install/app.sh writes.
S_TEMPLATES="none (--no-subagents)"
if [ "$SUBAGENTS" = 1 ]; then
  wrote=()
  for p in $PROVIDERS; do
    command -v "$p" >/dev/null || continue
    mkdir -p "$TPL_DIR"
    f="$TPL_DIR/$p-chat.md"
    if [ -f "$f" ] && ! grep -qx "$TPL_MARK" "$f"; then say "$f exists and isn't herdr-chat's; not touching it"; continue; fi
    wrote+=("$p-chat")
    case "$p" in pi) name="Pi" ;; claude) name="Claude Code" ;; codex) name="Codex" ;; esac
    cat >"$f" <<TPL
---
description: $name as a sub-agent the person can open as a chat in Herdr (its row in the agents list). Give it the task in hc run.
command: '$LINK/bin/herdr-chat-subagent' --provider $p
$TPL_MARK
---
You are a sub-agent: another agent started you with hc run and gave you the task below. Stay within it. The person may also write to you here.
TPL
  done
  S_TEMPLATES="${wrote[*]:-none (no pi, claude or codex on PATH)}${wrote[*]:+ in $TPL_DIR}"
fi

say "done: herdr-chat $VERSION's host, no Herdr app home touched"
say "templates: $S_TEMPLATES"
say "host: $HOST"
say "on the Mac, this machine's \"host\" in herdr-chat's settings (machines.<name>.host) is that path"
