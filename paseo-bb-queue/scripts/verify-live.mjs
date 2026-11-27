import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

const paseoBin = realpathSync(
  spawnSync("which", ["paseo"], { encoding: "utf8" }).stdout.trim(),
);
// Checks the daemon of PASEO_HOME (default ~/.paseo).
const homeArgs = process.env.PASEO_HOME ? ["--home", process.env.PASEO_HOME] : [];
const statusRaw = spawnSync(paseoBin, [...homeArgs, "status", "--json"], {
  encoding: "utf8",
  env: { ...process.env, NODE_OPTIONS: "" },
});
assert.equal(statusRaw.status, 0, `paseo status failed: ${statusRaw.stderr}`);
const status = JSON.parse(statusRaw.stdout);
assert.equal(status.localDaemon, "running");
assert.equal(status.connectedDaemon, "reachable");

const listenHost = status.listen.startsWith("0.0.0.0:")
  ? `127.0.0.1:${status.listen.split(":")[1]}`
  : status.listen;

const daemonClientModUrl = new URL(
  "../node_modules/@getpaseo/client/dist/daemon-client.js",
  `file://${paseoBin}`,
).href;
const { DaemonClient } = await import(daemonClientModUrl);

const client = new DaemonClient({
  url: `ws://${listenHost}/ws`,
  clientId: "cid_bb_live_verify",
  clientType: "cli",
  appVersion: status.daemonVersion,
});
await client.connect();

try {
  // 1. Plugin RPC live check
  const summaries = await client.invokePluginRpc("bb-queue", "queue.summaries", {});
  assert.ok(Array.isArray(summaries.summaries), "queue.summaries must return array");

  // 2. Live 'bb ' interception check
  await assert.rejects(
    () =>
      client.sendAgentMessage("__bb_live_probe_nonexistent__", "bb    ", {
        messageId: "msg_live_probe_empty",
      }),
    /bb 排队消息内容不能为空/,
  );

  // 3. Live 'Bb ' (capitalized) interception check
  await assert.rejects(
    () =>
      client.sendAgentMessage("__bb_live_probe_nonexistent__", "Bb probe task", {
        messageId: "msg_live_probe_missing",
      }),
    /Agent 不存在/,
  );

  // 4. Normal message passthrough check
  await assert.rejects(
    () =>
      client.sendAgentMessage("__bb_live_probe_nonexistent__", "normal probe", {
        messageId: "msg_live_probe_normal",
      }),
    /Agent not found/i,
  );

  console.log(
    JSON.stringify({
      ok: true,
      hostname: status.hostname,
      daemonVersion: status.daemonVersion,
      workerPid: status.workerPid,
      listen: status.listen,
    }),
  );
} finally {
  await client.close();
}
