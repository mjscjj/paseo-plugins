import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { ActiveSendBehavior, AgentQueueDetail } from "../shared/contracts.ts";
import {
  inspectAgentTree,
  type ProviderSubagentTracker,
  type TreeBusyReport,
  type TreeNodeSnapshot,
} from "./agent-tree.ts";
import {
  assertNonEmptyPayload,
  type EnqueuePayload,
  type QueueStore,
  type StoredQueuedItem,
} from "./store.ts";

const DEFAULT_TURN_END_GRACE_MS = 650;
const DEFAULT_FRONTEND_HOLD_MAX_WAIT_MS = 8_000;
const DEFAULT_FRONTEND_HOLD_TTL_MS = 60_000;

export interface QueueSchedulerOptions {
  turnEndGraceMs?: number;
  frontendHoldMaxWaitMs?: number;
  frontendHoldTtlMs?: number;
}

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
  /** Whether the agent or any descendant is still working. Defaults to quiet when absent. */
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

// "closed" is an agent whose runtime is not loaded (sending resumes it); "error" is one whose
// last turn failed. Both accept a new prompt exactly like "idle".
const RESTING_STATUSES = new Set<string>(["idle", "closed", "error"]);

function isAgentIdleAndUnblocked(agent: AgentSnapshotMinimal): boolean {
  return RESTING_STATUSES.has(agent.status) && (agent.pendingPermissions?.length ?? 0) === 0;
}

/**
 * The tree walk takes several round trips. A subagent's finish notice can start a parent turn
 * meanwhile, and a plugin send interrupts a running turn, so re-read the root right before sending.
 */
async function stillIdleBeforeSend(port: AgentPort, agentId: string): Promise<boolean> {
  if (!port.inspectTree) return true;
  const fresh = await port.inspect(agentId);
  return Boolean(fresh && isAgentIdleAndUnblocked(fresh));
}

