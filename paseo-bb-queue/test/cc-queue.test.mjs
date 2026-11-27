import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TimedQueueScheduler } from "../plugin/server/cc-scheduler.ts";
import { computeNextDueAt, QueueStore, stripCcPrefix } from "../plugin/server/cc-store.ts";
import { formatCountdown } from "../plugin/client/time-format.ts";

const T0 = Date.parse("2026-11-27T14:00:00.000Z");
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

function fixture({ interval = 30 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ccq-"));
  const file = path.join(dir, "queues.json");
  const clock = { now: T0 };
  const state = {
    agentStatus: "idle",
    tree: { busy: false, reason: null },
    bbReady: false,
    sendError: null,
  };
  const sent = [];
  const store = new QueueStore(file);
  const scheduler = new TimedQueueScheduler(store, {
    now: () => clock.now,
    bbQueuePeek: () => state.bbReady,
  });
  const port = {
    async inspect(id) {
      return { id, status: state.agentStatus, pendingPermissions: [] };
    },
    async inspectTree() {
      return state.tree;
    },
    async send(agentId, text) {
      if (state.sendError) throw new Error(state.sendError);
      sent.push({ agentId, text, at: clock.now });
    },
  };
  const submit = (text) => scheduler.submit(port, "a1", { text }, interval);
  return {
    dir,
    file,
    clock,
    state,
    sent,
    store,
    scheduler,
    port,
    submit,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("timetable: first cc waits one interval, each next one interval after the previous", async () => {
  const f = fixture({ interval: 30 });
  try {
    await f.submit("one");
    await f.submit("two");
    f.clock.now = T0 + 5 * MIN;
    await f.submit("three");
    const due = f.store.getDetail("a1").items.map((item) => item.dueAt);
    assert.deepEqual(due, [iso(T0 + 30 * MIN), iso(T0 + 60 * MIN), iso(T0 + 90 * MIN)]);
  } finally {
    f.cleanup();
  }
});

test("timetable: with nothing pending, timing restarts from now", () => {
  assert.equal(computeNextDueAt(null, T0, 20).toISOString(), iso(T0 + 20 * MIN));
  // Last pending item is overdue (still waiting for the agent): next slot counts from now.
  assert.equal(computeNextDueAt(iso(T0 - 10 * MIN), T0, 20).toISOString(), iso(T0 + 20 * MIN));
});

test("sweep: nothing is sent before it is due; due items go one per sweep", async () => {
  const f = fixture({ interval: 30 });
  try {
    await f.submit("one");
    await f.submit("two");
    f.clock.now = T0 + 29 * MIN;
    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 0);

    f.clock.now = T0 + 30 * MIN;
    await f.scheduler.sweep(f.port);
    assert.deepEqual(f.sent.map((s) => s.text), ["one"]);

    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 1, "second item is not due until 15:00");

    f.clock.now = T0 + 60 * MIN;
    await f.scheduler.sweep(f.port);
    assert.deepEqual(f.sent.map((s) => s.text), ["one", "two"]);
  } finally {
    f.cleanup();
  }
});

test("due item waits for a running agent, then for subagents, then sends", async () => {
  const f = fixture({ interval: 10 });
  try {
    await f.submit("later");
    f.clock.now = T0 + 10 * MIN;

    f.state.agentStatus = "running";
    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 0);
    assert.match(f.scheduler.getWaitingReason("a1"), /运行中/);

    f.state.agentStatus = "idle";
    f.state.tree = { busy: true, reason: "子 Agent「worker」运行中" };
    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 0);
    assert.match(f.scheduler.getWaitingReason("a1"), /^子 Agent「worker」运行中 · 最多再等/);

    f.state.tree = { busy: false, reason: null };
    await f.scheduler.sweep(f.port);
    assert.deepEqual(f.sent.map((s) => s.text), ["later"]);
    assert.equal(f.scheduler.getWaitingReason("a1"), null);
  } finally {
    f.cleanup();
  }
});

test("cc lets a ready bb queue and the native frontend queue go first", async () => {
  const f = fixture({ interval: 1 });
  try {
    await f.submit("timed");
    f.clock.now = T0 + MIN;

    f.state.bbReady = true;
    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 0);
    assert.match(f.scheduler.getWaitingReason("a1"), /bb/);

    f.state.bbReady = false;
    f.scheduler.setFrontendHold("a1", true);
    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 0);
    assert.match(f.scheduler.getWaitingReason("a1"), /前端队列/);

    f.scheduler.setFrontendHold("a1", false);
    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 1);
  } finally {
    f.cleanup();
  }
});

