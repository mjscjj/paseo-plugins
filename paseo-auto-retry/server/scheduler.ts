import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  MARKER,
  buildRecoveryPrompt,
  classifyError,
  extractRetryAfterSeconds,
  redactError,
  renderedError,
  type ErrorCategory,
} from "../shared/classifier.ts";
import type { AutoRetryConfig, AutoRetryStore } from "./store.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface TurnOutcome {
  kind: "completed" | "failed" | "canceled";
  error?: { message?: string; code?: string };
  reason?: string;
}

export interface AgentSnapshot {
  id: string;
  cwd?: string | null;
  status: string;
  updatedAt?: string | number | null;
  lastUserMessageAt?: string | number | null;
  lastError?: string | null;
  archivedAt?: string | number | null;
  activeTurn?: unknown;
  pendingPermissions?: readonly unknown[] | null;
  attentionReason?: string | null;
  attentionTimestamp?: string | number | null;
  labels?: Record<string, string> | null;
}

export interface TimelineEntry {
  seqEnd?: number;
  turnId?: string | null;
  timestamp?: string | number | null;
  item?: {
    type?: string;
    role?: string;
    level?: string;
    message?: string;
    text?: string;
    content?: string;
  } | null;
}

export interface TimelinePage {
  agent?: AgentSnapshot | null;
  epoch?: string | number | null;
  hasNewer?: boolean;
  error?: unknown;
  entries?: TimelineEntry[];
}

export interface RetryAgentPort {
  refresh(agentId: string): Promise<AgentSnapshot | null>;
  refetchTimeline(agentId: string, limit: number): Promise<TimelinePage | null>;
  send(agentId: string, text: string, options: { messageId: string }): Promise<void>;
}

export interface DetectedIssue {
  key: string;
  at: number;
  source: string;
  category: ErrorCategory;
  retryable: boolean;
  message: string;
  retryAfterSeconds: number;
}

export interface RetrySchedulerOptions {
  turnEndGraceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

function toMillis(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Date.parse(v);
  return Number.NaN;
}

export function isAgentStopped(agent: AgentSnapshot | null | undefined): boolean {
  if (!agent) return false;
  return (
    (agent.status === "idle" || agent.status === "error") &&
    !agent.archivedAt &&
    !agent.activeTurn &&
    (agent.pendingPermissions?.length ?? 0) === 0 &&
    agent.attentionReason !== "permission" &&
    agent.labels?.["paseo.auto-retry"] !== "off"
  );
}

export function isAgentInScope(
  agent: AgentSnapshot,
  config: AutoRetryConfig,
): boolean {
  if (config.scope === "all") return true;
  if (typeof agent.cwd !== "string" || !agent.cwd) return false;
  const cwd = path.resolve(agent.cwd);
  return config.cwdRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return cwd === resolvedRoot || cwd.startsWith(resolvedRoot + path.sep);
  });
}

function snapshotKey(a: AgentSnapshot): string {
  return JSON.stringify([
    a.status,
    a.updatedAt ?? null,
    a.lastUserMessageAt ?? null,
    a.lastError ?? null,
    a.archivedAt ?? null,
    a.activeTurn ?? null,
    a.pendingPermissions?.length ?? 0,
    a.attentionReason ?? null,
  ]);
}

function extractUserMessageText(entry: TimelineEntry): string | null {
  const item = entry.item;
  if (!item) return null;
  if (item.type === "user_message" || item.role === "user") {
    const text = item.text ?? item.content ?? item.message;
    return typeof text === "string" ? text : "";
  }
  return null;
}

