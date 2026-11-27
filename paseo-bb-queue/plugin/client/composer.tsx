import type {
  PluginAgentPanelProps,
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { Alert } from "react-native";
import {
  type AgentQueueSummary,
  BB_PREFIX_REGEX,
  enqueueManualRpc,
  ingestRpc,
  listQueueSummariesRpc,
  setFrontendQueueHoldRpc,
} from "../shared/contracts.ts";
import { registerFrontendQueueBridgeOwner } from "./frontend-queue-bridge.ts";
import { QueueManagerView } from "./queue-manager.tsx";

const SUMMARY_POLL_MS = 1_500;
const AGENT_PAGE_LIMIT = 200;
const PILL_PREVIEW_MAX_CHARS = 15;

export interface ClientErrorReporter {
  setToastHandler(handler: ((message: string) => void) | null): void;
  report(message: string): void;
}

export function createClientErrorReporter(): ClientErrorReporter {
  let toastHandler: ((message: string) => void) | null = null;
  return {
    setToastHandler(handler) {
      toastHandler = handler;
    },
    report(message: string) {
      if (toastHandler) {
        toastHandler(message);
        return;
      }
      Alert.alert("BB 服务端队列", message);
    },
  };
}

export function QueuePopoverContent(props: PluginButtonContentProps) {
  if (props.context !== "agent") {
    return null;
  }
  return (
    <QueueManagerView
      agentId={props.agentId}
      theme={props.theme}
      compact={props.layout.compact}
      surface="popover"
    />
  );
}

export function QueueAgentPanel(props: PluginAgentPanelProps) {
  const compatProps = props as PluginAgentPanelProps & {
    params?: { readonly agentId?: string };
    agentId?: string;
  };
  const resolvedAgentId = compatProps.params?.agentId ?? compatProps.agentId ?? "";
  return (
    <QueueManagerView
      agentId={resolvedAgentId}
      theme={props.theme}
      compact={props.layout.compact}
      surface="panel"
      embedded
    />
  );
}

function compactPreview(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (!singleLine) return null;
  return singleLine.length > PILL_PREVIEW_MAX_CHARS
    ? `${singleLine.slice(0, PILL_PREVIEW_MAX_CHARS)}…`
    : singleLine;
}

function formatPillLabel(summary: AgentQueueSummary | undefined): string {
  if (!summary) return "BB 排队";
  const prefix = summary.paused
    ? `BB 暂停 (${summary.count})`
    : summary.waitingReason
      ? `BB 等待 (${summary.count})`
      : `BB 排队 (${summary.count})`;
  const preview = compactPreview(summary.firstItemPreview);
  return preview ? `${prefix}: ${preview}` : prefix;
}

function formatSheetTitle(summary: AgentQueueSummary | undefined): string {
  if (!summary) return "BB 服务端队列";
  return summary.paused
    ? `BB 服务端队列 · 已暂停 (${summary.count})`
    : `BB 服务端队列 (${summary.count})`;
}

export function contributeQueueComposer(
  client: PluginClientContext,
  errorReporter: ClientErrorReporter,
): () => void {
  const instanceId = `bbq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  const clientCompat = client as PluginClientContext & {
    addAgentPanel?: (contribution: {
      id: string;
      title: string;
      icon: string;
      locations?: readonly ("workspace" | "explorer")[];
      Component: typeof QueueAgentPanel;
    }) => () => void;
  };
  const removePanel =
    typeof clientCompat.addAgentPanel === "function"
      ? clientCompat.addAgentPanel({
          id: "bb-queue-panel",
          title: "BB 服务端队列",
          icon: "ListOrdered",
          locations: ["workspace", "explorer"],
          Component: QueueAgentPanel,
        })
      : client.addWorkspacePanel({
          id: "bb-queue-panel",
          title: "BB 服务端队列",
          icon: "ListOrdered",
          context: "agent",
          locations: ["workspace", "explorer"],
          Component: QueueAgentPanel,
        });

  const removeCommand = client.addCommandCenterItem({
    id: "open-bb-queue-panel",
    title: "打开当前 Agent 的 BB 服务端队列面板",
    icon: "ListOrdered",
    keywords: ["bb", "queue", "排队", "服务端队列"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("bb-queue-panel");
    },
  });

  const removeSlash = client.addSlashCommand({
    name: "bb",
    description: "将消息加入服务端持久化队列（Agent 空闲时直接发送）",
    argumentHint: "<待排队的任务内容>",
    context: "agent",
    async onSubmit({ agent, args, rpc, openPanel }) {
      const cleaned = args.replace(BB_PREFIX_REGEX, "").trim();
      if (!cleaned) {
        openPanel("bb-queue-panel");
        return;
      }
      await rpc(enqueueManualRpc, { agentId: agent.id, text: cleaned });
      void pollSummaries();
    },
  });

  const knownAgentIds = new Set<string>();
  const agents = new Map<string, string>(); // agentId -> workspaceId
  const pills = new Map<
    string,
    { workspaceId: string; registration: PluginButtonRegistration }
  >();
  let summaries = new Map<string, AgentQueueSummary>();
  let stopped = false;
  let polling = false;
  const lifetime = new AbortController();
  let unsubscribeDir: (() => void) | null = null;
  let releaseDir: (() => Promise<void>) | null = null;

  const removePill = (agentId: string) => {
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };

  const syncAgentPill = (agentId: string, workspaceId: string) => {
    const summary = summaries.get(agentId);
    const shouldShow = Boolean(summary && (summary.count > 0 || summary.paused));
    const existing = pills.get(agentId);

    if (!shouldShow) {
      if (existing) {
        existing.registration.update({ visible: false });
      }
      return;
    }

    const label = formatPillLabel(summary);
    const title = formatSheetTitle(summary);
    if (existing && existing.workspaceId === workspaceId) {
      existing.registration.update({
        label,
        title,
        icon: summary?.paused ? "Pause" : "ListOrdered",
        visible: true,
      });
      return;
    }

    removePill(agentId);
    const registration = client.addComposerPill({
      id: "bb-server-queue",
      workspaceId,
      agentId,
      button: {
        title,
        label,
        icon: summary?.paused ? "Pause" : "ListOrdered",
        visible: true,
        behavior: {
          kind: "popover",
          Content: QueuePopoverContent,
        },
      },
    });
    pills.set(agentId, { workspaceId, registration });
  };

  const syncAll = () => {
    for (const [agentId, workspaceId] of agents.entries()) {
      syncAgentPill(agentId, workspaceId);
    }
  };

  const pollSummaries = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const res = await client.rpc(listQueueSummariesRpc, {});
      if (stopped) return;
      const next = new Map<string, AgentQueueSummary>();
      for (const item of res.summaries) {
        next.set(item.agentId, item);
      }
      summaries = next;
      syncAll();
    } catch {
      // Ignore transient disconnect while polling badge state
    } finally {
      polling = false;
    }
  };

  const removeFrontendBridge = registerFrontendQueueBridgeOwner({
    id: instanceId,
    hasAgent(agentId) {
      return knownAgentIds.has(agentId);
    },
    async ingest(payload) {
      const result = await client.rpc(ingestRpc, payload);
      if (!result.accepted) {
        throw new Error(result.error ?? "服务端入队失败");
      }
      await pollSummaries();
    },
    setFrontendHold(agentId, hasFrontendItems) {
      void client
        .rpc(setFrontendQueueHoldRpc, { agentId, hasFrontendItems })
        .catch(() => undefined);
    },
    reportError(message) {
      errorReporter.report(message);
    },
  });

  const loadRemainingPages = async (initialNextCursor: string | null | undefined) => {
    let cursor = initialNextCursor ?? null;
    while (cursor && !stopped) {
      const page = await client.paseo.agents.list({
        scope: "active",
        page: { limit: AGENT_PAGE_LIMIT, cursor },
        signal: lifetime.signal,
      });
      if (stopped) return;
      for (const entry of page.entries) {
        knownAgentIds.add(entry.agent.id);
        if (entry.agent.workspaceId) {
          agents.set(entry.agent.id, entry.agent.workspaceId);
        }
      }
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? null) : null;
    }
    syncAll();
  };

  void client.paseo.agents
    .list({
      scope: "active",
      page: { limit: AGENT_PAGE_LIMIT },
      subscribe: {},
      signal: lifetime.signal,
    })
    .then(({ entries, pageInfo, subscription }) => {
      if (stopped) {
        void subscription.release().catch(() => undefined);
        return;
      }
      for (const entry of entries) {
        knownAgentIds.add(entry.agent.id);
        if (entry.agent.workspaceId) {
          agents.set(entry.agent.id, entry.agent.workspaceId);
        }
      }
      syncAll();
      if (pageInfo.hasMore) {
        void loadRemainingPages(pageInfo.nextCursor).catch(() => undefined);
      }
      void pollSummaries();

      releaseDir = subscription.release;
      unsubscribeDir = subscription.subscribe({
        snapshot: (snap) => {
          knownAgentIds.clear();
          agents.clear();
          for (const entry of snap.entries) {
            knownAgentIds.add(entry.agent.id);
            if (entry.agent.workspaceId) {
              agents.set(entry.agent.id, entry.agent.workspaceId);
            }
          }
          syncAll();
          if (snap.pageInfo.hasMore) {
            void loadRemainingPages(snap.pageInfo.nextCursor).catch(() => undefined);
          }
        },
        update: (msg) => {
          if (msg.type !== "agent_update") return;
          const payload = msg.payload;
          if (payload.kind === "remove") {
            knownAgentIds.delete(payload.agentId);
            agents.delete(payload.agentId);
            removePill(payload.agentId);
            return;
          }
          knownAgentIds.add(payload.agent.id);
          if (payload.agent.workspaceId) {
            agents.set(payload.agent.id, payload.agent.workspaceId);
            syncAgentPill(payload.agent.id, payload.agent.workspaceId);
            void pollSummaries();
          }
        },
      });
    })
    .catch(() => undefined);

  const timer = setInterval(() => void pollSummaries(), SUMMARY_POLL_MS);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    removeFrontendBridge();
    unsubscribeDir?.();
    void releaseDir?.().catch(() => undefined);
    lifetime.abort();
    for (const { registration } of pills.values()) {
      registration.remove();
    }
    pills.clear();
    agents.clear();
    knownAgentIds.clear();
    removeSlash();
    removeCommand();
    removePanel();
  };
}
