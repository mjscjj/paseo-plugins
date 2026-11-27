import {
  type PluginClientContext,
  type PluginScreenProps,
  type PluginSidebarItemProps,
  useAgent,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView, useToast } from "@getpaseo/plugin/client/react-native";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AgentQueueSummary } from "../shared/contracts.ts";
import type { ClientErrorReporter } from "./composer.tsx";
import { useAgentQueueActions, useQueueSummaries } from "./hooks.ts";
import { QueueManagerView } from "./queue-manager.tsx";

const SCREEN_ID = "bb-queue-overview";

interface SummaryCardProps {
  summary: AgentQueueSummary;
  theme: PluginScreenProps["theme"];
  compact: boolean;
  onOpenAgent?: () => void;
}

function AgentSummaryCard({
  summary,
  theme,
  compact,
  onOpenAgent,
}: SummaryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const actions = useAgentQueueActions(summary.agentId);
  const agentMeta = useAgent(summary.agentId, (agent) => ({
    title: agent.title,
    status: agent.status,
    provider: agent.provider,
    model: agent.model,
    cwd: agent.cwd,
  }));

  const title = agentMeta?.title?.trim() || `Agent ${summary.agentId.slice(0, 8)}`;
  const statusLabel = agentMeta?.status ?? "unknown";

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: summary.paused ? theme.colors.statusWarning : theme.colors.border,
        },
      ]}
    >
      <View style={styles.cardHeader}>
        <View style={styles.cardInfo}>
          <View style={styles.titleLine}>
            <Text
              numberOfLines={1}
              style={[styles.agentTitle, { color: theme.colors.foreground }]}
            >
              {title}
            </Text>
            <View
              style={[
                styles.statusBadge,
                {
                  backgroundColor: summary.paused
                    ? theme.colors.surface2
                    : theme.colors.accent,
                },
              ]}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "600",
                  color: summary.paused
                    ? theme.colors.statusWarning
                    : theme.colors.accentForeground,
                }}
              >
                {summary.paused ? `已暂停 (${summary.count})` : `排队 ${summary.count} 条`}
              </Text>
            </View>
          </View>

          <Text
            numberOfLines={1}
            style={{ fontSize: 12, color: theme.colors.foregroundMuted }}
          >
            状态: {statusLabel}
            {agentMeta?.model ? ` · ${agentMeta.model}` : ""}
            {agentMeta?.cwd ? ` · ${agentMeta.cwd}` : ""}
          </Text>

          {summary.paused && summary.pauseReason ? (
            <Text style={{ fontSize: 12, color: theme.colors.statusWarning }}>
              暂停原因：{summary.pauseReason}
            </Text>
          ) : summary.firstItemPreview ? (
            <Text
              numberOfLines={2}
              style={{ fontSize: 12, color: theme.colors.foregroundMuted }}
            >
              下一条：{summary.firstItemPreview}
            </Text>
          ) : null}
        </View>

        <View style={styles.cardActions}>
          {summary.paused ? (
            <Pressable
              accessibilityRole="button"
              style={[styles.btn, { backgroundColor: theme.colors.accent }]}
              onPress={() => actions.setPaused.mutate(false)}
            >
              <Icon name="Play" size={12} color={theme.colors.accentForeground} />
              <Text style={{ fontSize: 12, color: theme.colors.accentForeground }}>
                恢复
              </Text>
            </Pressable>
          ) : null}

          {onOpenAgent ? (
            <Pressable
              accessibilityRole="button"
              style={[styles.btn, { backgroundColor: theme.colors.surface2 }]}
              onPress={onOpenAgent}
            >
              <Text style={{ fontSize: 12, color: theme.colors.foreground }}>进入会话</Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            style={[styles.btn, { backgroundColor: theme.colors.surface2 }]}
            onPress={() => setExpanded((prev) => !prev)}
          >
            <Text style={{ fontSize: 12, color: theme.colors.foreground }}>
              {expanded ? "收起" : "管理队列"}
            </Text>
          </Pressable>
        </View>
      </View>

      {expanded ? (
        <View style={[styles.expandedBody, { borderTopColor: theme.colors.border }]}>
          <QueueManagerView
            agentId={summary.agentId}
            theme={theme}
            compact={compact}
            embedded
          />
        </View>
      ) : null}
    </View>
  );
}

