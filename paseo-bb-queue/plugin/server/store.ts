import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  type AgentQueueDetail,
  type AgentQueueSummary,
  BB_PREFIX,
  BB_PREFIX_REGEX,
  ImagePayloadSchema,
  type QueuedItemView,
} from "../shared/contracts.ts";

const HISTORY_CAP = 100;

const StoredQueuedItemSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().optional(),
  text: z.string(),
  images: z.array(ImagePayloadSchema).optional(),
  attachments: z.array(z.unknown()).optional(),
  sessionMode: z.string().optional(),
  createdAt: z.string(),
});

export type StoredQueuedItem = z.infer<typeof StoredQueuedItemSchema>;

const StoredAgentQueueSchema = z.object({
  paused: z.boolean(),
  pauseReason: z.string().nullable(),
  /** Paused by a failed turn: the next completed turn (e.g. an auto-retry) resumes it. */
  resumeOnCompletedTurn: z.boolean().optional(),
  updatedAt: z.string().optional(),
  items: z.array(StoredQueuedItemSchema),
});

const PersistedStoreSchema = z.object({
  version: z.literal(1),
  queues: z.record(z.string(), StoredAgentQueueSchema),
});

interface AgentQueueRecord {
  paused: boolean;
  pauseReason: string | null;
  resumeOnCompletedTurn?: boolean;
  updatedAt: string;
  items: StoredQueuedItem[];
}

export interface EnqueuePayload {
  text: string;
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: unknown[];
  sessionMode?: string;
}

/**
 * Paseo keeps a receipt per messageId, including for sends that failed, so a retried send needs
 * a fresh id or it is refused as already handled.
 */
function withFreshMessageId(item: StoredQueuedItem): StoredQueuedItem {
  if (!item.messageId) return item;
  const base = item.messageId.replace(/~r[0-9a-z]+$/, "");
  return { ...item, messageId: `${base}~r${Date.now().toString(36)}` };
}

export function stripBbPrefix(rawText: string): string {
  if (!BB_PREFIX_REGEX.test(rawText)) {
    throw new Error(`Expected message starting with "${BB_PREFIX}"`);
  }
  return rawText.replace(BB_PREFIX_REGEX, "");
}

export function stripOptionalBbPrefix(rawText: string): string {
  return BB_PREFIX_REGEX.test(rawText) ? rawText.replace(BB_PREFIX_REGEX, "") : rawText;
}

export function assertNonEmptyPayload(payload: {
  text: string;
  images?: unknown[];
  attachments?: unknown[];
}): void {
  const hasText = payload.text.trim().length > 0;
  const hasImages = (payload.images?.length ?? 0) > 0;
  const hasAttachments = (payload.attachments?.length ?? 0) > 0;
  if (!hasText && !hasImages && !hasAttachments) {
    throw new Error("bb 排队消息内容不能为空");
  }
}

function toItemView(item: StoredQueuedItem): QueuedItemView {
  return {
    id: item.id,
    messageId: item.messageId,
    text: item.text,
    imageCount: item.images?.length ?? 0,
    attachmentCount: item.attachments?.length ?? 0,
    sessionMode: item.sessionMode,
    createdAt: item.createdAt,
  };
}

function formatPreview(item: StoredQueuedItem | undefined): string | null {
  if (!item) return null;
  const trimmed = item.text.trim();
  if (trimmed) {
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  }
  const parts: string[] = [];
  if (item.images?.length) parts.push(`图片×${item.images.length}`);
  if (item.attachments?.length) parts.push(`附件×${item.attachments.length}`);
  return parts.length > 0 ? `(${parts.join(" · ")})` : "(空)";
}

export class QueueStore {
  private readonly filePath: string;
  private readonly queues = new Map<string, AgentQueueRecord>();
  private readonly withdrawnByAgent = new Map<string, string[]>();
  private readonly dispatchedByAgent = new Map<string, Map<string, string>>();

