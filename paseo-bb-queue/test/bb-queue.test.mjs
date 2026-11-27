import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createConnectionBridge,
  wrapCreateDaemonChannel,
  wrapOpenDaemonSecureChannel,
} from "../shim/protocol-bridge.mjs";
import {
  convertComposerAttachmentsForIngest,
  createScopedQueueMapInterceptor,
} from "../plugin/client/frontend-queue-bridge.ts";
import { QueueScheduler } from "../plugin/server/scheduler.ts";
import { QueueStore, stripBbPrefix, stripOptionalBbPrefix } from "../plugin/server/store.ts";

test("protocol-bridge: passes through non-bb and agent-originated messages untouched", () => {
  const bridge = createConnectionBridge({ isPluginAvailable: () => true });

  assert.equal(bridge.transformInboundText('{"type":"ping"}'), null);
  assert.equal(
    bridge.transformInboundText(
      JSON.stringify({
        type: "session",
        message: {
          type: "send_agent_message_request",
          requestId: "r1",
          agentId: "a1",
          text: "normal message",
        },
      }),
    ),
    null,
  );
  // "bb" without trailing space or words starting with "bb" (like "bbox") must NOT trigger
  assert.equal(
    bridge.transformInboundText(
      JSON.stringify({
        type: "session",
        message: {
          type: "send_agent_message_request",
          requestId: "r2",
          agentId: "a1",
          text: "bb",
        },
      }),
    ),
    null,
  );
  assert.equal(
    bridge.transformInboundText(
      JSON.stringify({
        type: "session",
        message: {
          type: "send_agent_message_request",
          requestId: "r2b",
          agentId: "a1",
          text: "bbox check",
        },
      }),
    ),
    null,
  );
  // Mobile IME U+2005 / NBSP / multiple spaces MUST trigger and strip cleanly
  for (const variant of ["bb   开始改吧", "Bb\u2005开始改吧", "bb\u00a0开始改吧", " bb\u3000开始改吧"]) {
    assert.ok(
      bridge.transformInboundText(
        JSON.stringify({
          type: "session",
          message: {
            type: "send_agent_message_request",
            requestId: "r_ime",
            agentId: "a1",
            text: variant,
          },
        }),
      ),
      `Expected variant ${JSON.stringify(variant)} to be intercepted`,
    );
    assert.equal(stripBbPrefix(variant), "开始改吧");
  }
  assert.equal(stripOptionalBbPrefix("bb 顺手带前缀"), "顺手带前缀");
  assert.equal(stripOptionalBbPrefix("不带前缀"), "不带前缀");
  bridge.clear();
  // Agent-to-agent messages (sourceAgentId present) must NOT be hijacked
  assert.equal(
    bridge.transformInboundText(
      JSON.stringify({
        type: "session",
        message: {
          type: "send_agent_message_request",
          requestId: "r3",
          agentId: "a1",
          sourceAgentId: "parent-agent",
          text: "bb subtask",
        },
      }),
    ),
    null,
  );
  assert.equal(bridge.pendingCount, 0);
});

