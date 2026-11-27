import { type PluginSurfaceProps, type SettingsState, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { MAX_INTERVAL_MINUTES, timingSettings } from "../shared/cc-contracts.ts";

type ReadySettings = Extract<SettingsState<typeof timingSettings.schema>, { status: "ready" }>;
type MinutesKey = "intervalMinutes" | "maxSubagentWaitMinutes";

function parseMinutes(raw: string, min: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= MAX_INTERVAL_MINUTES ? value : null;
}

function MinutesField({
  settings,
  field,
  label,
  min,
  describe,
}: {
  settings: ReadySettings;
  field: MinutesKey;
  label: string;
  min: number;
  describe(value: number): string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const current = settings.values[field];

  const save = useCallback(async () => {
    if (draft === null) return;
    const minutes = parseMinutes(draft, min);
    if (minutes === null) {
      setInputError(`请输入 ${min}–${MAX_INTERVAL_MINUTES} 之间的整数分钟`);
      return;
    }
    setInputError(null);
    if (await settings.save({ ...settings.values, [field]: minutes }, settings.revision)) {
      setDraft(null);
    }
  }, [settings, draft, field, min]);

  return (
    <SettingsCard>
      <SettingsInput
        label={label}
        hint={describe(current)}
        initialValue={String(current)}
        disabled={settings.saving}
        error={inputError ?? settings.saveError}
        onChangeText={setDraft}
      />
      <SettingsAction
        label={`保存${label}`}
        actionLabel={settings.saving ? "保存中…" : "保存"}
        disabled={settings.saving || draft === null}
        onPress={() => void save()}
      />
    </SettingsCard>
  );
}

function exampleTimes(interval: number): string {
  return [1, 2, 3]
    .map((n) => {
      const total = 14 * 60 + n * interval;
      return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    })
    .join("、");
}

export function TimingSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(timingSettings);
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted, fontSize: 12 }), [theme]);

  if (settings.status === "loading") {
    return <Text style={textStyle}>正在读取设置…</Text>;
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="定时间隔">
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label="重新读取" actionLabel="重试" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="恢复默认设置" actionLabel="重置" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        title="定时间隔"
        info="cc 消息在这个间隔后发送；连续多条时，每条比上一条再晚一个间隔。修改只影响之后新加的消息。"
      >
        <MinutesField
          settings={settings}
          field="intervalMinutes"
          label="间隔（分钟）"
          min={1}
          describe={(value) => `当前：${value} 分钟`}
        />
        <SettingsRow label="示例">
          <Text style={textStyle}>
            {`14:00 连发三条 cc → ${exampleTimes(settings.values.intervalMinutes)} 发送`}
          </Text>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="等待子 Agent"
        info="消息到点后，如果主 Agent 空闲但子 Agent 还在跑，最多等这么久，超时就直接发送（子 Agent 不会被停掉）。主 Agent 自己在跑、等权限或队列暂停时不受此限制。0 表示一直等。"
      >
        <MinutesField
          settings={settings}
          field="maxSubagentWaitMinutes"
          label="最长等待（分钟）"
          min={0}
          describe={(value) => (value === 0 ? "当前：不限" : `当前：${value} 分钟`)}
        />
      </SettingsSection>
    </>
  );
}
