import {
  type PluginSidebarItemProps,
  type PluginWorkspaceRowBadgeItemProps,
  useAgents,
} from "@getpaseo/plugin/client";
import { SidebarRow, WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useUnreadCounts } from "./hooks.ts";
import { agentUnreadKind, formatSidebarLabel } from "./rules.ts";

export const SCREEN_ID = "unread-overview";

/** 侧边栏最上面一行：统计所有已连接主机。全部为 0 时不显示。 */
export function UnreadSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const counts = useUnreadCounts();
  const label = formatSidebarLabel(counts);
  if (!label) return null;
  return (
    <SidebarRow
      icon={counts.permission > 0 ? "BellRing" : counts.error > 0 ? "BellDot" : "Bell"}
      label={label}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

/**
 * 工作区行上的“未看 N”。Paseo 只为插件所在主机的工作区渲染它，
 * 所以其他主机的工作区要在那台主机也装上插件才有。等审批 Paseo 本身已用状态点标出，这里只数完成和出错。
 */
export function UnreadWorkspaceBadge({ workspaceId, host }: PluginWorkspaceRowBadgeItemProps) {
  const errors = useAgents({
    hosts: [host.id],
    where: (a) => a.workspaceId === workspaceId && agentUnreadKind(a) === "error",
  }).length;
  const finished = useAgents({
    hosts: [host.id],
    where: (a) => a.workspaceId === workspaceId && agentUnreadKind(a) === "finished",
  }).length;
  const total = errors + finished;
  if (total === 0) return null;
  return (
    <WorkspaceRowBadge
      icon={errors > 0 ? "CircleAlert" : "Bell"}
      label={`未看 ${total}`}
      tone={errors > 0 ? "danger" : "info"}
      accessibilityLabel={`未看 ${total}（出错 ${errors}，完成 ${finished}）`}
    />
  );
}