test("protocol-bridge: rewrites 'bb ' inbound to plugin.rpc.invoke.request and maps response/error back", () => {
  const bridge = createConnectionBridge({ isPluginAvailable: () => true });

  const inbound = JSON.stringify({
    type: "session",
    message: {
      type: "send_agent_message_request",
      requestId: "client_req_1",
      agentId: "agent_abc",
      text: "bb run unit tests",
      messageId: "msg_001",
      images: [{ data: "base64data", mimeType: "image/png" }],
    },
  });

  const rewrittenRaw = bridge.transformInboundText(inbound);
  assert.ok(rewrittenRaw, "Expected inbound message to be rewritten");
  const rewritten = JSON.parse(rewrittenRaw);
  assert.equal(rewritten.type, "session");
  assert.equal(rewritten.message.type, "plugin.rpc.invoke.request");
  assert.equal(rewritten.message.pluginId, "bb-queue");
  assert.equal(rewritten.message.method, "bb.ingest");
  assert.equal(rewritten.message.input.text, "bb run unit tests");
  assert.equal(rewritten.message.input.messageId, "msg_001");
  assert.equal(rewritten.message.input.images.length, 1);
  assert.equal(bridge.pendingCount, 1);

  const bridgeReqId = rewritten.message.requestId;
  const pluginRpcResponse = JSON.stringify({
    type: "session",
    message: {
      type: "plugin.rpc.invoke.response",
      payload: {
        requestId: bridgeReqId,
        output: {
          agentId: "agent_abc_resolved",
          accepted: true,
          deliveryStatus: "queued",
          error: null,
        },
      },
    },
  });

  const clientOutRaw = bridge.transformOutboundText(pluginRpcResponse);
  assert.ok(clientOutRaw);
  assert.deepEqual(JSON.parse(clientOutRaw), {
    type: "session",
    message: {
      type: "send_agent_message_response",
      payload: {
        requestId: "client_req_1",
        agentId: "agent_abc_resolved",
        accepted: true,
        deliveryStatus: "queued",
        error: null,
      },
    },
  });
  assert.equal(bridge.pendingCount, 0);

  // Fail-fast on rpc_error (e.g. plugin disabled), also testing iOS capitalized "Bb "
  const rewrittenErrRaw = bridge.transformInboundText(
    JSON.stringify({
      type: "session",
      message: {
        type: "send_agent_message_request",
        requestId: "client_req_2",
        agentId: "agent_abc",
        text: "Bb second task",
      },
    }),
  );
  const errBridgeId = JSON.parse(rewrittenErrRaw).message.requestId;
  const mappedErrRaw = bridge.transformOutboundText(
    JSON.stringify({
      type: "session",
      message: {
        type: "rpc_error",
        payload: {
          requestId: errBridgeId,
          requestType: "plugin.rpc.invoke.request",
          error: "Request failed: Plugin is not available: bb-queue",
          code: "handler_error",
        },
      },
    }),
  );
  assert.deepEqual(JSON.parse(mappedErrRaw), {
    type: "session",
    message: {
      type: "send_agent_message_response",
      payload: {
        requestId: "client_req_2",
        agentId: "agent_abc",
        accepted: false,
        error: "Request failed: Plugin is not available: bb-queue",
      },
    },
  });
  assert.equal(bridge.pendingCount, 0);
});

