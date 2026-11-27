import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHandlerContext["paseo"];

export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/** A child that changed this recently may still be delivering its finish notification. */
export const DEFAULT_RECENT_ACTIVITY_MS = 10_000;
/** A provider subagent with no update for this long is treated as lost, not running. */
export const DEFAULT_PROVIDER_SUBAGENT_STALE_MS = 6 * 60 * 60_000;
const SUBSCRIBE_RETRY_MS = 60_000;
const MAX_TREE_DEPTH = 6;
const MAX_TREE_NODES = 200;
const CHILD_PAGE_LIMIT = 200;

export interface TreeNodeSnapshot {
  id: string;
  status: string;
  title?: string | null;
  updatedAt?: string | null;
  pendingPermissions?: readonly unknown[] | null;
  backgroundWork?: { count: number; runningCount?: number } | null;
  labels?: Record<string, string> | null;
}

export interface TreeBusyReport {
  busy: boolean;
  reason: string | null;
}

interface TrackedSubagent {
  status: string;
  updatedAt: number;
}

/**
 * Tracks provider-native subagents (Codex spawn_agent, Claude Task, ...) from the daemon's
 * `agent.provider_subagents.update` events. Codex reports these here and not in backgroundWork.
 */
export class ProviderSubagentTracker {
  private readonly byParent = new Map<string, Map<string, TrackedSubagent>>();
  private release: (() => void) | null = null;
  private started = false;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(options: { staleMs?: number; now?: () => number } = {}) {
    this.staleMs = options.staleMs ?? DEFAULT_PROVIDER_SUBAGENT_STALE_MS;
    this.now = options.now ?? Date.now;
  }

  get isStarted(): boolean {
    return this.started;
  }