function extractLatestPromptIdentity(
  agent: AgentSnapshot,
  entries: TimelineEntry[],
): { key: string; text: string; timestamp: number } | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const text = extractUserMessageText(entries[i]);
    if (text !== null) {
      const ts = toMillis(entries[i].timestamp ?? agent.lastUserMessageAt);
      const preview = text.slice(0, 240);
      return {
        key: sha256(JSON.stringify([entries[i].seqEnd ?? null, ts, preview])),
        text,
        timestamp: ts,
      };
    }
  }
  const lastUserAt = toMillis(agent.lastUserMessageAt);
  if (Number.isFinite(lastUserAt)) {
    return {
      key: sha256(JSON.stringify(["lastUserMessageAt", lastUserAt])),
      text: "",
      timestamp: lastUserAt,
    };
  }
  return null;
}

export function detectIssue(
  agent: AgentSnapshot,
  timeline: TimelinePage | null,
  outcome: TurnOutcome,
  config: AutoRetryConfig,
  now: number,
): DetectedIssue | null {
  if (!isAgentStopped(agent) || !isAgentInScope(agent, config)) return null;
  if (outcome.kind === "canceled") return null;

  const entries = Array.isArray(timeline?.entries) ? timeline.entries : [];
  if (timeline?.hasNewer) return null;
  const tail = entries.at(-1);

  let text = "";
  let at = Number.NaN;
  let source = "";
  let rendered = false;

  if (outcome.kind === "failed" && outcome.error?.message) {
    text = outcome.error.code
      ? `${outcome.error.code}: ${outcome.error.message}`
      : outcome.error.message;
    at = toMillis(agent.attentionTimestamp ?? agent.updatedAt) || now;
    source = "turn-failed";
  } else if (agent.lastError) {
    text = agent.lastError;
    at = toMillis(agent.attentionTimestamp ?? agent.updatedAt) || now;
    source = "lastError";
  } else if (
    tail?.item?.type === "error" ||
    (tail?.item?.type === "notification" && tail.item.level === "error")
  ) {
    text = tail.item.message ?? tail.item.text ?? "";
    at = toMillis(tail.timestamp) || now;
    source = "timeline-error";
  } else if (
    tail?.item?.type === "assistant_message" &&
    renderedError(tail.item.text)
  ) {
    text = (tail.item.text ?? "").trim();
    at = toMillis(tail.timestamp) || now;
    source = "rendered-error-message";
    rendered = true;
  } else if (agent.status === "error") {
    text = "Paseo entered error state without a diagnostic message";
    at = toMillis(agent.attentionTimestamp ?? agent.updatedAt) || now;
    source = "error-status";
  } else {
    return null;
  }

  const classification = classifyError(text, rendered);
  if (!classification) return null;

  const lastUserAt = toMillis(agent.lastUserMessageAt);
  if (
    !Number.isFinite(at) ||
    at < now - config.maxErrorAgeSeconds * 1000 ||
    at > now + 30_000 ||
    (Number.isFinite(lastUserAt) && at < lastUserAt - 1000)
  ) {
    return null;
  }

  return {
    key: sha256(
      JSON.stringify([
        timeline?.epoch ?? null,
        tail?.seqEnd ?? null,
        tail?.turnId ?? null,
        source,
        text,
      ]),
    ),
    at,
    source,
    category: classification.category,
    retryable: classification.retryable,
    message: redactError(text),
    retryAfterSeconds: extractRetryAfterSeconds(text),
  };
}

export class AutoRetryScheduler {
  private readonly store: AutoRetryStore;
  private readonly turnEndGraceMs: number;
  private readonly now: () => number;
  private readonly setTimer: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
  private readonly pendingInspectTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly pendingRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly inFlight = new Set<string>();
  private disposed = false;

  constructor(store: AutoRetryStore, options: RetrySchedulerOptions = {}) {
    this.store = store;
    this.turnEndGraceMs = options.turnEndGraceMs ?? 500;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  }

