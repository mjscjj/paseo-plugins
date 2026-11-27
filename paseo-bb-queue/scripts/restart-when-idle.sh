#!/usr/bin/env bash
set -euo pipefail

export PATH="$HOME/.local/node/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

# Wait up to 15 minutes until zero Paseo agents are in "running" state, then restart paseo.service cleanly.
for _ in $(seq 1 900); do
  running_count="$(
    paseo ls --json 2>/dev/null | node -e '
      const raw = require("fs").readFileSync(0, "utf8").trim();
      if (!raw) { console.log("999"); process.exit(0); }
      const d = JSON.parse(raw);
      const list = Array.isArray(d) ? d : (d.agents || d.entries || []);
      const n = list.filter(a => (a.status || a.agent?.status) === "running").length;
      console.log(String(n));
    ' 2>/dev/null || echo "999"
  )"
  if [ "$running_count" = "0" ]; then
    sleep 1
    systemctl --user restart paseo.service
    exit 0
  fi
  sleep 1
done

echo "[bb-queue] Timed out waiting for running Paseo agents to become idle" >&2
exit 1
