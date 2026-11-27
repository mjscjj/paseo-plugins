import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { MAX_INTERVAL_MINUTES, timingSettings } from "../shared/contracts.ts";

function parseMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_INTERVAL_MINUTES ? value : null;
}

export function TimingSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(timingSettings);
  const [draft, setDraft] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted, fontSize: 12 }), [theme]);

  const save = useCallback(async () => {
    if (settings.status !== "ready" || draft === null) return;
    const minutes = parseMinutes(draft);
    if (minutes === null) {
      setInputError(`请输入 1–${MAX_INTERVAL_MINUTES} 之间的整数分钟`);
      return;
    }
    setInputError(null);
    if (await settings.save({ ...settings.values, intervalMinutes: minutes }, settings.revision)) {
      setDraft(null);
    }
  }, [settings, draft]);

  if (settings.status === "loading") {
    return <Text style={textStyle}>正在读取设置…</Text>;
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="定时间隔">
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label="重新读取" actionLabel="重试" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="恢复默认（30 分钟）" actionLabel="重置" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  }

  const current = settings.values.intervalMinutes;
  return (
    <SettingsSection
      title="定时间隔"
      info="cc 消息在这个间隔后发送；连续多条时，每条比上一条再晚一个间隔。修改只影响之后新加的消息。"
    >
      <SettingsCard>
        <SettingsInput
          label="间隔（分钟）"
          hint={`当前：${current} 分钟`}
          initialValue={String(current)}
          placeholder="例如 30"
          disabled={settings.saving}
          error={inputError ?? settings.saveError}
          onChangeText={setDraft}
        />
        <SettingsAction
          label="保存间隔"
          actionLabel={settings.saving ? "保存中…" : "保存"}
          disabled={settings.saving || draft === null}
          onPress={() => void save()}
        />
      </SettingsCard>
      <SettingsRow label="示例">
        <Text style={textStyle}>
          {`14:00 连发三条 cc → ${[1, 2, 3]
            .map((n) => {
              const total = 14 * 60 + n * current;
              const h = Math.floor(total / 60) % 24;
              const m = total % 60;
              return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
            })
            .join("、")} 发送`}
        </Text>
      </SettingsRow>
    </SettingsSection>
  );
}