export function GlobalQueueScreen({ theme, layout, navigation }: PluginScreenProps) {
  const summariesQuery = useQueueSummaries(1_500);
  const summaries = summariesQuery.data ?? [];
  const totalCount = summaries.reduce((acc, s) => acc + s.count, 0);
  const pausedCount = summaries.filter((s) => s.paused).length;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 14 : 24,
        gap: 14,
      }}
    >
      <View style={styles.screenHeader}>
        <Text style={[styles.screenTitle, { color: theme.colors.foreground }]}>
          BB 服务端队列总览
        </Text>
        <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>
          共 {summaries.length} 个活跃队列 · {totalCount} 条待执行消息
          {pausedCount > 0 ? ` · ${pausedCount} 个已暂停` : ""}
        </Text>
      </View>

      {summaries.length === 0 ? (
        <View
          style={[
            styles.emptyBox,
            { backgroundColor: theme.colors.surface1, borderColor: theme.colors.border },
          ]}
        >
          <Text style={{ fontSize: 13, lineHeight: 20, color: theme.colors.foregroundMuted }}>
            当前没有任何排队中的服务端消息。{"\n"}
            在任意 Agent 输入框发送以 &quot;bb &quot; 开头的消息（或使用 /bb 命令），即可在服务端持久化排队并在此处集中管理。
          </Text>
        </View>
      ) : (
        summaries.map((summary) => (
          <AgentSummaryCard
            key={summary.agentId}
            summary={summary}
            theme={theme}
            compact={layout.compact}
            onOpenAgent={
              navigation?.openAgent
                ? () => navigation.openAgent({ agentId: summary.agentId })
                : undefined
            }
          />
        ))
      )}
    </ScrollView>
  );
}

function createQueueSidebarItem(errorReporter: ClientErrorReporter) {
  return function QueueSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
    const toast = useToast();
    useEffect(() => {
      errorReporter.setToastHandler((msg) => toast.error(msg));
      return () => errorReporter.setToastHandler(null);
    }, [toast]);

    const summaries = useQueueSummaries(2_000).data ?? [];
    if (summaries.length === 0) {
      return null;
    }
    const totalCount = summaries.reduce((acc, s) => acc + s.count, 0);
    const pausedCount = summaries.filter((s) => s.paused).length;
    const label =
      pausedCount > 0
        ? `BB 队列 (${totalCount} · ${pausedCount} 暂停)`
        : `BB 队列 (${totalCount})`;

    return (
      <SidebarRow
        icon={pausedCount > 0 ? "Pause" : "ListOrdered"}
        label={label}
        active={currentScreen?.screenId === SCREEN_ID}
        onPress={() => openScreen({ screenId: SCREEN_ID })}
      />
    );
  };
}

export function contributeQueueSidebarAndScreen(
  client: PluginClientContext,
  errorReporter: ClientErrorReporter,
): () => void {
  const removeScreen = client.addScreen({
    id: SCREEN_ID,
    title: "BB 服务端队列总览",
    Component: GlobalQueueScreen,
  });

  const removeGlobalCmd = client.addCommandCenterItem({
    id: "open-bb-queue-overview",
    title: "查看全局 BB 服务端队列总览",
    icon: "ListOrdered",
    keywords: ["bb", "queue", "排队", "总览", "服务端队列"],
    context: "global",
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });

  const SidebarItemComponent = createQueueSidebarItem(errorReporter);
  const removeSidebar =
    typeof client.addSidebarFooterItem === "function"
      ? client.addSidebarFooterItem({
          id: "bb-queue-sidebar-footer",
          title: "BB 服务端队列",
          Component: SidebarItemComponent,
        })
      : () => {};

  return () => {
    removeSidebar();
    removeGlobalCmd();
    removeScreen();
  };
}

const styles = StyleSheet.create({
  screenHeader: {
    gap: 4,
    marginBottom: 4,
  },
  screenTitle: {
    fontSize: 18,
    fontWeight: "600",
  },
  emptyBox: {
    padding: 20,
    borderRadius: 10,
    borderWidth: 1,
  },
  card: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
  },
  cardInfo: {
    flex: 1,
    minWidth: 220,
    gap: 4,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  agentTitle: {
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 5,
  },
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  expandedBody: {
    borderTopWidth: 1,
    paddingTop: 8,
  },
});
