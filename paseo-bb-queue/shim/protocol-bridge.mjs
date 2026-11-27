import { randomUUID } from "node:crypto";

export const BB_PLUGIN_ID = "bb-queue";
export const BB_INGEST_METHOD = "bb.ingest";
export const BB_PREFIX = "bb ";
export const BB_PREFIX_REGEX = /^\s*bb[^\S\r\n]+/i;
export const CC_PLUGIN_ID = "cc-queue";
export const CC_INGEST_METHOD = "cc.ingest";
export const CC_PREFIX_REGEX = /^\s*cc[^\S\r\n]+/i;
const BRIDGE_REQ_PREFIX = "__bbq_";

/** Prefix routes: a user message starting with the prefix goes to that plugin's ingest RPC. */
export const PREFIX_ROUTES = [
  { regex: BB_PREFIX_REGEX, pluginId: BB_PLUGIN_ID, method: BB_INGEST_METHOD },
  { regex: CC_PREFIX_REGEX, pluginId: CC_PLUGIN_ID, method: CC_INGEST_METHOD },
];

function findRoute(text) {
  return PREFIX_ROUTES.find((route) => route.regex.test(text)) ?? null;
}

function decodeUtf8Frame(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data) && data.every((chunk) => Buffer.isBuffer(chunk))) {
    return Buffer.concat(data).toString("utf8");
  }
  return null;
}

export function createConnectionBridge() {
  const pending = new Map();

  function transformInboundText(text) {
    if (!text.includes("send_agent_message_request")) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.type !== "session" ||
      typeof parsed.message !== "object" ||
      parsed.message === null
    ) {
      return null;
    }
    const msg = parsed.message;
    if (
      msg.type !== "send_agent_message_request" ||
      typeof msg.requestId !== "string" ||
      typeof msg.agentId !== "string" ||
      Boolean(msg.sourceAgentId) ||
      typeof msg.text !== "string"
    ) {
      return null;
    }
    const route = findRoute(msg.text);
    if (!route) {
      return null;
    }

    const bridgeRequestId = `${BRIDGE_REQ_PREFIX}${randomUUID()}`;
    pending.set(bridgeRequestId, {
      originalRequestId: msg.requestId,
      agentId: msg.agentId,
      pluginId: route.pluginId,
    });

    return JSON.stringify({
      type: "session",
      message: {
        type: "plugin.rpc.invoke.request",
        requestId: bridgeRequestId,
        pluginId: route.pluginId,
        method: route.method,
        input: {
          agentId: msg.agentId,
          text: msg.text,
          ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
          ...(msg.sessionMode !== undefined ? { sessionMode: msg.sessionMode } : {}),
          ...(msg.images !== undefined ? { images: msg.images } : {}),
          ...(msg.attachments !== undefined ? { attachments: msg.attachments } : {}),
        },
      },
    });
  }

  function transformOutboundText(text) {
    if (pending.size === 0 || !text.includes(BRIDGE_REQ_PREFIX)) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      parsed.type !== "session" ||
      typeof parsed.message !== "object" ||
      parsed.message === null
    ) {
      return null;
    }

    const msg = parsed.message;
    const reqId = msg.payload?.requestId;
    if (typeof reqId !== "string" || !pending.has(reqId)) {
      return null;
    }

    if (msg.type === "plugin.rpc.invoke.response") {
      const entry = pending.get(reqId);
      pending.delete(reqId);
      const output = msg.payload?.output;
      if (typeof output !== "object" || output === null || typeof output.accepted !== "boolean") {
        return JSON.stringify({
          type: "session",
          message: {
            type: "send_agent_message_response",
            payload: {
              requestId: entry.originalRequestId,
              agentId: entry.agentId,
              accepted: false,
              error: `Invalid response from ${entry.pluginId} plugin`,
            },
          },
        });
      }
      return JSON.stringify({
        type: "session",
        message: {
          type: "send_agent_message_response",
          payload: {
            requestId: entry.originalRequestId,
            agentId: typeof output.agentId === "string" ? output.agentId : entry.agentId,
            accepted: output.accepted,
            ...(output.deliveryStatus === "queued" ? { deliveryStatus: "queued" } : {}),
            error: typeof output.error === "string" ? output.error : null,
          },
        },
      });
    }

    if (msg.type === "rpc_error") {
      const entry = pending.get(reqId);
      pending.delete(reqId);
      return JSON.stringify({
        type: "session",
        message: {
          type: "send_agent_message_response",
          payload: {
            requestId: entry.originalRequestId,
            agentId: entry.agentId,
            accepted: false,
            error:
              typeof msg.payload?.error === "string"
                ? msg.payload.error
                : `${entry.pluginId} plugin unavailable`,
          },
        },
      });
    }

    return null;
  }

  function clear() {
    pending.clear();
  }

  return {
    transformInboundText,
    transformOutboundText,
    clear,
    get pendingCount() {
      return pending.size;
    },
  };
}

