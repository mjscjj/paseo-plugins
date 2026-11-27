import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { MAX_SUBAGENT_WAIT_LIMIT_MINUTES, waitSettings } from "../shared/contracts.ts";

function parseMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= MAX_SUBAGENT_WAIT_LIMIT_MINUTES ? value : null;
}

export function WaitSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(waitSettings);
  const [draft, setDraft] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const textStyle = useMemo(() => ({ color: theme.colors.foregroundMuted, fontSize: 12 }), [theme]);

  const save = useCallback(async () => {
    if (settings.status !== "ready" || draft === null) return;
    const minutes = parseMinutes(draft);
    if (minutes === null) {
      setInputError(`请输入 0–${MAX_SUBAGENT_WAIT_LIMIT_MINUTES} 之间的整数分钟`);
      return;
    }
    setInputError(null);
    if (await settings.save({ ...settings.values, maxSubagentWaitMinutes: minutes }, settings.revision)) {
      setDraft(null);
    }
  }, [settings, draft]);

  if (settings.status === "loading") return <Text style={textStyle}>正在读取设置…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="等待子 Agent">
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label="重新读取" actionLabel="重试" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="恢复默认（60 分钟）" actionLabel="重置" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  }

  const current = settings.values.maxSubagentWaitMinutes;
  return (
    <SettingsSection
      title="等待子 Agent"
      info="主 Agent 空闲但子 Agent 还在跑时，bb 的下一条最多等这么久，超时就直接发送（子 Agent 不会被停掉）。主 Agent 自己在跑、等权限、或队列暂停时不受此限制。0 表示一直等。"
    >
      <SettingsCard>
        <SettingsInput
          label="最长等待（分钟）"
          hint={current === 0 ? "当前：不限" : `当前：${current} 分钟`}
          initialValue={String(current)}
          placeholder="例如 60"
          disabled={settings.saving}
          error={inputError ?? settings.saveError}
          onChangeText={setDraft}
        />
        <SettingsAction
          label="保存"
          actionLabel={settings.saving ? "保存中…" : "保存"}
          disabled={settings.saving || draft === null}
          onPress={() => void save()}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
