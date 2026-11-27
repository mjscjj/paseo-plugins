import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeQueueComposer, createClientErrorReporter } from "./client/composer.tsx";
import { TimingSettingsScreen } from "./client/settings-screen.tsx";
import { contributeQueueTimeline } from "./client/timeline.tsx";

export default function contribute(client: PluginClientContext) {
  const errorReporter = createClientErrorReporter();
  const removeComposer = contributeQueueComposer(client, errorReporter);
  const removeTimeline = contributeQueueTimeline(client);
  const removeSettings = client.addSettingsScreen({
    id: "timing",
    title: "定时间隔",
    icon: "Clock",
    Component: TimingSettingsScreen,
  });
  const removeSettingsCommand = client.addCommandCenterItem({
    id: "cc-queue-settings",
    title: "设置 CC 定时间隔",
    icon: "Clock",
    keywords: ["cc", "定时", "间隔", "interval"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings("timing");
    },
  });

  return () => {
    removeSettingsCommand();
    removeSettings();
    removeTimeline();
    removeComposer();
  };
}
