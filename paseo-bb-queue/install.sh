#!/usr/bin/env bash
# Install or update BB Server Queue for the local Paseo daemon.
#
#   curl -fsSL https://raw.githubusercontent.com/mjscjj/paseo-bb-queue/master/install.sh | bash
#
# Environment overrides:
#   BB_QUEUE_REPO     Git URL to install from (default: the GitHub repo)
#   BB_QUEUE_REF      Branch or tag (default: master)
#   BB_QUEUE_DIR      Install directory (default: ~/.local/lib/paseo-bb-queue)
#   BB_QUEUE_RESTART  idle (default): restart the daemon once no agent is running
#                     now: restart immediately    no: never restart, print what to do
#   PASEO_HOME        Paseo home (default: ~/.paseo)
set -euo pipefail

REPO_URL="${BB_QUEUE_REPO:-https://github.com/mjscjj/paseo-bb-queue.git}"
REF="${BB_QUEUE_REF:-master}"
DIR="${BB_QUEUE_DIR:-$HOME/.local/lib/paseo-bb-queue}"
RESTART="${BB_QUEUE_RESTART:-idle}"
export PASEO_HOME="${PASEO_HOME:-$HOME/.paseo}"
PLUGIN_ID="bb-queue"
DROPIN_DIR="$HOME/.config/systemd/user/paseo.service.d"
DROPIN_FILE="$DROPIN_DIR/bb-queue.conf"

# Always target the selected home explicitly; some paseo subcommands ignore PASEO_HOME.
pz() { paseo --home "$PASEO_HOME" "$@"; }
log() { printf '[bb-queue] %s\n' "$*"; }
die() { printf '[bb-queue] ERROR: %s\n' "$*" >&2; exit 1; }

# Keep our own shim out of every command this script runs.
unset NODE_OPTIONS || true

# ---------------------------------------------------------------- preflight
command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "node is required (>= 20.6)"
command -v paseo >/dev/null || die "paseo CLI not found. Install Paseo first: https://paseo.sh/download"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=6)?0:1)' \
  || die "node >= 20.6 is required (found $(node --version))"

json_field() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=$1; console.log(v===undefined||v===null?'':String(v))"; }

STATUS_JSON="$(pz status --json 2>/dev/null)" || die "cannot read 'paseo status'. Start the daemon first: paseo daemon start"
[ "$(printf '%s' "$STATUS_JSON" | json_field 'd.localDaemon')" = "running" ] \
  || die "the local Paseo daemon is not running. Start it first: paseo daemon start"
DAEMON_VERSION="$(printf '%s' "$STATUS_JSON" | json_field 'd.daemonVersion')"
DESKTOP_MANAGED="$(printf '%s' "$STATUS_JSON" | json_field 'd.desktopManaged')"
WORKER_PID="$(printf '%s' "$STATUS_JSON" | json_field 'd.workerPid')"
log "Paseo daemon $DAEMON_VERSION is running (home: $PASEO_HOME)"

