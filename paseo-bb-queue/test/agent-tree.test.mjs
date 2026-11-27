import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectAgentTree,
  PARENT_AGENT_ID_LABEL,
  ProviderSubagentTracker,
} from "../plugin/server/agent-tree.ts";
import { QueueScheduler } from "../plugin/server/scheduler.ts";
import { QueueStore } from "../plugin/server/store.ts";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

function agent(id, extra = {}) {
  return { id, status: "idle", updatedAt: ago(60_000), pendingPermissions: [], ...extra };
}
function child(id, parentId, extra = {}) {
  return agent(id, { labels: { [PARENT_AGENT_ID_LABEL]: parentId }, ...extra });
}

function fakePaseo(agents) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return {
    listCalls: 0,
    agents: {
      async list({ filter }) {
        this.listCalls = (this.listCalls ?? 0) + 1;
        const parentId = filter.labels[PARENT_AGENT_ID_LABEL];
        return {
          entries: [...byId.values()]
            .filter((a) => a.labels?.[PARENT_AGENT_ID_LABEL] === parentId)
            .map((a) => ({ agent: a })),
        };
      },
      ref(id) {
        return { refresh: async () => (byId.has(id) ? { agent: byId.get(id) } : null) };
      },
    },
    observeEvents() {
      return { subscribe() {}, release: async () => {} };
    },
  };
}

const inspect = (paseo, root, tracker = null) =>
  inspectAgentTree(paseo, tracker, root, { now: NOW });

test("agent-tree: idle root without children is quiet", async () => {
  const root = agent("root");
  assert.deepEqual(await inspect(fakePaseo([root]), root), { busy: false, reason: null });
});

test("agent-tree: idle root with a running Paseo child is busy", async () => {
  const root = agent("root");
  const paseo = fakePaseo([root, child("c1", "root", { status: "running", title: "worker" })]);
  const report = await inspect(paseo, root);
  assert.equal(report.busy, true);
  assert.match(report.reason, /子 Agent「worker」运行中/);
});

test("agent-tree: idle child holding background work keeps the tree busy", async () => {
  const root = agent("root");
  const paseo = fakePaseo([root, child("c1", "root", { backgroundWork: { count: 1 } })]);
  const report = await inspect(paseo, root);
  assert.equal(report.busy, true);
  assert.match(report.reason, /1 个后台任务/);
});

test("agent-tree: running grandchild is found recursively", async () => {
  const root = agent("root");
  const paseo = fakePaseo([
    root,
    child("c1", "root"),
    child("g1", "c1", { status: "running" }),
  ]);
  assert.equal((await inspect(paseo, root)).busy, true);
});

test("agent-tree: child waiting on permission keeps the tree busy", async () => {
  const root = agent("root");
  const paseo = fakePaseo([root, child("c1", "root", { pendingPermissions: [{ id: "p" }] })]);
  assert.match((await inspect(paseo, root)).reason, /等待权限/);
});

test("agent-tree: a child that just finished waits for its finish notice", async () => {
  const root = agent("root");
  const recent = fakePaseo([root, child("c1", "root", { updatedAt: ago(2_000) })]);
  assert.match((await inspect(recent, root)).reason, /刚结束/);
  const settled = fakePaseo([root, child("c1", "root", { updatedAt: ago(20_000) })]);
  assert.equal((await inspect(settled, root)).busy, false);
});

test("agent-tree: root background work (Claude background Task) keeps the tree busy", async () => {
  const root = agent("root", { backgroundWork: { count: 1 } });
  const report = await inspect(fakePaseo([root]), root);
  assert.equal(report.busy, true);
  assert.match(report.reason, /主 Agent有 1 个后台任务/);
});

test("agent-tree: errored and closed children do not block", async () => {
  const root = agent("root");
  const paseo = fakePaseo([
    root,
    child("c1", "root", { status: "error" }),
    child("c2", "root", { status: "closed" }),
  ]);
  assert.equal((await inspect(paseo, root)).busy, false);
});

