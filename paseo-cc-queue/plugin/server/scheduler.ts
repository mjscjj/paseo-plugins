import { existsSync, readFileSync } from "node:fs";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ActiveSendBehavior, AgentQueueDetail } from "../shared/contracts.ts";
import {
  inspectAgentTree,
  type ProviderSubagentTracker,
  type TreeBusyReport,
  type TreeNodeSnapshot,
  TreeWaitLimiter,
} from "./agent-tree.ts";
import {
  assertNonEmptyPayload,
  type EnqueuePayload,
  type QueueStore,
  type StoredQueuedItem,
} from "./store.ts";

const DEFAULT_FRONTEND_HOLD_TTL_MS = 60_000;

export interface AgentSendOptions {
  messageId?: string;
  sessionMode?: string;
  activeTurnBehavior?: ActiveSendBehavior;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: unknown[];
}

export interface AgentSnapshotMinimal extends TreeNodeSnapshot {
  id: string;
  status: "initializing" | "idle" | "running" | "error" | "closed";
  pendingPermissions?: readonly unknown[] | null;
}

export interface AgentPort {
  inspect(agentIdOrRef: string): Promise<AgentSnapshotMinimal | null>;
  inspectTree?(agent: AgentSnapshotMinimal): Promise<TreeBusyReport>;
  send(agentId: string, text: string, options?: AgentSendOptions): Promise<void>;
}

export function createPaseoAgentPort(
  paseo: PluginHandlerContext["paseo"],
  tracker: ProviderSubagentTracker | null = null,
): AgentPort {
  return {
    async inspect(agentIdOrRef: string) {
      const refreshed = await paseo.agents.ref(agentIdOrRef).refresh();
      return (refreshed?.agent ?? null) as AgentSnapshotMinimal | null;
    },
    inspectTree(agent: AgentSnapshotMinimal) {
      return inspectAgentTree(paseo, tracker, agent);
    },
    async send(agentId: string, text: string, options?: AgentSendOptions) {
      await paseo.agents.ref(agentId).send(
        text,
        options as Parameters<ReturnType<PluginHandlerContext["paseo"]["agents"]["ref"]>["send"]>[1],
      );
    },
  };
}

/** True when the bb queue has a message ready for this agent; cc lets bb go first. */
export type BbQueuePeek = (agentId: string) => boolean;

/** Reads bb-queue's persisted queue file. Missing or unreadable file means nothing pending. */
export function createBbQueueFilePeek(filePath: string): BbQueuePeek {
  return (agentId: string) => {
    try {
      if (!existsSync(filePath)) return false;
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
        queues?: Record<string, { paused?: boolean; items?: unknown[] }>;
      };
      const queue = parsed.queues?.[agentId];
      return Boolean(queue && !queue.paused && (queue.items?.length ?? 0) > 0);
    } catch {
      return false;
    }
  };
}

// "closed" is an agent whose runtime is not loaded (sending resumes it); "error" is one whose
// last turn failed. Both accept a new prompt exactly like "idle".
const RESTING_STATUSES = new Set<string>(["idle", "closed", "error"]);

function isAgentIdleAndUnblocked(agent: AgentSnapshotMinimal): boolean {
  return RESTING_STATUSES.has(agent.status) && (agent.pendingPermissions?.length ?? 0) === 0;
}

function toSendOptions(
  item: EnqueuePayload | StoredQueuedItem,
  activeTurnBehavior?: ActiveSendBehavior,
): AgentSendOptions {
  return {
    ...(item.messageId ? { messageId: item.messageId } : {}),
    ...(item.sessionMode ? { sessionMode: item.sessionMode } : {}),
    ...(activeTurnBehavior ? { activeTurnBehavior } : {}),
    ...(item.images && item.images.length > 0 ? { images: item.images } : {}),
    ...(item.attachments && item.attachments.length > 0 ? { attachments: item.attachments } : {}),
  };
}

export interface TimedSchedulerOptions {
  frontendHoldTtlMs?: number;
  now?: () => number;
  bbQueuePeek?: BbQueuePeek;
  /** Longest a due message waits for busy subagents once the root is idle; 0 = no limit. */
  maxTreeWaitMs?: () => number;
}

const DEFAULT_MAX_TREE_WAIT_MS = 60 * 60_000;

/**
 * Timed queue: every message waits until its dueAt, then until the agent tree is quiet,
 * the native frontend queue is empty and bb has nothing ready for the same agent.
 */
export class TimedQueueScheduler {
  private readonly store: QueueStore;
  private readonly inFlight = new Set<string>();
  private readonly frontendHolds = new Map<string, number>();
  private readonly waitingReasons = new Map<string, string>();
  private readonly frontendHoldTtlMs: number;
  private readonly now: () => number;
  private readonly bbQueuePeek: BbQueuePeek;
  private readonly waitLimiter: TreeWaitLimiter;

  constructor(store: QueueStore, options: TimedSchedulerOptions = {}) {
    this.store = store;
    this.frontendHoldTtlMs = options.frontendHoldTtlMs ?? DEFAULT_FRONTEND_HOLD_TTL_MS;
    this.now = options.now ?? Date.now;
    this.bbQueuePeek = options.bbQueuePeek ?? (() => false);
    this.waitLimiter = new TreeWaitLimiter({
      maxWaitMs: options.maxTreeWaitMs ?? (() => DEFAULT_MAX_TREE_WAIT_MS),
      now: this.now,
    });
  }

  getTimeoutNotice(agentId: string): string | null {
    return this.waitLimiter.getNotice(agentId);
  }

  resetTreeWait(agentId: string): void {
    this.waitLimiter.reset(agentId);
  }

