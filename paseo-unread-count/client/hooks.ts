import { useAgents, useWorkspaces } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import {
  inLiveWorkspace,
  isAwaitingPermission,
  isLiveWorkspace,
  isUnreadError,
  isUnreadFinished,
  newestFirst,
  type UnreadCounts,
} from "./rules.ts";

/** 省略 hosts 时统计 App 当前连着的所有主机。 */
export function useUnreadRefs(hosts?: readonly string[]) {
  const liveWorkspaces = useWorkspaces({ hosts, where: isLiveWorkspace });
  const liveWorkspaceKeys = useMemo(
    () => new Set(liveWorkspaces.map((ref) => ref.key)),
    [liveWorkspaces],
  );
  const permission = useWorkspaces({
    hosts,
    where: isAwaitingPermission,
    orderBy: (a, b) => newestFirst(a.statusEnteredAt, b.statusEnteredAt),
  });
  // where 每次渲染都会重新求值，闭包里的 liveWorkspaceKeys 总是最新的。
  const error = useAgents({
    hosts,
    where: (agent) => isUnreadError(agent) && inLiveWorkspace(agent, liveWorkspaceKeys),
    orderBy: (a, b) => newestFirst(a.lastActivityAt, b.lastActivityAt),
  });
  const finished = useAgents({
    hosts,
    where: (agent) => isUnreadFinished(agent) && inLiveWorkspace(agent, liveWorkspaceKeys),
    orderBy: (a, b) => newestFirst(a.lastActivityAt, b.lastActivityAt),
  });
  return { permission, error, finished };
}

export function useUnreadCounts(hosts?: readonly string[]): UnreadCounts {
  const refs = useUnreadRefs(hosts);
  return {
    permission: refs.permission.length,
    error: refs.error.length,
    finished: refs.finished.length,
  };
}
