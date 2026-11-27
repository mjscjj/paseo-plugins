import { useAgents, useWorkspaces } from "@getpaseo/plugin/client";
import {
  isAwaitingPermission,
  isUnreadError,
  isUnreadFinished,
  newestFirst,
  type UnreadCounts,
} from "./rules.ts";

/** 省略 hosts 时统计 App 当前连着的所有主机。 */
export function useUnreadRefs(hosts?: readonly string[]) {
  const permission = useWorkspaces({
    hosts,
    where: isAwaitingPermission,
    orderBy: (a, b) => newestFirst(a.statusEnteredAt, b.statusEnteredAt),
  });
  const error = useAgents({
    hosts,
    where: isUnreadError,
    orderBy: (a, b) => newestFirst(a.lastActivityAt, b.lastActivityAt),
  });
  const finished = useAgents({
    hosts,
    where: isUnreadFinished,
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