test("provider subagent tracker: Codex-style subagent blocks until completed and settled", async () => {
  let now = NOW;
  const tracker = new ProviderSubagentTracker({ now: () => now });
  const root = agent("root");
  const paseo = fakePaseo([root]);
  const upsert = (status) =>
    tracker.handleMessage({
      type: "agent.provider_subagents.update",
      payload: { kind: "upsert", subagent: { id: "s1", parentAgentId: "root", status } },
    });

  upsert("running");
  let report = await inspectAgentTree(paseo, tracker, root, { now });
  assert.match(report.reason, /1 个子任务在跑/);

  now += 80_000;
  upsert("completed");
  report = await inspectAgentTree(paseo, tracker, root, { now });
  assert.match(report.reason, /子任务刚结束/);

  now += 15_000;
  report = await inspectAgentTree(paseo, tracker, root, { now });
  assert.equal(report.busy, false);
});

test("provider subagent tracker: timeline output from an unknown subagent marks it running", () => {
  const tracker = new ProviderSubagentTracker({ now: () => NOW });
  tracker.handleMessage({
    type: "agent.provider_subagents.update",
    payload: { kind: "timeline", parentAgentId: "root", subagentId: "s9" },
  });
  assert.equal(tracker.activity("root", 10_000).running, 1);
});

test("provider subagent tracker: running entries go stale instead of blocking forever", () => {
  let now = NOW;
  const tracker = new ProviderSubagentTracker({ now: () => now, staleMs: 60_000 });
  tracker.handleMessage({
    type: "agent.provider_subagents.update",
    payload: { kind: "upsert", subagent: { id: "s1", parentAgentId: "root", status: "running" } },
  });
  now += 61_000;
  assert.equal(tracker.activity("root", 10_000).running, 0);
});