  getWaitingReason(agentId: string): string | null {
    return this.waitingReasons.get(agentId) ?? null;
  }

  private setWaitingReason(agentId: string, reason: string | null): void {
    if (reason) this.waitingReasons.set(agentId, reason);
    else this.waitingReasons.delete(agentId);
  }

  hasActiveFrontendHold(agentId: string): boolean {
    const expiresAt = this.frontendHolds.get(agentId);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.frontendHolds.delete(agentId);
      return false;
    }
    return true;
  }

  setFrontendHold(agentId: string, hasFrontendItems: boolean): void {
    if (hasFrontendItems) this.frontendHolds.set(agentId, this.now() + this.frontendHoldTtlMs);
    else this.frontendHolds.delete(agentId);
  }

  /** Always scheduled, never sent immediately: cc means "later". */
  async submit(
    port: AgentPort,
    agentIdOrRef: string,
    payload: EnqueuePayload,
    intervalMinutes: number,
  ): Promise<{ agentId: string; item: StoredQueuedItem }> {
    assertNonEmptyPayload(payload);
    const agent = await port.inspect(agentIdOrRef);
    if (!agent) throw new Error(`Agent 不存在: ${agentIdOrRef}`);
    const item = this.store.enqueue(agent.id, payload, { intervalMinutes, nowMs: this.now() });
    return { agentId: agent.id, item };
  }

  async sendItemNow(
    port: AgentPort,
    agentId: string,
    itemId: string,
    activeTurnBehavior: ActiveSendBehavior = "steer",
  ): Promise<AgentQueueDetail> {
    if (this.inFlight.has(agentId)) throw new Error("该 Agent 正在派发另一条消息，请稍后重试");
    const agent = await port.inspect(agentId);
    if (!agent) throw new Error(`Agent 不存在: ${agentId}`);
    const { item, index } = this.store.takeItemById(agent.id, itemId);
    this.inFlight.add(agent.id);
    try {
      const behavior = agent.status === "running" ? activeTurnBehavior : undefined;
      await port.send(agent.id, item.text, toSendOptions(item, behavior));
      this.store.recordDispatched(agent.id, item.messageId, item.text);
      return this.store.getDetail(agent.id);
    } catch (error) {
      this.store.restoreItemAt(agent.id, item, index);
      throw error;
    } finally {
      this.inFlight.delete(agent.id);
    }
  }

  async sweep(port: AgentPort): Promise<void> {
    const nowMs = this.now();
    for (const agentId of this.store.listDueAgentIds(nowMs)) {
      if (this.inFlight.has(agentId)) continue;
      await this.drainNext(port, agentId).catch((error) => {
        console.error(`[cc-queue] sweep failed for ${agentId}:`, error);
      });
    }
    for (const agentId of [...this.waitingReasons.keys()]) {
      if (!this.store.hasDueItems(agentId, nowMs)) this.waitingReasons.delete(agentId);
    }
  }

  async drainNext(port: AgentPort, agentId: string): Promise<boolean> {
    if (this.inFlight.has(agentId) || !this.store.hasDueItems(agentId, this.now())) return false;
    this.inFlight.add(agentId);
    let timedOut = false;
    try {
      try {
        const agent = await port.inspect(agentId);
        if (!agent) return false;
        if (!isAgentIdleAndUnblocked(agent)) {
          this.setWaitingReason(
            agentId,
            (agent.pendingPermissions?.length ?? 0) > 0 ? "主 Agent等待权限确认" : "主 Agent运行中",
          );
          return false;
        }
        if (this.hasActiveFrontendHold(agentId)) {
          this.setWaitingReason(agentId, "前端队列还有消息");
          return false;
        }
        if (this.bbQueuePeek(agentId)) {
          this.setWaitingReason(agentId, "bb 队列优先发送");
          return false;
        }
        if (port.inspectTree) {
          const tree = await port.inspectTree(agent);
          if (tree.busy) {
            const head = this.store.peekDue(agentId, this.now());
            if (!head) return false;
            const decision = this.waitLimiter.evaluate(agentId, head.id, tree.reason);
            if (!decision.send) {
              this.setWaitingReason(agentId, decision.reason);
              return false;
            }
            timedOut = true;
          }
          // The tree walk takes several round trips; a finish notice can start a parent turn
          // meanwhile, and a plugin send interrupts a running turn. Re-read the root first.
          const fresh = await port.inspect(agentId);
          if (!fresh || !isAgentIdleAndUnblocked(fresh)) {
            this.setWaitingReason(agentId, "主 Agent运行中");
            return false;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setWaitingReason(agentId, `读取 Agent 状态失败，稍后重试: ${message}`);
        return false;
      }
      this.setWaitingReason(agentId, null);
      const nextItem = this.store.shiftDue(agentId, this.now());
      if (!nextItem) return false;
      try {
        await port.send(agentId, nextItem.text, toSendOptions(nextItem));
        this.store.recordDispatched(agentId, nextItem.messageId, nextItem.text);
        this.waitLimiter.reset(agentId);
        if (timedOut) {
          this.waitLimiter.recordTimeout(agentId, nextItem.text);
          console.log(`[cc-queue] ${agentId}: subagent wait limit reached, sent anyway`);
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.requeueFrontAndPause(agentId, nextItem, `定时发送失败: ${message}`);
        console.error(`[cc-queue] Failed to dispatch timed item for ${agentId}:`, error);
        return false;
      }
    } finally {
      this.inFlight.delete(agentId);
    }
  }

  dispose(): void {
    this.frontendHolds.clear();
    this.waitingReasons.clear();
    this.waitLimiter.dispose();
  }
}
