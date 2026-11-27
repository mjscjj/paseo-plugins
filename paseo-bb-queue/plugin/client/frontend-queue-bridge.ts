import { BB_PREFIX_REGEX } from "../shared/contracts.ts";

export interface RawImageAttachmentMetadata {
  id: string;
  mimeType: string;
  storageType: string;
  storageKey: string;
  fileName?: string | null;
}

export interface RawComposerQueuedItem {
  id: string;
  text: string;
  attachments: readonly Record<string, unknown>[];
}

export interface ConvertedIngestPayload {
  agentId: string;
  text: string;
  messageId: string;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: unknown[];
}

export interface FrontendQueueOwner {
  readonly id: string;
  /** Whether a frontend-queued message belongs to this owner. Defaults to the "bb " prefix. */
  matches?(text: string): boolean;
  hasAgent(agentId: string): boolean;
  ingest(payload: ConvertedIngestPayload): Promise<void>;
  setFrontendHold(agentId: string, hasFrontendItems: boolean): void;
  reportError(message: string): void;
  /** Puts a message the backend could not take back into the agent's input box. */
  restore?(agentId: string, text: string): boolean;
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// V2 is shared by every prefix-queue plugin (bb-queue, cc-queue): one Map.prototype.set patch,
// many owners, each claiming the frontend-queued messages its `matches` accepts.
const BRIDGE_GLOBAL_KEY = "__PASEO_PREFIX_QUEUE_FRONTEND_BRIDGE_V2__";
const SEEN_IDS_CAP = 256;
const HOLD_HEARTBEAT_MS = 25_000;
const INGEST_RETRY_DELAY_MS = 1_500;

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < len ? bytes[i + 1]! : 0;
    const b2 = i + 2 < len ? bytes[i + 2]! : 0;
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < len ? BASE64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < len ? BASE64_CHARS[b2 & 63] : "=";
  }
  return out;
}

function fileUriToPath(value: string): string {
  if (!value.startsWith("file://")) return value;
  const withoutScheme = decodeURIComponent(value.slice("file://".length));
  return /^\/[A-Za-z]:\//.test(withoutScheme) ? withoutScheme.slice(1) : withoutScheme;
}

function pathToFileUri(value: string): string {
  if (value.startsWith("file://")) return value;
  if (value.startsWith("/")) return `file://${value}`;
  return `file:///${value.replace(/\\/g, "/")}`;
}

async function readIndexedDbAttachmentBase64(storageKey: string): Promise<string> {
  const idb = (globalThis as Record<string, unknown>).indexedDB as
    | {
        open(
          name: string,
          version: number,
        ): {
          result: {
            objectStoreNames: { contains(name: string): boolean };
            createObjectStore(name: string, opts: { keyPath: string }): void;
            transaction(
              storeName: string,
              mode: string,
            ): {
              objectStore(name: string): {
                get(key: string): {
                  result?: { blob?: { arrayBuffer(): Promise<ArrayBuffer> } };
                  error?: Error;
                  addEventListener(type: string, cb: () => void): void;
                };
              };
              addEventListener(type: string, cb: () => void): void;
              error?: Error;
            };
            close(): void;
          };
          error?: Error;
          onupgradeneeded: (() => void) | null;
          addEventListener(type: string, cb: () => void): void;
        };
      }
    | undefined;

  if (!idb) {
    throw new Error("当前环境不支持读取 IndexedDB 图片附件");
  }

  const db = await new Promise<ReturnType<typeof idb.open>["result"]>((resolve, reject) => {
    const req = idb.open("paseo-attachment-bytes", 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("attachments")) {
        req.result.createObjectStore("attachments", { keyPath: "id" });
      }
    };
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () =>
      reject(req.error ?? new Error("无法打开图片缓存库")),
    );
  });

  try {
    const record = await new Promise<{ blob?: { arrayBuffer(): Promise<ArrayBuffer> } } | undefined>(
      (resolve, reject) => {
        const tx = db.transaction("attachments", "readonly");
        const getReq = tx.objectStore("attachments").get(storageKey);
        getReq.addEventListener("success", () => resolve(getReq.result));
        getReq.addEventListener("error", () =>
          reject(getReq.error ?? new Error("读取图片缓存失败")),
        );
        tx.addEventListener("error", () =>
          reject(tx.error ?? new Error("图片缓存事务失败")),
        );
      },
    );
    if (!record?.blob) {
      throw new Error(`未找到缓存图片: ${storageKey}`);
    }
    const buf = await record.blob.arrayBuffer();
    return uint8ArrayToBase64(new Uint8Array(buf));
  } finally {
    db.close();
  }
}

