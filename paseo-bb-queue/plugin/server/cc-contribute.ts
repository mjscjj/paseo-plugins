import { homedir } from "node:os";
import path from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  clearQueueRpc,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_MAX_SUBAGENT_WAIT_MINUTES,
  enqueueManualRpc,
  getAgentQueueRpc,
  ingestRpc,
  listQueueSummariesRpc,
  removeQueueItemRpc,
  sendQueueItemNowRpc,
  setFrontendQueueHoldRpc,
  setQueuePausedRpc,
  timingSettings,
  updateQueueItemRpc,
} from "../shared/cc-contracts.ts";
import { ProviderSubagentTracker } from "./agent-tree.ts";
import {
  type BbQueuePeek,
  createPaseoAgentPort,
  TimedQueueScheduler,
} from "./cc-scheduler.ts";
import { QueueStore, stripCcPrefix, stripOptionalCcPrefix } from "./cc-store.ts";

/** Due messages are picked up within this long. */
const SWEEP_INTERVAL_MS = 5_000;

function paseoHome(): string {
  return process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
}

export interface TimedQueueDeps {
  /** Shared with the bb queue: an agent with a send in progress gets nothing else. */
  inFlight: Set<string>;
  /** Whether the bb queue has a message ready for this agent; bb goes first. */
  bbHasReady: BbQueuePeek;
  tracker: ProviderSubagentTracker;
}

/** The "cc " timed queue, run inside the bb-queue plugin. */
export function contributeTimedQueue(server: PluginServerContext, deps: TimedQueueDeps) {
  const store = new QueueStore(path.join(paseoHome(), "plugin-data", "bb-queue", "cc-queues.json"));
  let intervalMinutes = DEFAULT_INTERVAL_MINUTES;
  let maxSubagentWaitMinutes = DEFAULT_MAX_SUBAGENT_WAIT_MINUTES;
  const scheduler = new TimedQueueScheduler(store, {
    bbQueuePeek: deps.bbHasReady,
    inFlight: deps.inFlight,
    maxTreeWaitMs: () => maxSubagentWaitMinutes * 60_000,
  });
  const { tracker } = deps;
  const settings = server.registerSettings(timingSettings);
  // Paseo hands the plugin its API only inside handlers and events; it is the same object for
  // the plugin process lifetime, so keep it for the sweep timer.
  let latestPaseo: PluginHandlerContext["paseo"] | null = null;
  let sweeping = false;

  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status !== "ready") return;
    intervalMinutes = state.values.intervalMinutes;
    maxSubagentWaitMinutes = state.values.maxSubagentWaitMinutes;
  };
  void settings.read().then(applySettings, (error) => {
    console.error("[cc-queue] failed to read settings:", error);
  });
  const removeSettingsListener = settings.subscribe(applySettings);

  const portFor = (paseo: PluginHandlerContext["paseo"]) => {
    latestPaseo = paseo;
    tracker.start(paseo);
    return createPaseoAgentPort(paseo, tracker);
  };

  const decorate = <T extends { agentId: string }>(detail: T) => ({
    ...detail,
    intervalMinutes,
    waitingReason: scheduler.getWaitingReason(detail.agentId),
    timeoutNotice: scheduler.getTimeoutNotice(detail.agentId),
  });

  const runSweep = () => {
    if (!latestPaseo || sweeping) return;
    sweeping = true;
    void scheduler.sweep(portFor(latestPaseo)).finally(() => {
      sweeping = false;
    });
  };
  const sweepTimer = setInterval(runSweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  server.handle(ingestRpc, async (input, { paseo }) => {
    try {
      const result = await scheduler.submit(
        portFor(paseo),
        input.agentId,
        {
          text: stripCcPrefix(input.text),
          messageId: input.messageId,
          images: input.images,
          attachments: input.attachments,
          sessionMode: input.sessionMode,
        },
        intervalMinutes,
      );
      return { agentId: result.agentId, accepted: true, deliveryStatus: "queued" as const, error: null };
    } catch (error) {
      return {
        agentId: input.agentId,
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  server.handle(setFrontendQueueHoldRpc, ({ agentId, hasFrontendItems }, { paseo }) => {
    portFor(paseo);
    scheduler.setFrontendHold(agentId, hasFrontendItems);
    return { ok: true };
  });

  server.handle(listQueueSummariesRpc, (_input, { paseo }) => {
    portFor(paseo);
    return { summaries: store.getSummaries().map(decorate) };
  });

  server.handle(getAgentQueueRpc, ({ agentId }, { paseo }) => {
    portFor(paseo);
    return decorate(store.getDetail(agentId));
  });

  server.handle(enqueueManualRpc, async ({ agentId, text }, { paseo }) => {
    const resolved = await scheduler.submit(
      portFor(paseo),
      agentId,
      { text: stripOptionalCcPrefix(text) },
      intervalMinutes,
    );
    return decorate(store.getDetail(resolved.agentId));
  });

  server.handle(updateQueueItemRpc, ({ agentId, itemId, text }) =>
    decorate(store.updateItemText(agentId, itemId, text)),
  );

  server.handle(sendQueueItemNowRpc, async ({ agentId, itemId, activeTurnBehavior }, { paseo }) =>
    decorate(
      await scheduler.sendItemNow(portFor(paseo), agentId, itemId, activeTurnBehavior ?? "steer"),
    ),
  );

  server.handle(removeQueueItemRpc, ({ agentId, itemId }) =>
    decorate(store.removeItem(agentId, itemId)),
  );

  server.handle(setQueuePausedRpc, async ({ agentId, paused }, { paseo }) => {
    if (paused) scheduler.resetTreeWait(agentId);
    const detail = store.setPaused(agentId, paused);
    if (!paused) await scheduler.drainNext(portFor(paseo), agentId);
    return decorate(paused ? detail : store.getDetail(agentId));
  });

  server.handle(clearQueueRpc, ({ agentId }) => {
    scheduler.resetTreeWait(agentId);
    return decorate(store.clear(agentId));
  });

  // Agent activity is the earliest moment the plugin gets its API after a (re)start.
  server.on("agent.turn_started", (_event, { paseo }) => {
    portFor(paseo);
  });

  server.on("agent.turn_ended", ({ agent, outcome }, { paseo }) => {
    portFor(paseo);
    if (outcome?.kind === "failed") {
      store.pauseAfterFailedTurn(agent.id, `上一轮执行失败: ${outcome.error.message}`);
    } else if (outcome?.kind === "completed") {
      store.resumeAfterCompletedTurn(agent.id);
    }
    runSweep();
  });

  server.on("agent.permission_resolved", (_event, { paseo }) => {
    portFor(paseo);
    runSweep();
  });

  server.on("agent.archived", ({ agent }) => {
    store.purgeAgent(agent.id);
  });

  return () => {
    clearInterval(sweepTimer);
    removeSettingsListener();
    scheduler.dispose();
  };
}
