import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MARKER,
  classifyError,
  extractRetryAfterSeconds,
  renderedError,
} from "../shared/classifier.ts";
import { AutoRetryScheduler } from "../server/scheduler.ts";
import { AutoRetryStore } from "../server/store.ts";

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), "paseo-auto-retry-test-"));
}

test("classifies PING timed out and RetriableError as retryable timeout", () => {
  const msg = "Error: RetriableError: [unavailable] PING timed out";
  assert.equal(renderedError(msg), true);
  assert.deepEqual(classifyError(msg, true), {
    category: "timeout",
    retryable: true,
  });
});

test("classifies transient network, rate-limit, and overload errors as retryable", () => {
  assert.deepEqual(classifyError("Error: read EHOSTUNREACH", true), {
    category: "network",
    retryable: true,
  });
  assert.deepEqual(
    classifyError("Error: RetriableError: Stream ended without turnEnded", true),
    { category: "network", retryable: true },
  );
  assert.deepEqual(classifyError("HTTP 429 Too Many Requests. Retry-After: 90"), {
    category: "rate-limit",
    retryable: true,
  });
  assert.equal(extractRetryAfterSeconds("HTTP 429 Retry-After: 90"), 90);
  assert.deepEqual(classifyError("502 Bad Gateway"), {
    category: "server-unavailable",
    retryable: true,
  });
});

test("never retries auth, quota, context overflow, user cancel, or prose discussing errors", () => {
  assert.deepEqual(classifyError("Error: 401 Unauthorized - invalid api key", true), {
    category: "requires-intervention",
    retryable: false,
  });
  assert.deepEqual(classifyError("maximum context length exceeded"), {
    category: "requires-intervention",
    retryable: false,
  });
  assert.deepEqual(classifyError("canceled by the user"), {
    category: "requires-intervention",
    retryable: false,
  });
  assert.equal(
    renderedError("Error: PING timed out\n这是一段普通说明文字，不是机器错误栈。"),
    false,
  );
});

