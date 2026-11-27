import type { PluginAgentSnapshot, PluginWorkspaceSnapshot } from "@getpaseo/plugin";

/**
 * 统计口径：
 * - 完成 / 出错：Paseo 自己的“未看”标记（requiresAttention + attentionReason），
 *   打开会话后由 Paseo 清除。
 * - 等审批：Paseo 不给权限请求设 requiresAttention，而是让工作区状态变成 needs_input；
 *   同一工作区里的子 agent 不会把工作区拉成 needs_input，所以按工作区统计。
 * - 子 agent、后台 helper、子 agent 开出来的工作区都不算。
 * - 只算所在工作区还在、且没在归档中的会话。归档工作区时 App 只移除工作区，若漏收了
 *   agent 自己的归档更新，agent 会带着旧的“未看”标记留在本地，点进去才发现已归档；
 *   App 侧边栏按工作区显示所以看不到它，这里按同样口径排除。
 */

export type UnreadKind = "permission" | "error" | "finished";

type AgentFields = Pick<
  PluginAgentSnapshot,
  "background" | "parentAgentId" | "parentAgent" | "requiresAttention" | "attentionReason"
>;

type WorkspaceFields = Pick<
  PluginWorkspaceSnapshot,
  "status" | "background" | "parentAgent" | "archivingAt"
>;

function isTopLevelAgent(agent: AgentFields): boolean {
  return !agent.background && agent.parentAgentId == null && agent.parentAgent == null;
}

export function agentUnreadKind(agent: AgentFields): "finished" | "error" | null {
  if (!isTopLevelAgent(agent) || !agent.requiresAttention) return null;
  if (agent.attentionReason === "finished") return "finished";
  if (agent.attentionReason === "error") return "error";
  return null;
}

export function isUnreadFinished(agent: AgentFields): boolean {
  return agentUnreadKind(agent) === "finished";
}

export function isUnreadError(agent: AgentFields): boolean {
  return agentUnreadKind(agent) === "error";
}

/** 工作区还在，且不在归档过程中。 */
export function isLiveWorkspace(workspace: Pick<PluginWorkspaceSnapshot, "archivingAt">): boolean {
  return workspace.archivingAt == null;
}

/** agent 所在工作区是否在当前可见的工作区里（用 ref.key，跨主机唯一）。 */
export function inLiveWorkspace(
  agent: { workspace: { key: string } },
  liveWorkspaceKeys: ReadonlySet<string>,
): boolean {
  return liveWorkspaceKeys.has(agent.workspace.key);
}

export function isAwaitingPermission(workspace: WorkspaceFields): boolean {
  return (
    workspace.status === "needs_input" &&
    !workspace.background &&
    workspace.parentAgent == null &&
    isLiveWorkspace(workspace)
  );
}

export interface UnreadCounts {
  permission: number;
  error: number;
  finished: number;
}

export function totalUnread(counts: UnreadCounts): number {
  return counts.permission + counts.error + counts.finished;
}

/** 侧边栏那一行的文字；全部为 0 时返回 null（整行隐藏）。 */
export function formatSidebarLabel(counts: UnreadCounts): string | null {
  const total = totalUnread(counts);
  if (total === 0) return null;
  const parts: string[] = [];
  if (counts.permission > 0) parts.push(`审批 ${counts.permission}`);
  if (counts.error > 0) parts.push(`出错 ${counts.error}`);
  if (counts.finished > 0) parts.push(`完成 ${counts.finished}`);
  return `未看 ${total} · ${parts.join(" · ")}`;
}

export function formatAgo(iso: string | null, now: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 按时间倒序，最近的在上面。 */
export function newestFirst(a: string | null, b: string | null): number {
  return toMillis(b) - toMillis(a);
}

function toMillis(iso: string | null): number {
  const value = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(value) ? 0 : value;
}
