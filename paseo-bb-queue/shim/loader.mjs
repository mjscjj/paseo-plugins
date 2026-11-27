import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BRIDGE_URL = new URL("./protocol-bridge.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.includes("?bb_")) {
    return nextResolve(specifier, context);
  }
  if (specifier === "ws") {
    const real = await nextResolve(specifier, context);
    return { url: `${real.url}?bb_wrap=ws`, shortCircuit: true };
  }
  if (specifier === "@getpaseo/relay/e2ee") {
    const real = await nextResolve(specifier, context);
    return { url: `${real.url}?bb_wrap=relay_e2ee`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith("?bb_wrap=ws")) {
    const realUrl = `${url.slice(0, -"?bb_wrap=ws".length)}?bb_raw=1`;
    return {
      format: "module",
      shortCircuit: true,
      source: [
        `import * as raw from ${JSON.stringify(realUrl)};`,
        `import { wrapWebSocketServerClass } from ${JSON.stringify(BRIDGE_URL)};`,
        `export * from ${JSON.stringify(realUrl)};`,
        `export const WebSocketServer = wrapWebSocketServerClass(raw.WebSocketServer);`,
        `export default raw.default;`,
      ].join("\n"),
    };
  }
  if (url.endsWith("?bb_wrap=relay_e2ee")) {
    const cleanUrl = url.slice(0, -"?bb_wrap=relay_e2ee".length);
    const realUrl = `${cleanUrl}?bb_raw=1`;
    const fileContent = readFileSync(fileURLToPath(cleanUrl), "utf8");
    const hasCreateChannel = /\bcreateDaemonChannel\b/.test(fileContent);
    const hasOpenSecure = /\bopenDaemonSecureChannel\b/.test(fileContent);
    if (!hasCreateChannel && !hasOpenSecure) {
      throw new Error(
        `[bb-queue-shim] Unsupported @getpaseo/relay/e2ee exports in ${cleanUrl}`,
      );
    }
    const lines = [
      `import * as raw from ${JSON.stringify(realUrl)};`,
      `import { wrapCreateDaemonChannel, wrapOpenDaemonSecureChannel } from ${JSON.stringify(BRIDGE_URL)};`,
      `export * from ${JSON.stringify(realUrl)};`,
    ];
    if (hasCreateChannel) {
      lines.push(
        `export const createDaemonChannel = wrapCreateDaemonChannel(raw.createDaemonChannel);`,
      );
    }
    if (hasOpenSecure) {
      lines.push(
        `export const openDaemonSecureChannel = wrapOpenDaemonSecureChannel(raw.openDaemonSecureChannel);`,
      );
    }
    return {
      format: "module",
      shortCircuit: true,
      source: lines.join("\n"),
    };
  }
  if (url.endsWith("?bb_raw=1")) {
    return nextLoad(url.slice(0, -"?bb_raw=1".length), context);
  }
  return nextLoad(url, context);
}