async function inspectTreeOrQuiet(
  port: AgentPort,
  agent: AgentSnapshotMinimal,
): Promise<TreeBusyReport> {
  if (!port.inspectTree) return { busy: false, reason: null };
  return port.inspectTree(agent);
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

export class QueueScheduler {
  private readonly store: QueueStore;
  private readonly inFlight = new Set<string>();
  private readonly frontendHolds = new Map<string, number>();
  private readonly pendingDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly waitingReasons = new Map<string, string>();
  private readonly turnEndGraceMs: number;
  private readonly frontendHoldMaxWaitMs: number;
  private readonly frontendHoldTtlMs: number;

  constructor(store: QueueStore, options: QueueSchedulerOptions = {}) {
    this.store = store;
    this.turnEndGraceMs = options.turnEndGraceMs ?? DEFAULT_TURN_END_GRACE_MS;
    this.frontendHoldMaxWaitMs =
      options.frontendHoldMaxWaitMs ?? DEFAULT_FRONTEND_HOLD_MAX_WAIT_MS;
    this.frontendHoldTtlMs = options.frontendHoldTtlMs ?? DEFAULT_FRONTEND_HOLD_TTL_MS;
  }

  private clearPendingDrainTimer(agentId: string): void {
    const existing = this.pendingDrainTimers.get(agentId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.pendingDrainTimers.delete(agentId);
    }
  }

  /** Why the head of this agent's queue has not been sent yet, if it is waiting on work. */
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
    if (expiresAt <= Date.now()) {
      this.frontendHolds.delete(agentId);
      return false;
    }
    return true;
  }

  setFrontendHold(port: AgentPort, agentId: string, hasFrontendItems: boolean): void {
    if (hasFrontendItems) {
      this.frontendHolds.set(agentId, Date.now() + this.frontendHoldTtlMs);
      return;
    }
    const hadHold = this.frontendHolds.delete(agentId);
    // If a post-turn hold timer was waiting solely for the frontend queue and the user
    // cleared/removed the frontend queue instead of running it, shorten to normal grace window.
    if (hadHold && this.pendingDrainTimers.has(agentId) && this.store.hasReadyItems(agentId)) {
      this.scheduleDrainAfterDelay(port, agentId, this.turnEndGraceMs, false);
    }
  }

  onTurnStarted(agentId: string): void {
    // Another turn (e.g. Paseo native frontend queue or manual prompt) just started;
    // cancel any pending drain timer and wait for its `agent.turn_ended`.
    this.clearPendingDrainTimer(agentId);
  }

  private scheduleDrainAfterDelay(
    port: AgentPort,
    agentId: string,
    delayMs: number,
    expireHoldOnFire: boolean,
  ): void {
    this.clearPendingDrainTimer(agentId);
    const timer = setTimeout(() => {
      this.pendingDrainTimers.delete(agentId);
      if (expireHoldOnFire) {
        this.frontendHolds.delete(agentId);
      }
      void this.drainNext(port, agentId);
    }, delayMs);
    timer.unref?.();
    this.pendingDrainTimers.set(agentId, timer);
  }

  dispose(): void {
    for (const timer of this.pendingDrainTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingDrainTimers.clear();
    this.frontendHolds.clear();
    this.waitingReasons.clear();
  }

  /** Retry every agent whose queue is ready but idle-waiting (e.g. on subagents to finish). */
  async sweep(port: AgentPort): Promise<void> {
    for (const agentId of this.store.listReadyAgentIds()) {
      if (this.inFlight.has(agentId) || this.pendingDrainTimers.has(agentId)) continue;
      if (this.hasActiveFrontendHold(agentId)) continue;
      await this.drainNext(port, agentId).catch((error) => {
        console.error(`[bb-queue] sweep failed for ${agentId}:`, error);
      });
    }
    for (const agentId of [...this.waitingReasons.keys()]) {
      if (!this.store.hasReadyItems(agentId)) this.waitingReasons.delete(agentId);
    }
  }

  async submit(
    port: AgentPort,
    agentIdOrRef: string,
    payload: EnqueuePayload,
  ): Promise<{ agentId: string; disposition: "sent_immediately" | "queued" }> {
    assertNonEmptyPayload(payload);
    const agent = await port.inspect(agentIdOrRef);
    if (!agent) {
      throw new Error(`Agent 不存在: ${agentIdOrRef}`);
    }
    const agentId = agent.id;

    if (
      !this.inFlight.has(agentId) &&
      !this.store.hasPendingOrPaused(agentId) &&
      !this.hasActiveFrontendHold(agentId) &&
      isAgentIdleAndUnblocked(agent)
    ) {
      this.inFlight.add(agentId);
      try {
        const tree = await inspectTreeOrQuiet(port, agent);
        if (!tree.busy && (await stillIdleBeforeSend(port, agentId))) {
          await port.send(agentId, payload.text, toSendOptions(payload));
          this.store.recordDispatched(agentId, payload.messageId, payload.text);
          return { agentId, disposition: "sent_immediately" };
        }
        if (tree.busy) this.setWaitingReason(agentId, tree.reason);
      } finally {
        this.inFlight.delete(agentId);
      }
    }

    this.store.enqueue(agentId, payload);
    // In case the agent transitioned to idle right before enqueue completed, trigger a safe reconcile check.
    if (!this.hasActiveFrontendHold(agentId) && !this.pendingDrainTimers.has(agentId)) {
      void this.drainNext(port, agentId);
    }
    return { agentId, disposition: "queued" };
  }

  async sendItemNow(
    port: AgentPort,
    agentId: string,
    itemId: string,
    activeTurnBehavior: ActiveSendBehavior = "steer",
  ): Promise<AgentQueueDetail> {
    if (this.inFlight.has(agentId)) {
      throw new Error("该 Agent 正在派发另一条消息，请稍后重试");
    }
    const agent = await port.inspect(agentId);
    if (!agent) {
      throw new Error(`Agent 不存在: ${agentId}`);
    }
    this.clearPendingDrainTimer(agent.id);
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

  async onTurnEnded(
    port: AgentPort,
    agentId: string,
    outcome:
      | { kind: "completed" }
      | { kind: "failed"; error: { message: string } }
      | { kind: "canceled"; reason: string },
  ): Promise<void> {
    this.clearPendingDrainTimer(agentId);
    if (outcome.kind === "failed") {
      this.store.pauseIfNonEmpty(agentId, `上一轮执行失败: ${outcome.error.message}`);
      return;
    }
    if (outcome.kind === "canceled") {
      this.store.pauseIfNonEmpty(agentId, `上一轮已取消 (${outcome.reason})`);
      return;
    }
    if (!this.store.hasReadyItems(agentId)) {
      return;
    }
    const hasHold = this.hasActiveFrontendHold(agentId);
    const delayMs = hasHold ? this.frontendHoldMaxWaitMs : this.turnEndGraceMs;
    if (delayMs <= 0) {
      await this.drainNext(port, agentId);
      return;
    }
    this.scheduleDrainAfterDelay(port, agentId, delayMs, hasHold);
  }

  async reconcileIdle(port: AgentPort, agentId: string): Promise<boolean> {
    if (this.pendingDrainTimers.has(agentId) || this.hasActiveFrontendHold(agentId)) {
      return false;
    }
    return this.drainNext(port, agentId);
  }

  async drainNext(port: AgentPort, agentId: string): Promise<boolean> {
    if (this.inFlight.has(agentId) || !this.store.hasReadyItems(agentId)) {
      return false;
    }
    this.clearPendingDrainTimer(agentId);
    this.inFlight.add(agentId);
    try {
      try {
        const agent = await port.inspect(agentId);
        if (!agent || !isAgentIdleAndUnblocked(agent)) {
          return false;
        }
        const tree = await inspectTreeOrQuiet(port, agent);
        if (tree.busy) {
          // The sweep retries; a subagent finishing does not always start a parent turn.
          this.setWaitingReason(agentId, tree.reason);
          return false;
        }
        if (!(await stillIdleBeforeSend(port, agentId))) {
          return false;
        }
      } catch (error) {
        // Callers fire this without awaiting; never let a lookup failure escape as a rejection.
        const message = error instanceof Error ? error.message : String(error);
        this.setWaitingReason(agentId, `读取 Agent 状态失败，稍后重试: ${message}`);
        return false;
      }
      this.setWaitingReason(agentId, null);
      const nextItem = this.store.shiftReady(agentId);
      if (!nextItem) {
        return false;
      }
      try {
        await port.send(agentId, nextItem.text, toSendOptions(nextItem));
        this.store.recordDispatched(agentId, nextItem.messageId, nextItem.text);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.requeueFrontAndPause(agentId, nextItem, `出队发送失败: ${message}`);
        console.error(`[bb-queue] Failed to dispatch queued item for ${agentId}:`, error);
        return false;
      }
    } finally {
      this.inFlight.delete(agentId);
    }
  }
}