  cancelAgent(agentId: string, reason?: string): void {
    const inspect = this.pendingInspectTimers.get(agentId);
    if (inspect !== undefined) {
      this.clearTimer(inspect);
      this.pendingInspectTimers.delete(agentId);
    }
    const retry = this.pendingRetryTimers.get(agentId);
    if (retry !== undefined) {
      this.clearTimer(retry);
      this.pendingRetryTimers.delete(agentId);
      if (reason) {
        this.store.appendEvent({ event: "retry-canceled", agentId, reason });
      }
    }
  }

  onTurnStarted(agentId: string): void {
    this.cancelAgent(agentId, "new-turn-started");
  }

  onPermissionRequested(agentId: string): void {
    this.cancelAgent(agentId, "permission-requested");
  }

  onAgentArchived(agentId: string): void {
    this.cancelAgent(agentId, "agent-archived");
    this.store.purgeAgent(agentId);
  }

  onAgentClosed(agentId: string): void {
    this.cancelAgent(agentId, "agent-closed");
  }

  onTurnEnded(
    port: RetryAgentPort,
    agentId: string,
    outcome: TurnOutcome,
  ): void {
    if (this.disposed) return;
    this.cancelAgent(agentId);
    if (outcome.kind === "canceled") return;

    const handle = this.setTimer(() => {
      this.pendingInspectTimers.delete(agentId);
      void this.inspectAndSchedule(port, agentId, outcome).catch((err) => {
        this.store.appendEvent({
          event: "inspect-error",
          agentId,
          error: String(err instanceof Error ? err.message : err).slice(0, 300),
        });
      });
    }, this.turnEndGraceMs);
    this.pendingInspectTimers.set(agentId, handle);
  }

  async inspectAndSchedule(
    port: RetryAgentPort,
    agentId: string,
    outcome: TurnOutcome,
  ): Promise<string> {
    if (this.disposed) return "disposed";
    const config = this.store.readConfig();
    if (!config.enabled) return "disabled";

    const page = await port.refetchTimeline(agentId, 30);
    const agent = page?.agent ?? (await port.refresh(agentId));
    if (!agent) return "missing-agent";

    const now = this.now();
    const issue = detectIssue(agent, page, outcome, config, now);
    if (!issue) return "skip";

    const isNewObs = this.store.recordObservation(issue.key, {
      agentId: agent.id,
      category: issue.category,
      retryable: issue.retryable,
      source: issue.source,
      message: issue.message,
      observedAt: new Date(now).toISOString(),
    });
    if (isNewObs) {
      this.store.appendEvent({
        event: "error-observed",
        agentId: agent.id,
        category: issue.category,
        retryable: issue.retryable,
        source: issue.source,
        message: issue.message,
      });
    }

    if (!issue.retryable) return "observed-non-retryable";

    const state = this.store.getState();
    const prompt = extractLatestPromptIdentity(agent, page?.entries ?? []);
    if (!prompt) {
      this.store.appendEvent({
        event: "skip",
        agentId: agent.id,
        reason: "missing-root-prompt",
      });
      return "missing-root-prompt";
    }

    let incident = state.agents[agent.id];
    const isAutoPrompt = prompt.text.startsWith(MARKER);
    if (isAutoPrompt) {
      // Fail closed if state was lost: never let an auto-retry prompt grant a fresh budget.
      if (
        !incident?.messageIds.some((id) =>
          prompt.text.startsWith(`${MARKER}${id}]`),
        )
      ) {
        this.store.appendEvent({
          event: "skip",
          agentId: agent.id,
          reason: "unknown-auto-prompt",
        });
        return "unknown-auto-prompt";
      }
    } else if (!incident || incident.rootPromptKey !== prompt.key) {
      incident = state.agents[agent.id] = {
        rootPromptKey: prompt.key,
        attempts: 0,
        messageIds: [],
        handledFailures: [],
      };
      this.store.saveState();
    }

    if (incident.handledFailures.includes(issue.key)) {
      return "already-handled";
    }
    if (incident.attempts >= config.retryDelaysSeconds.length) {
      this.store.appendEvent({
        event: "retry-exhausted",
        agentId: agent.id,
        attempts: incident.attempts,
        category: issue.category,
      });
      return "retry-limit";
    }

    const baseDelaySeconds = config.retryDelaysSeconds[incident.attempts];
    const delaySeconds = Math.max(baseDelaySeconds, issue.retryAfterSeconds);
    const delayMs = delaySeconds * 1000;
    const expectedSnapshot = snapshotKey(agent);
    const attempt = incident.attempts + 1;

    incident.lastOutcome = "scheduled";
    this.store.saveState();
    this.store.appendEvent({
      event: "retry-scheduled",
      agentId: agent.id,
      attempt,
      maxAttempts: config.retryDelaysSeconds.length,
      delaySeconds,
      category: issue.category,
      source: issue.source,
    });

    const handle = this.setTimer(() => {
      this.pendingRetryTimers.delete(agent.id);
      void this.dispatchRetry(port, agent.id, issue, expectedSnapshot).catch(
        (err) => {
          this.store.appendEvent({
            event: "dispatch-error",
            agentId: agent.id,
            error: String(err instanceof Error ? err.message : err).slice(
              0,
              300,
            ),
          });
        },
      );
    }, delayMs);
    this.pendingRetryTimers.set(agent.id, handle);
    return "scheduled";
  }

