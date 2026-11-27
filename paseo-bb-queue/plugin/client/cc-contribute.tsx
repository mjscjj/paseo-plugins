import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributeQueueComposer, createClientErrorReporter } from "./cc-composer.tsx";
import { TimingSettingsScreen } from "./cc-settings-screen.tsx";
import { contributeQueueTimeline } from "./cc-timeline.tsx";

/** The "cc " timed queue's composer pill, panel, timeline cards and settings. */
export function contributeTimedQueueClient(client: PluginClientContext): () => void {
  const errorReporter = createClientErrorReporter();
  const removeComposer = contributeQueueComposer(client, errorReporter);
  const removeTimeline = contributeQueueTimeline(client);
  const removeSettings = client.addSettingsScreen({
    id: "cc-timing",
    title: "CC 定时间隔",
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
      openSettings("cc-timing");
    },
  });

  return () => {
    removeSettingsCommand();
    removeSettings();
    removeTimeline();
    removeComposer();
  };
}