test("pause freezes the timetable; resume shifts it so spacing survives", async () => {
  const f = fixture({ interval: 30 });
  try {
    await f.submit("one"); // 14:30
    await f.submit("two"); // 15:00
    f.store.setPaused("a1", true, null, T0 + 10 * MIN);
    f.clock.now = T0 + 120 * MIN; // 16:00, both overdue while paused
    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 0, "paused queue never sends");

    f.store.setPaused("a1", false, null, f.clock.now);
    const due = f.store.getDetail("a1").items.map((item) => item.dueAt);
    assert.deepEqual(due, [iso(T0 + 120 * MIN), iso(T0 + 150 * MIN)], "head now, next 30 min later");
  } finally {
    f.cleanup();
  }
});

test("send failure puts the item back at the head and pauses", async () => {
  const f = fixture({ interval: 1 });
  try {
    await f.submit("boom");
    f.clock.now = T0 + MIN;
    f.state.sendError = "transport disconnected";
    await f.scheduler.sweep(f.port);
    const detail = f.store.getDetail("a1");
    assert.equal(detail.paused, true);
    assert.match(detail.pauseReason, /transport disconnected/);
    assert.equal(detail.items[0].text, "boom");
  } finally {
    f.cleanup();
  }
});

test("send now skips the timetable for that one item only", async () => {
  const f = fixture({ interval: 30 });
  try {
    await f.submit("one");
    await f.submit("two");
    const firstId = f.store.getDetail("a1").items[0].id;
    await f.scheduler.sendItemNow(f.port, "a1", firstId);
    assert.deepEqual(f.sent.map((s) => s.text), ["one"]);
    assert.equal(f.store.getDetail("a1").items[0].dueAt, iso(T0 + 60 * MIN));
  } finally {
    f.cleanup();
  }
});

test("queue survives a restart and overdue items are sent once back", async () => {
  const f = fixture({ interval: 5 });
  try {
    await f.submit("persisted");
    const reloaded = new QueueStore(f.file);
    const scheduler = new TimedQueueScheduler(reloaded, { now: () => T0 + 60 * MIN });
    await scheduler.sweep(f.port);
    assert.deepEqual(f.sent.map((s) => s.text), ["persisted"]);
  } finally {
    f.cleanup();
  }
});