test("QueueStore & QueueScheduler: FIFO persistence, idle immediate send, permission block, and fail-fast pause", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "bb-queue-test-"));
  try {
    const file = path.join(tmpDir, "queues.json");

    // Fail-fast on corrupted JSON
    writeFileSync(file, "{corrupted", "utf8");
    assert.throws(() => new QueueStore(file));
    rmSync(file);

    const store = new QueueStore(file);
    const scheduler = new QueueScheduler(store, { turnEndGraceMs: 0 });

    // Fail-fast on empty bb message
    assert.throws(() => store.enqueue("a1", { text: stripBbPrefix("bb    ") }), /不能为空/);

    let currentStatus = "idle";
    let pendingPermissions = [];
    const sent = [];
    let failSendOnce = false;

    const fakePort = {
      async inspect(id) {
        if (id === "missing") return null;
        return {
          id: "agent-1",
          status: currentStatus,
          pendingPermissions,
        };
      },
      async send(agentId, text, options) {
        if (failSendOnce) {
          failSendOnce = false;
          throw new Error("transport disconnected");
        }
        sent.push({ agentId, text, options });
        currentStatus = "running";
      },
    };

    // Missing agent fails fast
    await assert.rejects(() =>
      scheduler.submit(fakePort, "missing", { text: "hello" }),
    );

    // 1. Idle agent -> sends immediately without queuing (testing iOS "Bb " capitalization too)
    const r1 = await scheduler.submit(fakePort, "agent-1", {
      text: stripBbPrefix("Bb first immediate"),
      messageId: "m1",
    });
    assert.equal(r1.disposition, "sent_immediately");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, "first immediate");
    assert.equal(store.getDetail("agent-1").items.length, 0);
    assert.equal(store.getDetail("agent-1").dispatchedTexts.m1, "first immediate");

    // 2. Agent is now running -> subsequent messages queue on disk in FIFO order
    const r2 = await scheduler.submit(fakePort, "agent-1", {
      text: stripBbPrefix("bb task two"),
      messageId: "m2",
    });
    const r3 = await scheduler.submit(fakePort, "agent-1", {
      text: stripBbPrefix("bb task three"),
      messageId: "m3",
    });
    assert.equal(r2.disposition, "queued");
    assert.equal(r3.disposition, "queued");

    // Reload from disk to verify persistence
    const reloadedStore = new QueueStore(file);
    assert.deepEqual(
      reloadedStore.getDetail("agent-1").items.map((i) => i.text),
      ["task two", "task three"],
    );

    // 3. Turn fails -> auto-pauses queue instead of blindly firing next prompt
    currentStatus = "idle";
    await scheduler.onTurnEnded(fakePort, "agent-1", {
      kind: "failed",
      error: { message: "rate limit" },
    });
    assert.equal(sent.length, 1);
    assert.equal(store.getDetail("agent-1").paused, true);
    assert.match(store.getDetail("agent-1").pauseReason ?? "", /rate limit/);

    // 4. Resume while blocked by pending permission -> stays queued until permission resolves
    pendingPermissions = [{ id: "perm_1" }];
    store.setPaused("agent-1", false);
    await scheduler.drainNext(fakePort, "agent-1");
    assert.equal(sent.length, 1);

    // Permission resolved -> drains "task two"
    pendingPermissions = [];
    await scheduler.drainNext(fakePort, "agent-1");
    assert.equal(sent.length, 2);
    assert.equal(sent[1].text, "task two");
    assert.equal(sent[1].options.messageId, "m2");

    // 5. Next turn completes, but send throws -> requeues at front and pauses (no message loss)
    currentStatus = "idle";
    failSendOnce = true;
    await scheduler.onTurnEnded(fakePort, "agent-1", { kind: "completed" });
    assert.equal(sent.length, 2);
    assert.equal(store.getDetail("agent-1").paused, true);
    assert.deepEqual(
      store.getDetail("agent-1").items.map((i) => i.text),
      ["task three"],
    );

    // Resume again -> drains "task three" and cleans up empty queue
    store.setPaused("agent-1", false);
    await scheduler.drainNext(fakePort, "agent-1");
    assert.equal(sent.length, 3);
    assert.equal(sent[2].text, "task three");
    assert.equal(store.getSummaries().length, 0);

    // 6. Edit item text & Send Now (including atomic rollback on send failure)
    currentStatus = "running";
    await scheduler.submit(fakePort, "agent-1", { text: "step A", messageId: "mA" });
    await scheduler.submit(fakePort, "agent-1", { text: "step B", messageId: "mB" });
    const itemsBefore = store.getDetail("agent-1").items;
    assert.equal(itemsBefore.length, 2);

    // Fail-fast on empty edit without attachments
    assert.throws(
      () => store.updateItemText("agent-1", itemsBefore[1].id, "   "),
      /不能为空/,
    );

    const updatedDetail = store.updateItemText(
      "agent-1",
      itemsBefore[1].id,
      "step B edited",
    );
    assert.equal(updatedDetail.items[1].text, "step B edited");
    assert.equal(store.getSummaries()[0].firstItemPreview, "step A");

    // Send Now fails -> item must be restored to index 1 and error surfaced!
    failSendOnce = true;
    await assert.rejects(() =>
      scheduler.sendItemNow(fakePort, "agent-1", itemsBefore[1].id, "steer"),
    );
    assert.deepEqual(
      store.getDetail("agent-1").items.map((i) => i.text),
      ["step A", "step B edited"],
    );

    // Send Now succeeds while running -> passes activeTurnBehavior: "steer" and removes only index 1
    const afterSendNow = await scheduler.sendItemNow(
      fakePort,
      "agent-1",
      itemsBefore[1].id,
      "steer",
    );
    assert.deepEqual(afterSendNow.items.map((i) => i.text), ["step A"]);
    // The failed send left a receipt for "mB" in Paseo, so the retry goes out under a fresh id.
    const retriedId = sent.at(-1).options.messageId;
    assert.match(retriedId, /^mB~r[0-9a-z]+$/);
    assert.equal(afterSendNow.dispatchedTexts[retriedId], "step B edited");
    assert.equal(sent.at(-1).text, "step B edited");
    assert.equal(sent.at(-1).options.activeTurnBehavior, "steer");

    // Remove remaining item -> records mA in withdrawnMessageIds
    const afterRemove = store.removeItem("agent-1", afterSendNow.items[0].id);
    assert.ok(afterRemove.withdrawnMessageIds.includes("mA"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("wrapOpenDaemonSecureChannel: bridges relay E2EE plaintext frames", async () => {
  let serverOnMessage;
  const outboundSent = [];
  const wrapped = wrapOpenDaemonSecureChannel(async (_transport, options) => {
    serverOnMessage = options.events.onmessage;
    return {
      async send(data) {
        outboundSent.push(data);
      },
      close() {},
      isOpen: () => true,
      securityMode: () => "protected",
      outboundWireByteLength: (d) => Buffer.byteLength(String(d)),
      onTransitionToOpen() {},
      onClose() {},
    };
  });

  const receivedByDaemon = [];
  const channel = await wrapped(
    {},
    {
      events: {
        onmessage(data) {
          receivedByDaemon.push(data);
        },
      },
    },
  );

  serverOnMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "send_agent_message_request",
        requestId: "relay_req_1",
        agentId: "agent_r",
        text: "bb via relay",
      },
    }),
  );

  assert.equal(receivedByDaemon.length, 1);
  const forwarded = JSON.parse(receivedByDaemon[0]);
  assert.equal(forwarded.message.type, "plugin.rpc.invoke.request");

  await channel.send(
    JSON.stringify({
      type: "session",
      message: {
        type: "plugin.rpc.invoke.response",
        payload: {
          requestId: forwarded.message.requestId,
          output: {
            agentId: "agent_r",
            accepted: true,
            deliveryStatus: "queued",
            error: null,
          },
        },
      },
    }),
  );

  assert.equal(outboundSent.length, 1);
  assert.deepEqual(JSON.parse(outboundSent[0]), {
    type: "session",
    message: {
      type: "send_agent_message_response",
      payload: {
        requestId: "relay_req_1",
        agentId: "agent_r",
        accepted: true,
        deliveryStatus: "queued",
        error: null,
      },
    },
  });

  // Also test v0.11.x legacy createDaemonChannel(transport, keyPair, events)
  let legacyOnMessage;
  const legacySent = [];
  const wrappedLegacy = wrapCreateDaemonChannel(async (_t, _kp, events) => {
    legacyOnMessage = events.onmessage;
    return {
      async send(d) {
        legacySent.push(d);
      },
    };
  });
  const legacyReceived = [];
  const legacyCh = await wrappedLegacy({}, {}, {
    onmessage(d) {
      legacyReceived.push(d);
    },
  });
  legacyOnMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "send_agent_message_request",
        requestId: "legacy_req_1",
        agentId: "agent_l",
        text: "bb legacy relay",
      },
    }),
  );
  assert.equal(legacyReceived.length, 1);
  const legacyFwd = JSON.parse(legacyReceived[0]);
  await legacyCh.send(
    JSON.stringify({
      type: "session",
      message: {
        type: "plugin.rpc.invoke.response",
        payload: {
          requestId: legacyFwd.message.requestId,
          output: { agentId: "agent_l", accepted: true, deliveryStatus: "queued", error: null },
        },
      },
    }),
  );
  assert.equal(legacySent.length, 1);
  assert.equal(JSON.parse(legacySent[0]).message.type, "send_agent_message_response");
});

