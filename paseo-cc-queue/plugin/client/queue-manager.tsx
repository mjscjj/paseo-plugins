import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CC_PREFIX_REGEX, type QueuedItemView } from "../shared/contracts.ts";
import { useAgentQueue, useAgentQueueActions } from "./hooks.ts";
import { formatCountdown, formatDue } from "./time-format.ts";

export interface QueueManagerViewProps {
  agentId: string;
  theme: PluginTheme;
  compact: boolean;
  surface?: "popover" | "panel";
  embedded?: boolean;
}

interface QueueItemRowProps {
  item: QueuedItemView;
  index: number;
  total: number;
  theme: PluginTheme;
  busy: boolean;
  onSaveText(itemId: string, text: string): Promise<unknown>;
  onSendNow(itemId: string): void;
  onRemove(itemId: string): void;
}

function QueueItemRow({
  item,
  index,
  total,
  theme,
  busy,
  onSaveText,
  onSendNow,
  onRemove,
}: QueueItemRowProps) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(item.text);

  const beginEdit = () => {
    setEditDraft(item.text);
    setEditing(true);
  };

  const commitEdit = async () => {
    await onSaveText(item.id, editDraft);
    setEditing(false);
  };

  const metaParts: string[] = [];
  const dueText = formatDue(item.dueAt);
  if (dueText) metaParts.push(`${dueText} 发送`);
  const countdown = formatCountdown(item.dueAt);
  if (countdown) metaParts.push(countdown);
  if (item.imageCount > 0) metaParts.push(`图片×${item.imageCount}`);
  if (item.attachmentCount > 0) metaParts.push(`附件×${item.attachmentCount}`);

  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: theme.colors.surface1,
          borderColor: theme.colors.border,
        },
      ]}
    >
      {editing ? (
        <View style={styles.editArea}>
          <TextInput
            value={editDraft}
            onChangeText={setEditDraft}
            multiline
            style={[
              styles.editInput,
              {
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface0,
                borderColor: theme.colors.border,
              },
            ]}
          />
          <View style={styles.editActions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[styles.smallBtn, { backgroundColor: theme.colors.surface2 }]}
              onPress={() => setEditing(false)}
            >
              <Text style={{ fontSize: 12, color: theme.colors.foreground }}>取消</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[styles.smallBtn, { backgroundColor: theme.colors.accent }]}
              onPress={() => void commitEdit()}
            >
              <Text style={{ fontSize: 12, color: theme.colors.accentForeground }}>保存</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View style={styles.rowMain}>
          <View style={styles.rowHeader}>
            <View style={[styles.badge, { backgroundColor: theme.colors.surface2 }]}>
              <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.foreground }}>
                #{index + 1}
              </Text>
            </View>
            {metaParts.length > 0 ? (
              <Text style={{ fontSize: 11, color: theme.colors.foregroundMuted }}>
                {metaParts.join(" · ")}
              </Text>
            ) : null}
          </View>

          <Text
            numberOfLines={6}
            style={[styles.itemText, { color: theme.colors.foreground }]}
          >
            {item.text || "(仅图片/附件消息)"}
          </Text>

          <View style={styles.actionBar}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="立即发送该定时消息"
              disabled={busy}
              style={[
                styles.actionChip,
                { backgroundColor: theme.colors.accent },
                busy && styles.disabled,
              ]}
              onPress={() => onSendNow(item.id)}
            >
              <Icon name="Play" size={11} color={theme.colors.accentForeground} />
              <Text style={{ fontSize: 11, fontWeight: "500", color: theme.colors.accentForeground }}>
                立即发送
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="编辑定时消息"
              disabled={busy}
              style={[styles.actionChip, { backgroundColor: theme.colors.surface2 }]}
              onPress={beginEdit}
            >
              <Icon name="Pencil" size={11} color={theme.colors.foreground} />
              <Text style={{ fontSize: 11, color: theme.colors.foreground }}>编辑</Text>
            </Pressable>

            <View style={styles.spacer} />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="撤回定时消息"
              disabled={busy}
              style={[styles.iconBtn, busy && styles.disabled]}
              onPress={() => onRemove(item.id)}
            >
              <Icon name="Trash2" size={13} color={theme.colors.statusDanger} />
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

