#!/usr/bin/env bash
# Install herdr-chat's host on a machine without the Herdr app: the machine of a
# remote space, where the Mac's chat starts the host through herdr-core.
# The root install.sh runs this for --host-only: from a clone (./install.sh --host-only),
# or from a release it downloaded and unpacked.
#
#   ./install.sh --host-only               the host, ready to run; prints the host command
#   ./install.sh --host-only --uninstall   nothing of its own to undo (a release's
#                                          folder is removed by install.sh)
#
# It writes nothing outside the tree it installs: no Herdr app home (mods,
# layout, keys, settings), no hc chat templates, no sub-agents notes. What it does:
#   - a clone: the host's runtime dependencies (npm install --omit=dev) when missing;
#     a release has them bundled
#   - checks that the host command runs, and prints it: on the Mac, that path is
#     this machine's "host" in herdr-chat's settings (machines.<name>.host),
#     since the host command isn't put on PATH
set -euo pipefail

# ROOT: the tree to install from (a clone, or an unpacked release). LINK: the path
# the printed host command names it by: for a release, the "current" link.
ROOT="${HERDR_CHAT_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LINK="${HERDR_CHAT_LINK:-$ROOT}"
if [ -f "$ROOT/host/main.js" ]; then EXT=js; else EXT=ts; fi

say() { printf 'herdr-chat: %s\n' "$*"; }
die() { printf 'herdr-chat: %s\n' "$*" >&2; exit 1; }

UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    -h|--help) awk 'NR > 1 && /^set -e/ { exit } NR > 1' "$0"; exit 0 ;;
    *) die "unknown option $1 (--host-only takes only --uninstall)" ;;
  esac
  shift
done

if [ "$UNINSTALL" = 1 ]; then
  say "the host-only install wrote nothing outside $LINK: nothing else to remove"
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
"$HOST" build >/dev/null || die "the host command doesn't run ($HOST build)"

say "done: herdr-chat $VERSION's host, no Herdr app home and no templates touched"
say "host command: $HOST"
say "it isn't on PATH: on the Mac, set this machine's \"host\" in herdr-chat's settings (machines.<name>.host) to it"