  async dispatchRetry(
    port: RetryAgentPort,
    agentId: string,
    issue: DetectedIssue,
    expectedSnapshot: string,
  ): Promise<string> {
    if (this.disposed) return "disposed";
    if (this.inFlight.has(agentId)) return "in-flight";
    this.inFlight.add(agentId);
    try {
      const config = this.store.readConfig();
      if (!config.enabled) return "disabled";

      const fresh = await port.refresh(agentId);
      if (
        !fresh ||
        !isAgentStopped(fresh) ||
        !isAgentInScope(fresh, config) ||
        snapshotKey(fresh) !== expectedSnapshot
      ) {
        this.store.appendEvent({
          event: "retry-aborted",
          agentId,
          reason: "agent-state-changed",
        });
        return "changed";
      }

      const state = this.store.getState();
      const incident = state.agents[agentId];
      if (!incident) return "missing-incident";
      if (incident.handledFailures.includes(issue.key)) return "already-handled";
      if (incident.attempts >= config.retryDelaysSeconds.length) {
        return "retry-limit";
      }

      const messageId = randomUUID();
      incident.attempts += 1;
      incident.messageIds.push(messageId);
      incident.handledFailures.push(issue.key);
      incident.lastAttemptAt = new Date(this.now()).toISOString();
      incident.lastOutcome = "dispatch-reserved";
      // Reserve before network write so crashes/timeouts never double-send.
      this.store.saveState();

      const promptText = buildRecoveryPrompt(
        messageId,
        incident.attempts,
        config.retryDelaysSeconds.length,
        issue.category,
      );

      try {
        await port.send(agentId, promptText, { messageId });
        incident.lastOutcome = "accepted";
        this.store.appendEvent({
          event: "retry-sent",
          agentId,
          attempt: incident.attempts,
          maxAttempts: config.retryDelaysSeconds.length,
          category: issue.category,
          source: issue.source,
          messageId,
        });
      } catch (err) {
        incident.lastOutcome = "delivery-uncertain";
        this.store.appendEvent({
          event: "delivery-uncertain",
          agentId,
          attempt: incident.attempts,
          messageId,
          error: String(err instanceof Error ? err.message : err).slice(0, 300),
        });
      }
      this.store.saveState();
      return incident.lastOutcome;
    } finally {
      this.inFlight.delete(agentId);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const h of this.pendingInspectTimers.values()) this.clearTimer(h);
    this.pendingInspectTimers.clear();
    for (const h of this.pendingRetryTimers.values()) this.clearTimer(h);
    this.pendingRetryTimers.clear();
  }
}
