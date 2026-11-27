import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  type AgentQueueDetail,
  type AgentQueueSummary,
  CC_PREFIX,
  CC_PREFIX_REGEX,
  ImagePayloadSchema,
  type QueuedItemView,
} from "../shared/cc-contracts.ts";

const HISTORY_CAP = 100;

const StoredQueuedItemSchema = z.object({
  id: z.string().min(1),
  messageId: z.string().optional(),
  text: z.string(),
  images: z.array(ImagePayloadSchema).optional(),
  attachments: z.array(z.unknown()).optional(),
  sessionMode: z.string().optional(),
  createdAt: z.string(),
  dueAt: z.string(),
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

export function stripCcPrefix(rawText: string): string {
  if (!CC_PREFIX_REGEX.test(rawText)) {
    throw new Error(`Expected message starting with "${CC_PREFIX}"`);
  }
  return rawText.replace(CC_PREFIX_REGEX, "");
}

export function stripOptionalCcPrefix(rawText: string): string {
  return CC_PREFIX_REGEX.test(rawText) ? rawText.replace(CC_PREFIX_REGEX, "") : rawText;
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
    throw new Error("cc 定时消息内容不能为空");
  }
}

/** The next slot: one interval after the last pending item, or after now when none is pending. */
export function computeNextDueAt(
  lastPendingDueAt: string | null,
  nowMs: number,
  intervalMinutes: number,
): Date {
  const lastMs = lastPendingDueAt ? Date.parse(lastPendingDueAt) : Number.NaN;
  const anchor = Number.isNaN(lastMs) ? nowMs : Math.max(nowMs, lastMs);
  return new Date(anchor + intervalMinutes * 60_000);
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
    dueAt: item.dueAt,
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

/**
 * Paseo keeps a receipt per messageId, including for sends that failed, so a retried send needs
 * a fresh id or it is refused as already handled.
 */
function withFreshMessageId(item: StoredQueuedItem): StoredQueuedItem {
  if (!item.messageId) return item;
  const base = item.messageId.replace(/~r[0-9a-z]+$/, "");
  return { ...item, messageId: `${base}~r${Date.now().toString(36)}` };
}

function isDue(item: StoredQueuedItem, nowMs: number): boolean {
  const due = Date.parse(item.dueAt);
  return Number.isNaN(due) || due <= nowMs;
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
    // Fail fast on a corrupted file rather than silently wiping scheduled messages.
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
          items: [...record.items].sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
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
      if (list.length > HISTORY_CAP) list.shift();
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

  lastPendingDueAt(agentId: string): string | null {
    return this.queues.get(agentId)?.items.at(-1)?.dueAt ?? null;
  }

  /** Schedules the payload one interval after the last pending item (or after now). */
  enqueue(
    agentId: string,
    payload: EnqueuePayload,
    options: { intervalMinutes: number; nowMs?: number },
  ): StoredQueuedItem {
    assertNonEmptyPayload(payload);
    const record = this.getOrCreate(agentId);
    if (payload.messageId) {
      const existing = record.items.find((entry) => entry.messageId === payload.messageId);
      if (existing) return existing;
    }
    const nowMs = options.nowMs ?? Date.now();
    const dueAt = computeNextDueAt(this.lastPendingDueAt(agentId), nowMs, options.intervalMinutes);
    const now = new Date(nowMs).toISOString();
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
      dueAt: dueAt.toISOString(),
    };
    record.items.push(item);
    record.updatedAt = now;
    this.persist();
    return item;
  }

  hasDueItems(agentId: string, nowMs: number = Date.now()): boolean {
    const record = this.queues.get(agentId);
    const head = record?.items[0];
    return Boolean(record && !record.paused && head && isDue(head, nowMs));
  }

  listDueAgentIds(nowMs: number = Date.now()): string[] {
    const result: string[] = [];
    for (const agentId of this.queues.keys()) {
      if (this.hasDueItems(agentId, nowMs)) result.push(agentId);
    }
    return result;
  }

  /** The due item the next dispatch would send, without removing it. */
  peekDue(agentId: string, nowMs: number = Date.now()): StoredQueuedItem | null {
    return this.hasDueItems(agentId, nowMs) ? this.queues.get(agentId)!.items[0] : null;
  }

  shiftDue(agentId: string, nowMs: number = Date.now()): StoredQueuedItem | null {
    if (!this.hasDueItems(agentId, nowMs)) return null;
    const record = this.queues.get(agentId)!;
    const item = record.items.shift()!;
    // Sent late (agent busy, daemon down): push the rest back by the same delay so the next one
    // still comes an interval later instead of right after this one.
    const headDue = Date.parse(item.dueAt);
    const lateness = Number.isNaN(headDue) ? 0 : Math.max(0, nowMs - headDue);
    if (lateness > 0) {
      for (const rest of record.items) {
        const due = Date.parse(rest.dueAt);
        rest.dueAt = new Date((Number.isNaN(due) ? nowMs : due) + lateness).toISOString();
      }
    }
    record.updatedAt = new Date(nowMs).toISOString();
    this.pruneIfEmpty(agentId);
    this.persist();
    return item;
  }

  takeItemById(agentId: string, itemId: string): { item: StoredQueuedItem; index: number } {
    const record = this.queues.get(agentId);
    if (!record) throw new Error(`队列不存在: ${agentId}`);
    const index = record.items.findIndex((entry) => entry.id === itemId);
    if (index === -1) throw new Error(`定时消息不存在或已被发送: ${itemId}`);
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

  /**
   * Pausing freezes the timetable. Resuming shifts every pending item by however long the head
   * is overdue, so the spacing between messages survives a pause instead of firing back-to-back.
   */
  setPaused(
    agentId: string,
    paused: boolean,
    reason: string | null = null,
    nowMs: number = Date.now(),
  ): AgentQueueDetail {
    const record = this.getOrCreate(agentId);
    const wasPaused = record.paused;
    record.paused = paused;
    record.pauseReason = paused ? (reason ?? "手动暂停") : null;
    record.resumeOnCompletedTurn = false;
    if (wasPaused && !paused && record.items.length > 0) {
      const headDue = Date.parse(record.items[0].dueAt);
      const shift = Number.isNaN(headDue) ? 0 : Math.max(0, nowMs - headDue);
      if (shift > 0) {
        for (const item of record.items) {
          const due = Date.parse(item.dueAt);
          item.dueAt = new Date((Number.isNaN(due) ? nowMs : due) + shift).toISOString();
        }
      }
    }
    record.updatedAt = new Date(nowMs).toISOString();
    this.pruneIfEmpty(agentId);
    this.persist();
    return this.getDetail(agentId);
  }

  /** A failed turn holds the queue so it does not race auto-retry or pile onto a broken agent. */
  pauseAfterFailedTurn(agentId: string, reason: string, nowMs: number = Date.now()): boolean {
    const record = this.queues.get(agentId);
    if (!record || record.items.length === 0 || record.paused) return false;
    this.setPaused(agentId, true, reason, nowMs);
    record.resumeOnCompletedTurn = true;
    this.persist();
    return true;
  }

  /** Resumes a queue that a failed turn paused, once a later turn completes. */
  resumeAfterCompletedTurn(agentId: string, nowMs: number = Date.now()): boolean {
    const record = this.queues.get(agentId);
    if (!record?.paused || !record.resumeOnCompletedTurn) return false;
    this.setPaused(agentId, false, null, nowMs);
    return true;
  }

  updateItemText(agentId: string, itemId: string, nextText: string): AgentQueueDetail {
    const record = this.queues.get(agentId);
    if (!record) throw new Error(`队列不存在: ${agentId}`);
    const item = record.items.find((entry) => entry.id === itemId);
    if (!item) throw new Error(`定时消息不存在或已被发送: ${itemId}`);
    const cleanedText = stripOptionalCcPrefix(nextText);
    assertNonEmptyPayload({ text: cleanedText, images: item.images, attachments: item.attachments });
    item.text = cleanedText;
    record.updatedAt = new Date().toISOString();
    this.persist();
    return this.getDetail(agentId);
  }

  removeItem(agentId: string, itemId: string): AgentQueueDetail {
    const record = this.queues.get(agentId);
    if (!record) throw new Error(`队列不存在: ${agentId}`);
    const index = record.items.findIndex((entry) => entry.id === itemId);
    if (index === -1) throw new Error(`定时消息不存在: ${itemId}`);
    const [removed] = record.items.splice(index, 1);
    this.markWithdrawn(agentId, removed.messageId);
    record.updatedAt = new Date().toISOString();
    this.pruneIfEmpty(agentId);
    this.persist();
    return this.getDetail(agentId);
  }

  clear(agentId: string): AgentQueueDetail {
    const record = this.queues.get(agentId);
    if (record) {
      for (const item of record.items) this.markWithdrawn(agentId, item.messageId);
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
          nextDueAt: record.items[0]?.dueAt ?? null,
          updatedAt: record.updatedAt,
        });
      }
    }
    summaries.sort((a, b) => {
      if (a.paused !== b.paused) return a.paused ? -1 : 1;
      return (a.nextDueAt ?? "").localeCompare(b.nextDueAt ?? "");
    });
    return summaries;
  }

  getDetail(agentId: string): AgentQueueDetail {
    const record = this.queues.get(agentId);
    const withdrawnMessageIds = [...(this.withdrawnByAgent.get(agentId) ?? [])];
    const dispatchedTexts = Object.fromEntries(this.dispatchedByAgent.get(agentId) ?? []);
    return {
      agentId,
      paused: record?.paused ?? false,
      pauseReason: record?.pauseReason ?? null,
      items: (record?.items ?? []).map(toItemView),
      withdrawnMessageIds,
      dispatchedTexts,
    };
  }
}