async function encodeImageMetadata(meta: RawImageAttachmentMetadata): Promise<{
  data: string;
  mimeType: string;
}> {
  if (meta.storageType === "web-indexeddb") {
    const data = await readIndexedDbAttachmentBase64(meta.storageKey);
    return { data, mimeType: meta.mimeType };
  }

  if (meta.storageType === "desktop-file") {
    const win = (globalThis as Record<string, unknown>).window as
      | {
          paseoDesktop?: {
            invoke?(cmd: string, args: Record<string, unknown>): Promise<string>;
          };
        }
      | undefined;
    const invoke = win?.paseoDesktop?.invoke;
    if (typeof invoke !== "function") {
      throw new Error("桌面端文件读取接口不可用");
    }
    const data = await invoke("read_file_base64", {
      path: fileUriToPath(meta.storageKey),
    });
    return { data, mimeType: meta.mimeType };
  }

  if (meta.storageType === "native-file") {
    const fetchFn = (globalThis as Record<string, unknown>).fetch as
      | ((url: string) => Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>)
      | undefined;
    if (typeof fetchFn !== "function") {
      throw new Error("移动端文件读取接口不可用");
    }
    const resp = await fetchFn(pathToFileUri(meta.storageKey));
    if (!resp.ok) {
      throw new Error(`读取本地图片失败: ${meta.storageKey}`);
    }
    const buf = await resp.arrayBuffer();
    return { data: uint8ArrayToBase64(new Uint8Array(buf)), mimeType: meta.mimeType };
  }

  throw new Error(`不支持的图片附件存储类型: ${meta.storageType}`);
}

function isPullRequestContextKind(kind: unknown): boolean {
  return (
    kind === "forge.change_request_comment" ||
    kind === "forge.change_request_review" ||
    kind === "forge.change_request_check" ||
    kind === "github.pull_request_comment" ||
    kind === "github.pull_request_review" ||
    kind === "github.pull_request_check"
  );
}

export async function convertComposerAttachmentsForIngest(
  rawAttachments: readonly Record<string, unknown>[],
  encodeImage: (meta: RawImageAttachmentMetadata) => Promise<{
    data: string;
    mimeType: string;
  }> = encodeImageMetadata,
): Promise<{
  images: Array<{ data: string; mimeType: string }>;
  attachments: unknown[];
}> {
  const images: Array<{ data: string; mimeType: string }> = [];
  const attachments: unknown[] = [];

  for (const entry of rawAttachments) {
    const kind = entry.kind;

    if (kind === "image") {
      const meta = entry.metadata as RawImageAttachmentMetadata | undefined;
      if (!meta || typeof meta.storageType !== "string" || typeof meta.storageKey !== "string") {
        throw new Error("图片附件缺少元数据");
      }
      images.push(await encodeImage(meta));
      continue;
    }

    if (kind === "file") {
      if (!entry.attachment) throw new Error("文件附件缺少内容");
      attachments.push(entry.attachment);
      continue;
    }

    if (kind === "workspace_file") {
      const filePath = String(entry.path ?? "");
      const title = filePath.split("/").pop() ?? filePath;
      const sel = entry.selection as
        | { kind: "whole_file" }
        | { kind: "line_range"; startLine: number; endLine: number }
        | undefined;
      const lines =
        sel?.kind === "line_range" ? `\nLines: ${sel.startLine}-${sel.endLine}` : "";
      attachments.push({
        type: "text",
        mimeType: "text/plain",
        title,
        text: `Workspace file: ${filePath}${lines}`,
      });
      continue;
    }

    if (kind === "plugin_resource") {
      const item = entry.item as Record<string, string> | undefined;
      if (!item) throw new Error("插件资源附件缺少内容");
      attachments.push({
        type: "text",
        mimeType: "text/plain",
        title: `${item.identifier} ${item.title}`,
        text: item.text,
        externalResource: {
          provider: entry.pluginId,
          providerLabel: entry.sourceTitle,
          resourceType: item.resourceType,
          id: item.id,
          identifier: item.identifier,
          title: item.title,
          url: item.url,
        },
      });
      continue;
    }

    if (kind === "browser_element") {
      const browserAtt = entry.attachment as
        | { tag: string; formatted: string; screenshot?: RawImageAttachmentMetadata }
        | undefined;
      if (!browserAtt) throw new Error("浏览器元素附件缺少内容");
      if (browserAtt.screenshot) {
        images.push(await encodeImage(browserAtt.screenshot));
      }
      attachments.push({
        type: "text",
        mimeType: "text/plain",
        title: `Browser element · ${browserAtt.tag}`,
        text: browserAtt.formatted,
      });
      continue;
    }

    if (kind === "chat_history" || kind === "review") {
      if (entry.attachment) attachments.push(entry.attachment);
      continue;
    }

    if (isPullRequestContextKind(kind)) {
      attachments.push({
        type: "text",
        mimeType: "text/plain",
        title: entry.title,
        text: entry.text,
      });
      continue;
    }

    if (entry.item && typeof entry.item === "object") {
      const searchItem = entry.item as Record<string, unknown>;
      if (searchItem.kind === "change_request") {
        attachments.push({
          type: "forge_change_request",
          mimeType: "application/paseo-forge-change-request",
          forge: (searchItem.forge as string | undefined) ?? "github",
          number: searchItem.number,
          title: searchItem.title,
          url: searchItem.url,
          ...(searchItem.body ? { body: searchItem.body } : {}),
          ...(searchItem.projectPath ? { projectPath: searchItem.projectPath } : {}),
          ...(searchItem.baseRefName ? { baseRefName: searchItem.baseRefName } : {}),
          ...(searchItem.headRefName ? { headRefName: searchItem.headRefName } : {}),
        });
        continue;
      }
      if (searchItem.kind === "issue") {
        attachments.push({
          type: "forge_issue",
          mimeType: "application/paseo-forge-issue",
          forge: (searchItem.forge as string | undefined) ?? "github",
          number: searchItem.number,
          title: searchItem.title,
          url: searchItem.url,
          ...(searchItem.body ? { body: searchItem.body } : {}),
          ...(searchItem.projectPath ? { projectPath: searchItem.projectPath } : {}),
        });
        continue;
      }
    }

    throw new Error(`暂不支持在前端排队模式下转换该附件类型 (${String(kind)})`);
  }

  return { images, attachments };
}

