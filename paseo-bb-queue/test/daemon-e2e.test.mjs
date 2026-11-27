import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

async function waitForDaemonReady(paseoBin, homeDir, getExitDiagnostic, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exitDiag = getExitDiagnostic();
    if (exitDiag) {
      throw new Error(`Daemon exited prematurely:\n${exitDiag}`);
    }
    const res = spawnSync(paseoBin, ["--home", homeDir, "status", "--json"], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    if (res.status === 0) {
      const parsed = JSON.parse(res.stdout);
      if (parsed.localDaemon === "running" && parsed.connectedDaemon === "reachable") {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Isolated Paseo daemon did not become ready within timeout:\n${getExitDiagnostic() ?? ""}`);
}

test("real Paseo daemon E2E: supervisor -> worker -> register.mjs -> bb-queue plugin full roundtrip", async () => {
  const paseoBin = realpathSync(
    spawnSync("which", ["paseo"], { encoding: "utf8" }).stdout.trim(),
  );
  const registerPath = path.resolve(import.meta.dirname, "../shim/register.mjs");
  const pluginDir = path.resolve(import.meta.dirname, "../plugin");
  const homeDir = mkdtempSync(path.join(tmpdir(), "paseo-bb-e2e-"));
  const port = await getFreePort();

  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(homeDir, "config.json"),
    JSON.stringify(
      {
        version: 1,
        daemon: {
          listen: `127.0.0.1:${port}`,
          relay: { enabled: false },
        },
        pluginsEnabled: true,
        plugins: {},
        features: {
          webUi: { enabled: false },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  let procOut = "";
  let exitedCode = null;
  const daemonProc = spawn(paseoBin, ["--home", homeDir, "daemon", "run"], {
    env: {
      ...process.env,
      PASEO_HOME: homeDir,
      NODE_OPTIONS: `--import ${registerPath}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemonProc.stdout.on("data", (d) => (procOut += d.toString("utf8")));
  daemonProc.stderr.on("data", (d) => (procOut += d.toString("utf8")));
  daemonProc.once("exit", (code, sig) => {
    exitedCode = `${code ?? sig}`;
  });

  try {
    await waitForDaemonReady(
      paseoBin,
      homeDir,
      () => (exitedCode !== null ? `exit=${exitedCode}\n${procOut}` : null),
    );

    const installRes = spawnSync(
      paseoBin,
      ["--home", homeDir, "plugin", "install", pluginDir],
      {
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    );
    assert.equal(installRes.status, 0, `plugin install failed:\n${installRes.stderr}`);

    // Wait until bb-queue plugin status is "running"
    const deadline = Date.now() + 15_000;
    let pluginReady = false;
    while (Date.now() < deadline) {
      const ls = spawnSync(paseoBin, ["--home", homeDir, "plugin", "ls", "--json"], {
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "" },
      });
      if (ls.status === 0) {
        const list = JSON.parse(ls.stdout);
        if (Array.isArray(list) && list.some((p) => p.id === "bb-queue" && p.status === "running")) {
          pluginReady = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(pluginReady, "bb-queue plugin must reach running state in real daemon");

    // Connect using Paseo's own DaemonClient (exact same call used by Paseo Web/Electron/Mobile Composer)
    const daemonClientModUrl = new URL(
      "../node_modules/@getpaseo/client/dist/daemon-client.js",
      `file://${paseoBin}`,
    ).href;
    const { DaemonClient } = await import(daemonClientModUrl);
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${port}/ws`,
      clientId: "cid_bb_e2e_test",
      clientType: "cli",
      appVersion: "0.15.3",
    });
    await client.connect();

    try {
      // 1. Empty "bb   " message must be intercepted by shim and fail-fast with our Chinese validation error!
      await assert.rejects(
        () => client.sendAgentMessage("nonexistent-agent", "bb    ", { messageId: "msg_e2e_empty" }),
        /bb 排队消息内容不能为空/,
      );

      // 2. Non-empty "bb run build" to nonexistent agent must route through shim into bb-queue scheduler!
      await assert.rejects(
        () => client.sendAgentMessage("nonexistent-agent", "bb run build", { messageId: "msg_e2e_1" }),
        /Agent 不存在/,
      );

      // 3. Normal message without "bb " must bypass shim and return native English error from Paseo Session!
      await assert.rejects(
        () => client.sendAgentMessage("nonexistent-agent", "normal hello", { messageId: "msg_e2e_2" }),
        /Agent not found/i,
      );

      // 4. Frontend plugin RPCs (summaries & detail) work end-to-end
      const summaries = await client.invokePluginRpc("bb-queue", "queue.summaries", {});
      assert.deepEqual(summaries, { summaries: [] });
      const detail = await client.invokePluginRpc("bb-queue", "queue.get", {
        agentId: "agent_check",
      });
      assert.deepEqual(detail, {
        agentId: "agent_check",
        paused: false,
        pauseReason: null,
        items: [],
        withdrawnMessageIds: [],
        dispatchedTexts: {},
        waitingReason: null,
        timeoutNotice: null,
      });
    } finally {
      await client.close();
    }
  } finally {
    daemonProc.kill("SIGTERM");
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        daemonProc.kill("SIGKILL");
        resolve(null);
      }, 5_000);
      daemonProc.once("exit", () => {
        clearTimeout(killTimer);
        resolve(null);
      });
    });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