  constructor(storageFilePath: string) {
    this.filePath = storageFilePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      return;
    }
    // Fail-fast: if persisted file is corrupted, throw immediately rather than silently wiping user queues.
    const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
    const parsed = PersistedStoreSchema.parse(raw);
    const now = new Date().toISOString();
    for (const [agentId, record] of Object.entries(parsed.queues)) {
      if (record.items.length > 0 || record.paused) {
        this.queues.set(agentId, {
          paused: record.paused,
          pauseReason: record.pauseReason,
          ...(record.resumeOnCompletedTurn ? { resumeOnCompletedTurn: true } : {}),
          updatedAt: record.updatedAt ?? record.items.at(-1)?.createdAt ?? now,
          items: [...record.items],
        });
      }
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const serializedQueues: Record<string, AgentQueueRecord> = {};
    for (const [agentId, record] of this.queues.entries()) {
      if (record.items.length > 0 || record.paused) {
        serializedQueues[agentId] = record;
      }
    }
    const payload = JSON.stringify({ version: 1, queues: serializedQueues }, null, 2);
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, this.filePath);
  }

  private getOrCreate(agentId: string): AgentQueueRecord {
    let record = this.queues.get(agentId);
    if (!record) {
      record = {
        paused: false,
        pauseReason: null,
        updatedAt: new Date().toISOString(),
        items: [],
      };
      this.queues.set(agentId, record);
    }
    return record;
  }

  private pruneIfEmpty(agentId: string): void {
    const record = this.queues.get(agentId);
    if (record && !record.paused && record.items.length === 0) {
      this.queues.delete(agentId);
    }
  }

  private markWithdrawn(agentId: string, messageId: string | undefined): void {
    if (!messageId) return;
    let list = this.withdrawnByAgent.get(agentId);
    if (!list) {
      list = [];
      this.withdrawnByAgent.set(agentId, list);
    }
    if (!list.includes(messageId)) {
      list.push(messageId);
      if (list.length > HISTORY_CAP) {
        list.shift();
      }
    }
  }

  recordDispatched(agentId: string, messageId: string | undefined, text: string): void {
    if (!messageId) return;
    let map = this.dispatchedByAgent.get(agentId);
    if (!map) {
      map = new Map();
      this.dispatchedByAgent.set(agentId, map);
    }
    map.delete(messageId);
    map.set(messageId, text);
    while (map.size > HISTORY_CAP) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  enqueue(agentId: string, payload: EnqueuePayload): StoredQueuedItem {
    assertNonEmptyPayload(payload);
    const record = this.getOrCreate(agentId);
    if (payload.messageId) {
      const existing = record.items.find((entry) => entry.messageId === payload.messageId);
      if (existing) {
        return existing;
      }
    }
    const now = new Date().toISOString();
    const item: StoredQueuedItem = {
      id: randomUUID(),
      ...(payload.messageId ? { messageId: payload.messageId } : {}),
      text: payload.text,
      ...(payload.images && payload.images.length > 0 ? { images: payload.images } : {}),
      ...(payload.attachments && payload.attachments.length > 0
        ? { attachments: payload.attachments }
        : {}),
      ...(payload.sessionMode ? { sessionMode: payload.sessionMode } : {}),
      createdAt: now,
    };
    record.items.push(item);
    record.updatedAt = now;
    this.persist();
    return item;
  }

  /** The item the next dispatch would send, without removing it. */
  peekReady(agentId: string): StoredQueuedItem | null {
    const record = this.queues.get(agentId);
    if (!record || record.paused) return null;
    return record.items[0] ?? null;
  }

  shiftReady(agentId: string): StoredQueuedItem | null {
    const record = this.queues.get(agentId);
    if (!record || record.paused || record.items.length === 0) {
      return null;
    }
    const item = record.items.shift()!;
    record.updatedAt = new Date().toISOString();
    this.pruneIfEmpty(agentId);
    this.persist();
    return item;
  }

  takeItemById(agentId: string, itemId: string): { item: StoredQueuedItem; index: number } {
    const record = this.queues.get(agentId);
    if (!record) {
      throw new Error(`队列不存在: ${agentId}`);
    }
    const index = record.items.findIndex((entry) => entry.id === itemId);
    if (index === -1) {
      throw new Error(`排队消息不存在或已被派发: ${itemId}`);
    }
    const [item] = record.items.splice(index, 1);
    record.updatedAt = new Date().toISOString();
    this.pruneIfEmpty(agentId);
    this.persist();
    return { item, index };
  }

  restoreItemAt(agentId: string, item: StoredQueuedItem, index: number): void {
    item = withFreshMessageId(item);
    const record = this.getOrCreate(agentId);
    const clamped = Math.max(0, Math.min(index, record.items.length));
    record.items.splice(clamped, 0, item);
    record.updatedAt = new Date().toISOString();
    this.persist();
  }

  requeueFrontAndPause(agentId: string, item: StoredQueuedItem, reason: string): void {
    const record = this.getOrCreate(agentId);
    record.items.unshift(withFreshMessageId(item));
    record.paused = true;
    record.pauseReason = reason;
    record.resumeOnCompletedTurn = false;
    record.updatedAt = new Date().toISOString();
    this.persist();
  }

  pauseIfNonEmpty(agentId: string, reason: string, resumeOnCompletedTurn = false): boolean {
    const record = this.queues.get(agentId);
    if (!record || record.items.length === 0 || record.paused) {
      // Already paused (by hand or earlier): keep that reason and do not make it auto-resume.
      return false;
    }
    record.paused = true;
    record.pauseReason = reason;
    record.resumeOnCompletedTurn = resumeOnCompletedTurn;
    record.updatedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  /** Resumes a queue that a failed turn paused, once a later turn completes. */
  resumeAfterCompletedTurn(agentId: string): boolean {
    const record = this.queues.get(agentId);
    if (!record?.paused || !record.resumeOnCompletedTurn) return false;
    record.paused = false;
    record.pauseReason = null;
    record.resumeOnCompletedTurn = false;
    record.updatedAt = new Date().toISOString();
    this.pruneIfEmpty(agentId);
    this.persist();
    return true;
  }

  setPaused(agentId: string, paused: boolean, reason: string | null = null): AgentQueueDetail {
    const record = this.getOrCreate(agentId);
    record.paused = paused;
    record.pauseReason = paused ? (reason ?? "手动暂停") : null;
    record.resumeOnCompletedTurn = false;
    record.updatedAt = new Date().toISOString();
    this.pruneIfEmpty(agentId);
    this.persist();
    return this.getDetail(agentId);
  }

  updateItemText(agentId: string, itemId: string, nextText: string): AgentQueueDetail {
    const record = this.queues.get(agentId);
    if (!record) {
      throw new Error(`队列不存在: ${agentId}`);
    }
    const item = record.items.find((entry) => entry.id === itemId);
    if (!item) {
      throw new Error(`排队消息不存在或已被派发: ${itemId}`);
    }
    const cleanedText = stripOptionalBbPrefix(nextText);
    assertNonEmptyPayload({
      text: cleanedText,
      images: item.images,
      attachments: item.attachments,
    });
    item.text = cleanedText;
    record.updatedAt = new Date().toISOString();
    this.persist();
    return this.getDetail(agentId);
  }

  removeItem(agentId: string, itemId: string): AgentQueueDetail {
    const record = this.queues.get(agentId);
    if (!record) {
      throw new Error(`队列不存在: ${agentId}`);
    }
    const index = record.items.findIndex((entry) => entry.id === itemId);
    if (index === -1) {
      throw new Error(`排队消息不存在: ${itemId}`);
    }
    const [removed] = record.items.splice(index, 1);
    this.markWithdrawn(agentId, removed.messageId);
    record.updatedAt = new Date().toISOString();
    this.pruneIfEmpty(agentId);
    this.persist();
    return this.getDetail(agentId);
  }

  moveItem(agentId: string, itemId: string, direction: "up" | "down"): AgentQueueDetail {
    const record = this.queues.get(agentId);
    if (!record) {
      throw new Error(`队列不存在: ${agentId}`);
    }
    const index = record.items.findIndex((entry) => entry.id === itemId);
    if (index === -1) {
      throw new Error(`排队消息不存在: ${itemId}`);
    }
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= record.items.length) {
      return this.getDetail(agentId);
    }
    const [item] = record.items.splice(index, 1);
    record.items.splice(target, 0, item);
    record.updatedAt = new Date().toISOString();
    this.persist();
    return this.getDetail(agentId);
  }

  clear(agentId: string): AgentQueueDetail {
    const record = this.queues.get(agentId);
    if (record) {
      for (const item of record.items) {
        this.markWithdrawn(agentId, item.messageId);
      }
    }
    this.queues.delete(agentId);
    this.persist();
    return this.getDetail(agentId);
  }

  purgeAgent(agentId: string): void {
    this.queues.delete(agentId);
    this.withdrawnByAgent.delete(agentId);
    this.dispatchedByAgent.delete(agentId);
    this.persist();
  }

  hasPendingOrPaused(agentId: string): boolean {
    const record = this.queues.get(agentId);
    return Boolean(record && (record.paused || record.items.length > 0));
  }

  hasReadyItems(agentId: string): boolean {
    const record = this.queues.get(agentId);
    return Boolean(record && !record.paused && record.items.length > 0);
  }

  listReadyAgentIds(): string[] {
    const result: string[] = [];
    for (const [agentId, record] of this.queues.entries()) {
      if (!record.paused && record.items.length > 0) {
        result.push(agentId);
      }
    }
    return result;
  }

  getSummaries(): AgentQueueSummary[] {
    const summaries: AgentQueueSummary[] = [];
    for (const [agentId, record] of this.queues.entries()) {
      if (record.items.length > 0 || record.paused) {
        summaries.push({
          agentId,
          count: record.items.length,
          paused: record.paused,
          pauseReason: record.pauseReason,
          firstItemPreview: formatPreview(record.items[0]),
          updatedAt: record.updatedAt,
        });
      }
    }
    summaries.sort((a, b) => {
      if (a.paused !== b.paused) return a.paused ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return summaries;
  }

  getDetail(agentId: string): AgentQueueDetail {
    const record = this.queues.get(agentId);
    const withdrawnMessageIds = [...(this.withdrawnByAgent.get(agentId) ?? [])];
    const dispatchedTexts = Object.fromEntries(this.dispatchedByAgent.get(agentId) ?? []);
    if (!record) {
      return {
        agentId,
        paused: false,
        pauseReason: null,
        items: [],
        withdrawnMessageIds,
        dispatchedTexts,
      };
    }
    return {
      agentId,
      paused: record.paused,
      pauseReason: record.pauseReason,
      items: record.items.map(toItemView),
      withdrawnMessageIds,
      dispatchedTexts,
    };
  }
}
