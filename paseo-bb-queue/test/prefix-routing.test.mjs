import assert from "node:assert/strict";
import test from "node:test";
import { attachWsSocketBridge, createConnectionBridge } from "../shim/protocol-bridge.mjs";
import { createScopedQueueMapInterceptor } from "../plugin/client/frontend-queue-bridge.ts";

function sendRequest(text, extra = {}) {
  return JSON.stringify({
    type: "session",
    message: { type: "send_agent_message_request", requestId: "r1", agentId: "a1", text, ...extra },
  });
}

test("shim: 'cc ' routes to the cc ingest of the bb-queue plugin, 'bb ' to bb.ingest", () => {
  const bridge = createConnectionBridge({ isPluginAvailable: () => true });
  const cc = JSON.parse(bridge.transformInboundText(sendRequest("cc 半小时后跑测试")));
  assert.equal(cc.message.type, "plugin.rpc.invoke.request");
  assert.equal(cc.message.pluginId, "bb-queue");
  assert.equal(cc.message.method, "cc.ingest");
  assert.equal(cc.message.input.text, "cc 半小时后跑测试");

  const bb = JSON.parse(bridge.transformInboundText(sendRequest("BB　排队任务")));
  assert.equal(bb.message.pluginId, "bb-queue");
  assert.equal(bb.message.method, "bb.ingest");
});

test("shim: words merely starting with cc and agent-originated messages pass through", () => {
  const bridge = createConnectionBridge({ isPluginAvailable: () => true });
  assert.equal(bridge.transformInboundText(sendRequest("ccache 清一下")), null);
  assert.equal(bridge.transformInboundText(sendRequest("cc")), null);
  assert.equal(
    bridge.transformInboundText(sendRequest("cc from agent", { sourceAgentId: "parent" })),
    null,
  );
});

test("shim: cc plugin errors name the cc plugin in the rejected send", () => {
  const bridge = createConnectionBridge({ isPluginAvailable: () => true });
  const rewritten = JSON.parse(bridge.transformInboundText(sendRequest("cc later")));
  const reqId = rewritten.message.requestId;
  const out = JSON.parse(
    bridge.transformOutboundText(
      JSON.stringify({ type: "session", message: { type: "rpc_error", payload: { requestId: reqId } } }),
    ),
  );
  assert.equal(out.message.type, "send_agent_message_response");
  assert.equal(out.message.payload.requestId, "r1");
  assert.equal(out.message.payload.accepted, false);
  assert.match(out.message.payload.error, /bb-queue/);
});

test("shim: a prefix whose plugin is not installed stays a normal message", () => {
  const bridge = createConnectionBridge({ isPluginAvailable: () => false });
  assert.equal(bridge.transformInboundText(sendRequest("cc 排队")), null);
  assert.equal(bridge.transformInboundText(sendRequest("bb 排队")), null);
});

test("shim: wrapped ws.send keeps the (data, options, cb) arity and forwards the callback", () => {
  const calls = [];
  const ws = {
    emit() {},
    send(data, options, cb) {
      calls.push([data, options]);
      (typeof options === "function" ? options : cb)?.();
    },
  };
  attachWsSocketBridge(ws);
  assert.ok(ws.send.length >= 2, "Paseo waits for the write callback only when send.length >= 2");
  let called = false;
  ws.send("frame", () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(calls[0][0], "frame");
});

test("frontend bridge: bb and cc owners each claim their own prefix, normal items stay", async () => {
  const proto = { set: Map.prototype.set };
  const interceptor = createScopedQueueMapInterceptor({ targetMapPrototype: proto });
  const ingested = { bb: [], cc: [] };
  const holds = { bb: [], cc: [] };
  const owner = (name, regex) => ({
    id: name,
    matches: (text) => regex.test(text),
    hasAgent: (agentId) => agentId === "a1",
    async ingest(payload) {
      ingested[name].push(payload.text);
    },
    setFrontendHold(agentId, has) {
      holds[name].push(has);
    },
    reportError(message) {
      throw new Error(message);
    },
  });
  const removeBb = interceptor.registerOwner(owner("bb", /^\s*bb[^\S\r\n]+/i));
  const removeCc = interceptor.registerOwner(owner("cc", /^\s*cc[^\S\r\n]+/i));

  const map = new Map();
  const item = (id, text) => ({ id: `msg_${id}`, text, attachments: [] });
  proto.set.call(map, "a1", [item(1, "bb one"), item(2, "plain"), item(3, "cc later")]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(ingested, { bb: ["bb one"], cc: ["cc later"] });
  assert.deepEqual(
    map.get("a1").map((entry) => entry.text),
    ["plain"],
    "normal frontend items stay in the native queue",
  );
  assert.deepEqual(holds, { bb: [true], cc: [true] }, "both backends hold for the frontend queue");

  removeCc();
  removeBb();
  assert.equal(proto.set, Map.prototype.set, "patch removed once no owner is left");
});

test("frontend bridge: a message the backend keeps refusing goes back to the input box", async () => {
  const proto = { set: Map.prototype.set };
  const interceptor = createScopedQueueMapInterceptor({ targetMapPrototype: proto });
  let attempts = 0;
  const restored = [];
  const errors = [];
  const remove = interceptor.registerOwner({
    id: "bb",
    hasAgent: () => true,
    async ingest() {
      attempts += 1;
      throw new Error("服务端入队失败");
    },
    setFrontendHold() {},
    reportError(message) {
      errors.push(message);
    },
    restore(agentId, text) {
      restored.push([agentId, text]);
      return true;
    },
  });
  proto.set.call(new Map(), "a1", [{ id: "msg_x", text: "bb 别丢了", attachments: [] }]);
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  assert.equal(attempts, 2, "one retry before giving up");
  assert.deepEqual(restored, [["a1", "bb 别丢了"]]);
  assert.match(errors[0], /已放回输入框/);
  remove();
});

test("frontend bridge: uninstall leaves a patch that was layered on top alone", () => {
  const proto = { set: Map.prototype.set };
  const interceptor = createScopedQueueMapInterceptor({ targetMapPrototype: proto });
  const remove = interceptor.registerOwner({
    id: "bb",
    hasAgent: () => false,
    async ingest() {},
    setFrontendHold() {},
    reportError() {},
  });
  const ours = proto.set;
  const foreign = function foreignSet(...args) {
    return ours.apply(this, args);
  };
  proto.set = foreign;
  remove();
  assert.equal(proto.set, foreign, "a later wrapper is not clobbered");
});