test("register.mjs e2e: strips NODE_OPTIONS for child processes and bridges real ws WebSocketServer", () => {
  const registerPath = path.resolve(
    import.meta.dirname,
    "../shim/register.mjs",
  );
  const paseoBin = realpathSync(spawnSync("which", ["paseo"], { encoding: "utf8" }).stdout.trim());
  const paseoPkgJson = path.resolve(paseoBin, "../../node_modules/@getpaseo/server/package.json");

  const script = `
    import assert from "node:assert/strict";
    import { realpathSync } from "node:fs";
    import { register } from "node:module";
    import { pathToFileURL } from "node:url";

    assert.equal(process.env.NODE_OPTIONS, undefined, "NODE_OPTIONS must be stripped inside worker");

    const parentUrl = pathToFileURL(realpathSync(${JSON.stringify(paseoPkgJson)})).href;
    const helperLoader = [
      "export async function resolve(specifier, context, nextResolve) {",
      "  if (specifier === 'virtual:ws-consumer') {",
      "    return { url: " + JSON.stringify(parentUrl + "?ws_consumer=1") + ", shortCircuit: true };",
      "  }",
      "  return nextResolve(specifier, context);",
      "}",
      "export async function load(url, context, nextLoad) {",
      "  if (url.endsWith('?ws_consumer=1')) {",
      "    return { format: 'module', shortCircuit: true, source: 'export { WebSocketServer, WebSocket } from \\"ws\\";' };",
      "  }",
      "  return nextLoad(url, context);",
      "}",
    ].join("\\n");
    register("data:text/javascript," + encodeURIComponent(helperLoader));

    const { WebSocketServer, WebSocket } = await import("virtual:ws-consumer");
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8"));
        assert.equal(msg.message.type, "plugin.rpc.invoke.request");
        ws.send(JSON.stringify({
          type: "session",
          message: {
            type: "plugin.rpc.invoke.response",
            payload: {
              requestId: msg.message.requestId,
              output: {
                agentId: msg.message.input.agentId,
                accepted: true,
                deliveryStatus: "queued",
                error: null,
              },
            },
          },
        }));
      });
    });

    await new Promise((r) => wss.once("listening", r));
    const { port } = wss.address();
    const client = new WebSocket("ws://127.0.0.1:" + port);
    await new Promise((r) => client.once("open", r));

    const replyPromise = new Promise((r) => client.once("message", (d) => r(JSON.parse(d.toString("utf8")))));
    client.send(JSON.stringify({
      type: "session",
      message: {
        type: "send_agent_message_request",
        requestId: "ws_e2e_1",
        agentId: "agent_ws",
        text: "bb live ws test",
      },
    }));

    const reply = await replyPromise;
    assert.deepEqual(reply, {
      type: "session",
      message: {
        type: "send_agent_message_response",
        payload: {
          requestId: "ws_e2e_1",
          agentId: "agent_ws",
          accepted: true,
          deliveryStatus: "queued",
          error: null,
        },
      },
    });

    client.close();
    await new Promise((r) => wss.close(r));
    console.log("E2E_WS_OK");
  `;

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        PASEO_BB_SHIM_FORCE: "1",
        NODE_OPTIONS: `--import ${registerPath}`,
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, `STDERR:\n${result.stderr}\nSTDOUT:\n${result.stdout}`);
  assert.match(result.stdout, /E2E_WS_OK/);
});