# ---------------------------------------------------------------- 1. code
shim_hash() { cat "$DIR"/shim/*.mjs 2>/dev/null | node -e 'const c=require("crypto").createHash("sha256"); process.stdin.on("data",d=>c.update(d)).on("end",()=>console.log(c.digest("hex")))'; }
OLD_SHIM_HASH="$(shim_hash || true)"

if [ -d "$DIR/.git" ]; then
  log "Updating $DIR ($REF)"
  git -C "$DIR" fetch --quiet origin "$REF"
  git -C "$DIR" checkout --quiet "$REF" 2>/dev/null || git -C "$DIR" checkout --quiet -B "$REF" "origin/$REF"
  git -C "$DIR" merge --quiet --ff-only "origin/$REF" || die "local changes in $DIR block the update; commit or discard them first"
else
  if [ -e "$DIR" ]; then
    BACKUP="$DIR.bak-$(date +%Y%m%d%H%M%S)"
    log "Moving existing non-git $DIR to $BACKUP"
    mv "$DIR" "$BACKUP"
  fi
  log "Cloning $REPO_URL ($REF) into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --branch "$REF" "$REPO_URL" "$DIR"
fi
NEW_SHIM_HASH="$(shim_hash)"
log "Code at $(git -C "$DIR" rev-parse --short HEAD)"

# ---------------------------------------------------------------- 2. plugin
PLUGIN_DIR="$DIR/plugin"
CURRENT_SOURCE="$(pz plugin ls --json 2>/dev/null | json_field "(Array.isArray(d)?d:[]).find(p=>p.id==='$PLUGIN_ID')?.path")" || CURRENT_SOURCE=""
if [ "$CURRENT_SOURCE" = "$PLUGIN_DIR" ]; then
  log "Reloading plugin $PLUGIN_ID"
  pz plugin reload "$PLUGIN_ID" >/dev/null
else
  if [ -n "$CURRENT_SOURCE" ]; then
    log "Replacing plugin $PLUGIN_ID installed from $CURRENT_SOURCE"
    pz plugin remove "$PLUGIN_ID" >/dev/null
  fi
  log "Installing plugin from $PLUGIN_DIR"
  pz plugin install "$PLUGIN_DIR" >/dev/null
fi

# ---------------------------------------------------------------- 3. daemon shim
SHIM_IMPORT="--import $DIR/shim/register.mjs"

shim_active() {
  [ -n "$WORKER_PID" ] || return 1
  if [ -r "/proc/$WORKER_PID/environ" ]; then
    tr '\0' '\n' < "/proc/$WORKER_PID/environ" | grep -qF "$DIR/shim/register.mjs"
  else
    ps eww -o command= -p "$WORKER_PID" 2>/dev/null | grep -qF "$DIR/shim/register.mjs"
  fi
}

MODE="manual"
if [ "$DESKTOP_MANAGED" = "true" ]; then
  MODE="desktop"
elif [ -n "$WORKER_PID" ] && grep -q '/paseo\.service$' "/proc/$WORKER_PID/cgroup" 2>/dev/null; then
  # Only when this very daemon runs under the systemd user unit paseo.service.
  MODE="systemd"
fi

NEEDS_RESTART="no"
case "$MODE" in
  systemd)
    WANT="$(printf '[Service]\nEnvironment="NODE_OPTIONS=%s"\n' "$SHIM_IMPORT")"
    if [ "$(cat "$DROPIN_FILE" 2>/dev/null)" != "$WANT" ]; then
      log "Writing $DROPIN_FILE"
      mkdir -p "$DROPIN_DIR"
      printf '%s\n' "$WANT" > "$DROPIN_FILE"
      systemctl --user daemon-reload
    fi
    ;;
  desktop)
    log "This daemon is managed by the Paseo desktop app; the shim cannot be attached automatically."
    log "Installed in panel mode: the queue panel and '/bb <task>' work; plain 'bb ' typing only queues while the agent is busy (Default send = Queue)."
    log "For full 'bb ' support, run the daemon from the CLI instead: NODE_OPTIONS=\"$SHIM_IMPORT\" paseo daemon start"
    ;;
esac

if [ "$MODE" != "desktop" ]; then
  if ! shim_active || [ "$OLD_SHIM_HASH" != "$NEW_SHIM_HASH" ]; then
    NEEDS_RESTART="yes"
  fi
fi

# ---------------------------------------------------------------- 4. restart
RESTARTER="$DIR/scripts/restart-when-idle.sh"
if [ "$NEEDS_RESTART" = "yes" ]; then
  case "$RESTART" in
    no)
      log "The daemon must restart to load the shim. Run when convenient:"
      if [ "$MODE" = "systemd" ]; then log "  systemctl --user restart paseo.service"
      else log "  paseo daemon stop && NODE_OPTIONS=\"$SHIM_IMPORT\" paseo daemon start"; fi
      ;;
    now|idle)
      WAIT_FLAG=$([ "$RESTART" = "now" ] && echo "--now" || echo "--when-idle")
      RESTART_LOG="$PASEO_HOME/plugin-data/$PLUGIN_ID/restart.log"
      mkdir -p "$(dirname "$RESTART_LOG")"
      # Detach from the daemon's process tree: if an agent runs this script, the restart must outlive it.
      if [ "$MODE" = "systemd" ] && command -v systemd-run >/dev/null; then
        systemd-run --user --quiet --collect --unit="paseo-bb-queue-restart-$(date +%s)" \
          --setenv=PASEO_HOME="$PASEO_HOME" --setenv=PATH="$PATH" \
          bash "$RESTARTER" "$WAIT_FLAG" systemd "$SHIM_IMPORT" >/dev/null
      else
        nohup setsid bash "$RESTARTER" "$WAIT_FLAG" "$MODE" "$SHIM_IMPORT" >"$RESTART_LOG" 2>&1 < /dev/null &
      fi
      if [ "$RESTART" = "now" ]; then
        log "Daemon restart triggered."
      else
        log "Daemon restart scheduled: it happens as soon as no agent is running (up to 30 min)."
        log "If this script runs inside a Paseo agent, finish the turn now so the restart can happen."
      fi
      ;;
    *) die "unknown BB_QUEUE_RESTART=$RESTART (use idle, now or no)" ;;
  esac
else
  log "Daemon already runs the current shim; no restart needed."
fi

log "Done. After the daemon is back, verify with: node $DIR/scripts/verify-live.mjs"
