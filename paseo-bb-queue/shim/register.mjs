import { register } from "node:module";
import { fileURLToPath } from "node:url";
import { getWsServerInstantiatedCount } from "./protocol-bridge.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);

function stripSelfFromNodeOptions() {
  const current = process.env.NODE_OPTIONS;
  if (!current) return;
  const escaped = SELF_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const next = current
    .replace(new RegExp(`--import(?:=|\\s+)(?:"${escaped}"|'${escaped}'|${escaped})`, "g"), "")
    .trim()
    .replace(/\s+/g, " ");
  if (next) {
    process.env.NODE_OPTIONS = next;
  } else {
    delete process.env.NODE_OPTIONS;
  }
}

function shouldActivateInCurrentProcess() {
  if (process.env.PASEO_BB_SHIM_FORCE === "1") {
    return true;
  }
  const entry = process.argv[1] ?? "";
  // Keep NODE_OPTIONS intact in CLI launcher and Supervisor so daemon-worker inherits it.
  if (
    entry.endsWith("/bin/paseo") ||
    entry.includes("supervisor-entrypoint")
  ) {
    return false;
  }
  if (entry.includes("daemon-worker")) {
    return true;
  }
  stripSelfFromNodeOptions();
  return false;
}

if (shouldActivateInCurrentProcess()) {
  // Strip immediately so agent/plugin/terminal child processes spawned by daemon-worker stay clean.
  stripSelfFromNodeOptions();

  register("./loader.mjs", import.meta.url);

  if (process.env.PASEO_BB_SHIM_FORCE !== "1") {
    const checkTimer = setTimeout(() => {
      if (getWsServerInstantiatedCount() === 0) {
        process.stderr.write(
          "[bb-queue-shim] ERROR: WebSocketServer was never instantiated within 15s; check Paseo transport compatibility.\n",
        );
      }
    }, 15_000);
    checkTimer.unref();
  }
}