test("Frontend + Backend Queue Coordination: frontend queue drains first without colliding, and offline hold expires safely", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "bb-dual-coord-"));
  try {
    const store = new QueueStore(path.join(tmpDir, "queues.json"));
    const scheduler = new QueueScheduler(store, {
      turnEndGraceMs: 25,
      frontendHoldMaxWaitMs: 90,
      frontendHoldTtlMs: 5_000,
    });

    let currentStatus = "running";
    const sent = [];
    const fakePort = {
      async inspect(id) {
        return { id, status: currentStatus, pendingPermissions: [] };
      },
      async send(agentId, text, options) {
        sent.push({ agentId, text, options });
        currentStatus = "running";
      },
    };

    // Enqueue backend task while Turn 1 is running
    await scheduler.submit(fakePort, "agent-1", {
      text: "后端任务 B",
      messageId: "m_back",
    });

    // Client also has a normal item in its Frontend Queue
    scheduler.setFrontendHold(fakePort, "agent-1", true);

    // Turn 1 completes -> Backend Queue MUST wait (up to 90ms) instead of firing at 0ms or 25ms
    currentStatus = "idle";
    await scheduler.onTurnEnded(fakePort, "agent-1", { kind: "completed" });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sent.length, 0, "Backend queue must hold while frontend queue has pending items");

    // Client drains its Frontend Queue item -> Turn 2 starts & client clears frontend hold
    currentStatus = "running";
    scheduler.onTurnStarted("agent-1");
    scheduler.setFrontendHold(fakePort, "agent-1", false);

    // Even after 90ms, Turn 2 is running so Backend Queue stays queued
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(sent.length, 0);

    // Turn 2 (frontend task) completes -> after 25ms grace, Backend Queue dispatches "后端任务 B"!
    currentStatus = "idle";
    await scheduler.onTurnEnded(fakePort, "agent-1", { kind: "completed" });
    await new Promise((r) => setTimeout(r, 45));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, "后端任务 B");

    // Now test offline client hold expiration (no deadlock if client tab closed mid-turn!)
    await scheduler.submit(fakePort, "agent-1", {
      text: "离线恢复后端任务 C",
      messageId: "m_offline",
    });
    scheduler.setFrontendHold(fakePort, "agent-1", true);
    currentStatus = "idle";
    await scheduler.onTurnEnded(fakePort, "agent-1", { kind: "completed" });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].text, "离线恢复后端任务 C");

    scheduler.dispose();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("frontend-queue-bridge: keeps normal frontend queue items in Map while promoting 'bb ' items to backend with attachments", async () => {
  class FakeQueueMap extends Map {}
  const interceptor = createScopedQueueMapInterceptor({
    targetMapPrototype: FakeQueueMap.prototype,
    encodeImage: async (meta) => ({
      data: `encoded_${meta.storageKey}`,
      mimeType: meta.mimeType,
    }),
  });

  const ingested = [];
  const holds = [];
  const errors = [];

  const unregister = interceptor.registerOwner({
    id: "host-dev2",
    hasAgent: (id) => id === "agent-dev2",
    async ingest(payload) {
      ingested.push(payload);
    },
    setFrontendHold(agentId, hasFrontendItems) {
      holds.push({ agentId, hasFrontendItems });
    },
    reportError(msg) {
      errors.push(msg);
    },
  });

  try {
    const queueMap = new FakeQueueMap();

    // 1. Normal message stays in Frontend Queue and sets frontendHold = true
    const normalItem = { id: "msg_norm_1", text: "先检查一下日志", attachments: [] };
    queueMap.set("agent-dev2", [normalItem]);
    assert.deepEqual(queueMap.get("agent-dev2"), [normalItem]);
    assert.deepEqual(holds, [{ agentId: "agent-dev2", hasFrontendItems: true }]);

    // 2. User sends "Bb 修完提交" with an image + workspace file while Default send = Queue!
    const bbItem = {
      id: "msg_bb_2",
      text: "Bb\u2005修完提交",
      attachments: [
        {
          kind: "image",
          metadata: {
            id: "img_1",
            mimeType: "image/png",
            storageType: "web-indexeddb",
            storageKey: "key_img_1",
          },
        },
        {
          kind: "workspace_file",
          path: "src/app.ts",
          selection: { kind: "line_range", startLine: 10, endLine: 20 },
        },
      ],
    };
    const returned = queueMap.set("agent-dev2", [normalItem, bbItem]);
    assert.equal(returned, queueMap, "Map.prototype.set must return `this`");

    // Normal item remains intact in Frontend Queue; bbItem is immediately stripped from Frontend Queue!
    assert.deepEqual(queueMap.get("agent-dev2"), [normalItem]);

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(errors.length, 0);
    assert.equal(ingested.length, 1);
    assert.deepEqual(ingested[0], {
      agentId: "agent-dev2",
      text: "Bb\u2005修完提交",
      messageId: "msg_bb_2",
      images: [{ data: "encoded_key_img_1", mimeType: "image/png" }],
      attachments: [
        {
          type: "text",
          mimeType: "text/plain",
          title: "app.ts",
          text: "Workspace file: src/app.ts\nLines: 10-20",
        },
      ],
    });

    // 3. Frontend Queue drains its last normal item -> sets frontendHold = false
    queueMap.set("agent-dev2", []);
    assert.deepEqual(holds, [
      { agentId: "agent-dev2", hasFrontendItems: true },
      { agentId: "agent-dev2", hasFrontendItems: false },
    ]);

    // 4. Unowned host agent is completely untouched even if text starts with "bb "
    const otherHostItem = { id: "msg_other_1", text: "bb other host", attachments: [] };
    queueMap.set("agent-unowned", [otherHostItem]);
    assert.deepEqual(queueMap.get("agent-unowned"), [otherHostItem]);
    assert.equal(ingested.length, 1);

    // 5. Direct attachment converter check for uploaded file + forge PR
    const converted = await convertComposerAttachmentsForIngest([
      {
        kind: "file",
        attachment: { type: "uploaded_file", id: "f1", fileName: "a.txt", mimeType: "text/plain", size: 3, path: "/tmp/a.txt" },
      },
      {
        kind: "github-pr",
        item: { kind: "change_request", number: 42, title: "Fix bug", url: "https://example.com/pr/42" },
      },
    ]);
    assert.equal(converted.attachments.length, 2);
    assert.equal(converted.attachments[0].type, "uploaded_file");
    assert.equal(converted.attachments[1].type, "forge_change_request");
  } finally {
    unregister();
  }
});