function schedulerFixture(initialTree) {
  const dir = mkdtempSync(path.join(tmpdir(), "bbq-tree-"));
  const store = new QueueStore(path.join(dir, "queues.json"));
  const scheduler = new QueueScheduler(store, { turnEndGraceMs: 0 });
  const sent = [];
  const state = { tree: initialTree };
  const port = {
    async inspect(id) {
      return { id, status: "idle", pendingPermissions: [] };
    },
    async inspectTree() {
      return state.tree;
    },
    async send(agentId, text) {
      sent.push({ agentId, text });
    },
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    store,
    scheduler,
    port,
    sent,
    state,
    settle,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("scheduler: bb message is queued, not sent, while the parent's subagents run", async () => {
  const f = schedulerFixture({ busy: true, reason: "子 Agent 运行中" });
  try {
    const result = await f.scheduler.submit(f.port, "root", { text: "next task" });
    assert.equal(result.disposition, "queued");
    assert.equal(f.sent.length, 0);
    assert.equal(f.scheduler.getWaitingReason("root"), "子 Agent 运行中");
  } finally {
    f.cleanup();
  }
});

test("scheduler: sweep dispatches once the whole tree is quiet", async () => {
  const f = schedulerFixture({ busy: true, reason: "子 Agent 运行中" });
  try {
    await f.scheduler.submit(f.port, "root", { text: "next task" });
    await f.settle();
    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 0, "still busy while subagents run");
    assert.match(f.scheduler.getWaitingReason("root"), /^子 Agent 运行中 · 最多再等 60 分钟$/);
    f.state.tree = { busy: false, reason: null };
    await f.scheduler.sweep(f.port);
    assert.deepEqual(f.sent, [{ agentId: "root", text: "next task" }]);
    assert.equal(f.scheduler.getWaitingReason("root"), null);
    assert.equal(f.store.hasReadyItems("root"), false);
  } finally {
    f.cleanup();
  }
});

test("scheduler: quiet tree keeps the old immediate-send behaviour", async () => {
  const f = schedulerFixture({ busy: false, reason: null });
  try {
    const result = await f.scheduler.submit(f.port, "root", { text: "now" });
    assert.equal(result.disposition, "sent_immediately");
    assert.equal(f.sent.length, 1);
  } finally {
    f.cleanup();
  }
});

function racePort({ statuses, tree = { busy: false, reason: null }, throwOnInspect = false }) {
  const sent = [];
  let call = 0;
  return {
    sent,
    port: {
      async inspect(id) {
        if (throwOnInspect) throw new Error("transport closed");
        const status = statuses[Math.min(call, statuses.length - 1)];
        call += 1;
        return { id, status, pendingPermissions: [] };
      },
      async inspectTree() {
        return tree;
      },
      async send(agentId, text) {
        sent.push({ agentId, text });
      },
    },
  };
}

function storeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "bbq-review-"));
  const store = new QueueStore(path.join(dir, "queues.json"));
  return { store, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("scheduler: a closed (runtime not loaded) agent still receives queued bb messages", async () => {
  const { store, cleanup } = storeFixture();
  try {
    const scheduler = new QueueScheduler(store, { turnEndGraceMs: 0 });
    store.enqueue("root", { text: "wake up" });
    const { port, sent } = racePort({ statuses: ["closed"] });
    assert.equal(await scheduler.drainNext(port, "root"), true);
    assert.deepEqual(sent, [{ agentId: "root", text: "wake up" }]);
  } finally {
    cleanup();
  }
});

test("scheduler: root that starts a turn during the tree walk is not interrupted", async () => {
  const { store, cleanup } = storeFixture();
  try {
    const scheduler = new QueueScheduler(store, { turnEndGraceMs: 0 });
    store.enqueue("root", { text: "next" });
    // idle when first read, running (finish notice arrived) when re-read before sending
    const { port, sent } = racePort({ statuses: ["idle", "running"] });
    assert.equal(await scheduler.drainNext(port, "root"), false);
    assert.equal(sent.length, 0);
    assert.equal(store.hasReadyItems("root"), true, "message stays queued");
  } finally {
    cleanup();
  }
});

test("scheduler: lookup failures resolve false instead of rejecting", async () => {
  const { store, cleanup } = storeFixture();
  try {
    const scheduler = new QueueScheduler(store, { turnEndGraceMs: 0 });
    store.enqueue("root", { text: "next" });
    const { port } = racePort({ statuses: ["idle"], throwOnInspect: true });
    assert.equal(await scheduler.drainNext(port, "root"), false);
    assert.match(scheduler.getWaitingReason("root"), /读取 Agent 状态失败/);
    assert.equal(store.hasReadyItems("root"), true);
  } finally {
    cleanup();
  }
});

test("provider subagent tracker: a rejected subscription neither throws nor retries hot", async () => {
  let now = NOW;
  let attempts = 0;
  const paseo = {
    observeEvents() {
      attempts += 1;
      return {
        ready: Promise.reject(new Error("unsupported")),
        subscribe() {
          return () => {};
        },
        release: async () => {},
      };
    },
  };
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const tracker = new ProviderSubagentTracker({ now: () => now });
    tracker.start(paseo);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tracker.isStarted, false);
    tracker.start(paseo);
    assert.equal(attempts, 1, "no retry within the backoff window");
    now += 61_000;
    tracker.start(paseo);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(attempts, 2);
    assert.ok(errors.some((line) => line.includes("subscription failed")));
  } finally {
    console.error = original;
  }
});

// ---- subagent wait limit ----
import { TreeWaitLimiter } from "../plugin/server/agent-tree.ts";

