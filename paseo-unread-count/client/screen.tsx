import {
  type AgentRef,
  type PluginScreenProps,
  type WorkspaceRef,
  useAgent,
  useHosts,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useUnreadRefs } from "./hooks.ts";
import { formatAgo, totalUnread } from "./rules.ts";

type Theme = PluginScreenProps["theme"];
type Navigation = PluginScreenProps["navigation"];

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useHostLabel(hostId: string | undefined): string {
  const hosts = useHosts();
  if (!hostId) return "";
  return hosts.find((host) => host.serverId === hostId)?.label ?? hostId;
}

interface RowViewProps {
  theme: Theme;
  icon: string;
  iconColor: string;
  title: string;
  subtitle: string;
  onPress?: () => void;
}

function RowView({ theme, icon, iconColor, title, subtitle, onPress }: RowViewProps) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Icon name={icon} size={16} color={iconColor} />
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.colors.foreground }]}>
          {title}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
          {subtitle}
        </Text>
      </View>
      {onPress ? (
        <Icon name="ChevronRight" size={16} color={theme.colors.foregroundMuted} />
      ) : null}
    </Pressable>
  );
}

function joinParts(parts: (string | null | undefined)[]): string {
  return parts.filter((part) => part && part.trim()).join(" · ");
}

function AgentRow({
  agentRef,
  kind,
  theme,
  navigation,
  now,
}: {
  agentRef: AgentRef;
  kind: "error" | "finished";
  theme: Theme;
  navigation: Navigation;
  now: number;
}) {
  const agent = useAgent(agentRef, (a) => ({
    id: a.id,
    hostId: a.hostId,
    title: a.title,
    provider: a.provider,
    lastActivityAt: a.lastActivityAt,
    workspace: a.workspace,
  }));
  if (!agent) return null;
  return <AgentRowBody agent={agent} kind={kind} theme={theme} navigation={navigation} now={now} />;
}

function AgentRowBody({
  agent,
  kind,
  theme,
  navigation,
  now,
}: {
  agent: {
    id: string;
    hostId: string;
    title: string | null;
    provider: string;
    lastActivityAt: string;
    workspace: WorkspaceRef;
  };
  kind: "error" | "finished";
  theme: Theme;
  navigation: Navigation;
  now: number;
}) {
  const workspaceName = useWorkspace(agent.workspace, (w) => w.title ?? w.name);
  const hostLabel = useHostLabel(agent.hostId);
  const title = agent.title?.trim() || `Agent ${agent.id.slice(0, 8)}`;
  return (
    <RowView
      theme={theme}
      icon={kind === "error" ? "CircleAlert" : "CircleCheck"}
      iconColor={kind === "error" ? theme.colors.statusDanger : theme.colors.statusSuccess}
      title={title}
      subtitle={joinParts([hostLabel, workspaceName, agent.provider, formatAgo(agent.lastActivityAt, now)])}
      onPress={
        navigation?.openAgent
          ? () => navigation.openAgent({ agentId: agent.id, serverId: agent.hostId })
          : undefined
      }
    />
  );
}

function PermissionRow({
  workspaceRef,
  theme,
  navigation,
  now,
}: {
  workspaceRef: WorkspaceRef;
  theme: Theme;
  navigation: Navigation;
  now: number;
}) {
  const workspace = useWorkspace(workspaceRef, (w) => ({
    id: w.id,
    hostId: w.hostId,
    name: w.title ?? w.name,
    project: w.projectDisplayName,
    statusEnteredAt: w.statusEnteredAt,
  }));
  const hostLabel = useHostLabel(workspace?.hostId);
  if (!workspace) return null;
  return (
    <RowView
      theme={theme}
      icon="ShieldQuestionMark"
      iconColor={theme.colors.statusWarning}
      title={workspace.name}
      subtitle={joinParts([hostLabel, workspace.project, formatAgo(workspace.statusEnteredAt, now)])}
      onPress={
        navigation?.openWorkspace
          ? () =>
              navigation.openWorkspace({ workspaceId: workspace.id, serverId: workspace.hostId })
          : undefined
      }
    />
  );
}

function Section({
  theme,
  title,
  count,
  children,
}: {
  theme: Theme;
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: theme.colors.foregroundMuted }]}>
        {title}（{count}）
      </Text>
      {children}
    </View>
  );
}

export function UnreadScreen({ theme, layout, navigation }: PluginScreenProps) {
  const refs = useUnreadRefs();
  const hosts = useHosts();
  const now = useNow();
  const total = totalUnread({
    permission: refs.permission.length,
    error: refs.error.length,
    finished: refs.finished.length,
  });
  const offline = hosts.filter((host) => host.status !== "online");

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 14 : 24, gap: 18 }}
    >
      <View style={{ gap: 4 }}>
        <Text style={[styles.screenTitle, { color: theme.colors.foreground }]}>未看的会话</Text>
        <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>
          {total === 0 ? "都看完了。" : `共 ${total} 个`}
          {` · 统计 ${hosts.length - offline.length} 台在线主机，不含子 agent`}
        </Text>
        {offline.length > 0 ? (
          <Text style={{ fontSize: 12, color: theme.colors.statusWarning }}>
            未连接：{offline.map((host) => host.label).join("、")}（这些主机的会话没统计进来）
          </Text>
        ) : null}
      </View>

      <Section theme={theme} title="等你审批" count={refs.permission.length}>
        {refs.permission.map((ref) => (
          <PermissionRow key={ref.key} workspaceRef={ref} theme={theme} navigation={navigation} now={now} />
        ))}
      </Section>
      <Section theme={theme} title="出错" count={refs.error.length}>
        {refs.error.map((ref) => (
          <AgentRow key={ref.key} agentRef={ref} kind="error" theme={theme} navigation={navigation} now={now} />
        ))}
      </Section>
      <Section theme={theme} title="已完成" count={refs.finished.length}>
        {refs.finished.map((ref) => (
          <AgentRow key={ref.key} agentRef={ref} kind="finished" theme={theme} navigation={navigation} now={now} />
        ))}
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screenTitle: { fontSize: 18, fontWeight: "600" },
  section: { gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 14, fontWeight: "500" },
});