test("QueueScheduler: a failed turn pauses, a later completed turn (auto-retry) resumes; manual pause stays", async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "bb-queue-resume-"));
  try {
    const store = new QueueStore(path.join(tmpDir, "queues.json"));
    const scheduler = new QueueScheduler(store, { turnEndGraceMs: 0 });
    let status = "running";
    const sent = [];
    const port = {
      async inspect() {
        return { id: "agent-1", status, pendingPermissions: [] };
      },
      async send(agentId, text) {
        sent.push(text);
        status = "running";
      },
    };
    await scheduler.submit(port, "agent-1", { text: "next task" });
    status = "error";
    await scheduler.onTurnEnded(port, "agent-1", { kind: "failed", error: { message: "socket hang up" } });
    assert.equal(store.getDetail("agent-1").paused, true);
    assert.equal(sent.length, 0);

    // auto-retry's turn completes -> queue resumes and sends
    status = "idle";
    await scheduler.onTurnEnded(port, "agent-1", { kind: "completed" });
    assert.deepEqual(sent, ["next task"]);

    // A manual pause is never lifted by a completed turn
    status = "running";
    await scheduler.submit(port, "agent-1", { text: "held" });
    store.setPaused("agent-1", true);
    status = "error";
    await scheduler.onTurnEnded(port, "agent-1", { kind: "failed", error: { message: "boom" } });
    status = "idle";
    await scheduler.onTurnEnded(port, "agent-1", { kind: "completed" });
    assert.equal(store.getDetail("agent-1").paused, true);
    assert.deepEqual(sent, ["next task"]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
