import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentUnreadKind,
  formatAgo,
  formatSidebarLabel,
  isAwaitingPermission,
  newestFirst,
} from "../client/rules.ts";

const base = {
  background: false,
  parentAgentId: null,
  parentAgent: null,
  requiresAttention: true,
  attentionReason: "finished" as const,
};

test("顶层 agent 完成未看算 finished", () => {
  assert.equal(agentUnreadKind(base), "finished");
});

test("出错未看算 error", () => {
  assert.equal(agentUnreadKind({ ...base, attentionReason: "error" }), "error");
});

test("已看（requiresAttention=false）不算", () => {
  assert.equal(agentUnreadKind({ ...base, requiresAttention: false }), null);
});

test("子 agent 不算", () => {
  assert.equal(agentUnreadKind({ ...base, parentAgentId: "p1" }), null);
  assert.equal(
    agentUnreadKind({ ...base, parentAgent: { kind: "agent", hostId: "h", id: "p1", key: "k" } as never }),
    null,
  );
});

test("后台 helper 不算", () => {
  assert.equal(agentUnreadKind({ ...base, background: true }), null);
});

test("agent 上的 permission 原因不重复计数（审批按工作区算）", () => {
  assert.equal(agentUnreadKind({ ...base, attentionReason: "permission" }), null);
});

test("等审批：needs_input 的顶层工作区", () => {
  const ws = { status: "needs_input" as const, background: false, parentAgent: null };
  assert.equal(isAwaitingPermission(ws), true);
  assert.equal(isAwaitingPermission({ ...ws, status: "attention" }), false);
  assert.equal(isAwaitingPermission({ ...ws, background: true }), false);
  assert.equal(
    isAwaitingPermission({ ...ws, parentAgent: { kind: "agent", hostId: "h", id: "p", key: "k" } as never }),
    false,
  );
});

test("侧边栏文字", () => {
  assert.equal(formatSidebarLabel({ permission: 0, error: 0, finished: 0 }), null);
  assert.equal(formatSidebarLabel({ permission: 0, error: 0, finished: 3 }), "未看 3 · 完成 3");
  assert.equal(
    formatSidebarLabel({ permission: 2, error: 1, finished: 3 }),
    "未看 6 · 审批 2 · 出错 1 · 完成 3",
  );
});

test("相对时间", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  assert.equal(formatAgo("2026-11-27T11:59:30Z", now), "刚刚");
  assert.equal(formatAgo("2026-11-27T11:15:00Z", now), "45 分钟前");
  assert.equal(formatAgo("2026-11-27T09:00:00Z", now), "3 小时前");
  assert.equal(formatAgo("2026-11-25T12:00:00Z", now), "2 天前");
  assert.equal(formatAgo(null, now), "");
});

test("排序：新的在前，坏时间和空值排最后且不产生 NaN", () => {
  const items = ["2026-11-27T10:00:00Z", "not-a-date", null, "2026-11-27T12:00:00Z"];
  const sorted = [...items].sort(newestFirst);
  assert.deepEqual(sorted.slice(0, 2), ["2026-11-27T12:00:00Z", "2026-11-27T10:00:00Z"]);
  for (const a of items) for (const b of items) assert.ok(!Number.isNaN(newestFirst(a, b)));
});
