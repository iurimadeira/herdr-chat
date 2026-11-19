#!/usr/bin/env bash
# The manual proof of a chat in a remote space (issue #6), run on the Mac:
# a private Herdr app and core (their own HERDR_APP_HOME, XDG dirs and
# HC_SESSION, never ~/.config/herdr-app), this checkout's mods installed into
# it, the remote machine added to that core, and machines.<name> written to
# the private settings. Then you open a space on that machine and start a chat:
# its host runs there (serve --socket-only), and the chat reaches it through the
# relay this Mac starts (127.0.0.1 only) over herdr-core's machine link.
#
#   scripts/mac-proof.sh --checkout /abs/herdr-chat/on/the/machine
#                        [--machine lab] [--ssh lab] [--base DIR]
#
# Before: the machine has this branch checked out at --checkout with `npm ci`
# run, and node and hc on its login shell's PATH (asked over ssh; set
# NODE_PATH_REMOTE, HC_REMOTE to override; CLAUDE_REMOTE, CODEX_REMOTE set the
# agent commands there, else acc and aco when found, else the agents' defaults).
# The Mac's hc and the machine's should be the same version (hc machine add asks
# otherwise). Nothing is installed on the Mac outside --base.
# Stop: quit the private app, then `HC_SESSION=<printed> hc server stop`.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MACHINE=lab SSH_HOST=lab CHECKOUT="" BASE=""
die() { printf 'mac-proof: %s\n' "$*" >&2; exit 1; }
say() { printf 'mac-proof: %s\n' "$*"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --checkout) CHECKOUT=$2; shift ;;
    --machine) MACHINE=$2; shift ;;
    --ssh) SSH_HOST=$2; shift ;;
    --base) BASE=$2; shift ;;
    -h|--help) awk 'NR > 1 && /^set -e/ { exit } NR > 1' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
[ -n "$CHECKOUT" ] || die "--checkout is required (--help)"
case "$CHECKOUT" in /*) ;; *) die "--checkout must be absolute" ;; esac

# A command's path on the machine; empty when its PATH has none. ssh's own failure (255) stops here.
remote_which() {
  local out rc=0
  out=$(ssh "$SSH_HOST" -- zsh -lc "'command -v $1'") || rc=$?
  [ "$rc" -ne 255 ] || die "ssh $SSH_HOST failed (exit 255)"
  [ "$rc" -eq 0 ] || return 0
  printf '%s\n' "$out" | tail -1
}
LAB_NODE=${NODE_PATH_REMOTE:-$(remote_which node)}
LAB_HC=${HC_REMOTE:-$(remote_which hc)}
LAB_ACC=${CLAUDE_REMOTE:-$(remote_which acc)}
LAB_ACO=${CODEX_REMOTE:-$(remote_which aco)}
[ -n "$LAB_NODE" ] || die "no node on $SSH_HOST (set NODE_PATH_REMOTE)"
[ -n "$LAB_HC" ] || die "no hc on $SSH_HOST (set HC_REMOTE)"
ssh "$SSH_HOST" -- test -x "$CHECKOUT/bin/herdr-chat-host" -a -d "$CHECKOUT/node_modules" ||
  die "$SSH_HOST:$CHECKOUT has no bin/herdr-chat-host or node_modules (check out the branch there and run npm ci)"

# --- the private instance (as tests/e2e/lib.sh makes it) ----------------------------
BASE="${BASE:-$(mktemp -d /tmp/herdr-chat-proof.XXXX)}"
mkdir -p "$BASE"
BASE="$(cd "$BASE" && pwd -P)"
for v in $(env | grep -oE '^(HERDR_[A-Z_]+|HC_[A-Z_]+)=' | tr -d =); do unset "$v"; done
export HERDR_APP_HOME="$BASE/home" XDG_STATE_HOME="$BASE/state" XDG_CONFIG_HOME="$BASE/config" XDG_DATA_HOME="$BASE/data"
export HC_SESSION="proof$$" HERDR_TELEMETRY=0 DO_NOT_TRACK=1
export HERDR_RELEASES_URL=http://127.0.0.1:9 # never update the installed app or core
export PI_CODING_AGENT_DIR="$BASE/pi"        # install.sh puts Pi's lock extension there, not in ~/.pi
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
mkdir -p "$HERDR_APP_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
real_home="$(cd "$HOME" && pwd -P)/.config/herdr-app"
case "$(cd "$HERDR_APP_HOME" && pwd -P)/" in
  "$real_home"/*) die "refusing: the app home is in your own ~/.config/herdr-app" ;;
esac
echo '{"frame.welcomed": true, "layout": "main"}' >"$HERDR_APP_HOME/shared.json"

APP=""
for c in "$(command -v herdr-app 2>/dev/null || true)" /Applications/*.app/Contents/MacOS/Herdr; do
  if [ -x "$c" ] && "$c" --version 2>/dev/null | grep -q '^herdr-app '; then APP=$c; break; fi
done
[ -n "$APP" ] || die "no herdr-app"

say "private app home $HERDR_APP_HOME, core session $HC_SESSION"
hc server start || die "hc server start failed (session $HC_SESSION)"
# The app writes its shipped mods at start; install.sh extends them, so start it first.
"$APP" >"$BASE/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 60); do "$APP" status >/dev/null 2>&1 && break; sleep 0.5; done
"$APP" status >/dev/null 2>&1 || die "the private app didn't answer (see $BASE/app.log)"

(cd "$REPO" && ./install.sh) >"$BASE/install.log" 2>&1 || die "install failed (see $BASE/install.log)"
hc machine add "$SSH_HOST" --name "$MACHINE" --session "proof$$" || die "hc machine add $SSH_HOST failed"

STATE="$HERDR_APP_HOME/data/herdr-chat"
mkdir -p "$STATE"
python3 - "$STATE/settings.json" "$MACHINE" "$CHECKOUT/bin/herdr-chat-host" "$LAB_NODE" "$LAB_HC" "$LAB_ACC" "$LAB_ACO" <<'EOF'
import json, os, sys
path, name, host, node, hc, acc, aco = sys.argv[1:]
s = json.load(open(path)) if os.path.exists(path) else {}
agents = {k: v for k, v in (("claude", acc), ("codex", aco)) if v}
s.setdefault("machines", {})[name] = {"host": host, "node": node, "hc": hc, "agents": agents}
json.dump(s, open(path, "w"), indent=1)
EOF

cat <<EOF
mac-proof: ready (app pid $APP_PID). In the private Herdr window:
  1. open a space on machine "$MACHINE" (a folder there),
  2. start a Claude chat in it (the new-chat picker, Claude Code),
  3. send a message: the reply streams in this window, the agent runs on $MACHINE.
Check: $STATE/relays/$MACHINE.json names a relay on 127.0.0.1 (its log beside it);
  on $SSH_HOST, HC_SESSION=proof$$ hc ls --label herdr-chat.role=host shows the host.
Logs: $BASE/app.log, $BASE/install.log; the mod's debug: $STATE/debug.
Stop: quit the private app, then HC_SESSION=$HC_SESSION hc server stop
     (and on $SSH_HOST: HC_SESSION=proof$$ hc server stop).
EOF