let wsServerInstantiatedCount = 0;

export function getWsServerInstantiatedCount() {
  return wsServerInstantiatedCount;
}

export function attachWsSocketBridge(ws) {
  const bridge = createConnectionBridge();
  const rawEmit = ws.emit.bind(ws);
  const rawSend = ws.send.bind(ws);

  ws.emit = function bridgedEmit(event, ...args) {
    if (event === "message") {
      const [data, isBinary] = args;
      if (!isBinary) {
        const text = decodeUtf8Frame(data);
        if (text !== null) {
          const rewritten = bridge.transformInboundText(text);
          if (rewritten !== null) {
            return rawEmit("message", Buffer.from(rewritten, "utf8"), false);
          }
        }
      }
    } else if (event === "close") {
      bridge.clear();
    }
    return rawEmit(event, ...args);
  };

  ws.send = function bridgedSend(data, ...rest) {
    if (typeof data === "string") {
      const rewritten = bridge.transformOutboundText(data);
      if (rewritten !== null) {
        return rawSend(rewritten, ...rest);
      }
    } else if (Buffer.isBuffer(data)) {
      // Only inspect when pending requests exist; binary terminal frames have no pending match.
      if (bridge.pendingCount > 0) {
        const rewritten = bridge.transformOutboundText(data.toString("utf8"));
        if (rewritten !== null) {
          return rawSend(Buffer.from(rewritten, "utf8"), ...rest);
        }
      }
    }
    return rawSend(data, ...rest);
  };

  return ws;
}

export function wrapWebSocketServerClass(RawWebSocketServer) {
  return class BbBridgedWebSocketServer extends RawWebSocketServer {
    constructor(...args) {
      super(...args);
      wsServerInstantiatedCount += 1;
    }

    emit(event, ...args) {
      if (event === "connection" && args[0]) {
        attachWsSocketBridge(args[0]);
      }
      return super.emit(event, ...args);
    }
  };
}

function wrapRelayEvents(bridge, rawEvents = {}) {
  return {
    ...rawEvents,
    onmessage: rawEvents.onmessage
      ? (data) => {
          if (typeof data === "string") {
            const rewritten = bridge.transformInboundText(data);
            if (rewritten !== null) {
              rawEvents.onmessage(rewritten);
              return;
            }
          }
          rawEvents.onmessage(data);
        }
      : undefined,
    onclose: (...closeArgs) => {
      bridge.clear();
      rawEvents.onclose?.(...closeArgs);
    },
  };
}

function wrapRelayChannelSend(bridge, channel) {
  const rawSend = channel.send.bind(channel);
  channel.send = (data) => {
    if (typeof data === "string") {
      const rewritten = bridge.transformOutboundText(data);
      if (rewritten !== null) {
        return rawSend(rewritten);
      }
    }
    return rawSend(data);
  };
  return channel;
}

export function wrapCreateDaemonChannel(rawCreateDaemonChannel) {
  return async function bridgedCreateDaemonChannel(transport, daemonKeyPair, events) {
    const bridge = createConnectionBridge();
    const channel = await rawCreateDaemonChannel(
      transport,
      daemonKeyPair,
      wrapRelayEvents(bridge, events),
    );
    return wrapRelayChannelSend(bridge, channel);
  };
}

export function wrapOpenDaemonSecureChannel(rawOpenDaemonSecureChannel) {
  return async function bridgedOpenDaemonSecureChannel(transport, options) {
    const bridge = createConnectionBridge();
    const wrappedOptions = {
      ...options,
      events: wrapRelayEvents(bridge, options?.events),
    };
    const channel = await rawOpenDaemonSecureChannel(transport, wrappedOptions);
    return wrapRelayChannelSend(bridge, channel);
  };
}
