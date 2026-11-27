#!/usr/bin/env bash
# Remove BB Server Queue from the local Paseo daemon.
#
#   bash ~/.local/lib/paseo-bb-queue/uninstall.sh
#
# Queued messages in $PASEO_HOME/plugin-data/bb-queue are kept; delete that folder to drop them.
# BB_QUEUE_RESTART=idle (default) | now | no, same as install.sh.
set -euo pipefail

DIR="${BB_QUEUE_DIR:-$HOME/.local/lib/paseo-bb-queue}"
RESTART="${BB_QUEUE_RESTART:-idle}"
export PASEO_HOME="${PASEO_HOME:-$HOME/.paseo}"
DROPIN_FILE="$HOME/.config/systemd/user/paseo.service.d/bb-queue.conf"
unset NODE_OPTIONS || true
pz() { paseo --home "$PASEO_HOME" "$@"; }

log() { printf '[bb-queue] %s\n' "$*"; }

if pz plugin ls bb-queue >/dev/null 2>&1; then
  log "Removing plugin bb-queue"
  pz plugin remove bb-queue >/dev/null
fi

MODE="manual"
if [ -f "$DROPIN_FILE" ]; then
  log "Removing $DROPIN_FILE"
  rm -f "$DROPIN_FILE"
  systemctl --user daemon-reload
  MODE="systemd"
fi

# The shim is still loaded in the running daemon; restart it before deleting the code.
case "$RESTART" in
  no)
    log "Restart the Paseo daemon, then delete $DIR"
    ;;
  now|idle)
    WAIT_FLAG=$([ "$RESTART" = "now" ] && echo "--now" || echo "--when-idle")
    RUNNER="$(mktemp "${TMPDIR:-/tmp}/bb-queue-uninstall.XXXXXX")"
    cp "$DIR/scripts/restart-when-idle.sh" "$RUNNER"
    CLEANUP="bash '$RUNNER' $WAIT_FLAG $MODE '' && rm -rf '$DIR' '$RUNNER'"
    if [ "$MODE" = "systemd" ] && command -v systemd-run >/dev/null; then
      systemd-run --user --quiet --collect --unit="paseo-bb-queue-uninstall-$(date +%s)" \
        --setenv=PASEO_HOME="$PASEO_HOME" --setenv=PATH="$PATH" bash -c "$CLEANUP" >/dev/null
    else
      nohup setsid bash -c "$CLEANUP" >/dev/null 2>&1 < /dev/null &
    fi
    log "Daemon restart scheduled; $DIR is deleted after it."
    ;;
esac