test("a bb send in progress (shared lock) holds a due cc message back", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccq-lock-"));
  try {
    const store = new QueueStore(path.join(dir, "queues.json"));
    const inFlight = new Set();
    const scheduler = new TimedQueueScheduler(store, { now: () => T0 + 31 * MIN, inFlight });
    const sent = [];
    const port = {
      async inspect(id) {
        return { id, status: "idle", pendingPermissions: [] };
      },
      async send(agentId, text) {
        sent.push(text);
      },
    };
    store.enqueue("a1", { text: "due" }, { intervalMinutes: 30, nowMs: T0 });
    inFlight.add("a1"); // bb is mid-send to a1
    assert.equal(await scheduler.drainNext(port, "a1"), false);
    assert.deepEqual(sent, []);
    inFlight.delete("a1");
    assert.equal(await scheduler.drainNext(port, "a1"), true);
    assert.deepEqual(sent, ["due"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prefix stripping and empty messages", async () => {
  assert.equal(stripCcPrefix("CC　半小时后提醒我"), "半小时后提醒我");
  const f = fixture();
  try {
    await assert.rejects(() => f.submit("   "), /不能为空/);
  } finally {
    f.cleanup();
  }
});

test("countdown labels", () => {
  assert.equal(formatCountdown(iso(T0 + 25 * MIN), T0), "约 25 分钟后");
  assert.equal(formatCountdown(iso(T0 + 90 * MIN), T0), "约 1 小时 30 分后");
  assert.equal(formatCountdown(iso(T0 - MIN), T0), "已到点");
});

test("closed agents get due cc messages; a turn starting mid-check is not interrupted", async () => {
  const f = fixture({ interval: 1 });
  try {
    await f.submit("first");
    f.clock.now = T0 + MIN;
    f.state.agentStatus = "closed";
    await f.scheduler.sweep(f.port);
    assert.deepEqual(f.sent.map((s) => s.text), ["first"], "closed = runtime not loaded, still sendable");

    await f.submit("second");
    f.clock.now += 2 * MIN;
    f.state.agentStatus = "idle";
    let reads = 0;
    const inspect = f.port.inspect;
    f.port.inspect = async (id) => {
      reads += 1;
      const snap = await inspect(id);
      return reads === 2 ? { ...snap, status: "running" } : snap;
    };
    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 1, "root started running before send; nothing sent");
    assert.match(f.scheduler.getWaitingReason("a1"), /运行中/);
  } finally {
    f.cleanup();
  }
});

test("cc lookup failures resolve instead of rejecting", async () => {
  const f = fixture({ interval: 1 });
  try {
    await f.submit("x");
    f.clock.now = T0 + MIN;
    f.port.inspect = async () => {
      throw new Error("transport closed");
    };
    assert.equal(await f.scheduler.drainNext(f.port, "a1"), false);
    assert.match(f.scheduler.getWaitingReason("a1"), /读取 Agent 状态失败/);
  } finally {
    f.cleanup();
  }
});

test("cc wait limit: a due message waits for subagents at most the limit, never past a running root", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ccq-limit-"));
  try {
    const store = new QueueStore(path.join(dir, "q.json"));
    const clock = { now: T0 };
    const state = { status: "idle" };
    const sent = [];
    const scheduler = new TimedQueueScheduler(store, {
      now: () => clock.now,
      maxTreeWaitMs: () => 60 * MIN,
    });
    const port = {
      async inspect(id) {
        return { id, status: state.status, pendingPermissions: [] };
      },
      async inspectTree() {
        return { busy: true, reason: "主 Agent有 1 个子任务在跑" };
      },
      async send(_agentId, text) {
        sent.push(text);
      },
    };
    await scheduler.submit(port, "a1", { text: "timed" }, 10);
    clock.now += 10 * MIN; // due
    await scheduler.sweep(port);
    assert.match(scheduler.getWaitingReason("a1"), /子任务在跑 · 最多再等 60 分钟/);

    clock.now += 61 * MIN;
    state.status = "running";
    await scheduler.sweep(port);
    assert.equal(sent.length, 0);

    state.status = "idle";
    await scheduler.sweep(port);
    assert.deepEqual(sent, ["timed"]);
    assert.match(scheduler.getTimeoutNotice("a1"), /超过 60 分钟/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QueueStore: a late send pushes the rest back so the spacing survives a busy agent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-spacing-"));
  try {
    const store = new QueueStore(path.join(dir, "queues.json"));
    const t0 = Date.parse("2026-11-28T06:00:00Z");
    for (const text of ["one", "two", "three"]) {
      store.enqueue("a1", { text }, { intervalMinutes: 30, nowMs: t0 });
    }
    // Due 06:30, 07:00, 07:30; the agent is busy until 07:40.
    const late = Date.parse("2026-11-28T07:40:00Z");
    assert.equal(store.shiftDue("a1", late).text, "one");
    assert.equal(store.peekDue("a1", late), null, "the second one is not due right away");
    const next = store.getDetail("a1").items.map((i) => i.dueAt);
    assert.deepEqual(next, ["2026-11-28T08:10:00.000Z", "2026-11-28T08:40:00.000Z"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("QueueStore: a failed turn pauses, a completed turn resumes; a manual pause stays", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cc-resume-"));
  try {
    const store = new QueueStore(path.join(dir, "queues.json"));
    store.enqueue("a1", { text: "later", messageId: "m1" }, { intervalMinutes: 30 });
    assert.equal(store.pauseAfterFailedTurn("a1", "上一轮执行失败: socket hang up"), true);
    assert.equal(store.getDetail("a1").paused, true);
    assert.equal(store.resumeAfterCompletedTurn("a1"), true);
    assert.equal(store.getDetail("a1").paused, false);

    store.setPaused("a1", true);
    assert.equal(store.pauseAfterFailedTurn("a1", "x"), false);
    assert.equal(store.resumeAfterCompletedTurn("a1"), false);
    assert.equal(store.getDetail("a1").pauseReason, "手动暂停");

    // A failed send goes back under a fresh messageId (Paseo refuses a reused one)
    store.setPaused("a1", false);
    const item = store.shiftDue("a1", Date.now() + 31 * 60_000);
    store.requeueFrontAndPause("a1", item, "定时发送失败");
    assert.match(store.getDetail("a1").items[0].messageId, /^m1~r[0-9a-z]+$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