export function isComposerQueueItem(value: unknown): value is RawComposerQueuedItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.id !== "string" ||
    !obj.id.startsWith("msg_") ||
    typeof obj.text !== "string" ||
    !Array.isArray(obj.attachments)
  ) {
    return false;
  }
  // Exclude timeline items (`kind`), submissions (`clientMessageId`), and tasks (`completed`).
  return !("kind" in obj) && !("clientMessageId" in obj) && !("completed" in obj);
}

export function isComposerQueueList(value: unknown): value is RawComposerQueuedItem[] {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (!isComposerQueueItem(value[i])) return false;
  }
  return true;
}

interface GlobalBridgeState {
  readonly rawMapSet: typeof Map.prototype.set;
  readonly owners: Map<string, FrontendQueueOwner>;
  readonly heldAgentsByOwner: Map<string, Set<string>>;
  readonly seenItemIds: Set<string>;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  installed: boolean;
}

export function createScopedQueueMapInterceptor(options?: {
  targetMapPrototype?: { set: typeof Map.prototype.set };
  encodeImage?: typeof encodeImageMetadata;
}) {
  const proto = options?.targetMapPrototype ?? Map.prototype;
  const encodeImage = options?.encodeImage ?? encodeImageMetadata;
  const rawMapSet = proto.set;
  const owners = new Map<string, FrontendQueueOwner>();
  const heldAgentsByOwner = new Map<string, Set<string>>();
  const seenItemIds = new Set<string>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let installed = false;
  let patchedSet: typeof Map.prototype.set | null = null;

  function ownersFor(agentId: string): FrontendQueueOwner[] {
    const result: FrontendQueueOwner[] = [];
    for (const owner of owners.values()) {
      if (owner.hasAgent(agentId)) result.push(owner);
    }
    return result;
  }

  function ownerMatches(owner: FrontendQueueOwner, text: string): boolean {
    return owner.matches ? owner.matches(text) : BB_PREFIX_REGEX.test(text);
  }

  function recordSeen(itemId: string): boolean {
    if (seenItemIds.has(itemId)) return false;
    seenItemIds.add(itemId);
    if (seenItemIds.size > SEEN_IDS_CAP) {
      const oldest = seenItemIds.values().next().value;
      if (oldest !== undefined) seenItemIds.delete(oldest);
    }
    return true;
  }

  function updateHoldState(owner: FrontendQueueOwner, agentId: string, hasNormalItems: boolean): void {
    let set = heldAgentsByOwner.get(owner.id);
    if (!set) {
      set = new Set();
      heldAgentsByOwner.set(owner.id, set);
    }
    const had = set.has(agentId);
    if (hasNormalItems && !had) {
      set.add(agentId);
      owner.setFrontendHold(agentId, true);
    } else if (!hasNormalItems && had) {
      set.delete(agentId);
      owner.setFrontendHold(agentId, false);
    }
  }

  function forwardItemToBackend(
    owner: FrontendQueueOwner,
    agentId: string,
    item: RawComposerQueuedItem,
  ): void {
    // Start reading/converting attachments immediately before DraftStore GC can run.
    const conversionPromise = convertComposerAttachmentsForIngest(item.attachments, encodeImage);
    queueMicrotask(() => {
      void conversionPromise
        .then(async ({ images, attachments }) => {
          const payload: ConvertedIngestPayload = {
            agentId,
            text: item.text,
            messageId: item.id,
            ...(images.length > 0 ? { images } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          };
          try {
            await owner.ingest(payload);
          } catch {
            // One retry covers a dropped connection; a second failure is reported below.
            await new Promise((resolve) => setTimeout(resolve, INGEST_RETRY_DELAY_MS));
            await owner.ingest(payload);
          }
        })
        .catch((err) => {
          // The message already left the native queue; hand the text back instead of losing it.
          const message = err instanceof Error ? err.message : String(err);
          let restored = false;
          try {
            restored = owner.restore?.(agentId, item.text) ?? false;
          } catch {
            restored = false;
          }
          owner.reportError(restored ? `${message}（内容已放回输入框）` : `${message}\n\n未能入队的内容：\n${item.text}`);
        });
    });
  }

  function install(): void {
    if (installed) return;
    installed = true;
    proto.set = patchedSet = function prefixQueueAwareMapSet(
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (typeof key === "string" && Array.isArray(value)) {
        const agentOwners = ownersFor(key);
        if (agentOwners.length > 0) {
          if (value.length === 0) {
            for (const owner of agentOwners) updateHoldState(owner, key, false);
            return rawMapSet.call(this, key, value);
          }
          if (isComposerQueueList(value)) {
            const normalItems: RawComposerQueuedItem[] = [];
            const routedItems: Array<{ owner: FrontendQueueOwner; item: RawComposerQueuedItem }> = [];
            for (const item of value) {
              const owner = agentOwners.find((candidate) => ownerMatches(candidate, item.text));
              if (owner) {
                routedItems.push({ owner, item });
              } else {
                normalItems.push(item);
              }
            }
            for (const owner of agentOwners) {
              updateHoldState(owner, key, normalItems.length > 0);
            }
            if (routedItems.length > 0) {
              if (normalItems.length > 0) {
                rawMapSet.call(this, key, normalItems);
              } else {
                this.delete(key);
              }
              for (const { owner, item } of routedItems) {
                if (recordSeen(item.id)) {
                  forwardItemToBackend(owner, key, item);
                }
              }
              return this;
            }
          }
        }
      }
      return rawMapSet.call(this, key, value);
    };

    heartbeatTimer = setInterval(() => {
      for (const [ownerId, agentIds] of heldAgentsByOwner.entries()) {
        const owner = owners.get(ownerId);
        if (!owner) continue;
        for (const agentId of agentIds) {
          owner.setFrontendHold(agentId, true);
        }
      }
    }, HOLD_HEARTBEAT_MS);
    (heartbeatTimer as { unref?: () => void }).unref?.();
  }

  function uninstallIfUnused(): void {
    if (!installed || owners.size > 0) return;
    installed = false;
    // Only undo our own patch: another code path may have wrapped Map.prototype.set after us.
    if (proto.set === patchedSet) proto.set = rawMapSet;
    patchedSet = null;
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  return {
    registerOwner(owner: FrontendQueueOwner): () => void {
      owners.set(owner.id, owner);
      install();
      return () => {
        const held = heldAgentsByOwner.get(owner.id);
        if (held) {
          for (const agentId of held) {
            owner.setFrontendHold(agentId, false);
          }
          heldAgentsByOwner.delete(owner.id);
        }
        owners.delete(owner.id);
        uninstallIfUnused();
      };
    },
  };
}

function getGlobalBridge(): ReturnType<typeof createScopedQueueMapInterceptor> {
  const g = globalThis as Record<string, unknown>;
  let existing = g[BRIDGE_GLOBAL_KEY] as
    | (GlobalBridgeState & { api: ReturnType<typeof createScopedQueueMapInterceptor> })
    | undefined;
  if (!existing) {
    const api = createScopedQueueMapInterceptor();
    existing = {
      rawMapSet: Map.prototype.set,
      owners: new Map(),
      heldAgentsByOwner: new Map(),
      seenItemIds: new Set(),
      heartbeatTimer: null,
      installed: false,
      api,
    };
    g[BRIDGE_GLOBAL_KEY] = existing;
  }
  return existing.api;
}

export function registerFrontendQueueBridgeOwner(owner: FrontendQueueOwner): () => void {
  return getGlobalBridge().registerOwner(owner);
}