  start(paseo: PaseoApi): void {
    if (this.started) return;
    const now = this.now();
    if (now - this.lastAttemptAt < SUBSCRIBE_RETRY_MS) return;
    this.lastAttemptAt = now;
    this.started = true;
    const fail = (error: unknown) => {
      this.release?.();
      this.release = null;
      this.started = false;
      console.error("[agent-tree] provider subagent subscription failed:", error);
    };
    try {
      const observation = paseo.observeEvents(["agent.provider_subagents.update"]);
      this.release = () => {
        void observation.release().catch(() => undefined);
      };
      observation.subscribe({
        snapshot: () => {},
        update: (message: unknown) => this.handleMessage(message),
        error: fail,
      });
      // An unhandled rejection here would take down the whole plugin process.
      observation.ready.catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  handleMessage(message: unknown): void {
    const msg = message as { type?: string; payload?: Record<string, unknown> } | null;
    if (!msg || msg.type !== "agent.provider_subagents.update" || !msg.payload) return;
    const payload = msg.payload as {
      kind?: string;
      subagent?: { id?: string; parentAgentId?: string; status?: string };
      parentAgentId?: string;
      subagentId?: string;
    };
    if (payload.kind === "upsert" && payload.subagent?.id && payload.subagent.parentAgentId) {
      this.set(payload.subagent.parentAgentId, payload.subagent.id, payload.subagent.status ?? "running");
      return;
    }
    if (payload.kind === "timeline" && payload.parentAgentId && payload.subagentId) {
      const known = this.byParent.get(payload.parentAgentId)?.get(payload.subagentId);
      // Output from a subagent we never saw an upsert for means it is alive.
      this.set(payload.parentAgentId, payload.subagentId, known?.status ?? "running");
      return;
    }
    if (payload.kind === "remove" && payload.parentAgentId && payload.subagentId) {
      const map = this.byParent.get(payload.parentAgentId);
      map?.delete(payload.subagentId);
      if (map && map.size === 0) this.byParent.delete(payload.parentAgentId);
    }
  }

  private set(parentId: string, subagentId: string, status: string): void {
    let map = this.byParent.get(parentId);
    if (!map) {
      map = new Map();
      this.byParent.set(parentId, map);
    }
    map.set(subagentId, { status, updatedAt: this.now() });
  }

  /** Running subagents, and finished ones still inside the recent-activity window. */
  activity(parentId: string, recentMs: number): { running: number; recent: number } {
    const map = this.byParent.get(parentId);
    if (!map) return { running: 0, recent: 0 };
    const now = this.now();
    let running = 0;
    let recent = 0;
    for (const [id, entry] of map) {
      if (entry.status === "running") {
        if (now - entry.updatedAt > this.staleMs) {
          map.delete(id);
          continue;
        }
        running += 1;
      } else if (now - entry.updatedAt < recentMs) {
        recent += 1;
      }
    }
    return { running, recent };
  }

  dispose(): void {
    this.release?.();
    this.release = null;
    this.byParent.clear();
    this.started = false;
  }
}

function backgroundRunning(node: TreeNodeSnapshot): number {
  const work = node.backgroundWork;
  if (!work) return 0;
  return work.runningCount ?? work.count ?? 0;
}

function describe(node: TreeNodeSnapshot, isRoot: boolean): string {
  if (isRoot) return "主 Agent";
  const title = node.title?.trim();
  return title ? `子 Agent「${title.slice(0, 24)}」` : `子 Agent ${node.id.slice(0, 8)}`;
}

/** Why one node keeps the tree busy, or null when it is quiet. */
export function nodeBusyReason(
  node: TreeNodeSnapshot,
  isRoot: boolean,
  tracker: ProviderSubagentTracker | null,
  options: { now: number; recentActivityMs: number },
): string | null {
  const who = describe(node, isRoot);
  if (node.status === "running" || node.status === "initializing") {
    return `${who}运行中`;
  }
  if ((node.pendingPermissions?.length ?? 0) > 0) {
    return `${who}等待权限确认`;
  }
  const bg = backgroundRunning(node);
  if (bg > 0) {
    return `${who}有 ${bg} 个后台任务在跑`;
  }
  if (tracker) {
    const sub = tracker.activity(node.id, options.recentActivityMs);
    if (sub.running > 0) return `${who}有 ${sub.running} 个子任务在跑`;
    if (sub.recent > 0) return `${who}的子任务刚结束，等待回报`;
  }
  if (!isRoot && node.updatedAt) {
    const changedAt = Date.parse(node.updatedAt);
    if (!Number.isNaN(changedAt) && options.now - changedAt < options.recentActivityMs) {
      return `${who}刚结束，等待回报`;
    }
  }
  return null;
}

async function listChildren(paseo: PaseoApi, parentId: string): Promise<TreeNodeSnapshot[]> {
  const labels = { [PARENT_AGENT_ID_LABEL]: parentId };
  let result;
  try {
    result = await paseo.agents.list({
      filter: { labels, includeBackground: true },
      page: { limit: CHILD_PAGE_LIMIT },
    } as never);
  } catch {
    // Hosts without background-agent support reject includeBackground.
    result = await paseo.agents.list({ filter: { labels }, page: { limit: CHILD_PAGE_LIMIT } } as never);
  }
  const entries = (result as { entries?: Array<{ agent?: TreeNodeSnapshot }> }).entries ?? [];
  return entries
    .map((entry) => entry.agent)
    .filter((agent): agent is TreeNodeSnapshot => Boolean(agent?.id))
    .filter((agent) => agent.labels?.[PARENT_AGENT_ID_LABEL] === parentId);
}

/**
 * The root may take the next queued message only when it and every descendant are quiet:
 * not running, no pending permission, no background work, no running provider subagent,
 * and nothing that finished so recently its completion notice may still be in flight.
 */
export async function inspectAgentTree(
  paseo: PaseoApi,
  tracker: ProviderSubagentTracker | null,
  root: TreeNodeSnapshot,
  options: { now?: number; recentActivityMs?: number } = {},
): Promise<TreeBusyReport> {
  const now = options.now ?? Date.now();
  const recentActivityMs = options.recentActivityMs ?? DEFAULT_RECENT_ACTIVITY_MS;
  const rootReason = nodeBusyReason(root, true, tracker, { now, recentActivityMs });
  if (rootReason) return { busy: true, reason: rootReason };

  const seen = new Set<string>([root.id]);
  let frontier = [root.id];
  for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const parentId of frontier) {
      const children = await listChildren(paseo, parentId);
      for (const child of children) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        if (seen.size > MAX_TREE_NODES) {
          return { busy: true, reason: "子 Agent 数量过多，暂缓发送" };
        }
        const reason = nodeBusyReason(child, false, tracker, { now, recentActivityMs });
        if (reason) return { busy: true, reason };
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return { busy: false, reason: null };
}

/** How long the "sent after the wait limit" notice stays visible. */
export const TIMEOUT_NOTICE_TTL_MS = 30 * 60_000;

export interface TreeWaitDecision {
  /** True once the wait limit ran out: send although subagents are still busy. */
  send: boolean;
  /** Shown while waiting; null when sending. */
  reason: string | null;
}

/**
 * Caps how long one queued message waits for subagents. The clock starts the first time the
 * root is idle but its tree is busy, keeps running through root turns (each subagent report
 * would otherwise restart it), and belongs to that one message: a new head starts a new clock.
 * It never overrides the root's own state; callers only consult it when the root is idle.
 */
export class TreeWaitLimiter {
  private readonly waits = new Map<string, { itemId: string; since: number }>();
  private readonly notices = new Map<string, { text: string; at: number }>();
  private readonly maxWaitMs: () => number;
  private readonly now: () => number;

  constructor(options: { maxWaitMs: () => number; now?: () => number }) {
    this.maxWaitMs = options.maxWaitMs;
    this.now = options.now ?? Date.now;
  }

  evaluate(agentId: string, headItemId: string, busyReason: string | null): TreeWaitDecision {
    const now = this.now();
    let entry = this.waits.get(agentId);
    if (!entry || entry.itemId !== headItemId) {
      entry = { itemId: headItemId, since: now };
      this.waits.set(agentId, entry);
    }
    const reason = busyReason ?? "子 Agent 运行中";
    const maxMs = this.maxWaitMs();
    if (maxMs <= 0) return { send: false, reason };
    const remaining = entry.since + maxMs - now;
    if (remaining <= 0) return { send: true, reason: null };
    return { send: false, reason: `${reason} · 最多再等 ${Math.ceil(remaining / 60_000)} 分钟` };
  }

  /** The message was sent, withdrawn or the queue paused: its clock is gone. */
  reset(agentId: string): void {
    this.waits.delete(agentId);
  }

  recordTimeout(agentId: string, preview: string): void {
    const minutes = Math.round(this.maxWaitMs() / 60_000);
    const at = this.now();
    const time = new Date(at).toTimeString().slice(0, 5);
    const short = preview.trim().replace(/\s+/g, " ").slice(0, 30);
    this.notices.set(agentId, {
      text: `${time} 等子 Agent 超过 ${minutes} 分钟，已直接发送「${short || "(附件消息)"}」，子 Agent 仍在继续运行`,
      at,
    });
  }

  getNotice(agentId: string): string | null {
    const notice = this.notices.get(agentId);
    if (!notice) return null;
    if (this.now() - notice.at > TIMEOUT_NOTICE_TTL_MS) {
      this.notices.delete(agentId);
      return null;
    }
    return notice.text;
  }

  dispose(): void {
    this.waits.clear();
    this.notices.clear();
  }
}
