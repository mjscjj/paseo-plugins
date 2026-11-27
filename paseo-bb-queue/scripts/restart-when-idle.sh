#!/usr/bin/env bash
# Restart the Paseo daemon so it loads the bb-queue shim.
#
#   restart-when-idle.sh [--when-idle|--now] [systemd|manual] [NODE_OPTIONS value]
#
# --when-idle waits (up to 30 min) until no Paseo agent is running, so no turn is cut off.
# systemd restarts paseo.service (the drop-in carries NODE_OPTIONS);
# manual stops the daemon and starts it again with NODE_OPTIONS set.
set -euo pipefail

WAIT="${1:---when-idle}"
MODE="${2:-systemd}"
SHIM_IMPORT="${3:-}"
unset NODE_OPTIONS || true
export PASEO_HOME="${PASEO_HOME:-$HOME/.paseo}"
pz() { paseo --home "$PASEO_HOME" "$@"; }

running_count() {
  pz ls --json 2>/dev/null | node -e '
    const raw = require("fs").readFileSync(0, "utf8").trim();
    if (!raw) { console.log("999"); process.exit(0); }
    const d = JSON.parse(raw);
    const list = Array.isArray(d) ? d : (d.agents || d.entries || []);
    console.log(String(list.filter(a => (a.status || a.agent?.status) === "running").length));
  ' 2>/dev/null || echo "999"
}

if [ "$WAIT" = "--when-idle" ]; then
  idle="no"
  for _ in $(seq 1 1800); do
    if [ "$(running_count)" = "0" ]; then idle="yes"; break; fi
    sleep 1
  done
  if [ "$idle" != "yes" ]; then
    echo "[bb-queue] Timed out waiting for running Paseo agents to become idle; restart the daemon manually" >&2
    exit 1
  fi
  sleep 1
fi

echo "[bb-queue] Restarting Paseo daemon ($MODE)"
if [ "$MODE" = "systemd" ]; then
  systemctl --user restart paseo.service
else
  pz daemon stop || true
  NODE_OPTIONS="$SHIM_IMPORT" pz daemon start
fi