export function QueueManagerView({
  agentId,
  theme,
  compact,
  surface = "panel",
  embedded = false,
}: QueueManagerViewProps) {
  const queueQuery = useAgentQueue(agentId);
  const actions = useAgentQueueActions(agentId);
  const [draft, setDraft] = useState("");

  const isPopover = surface === "popover";
  const hideDuplicateTitle = isPopover && compact;

  const detail = queueQuery.data;
  const items = detail?.items ?? [];
  const interval = detail?.intervalMinutes ?? 30;
  const paused = detail?.paused ?? false;
  const busy =
    actions.enqueue.isPending ||
    actions.updateText.isPending ||
    actions.sendNow.isPending ||
    actions.remove.isPending ||
    actions.setPaused.isPending ||
    actions.clear.isPending;

  const submitDraft = () => {
    const cleaned = draft.replace(CC_PREFIX_REGEX, "").trim();
    if (!cleaned || actions.enqueue.isPending) return;
    actions.enqueue.mutate(cleaned, {
      onSuccess: () => setDraft(""),
    });
  };

  const renderedRows =
    items.length === 0 ? (
      <Text style={[styles.empty, { color: theme.colors.foregroundMuted }]}>
        当前没有定时消息。{"\n"}以 &quot;cc &quot; 开头（或敲 /cc）的消息会在 {interval} 分钟后发送，后续每条再顺延 {interval} 分钟。
      </Text>
    ) : (
      items.map((item, idx) => (
        <QueueItemRow
          key={item.id}
          item={item}
          index={idx}
          total={items.length}
          theme={theme}
          busy={busy}
          onSaveText={(itemId, text) =>
            actions.updateText.mutateAsync({ itemId, text })
          }
          onSendNow={(itemId) => actions.sendNow.mutate({ itemId })}
          onRemove={(itemId) => actions.remove.mutate(itemId)}
        />
      ))
    );

  return (
    <View
      style={[
        isPopover ? styles.popoverContainer : styles.panelContainer,
        isPopover && !compact && { width: 372 },
        !isPopover && !embedded && { backgroundColor: theme.colors.surface0, flex: 1 },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        {hideDuplicateTitle ? (
          <Text
            numberOfLines={1}
            style={[styles.subtitleHint, { color: theme.colors.foregroundMuted }]}
          >
            {paused ? "定时发送已暂停" : `每条间隔 ${interval} 分钟，到点且空闲时发送`}
          </Text>
        ) : (
          <View style={styles.titleRow}>
            <Icon name="Clock" size={15} color={theme.colors.foreground} />
            <Text style={[styles.title, { color: theme.colors.foreground }]}>
              CC 定时队列 ({items.length}) · 间隔 {interval} 分钟
            </Text>
          </View>
        )}

        <View style={styles.headerActions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            style={[
              styles.smallBtn,
              {
                backgroundColor: paused ? theme.colors.accent : theme.colors.surface2,
              },
              busy && styles.disabled,
            ]}
            onPress={() => actions.setPaused.mutate(!paused)}
          >
            <Icon
              name={paused ? "Play" : "Pause"}
              size={12}
              color={paused ? theme.colors.accentForeground : theme.colors.foreground}
            />
            <Text
              style={{
                fontSize: 12,
                color: paused ? theme.colors.accentForeground : theme.colors.foreground,
              }}
            >
              {paused ? "恢复" : "暂停"}
            </Text>
          </Pressable>
          {items.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[
                styles.smallBtn,
                { backgroundColor: theme.colors.surface2 },
                busy && styles.disabled,
              ]}
              onPress={() => actions.clear.mutate()}
            >
              <Text style={{ fontSize: 12, color: theme.colors.statusDanger }}>清空</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {paused ? (
        <View
          style={[
            styles.banner,
            {
              backgroundColor: theme.colors.surface1,
              borderColor: theme.colors.statusWarning,
            },
          ]}
        >
          <Text style={{ fontSize: 12, color: theme.colors.statusWarning }}>
            暂停原因：{detail?.pauseReason ?? "手动暂停"}
          </Text>
        </View>
      ) : null}

      {!paused && detail?.waitingReason && items.length > 0 ? (
        <View
          style={[
            styles.banner,
            {
              backgroundColor: theme.colors.surface1,
              borderColor: theme.colors.border,
            },
          ]}
        >
          <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>
            已到点，等待中：{detail.waitingReason}
          </Text>
        </View>
      ) : null}

      {isPopover ? (
        <View style={styles.popoverList}>{renderedRows}</View>
      ) : (
        <ScrollView style={embedded ? styles.embeddedList : styles.panelList}>
          {renderedRows}
        </ScrollView>
      )}

      <View style={[styles.footer, { borderTopColor: theme.colors.border }]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={submitDraft}
          placeholder={`追加定时消息（${interval} 分钟后）...`}
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[
            styles.input,
            {
              color: theme.colors.foreground,
              backgroundColor: theme.colors.surface1,
              borderColor: theme.colors.border,
            },
          ]}
        />
        <Pressable
          accessibilityRole="button"
          disabled={!draft.replace(CC_PREFIX_REGEX, "").trim() || busy}
          style={[
            styles.addBtn,
            { backgroundColor: theme.colors.accent },
            (!draft.replace(CC_PREFIX_REGEX, "").trim() || busy) && styles.disabled,
          ]}
          onPress={submitDraft}
        >
          <Text style={{ fontSize: 12, fontWeight: "500", color: theme.colors.accentForeground }}>
            定时
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  popoverContainer: {
    gap: 10,
  },
  panelContainer: {
    padding: 12,
    gap: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 8,
    borderBottomWidth: 1,
    gap: 8,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  title: {
    fontSize: 14,
    fontWeight: "600",
  },
  subtitleHint: {
    fontSize: 12,
    flex: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  smallBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
  },
  banner: {
    padding: 8,
    borderRadius: 6,
    borderWidth: 1,
  },
  popoverList: {
    gap: 8,
  },
  panelList: {
    flex: 1,
  },
  embeddedList: {
    maxHeight: 340,
  },
  empty: {
    fontSize: 12,
    lineHeight: 18,
    paddingVertical: 14,
    textAlign: "center",
  },
  row: {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 4,
  },
  rowMain: {
    gap: 6,
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  itemText: {
    fontSize: 13,
    lineHeight: 19,
  },
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  actionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 5,
  },
  spacer: {
    flex: 1,
  },
  iconBtn: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
  },
  editArea: {
    gap: 8,
  },
  editInput: {
    fontSize: 13,
    minHeight: 56,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  editActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 6,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 8,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    fontSize: 13,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 6,
    borderWidth: 1,
  },
  addBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  disabled: {
    opacity: 0.4,
  },
});
