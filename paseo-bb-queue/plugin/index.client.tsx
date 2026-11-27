import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeQueueComposer, createClientErrorReporter } from "./client/composer.tsx";
import { contributeQueueSidebarAndScreen } from "./client/sidebar-screen.tsx";
import { contributeQueueTimeline } from "./client/timeline.tsx";

export default function contribute(client: PluginClientContext) {
  const errorReporter = createClientErrorReporter();
  const removeComposer = contributeQueueComposer(client, errorReporter);
  const removeTimeline = contributeQueueTimeline(client);
  const removeSidebarAndScreen = contributeQueueSidebarAndScreen(client, errorReporter);

  return () => {
    removeSidebarAndScreen();
    removeTimeline();
    removeComposer();
  };
}