test("wait limiter: counts down, then lets the message through; 0 means wait forever", () => {
  let now = NOW;
  const limiter = new TreeWaitLimiter({ maxWaitMs: () => 60 * 60_000, now: () => now });
  assert.deepEqual(limiter.evaluate("root", "i1", "子 Agent 运行中"), {
    send: false,
    reason: "子 Agent 运行中 · 最多再等 60 分钟",
  });
  now += 59 * 60_000 + 30_000;
  assert.match(limiter.evaluate("root", "i1", "x").reason, /最多再等 1 分钟/);
  now += 30_000;
  assert.deepEqual(limiter.evaluate("root", "i1", "x"), { send: true, reason: null });

  const unlimited = new TreeWaitLimiter({ maxWaitMs: () => 0, now: () => now });
  unlimited.evaluate("root", "i1", "x");
  now += 24 * 60 * 60_000;
  assert.deepEqual(unlimited.evaluate("root", "i1", "子 Agent 运行中"), {
    send: false,
    reason: "子 Agent 运行中",
  });
});

test("wait limiter: a new head message starts a new clock", () => {
  let now = NOW;
  const limiter = new TreeWaitLimiter({ maxWaitMs: () => 10 * 60_000, now: () => now });
  limiter.evaluate("root", "i1", "x");
  now += 11 * 60_000;
  assert.match(limiter.evaluate("root", "i2", "x").reason, /最多再等 10 分钟/);
});

function limitFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "bbq-limit-"));
  const store = new QueueStore(path.join(dir, "queues.json"));
  const clock = { now: NOW };
  const scheduler = new QueueScheduler(store, {
    turnEndGraceMs: 0,
    maxTreeWaitMs: () => 60 * 60_000,
    now: () => clock.now,
  });
  const state = { status: "idle", tree: { busy: true, reason: "子 Agent「worker」运行中" } };
  const sent = [];
  const port = {
    async inspect(id) {
      return { id, status: state.status, pendingPermissions: [] };
    },
    async inspectTree() {
      return state.tree;
    },
    async send(agentId, text) {
      sent.push(text);
    },
  };
  return { store, scheduler, clock, state, sent, port, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("bb wait limit: root turns do not restart the clock; after 60 min an idle root gets the message", async () => {
  const f = limitFixture();
  try {
    f.store.enqueue("root", { text: "next step" });
    await f.scheduler.sweep(f.port);
    assert.match(f.scheduler.getWaitingReason("root"), /子 Agent「worker」运行中 · 最多再等 60 分钟/);

    // A subagent report makes the root run for a while; that time still counts.
    f.clock.now += 30 * 60_000;
    f.state.status = "running";
    await f.scheduler.sweep(f.port);
    f.clock.now += 31 * 60_000;
    await f.scheduler.sweep(f.port);
    assert.equal(f.sent.length, 0, "never sent while the root itself runs, even past the limit");

    f.state.status = "idle";
    await f.scheduler.sweep(f.port);
    assert.deepEqual(f.sent, ["next step"]);
    assert.match(f.scheduler.getTimeoutNotice("root"), /超过 60 分钟，已直接发送「next step」/);
  } finally {
    f.cleanup();
  }
});

test("bb wait limit: the next message gets its own clock; pausing resets it", async () => {
  const f = limitFixture();
  try {
    f.store.enqueue("root", { text: "one" });
    f.store.enqueue("root", { text: "two" });
    await f.scheduler.sweep(f.port);
    f.clock.now += 61 * 60_000;
    await f.scheduler.sweep(f.port);
    assert.deepEqual(f.sent, ["one"]);
    await f.scheduler.sweep(f.port);
    assert.deepEqual(f.sent, ["one"], "'two' starts waiting from now, not from 'one'");
    assert.match(f.scheduler.getWaitingReason("root"), /最多再等 60 分钟/);

    f.clock.now += 50 * 60_000;
    f.scheduler.resetTreeWait("root");
    f.store.setPaused("root", true);
    f.store.setPaused("root", false);
    await f.scheduler.sweep(f.port);
    assert.match(f.scheduler.getWaitingReason("root"), /最多再等 60 分钟/, "pause restarted the clock");
  } finally {
    f.cleanup();
  }
});
