import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { z } from "zod";
import { CC_PREFIX_REGEX } from "../shared/cc-contracts.ts";
import { useAgentQueue } from "./cc-hooks.ts";

const TIMELINE_DISPATCHED_KIND = "cc-dispatched-message";
const TIMELINE_DISPATCHED_VERSION = 1;

const TimelineDispatchedDataSchema = z.object({
  clientMessageId: z.string().nullable(),
  fallbackText: z.string(),
});

type TimelineDispatchedData = z.infer<typeof TimelineDispatchedDataSchema>;

function formatTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return "";
  return date.toTimeString().slice(0, 5);
}

function CcDispatchedMessageBubble({
  agentId,
  theme,
  timestamp,
  item,
}: PluginTimelineItemProps<TimelineDispatchedData>) {
  const toast = useToast();
  const queueQuery = useAgentQueue(agentId, 5_000);
  const clientMsgId = item.data.clientMessageId;
  const serverRecordedText =
    clientMsgId && queueQuery.data?.dispatchedTexts
      ? queueQuery.data.dispatchedTexts[clientMsgId]
      : undefined;
  const displayText = serverRecordedText ?? item.data.fallbackText;
  const timeLabel = formatTime(timestamp);

  const handleCopy = () => {
    if (!displayText) return;
    void copyText(displayText).then(
      () => toast.show("已复制消息", { durationMs: 1_200 }),
      (err) => toast.error(err instanceof Error ? err.message : String(err)),
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View
          style={[
            styles.bubble,
            {
              backgroundColor: theme.colors.surface2,
            },
          ]}
        >
          <Text style={[styles.text, { color: theme.colors.foreground }]}>
            {displayText || "(仅图片/附件消息)"}
          </Text>
        </View>
        <View style={styles.trailingRow}>
          {timeLabel ? (
            <Text style={[styles.timestampText, { color: theme.colors.foregroundMuted }]}>
              {timeLabel}
            </Text>
          ) : null}
          {displayText ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="复制消息"
              hitSlop={6}
              style={styles.copyBtn}
              onPress={handleCopy}
            >
              <Icon name="Copy" size={12} color={theme.colors.foregroundMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function contributeQueueTimeline(client: PluginClientContext): () => void {
  const removeRenderer = client.addTimelineRenderer({
    kind: TIMELINE_DISPATCHED_KIND,
    version: TIMELINE_DISPATCHED_VERSION,
    schema: TimelineDispatchedDataSchema,
    Component: CcDispatchedMessageBubble,
  });

  const removeTransformer = client.addTimelineTransformer({
    id: "cc-queue-timeline-projection",
    query: { itemType: "user_message" },
    transform({ item }) {
      if (!CC_PREFIX_REGEX.test(item.text)) {
        return undefined;
      }
      // 1. Still waiting in timed queue (unacknowledged optimistic submission):
      // Hide from the scrolling timeline so subsequent tool calls & replies never bury it.
      // It stays pinned in the sticky bottom Composer Pill above the input bar instead.
      if (item.messageId === undefined) {
        return { items: [] };
      }
      // 2. Dispatched to the agent:
      // Paseo moves the reconciled row to the bottom of the timeline as the start of the new turn,
      // but retains the local optimistic `item.text` ("cc ...") in memory until reload.
      // Render it as a clean user bubble with the "cc " prefix stripped.
      return {
        items: [
          {
            type: "plugin",
            kind: TIMELINE_DISPATCHED_KIND,
            version: TIMELINE_DISPATCHED_VERSION,
            data: {
              clientMessageId: item.clientMessageId ?? null,
              fallbackText: item.text.replace(CC_PREFIX_REGEX, ""),
            },
          },
        ],
      };
    },
  });

  return () => {
    removeTransformer();
    removeRenderer();
  };
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 12,
    marginBottom: 8,
  },
  content: {
    alignItems: "flex-end",
    maxWidth: "88%",
  },
  bubble: {
    borderRadius: 16,
    borderTopRightRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 11,
    minWidth: 0,
    flexShrink: 1,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
  },
  trailingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  timestampText: {
    fontSize: 11,
  },
  copyBtn: {
    padding: 2,
  },
});