test("schedules and dispatches auto-retry on rendered Cursor timeout error and enforces budget", async () => {
  const dir = makeTempDir();
  try {
    const store = new AutoRetryStore(dir);
    let now = 1_700_000_000_000;
    const timers = [];
    const scheduler = new AutoRetryScheduler(store, {
      turnEndGraceMs: 0,
      now: () => now,
      setTimer: (fn, ms) => {
        const entry = { fn, ms, cleared: false };
        timers.push(entry);
        return entry;
      },
      clearTimer: (entry) => {
        entry.cleared = true;
      },
    });

    const sent = [];
    const agent = {
      id: "ag_1",
      cwd: "/tmp/work",
      status: "idle",
      updatedAt: now,
      lastUserMessageAt: now - 5000,
      lastError: null,
      archivedAt: null,
      activeTurn: null,
      pendingPermissions: [],
      attentionReason: null,
      labels: {},
    };
    const entries = [
      {
        seqEnd: 1,
        timestamp: now - 5000,
        item: { type: "user_message", text: "你盯住" },
      },
      {
        seqEnd: 2,
        turnId: "t1",
        timestamp: now,
        item: {
          type: "assistant_message",
          text: "Error: RetriableError: [unavailable] PING timed out",
        },
      },
    ];
    const port = {
      async refresh() {
        return { ...agent };
      },
      async refetchTimeline() {
        return { agent: { ...agent }, epoch: "ep1", hasNewer: false, entries };
      },
      async send(agentId, text, options) {
        sent.push({ agentId, text, options });
      },
    };

    const res = await scheduler.inspectAndSchedule(port, "ag_1", {
      kind: "completed",
    });
    assert.equal(res, "scheduled");
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 15_000);

    // Fire retry timer
    now += 15_000;
    timers[0].fn();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /^\[paseo-auto-retry:[0-9a-f-]+\] 自动重试 1\/3/);

    // Simulate 2 more failures after our auto-retry prompt; 4th must stop at retry-limit
    for (let attempt = 2; attempt <= 4; attempt += 1) {
      const lastMsg = sent.at(-1);
      entries.push(
        {
          seqEnd: attempt * 2 - 1,
          timestamp: now,
          item: { type: "user_message", text: lastMsg.text },
        },
        {
          seqEnd: attempt * 2,
          turnId: `t${attempt}`,
          timestamp: now + 1000,
          item: {
            type: "assistant_message",
            text: "Error: RetriableError: [unavailable] PING timed out",
          },
        },
      );
      agent.lastUserMessageAt = now;
      agent.updatedAt = now + 1000;
      now += 1000;
      const r = await scheduler.inspectAndSchedule(port, "ag_1", {
        kind: "completed",
      });
      if (attempt <= 3) {
        assert.equal(r, "scheduled");
        const nextTimer = timers.at(-1);
        now += nextTimer.ms;
        nextTimer.fn();
        await new Promise((r2) => setTimeout(r2, 10));
        assert.equal(sent.length, attempt);
      } else {
        assert.equal(r, "retry-limit");
        assert.equal(sent.length, 3);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aborts scheduled retry if user manually continues before timer fires", async () => {
  const dir = makeTempDir();
  try {
    const store = new AutoRetryStore(dir);
    const now = 1_700_000_000_000;
    const timers = [];
    const scheduler = new AutoRetryScheduler(store, {
      turnEndGraceMs: 0,
      now: () => now,
      setTimer: (fn, ms) => {
        const entry = { fn, ms, cleared: false };
        timers.push(entry);
        return entry;
      },
      clearTimer: (entry) => {
        entry.cleared = true;
      },
    });

    const sent = [];
    let currentAgent = {
      id: "ag_2",
      cwd: "/tmp/work",
      status: "error",
      updatedAt: now,
      lastUserMessageAt: now - 3000,
      lastError: "ETIMEDOUT",
      archivedAt: null,
      activeTurn: null,
      pendingPermissions: [],
      attentionReason: null,
      labels: {},
    };
    const port = {
      async refresh() {
        return { ...currentAgent };
      },
      async refetchTimeline() {
        return {
          agent: { ...currentAgent },
          epoch: "ep1",
          hasNewer: false,
          entries: [
            {
              seqEnd: 1,
              timestamp: now - 3000,
              item: { type: "user_message", text: "hello" },
            },
          ],
        };
      },
      async send(agentId, text, options) {
        sent.push({ agentId, text, options });
      },
    };

    const res = await scheduler.inspectAndSchedule(port, "ag_2", {
      kind: "failed",
      error: { message: "ETIMEDOUT" },
    });
    assert.equal(res, "scheduled");

    // User sent a manual message before timer fired
    currentAgent = { ...currentAgent, lastUserMessageAt: now + 5000, status: "idle", lastError: null };
    timers[0].fn();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(sent.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails closed on unknown auto-retry prompt after state loss and respects opt-out label", async () => {
  const dir = makeTempDir();
  try {
    const store = new AutoRetryStore(dir);
    const now = 1_700_000_000_000;
    const scheduler = new AutoRetryScheduler(store, {
      turnEndGraceMs: 0,
      now: () => now,
    });
    const port = {
      async refresh() {
        return null;
      },
      async refetchTimeline() {
        return {
          agent: {
            id: "ag_3",
            cwd: "/tmp/work",
            status: "idle",
            updatedAt: now,
            lastUserMessageAt: now - 1000,
            lastError: "PING timed out",
            labels: {},
          },
          epoch: "ep1",
          hasNewer: false,
          entries: [
            {
              seqEnd: 1,
              timestamp: now - 1000,
              item: {
                type: "user_message",
                text: `${MARKER}unknown-id] 自动重试 1/3`,
              },
            },
          ],
        };
      },
      async send() {
        throw new Error("should not send");
      },
    };

    const res = await scheduler.inspectAndSchedule(port, "ag_3", {
      kind: "failed",
      error: { message: "PING timed out" },
    });
    assert.equal(res, "unknown-auto-prompt");

    // Opt-out label
    const optOutPort = {
      ...port,
      async refetchTimeline() {
        return {
          agent: {
            id: "ag_4",
            cwd: "/tmp/work",
            status: "idle",
            updatedAt: now,
            lastUserMessageAt: now - 1000,
            lastError: "PING timed out",
            labels: { "paseo.auto-retry": "off" },
          },
          epoch: "ep1",
          hasNewer: false,
          entries: [],
        };
      },
    };
    const res2 = await scheduler.inspectAndSchedule(optOutPort, "ag_4", {
      kind: "failed",
      error: { message: "PING timed out" },
    });
    assert.equal(res2, "skip");

    // Corrupt state fails fast
    const badDir = makeTempDir();
    try {
      writeFileSync(path.join(badDir, "state.json"), '{"version": 999}');
      assert.throws(() => new AutoRetryStore(badDir), /Corrupt auto-retry state/);
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
