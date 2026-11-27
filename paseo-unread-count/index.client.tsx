import type { PluginClientContext } from "@getpaseo/plugin/client";
import { UnreadScreen } from "./client/screen.tsx";
import { SCREEN_ID, UnreadSidebarItem, UnreadWorkspaceBadge } from "./client/sidebar.tsx";

const noop = () => {};

export default function contribute(client: PluginClientContext) {
  const removeScreen = client.addScreen({
    id: SCREEN_ID,
    title: "未看的会话",
    Component: UnreadScreen,
  });
  const removeSidebar = client.addSidebarHeaderItem({
    id: "unread-count",
    title: "未看会话",
    Component: UnreadSidebarItem,
  });
  // 旧版 App 没有下面两个接口；缺了就跳过，不影响侧边栏那一行。
  const removeBadge =
    typeof client.addWorkspaceRowBadgeItem === "function"
      ? client.addWorkspaceRowBadgeItem({
          id: "unread-count-badge",
          title: "未看数",
          icon: "Bell",
          Component: UnreadWorkspaceBadge,
        })
      : noop;
  const removeCommand =
    typeof client.addCommandCenterItem === "function"
      ? client.addCommandCenterItem({
          id: "open-unread-overview",
          title: "查看未看的会话",
          icon: "Bell",
          keywords: ["unread", "未看", "未读", "完成", "审批"],
          context: "global",
          onSelect({ openScreen }) {
            openScreen({ screenId: SCREEN_ID });
          },
        })
      : noop;
  return () => {
    removeCommand();
    removeBadge();
    removeSidebar();
    removeScreen();
  };
}
