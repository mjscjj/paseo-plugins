import { homedir } from "node:os";
import path from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  BB_PLUGIN_ID,
  clearQueueRpc,
  DEFAULT_MAX_SUBAGENT_WAIT_MINUTES,
  enqueueManualRpc,
  getAgentQueueRpc,
  ingestRpc,
  listQueueSummariesRpc,
  moveQueueItemRpc,
  removeQueueItemRpc,
  sendQueueItemNowRpc,
  setFrontendQueueHoldRpc,
  setQueuePausedRpc,
  updateQueueItemRpc,
  waitSettings,
} from "./shared/contracts.ts";
import { ProviderSubagentTracker } from "./server/agent-tree.ts";
import { contributeTimedQueue } from "./server/cc-contribute.ts";
import { createPaseoAgentPort, QueueScheduler } from "./server/scheduler.ts";
import { QueueStore, stripBbPrefix, stripOptionalBbPrefix } from "./server/store.ts";

const RECONCILE_INTERVAL_MS = 5_000;
/** How often queues waiting on subagents are re-checked. */
const SWEEP_INTERVAL_MS = 5_000;

function resolveQueueStoragePath(): string {
  const paseoHome = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
  return path.join(paseoHome, "plugin-data", BB_PLUGIN_ID, "queues.json");
}

export default function contribute(server: PluginServerContext) {
  const store = new QueueStore(resolveQueueStoragePath());
  const settings = server.registerSettings(waitSettings);
  let maxSubagentWaitMinutes = DEFAULT_MAX_SUBAGENT_WAIT_MINUTES;
  const applySettings = (state: Awaited<ReturnType<typeof settings.read>>) => {
    if (state.status === "ready") maxSubagentWaitMinutes = state.values.maxSubagentWaitMinutes;
  };
  void settings.read().then(applySettings, (error) => {
    console.error("[bb-queue] failed to read settings:", error);
  });
  const removeSettingsListener = settings.subscribe(applySettings);

  // One per-agent send lock for both queues, so a cc message never cuts into a bb send.
  const inFlight = new Set<string>();
  const scheduler = new QueueScheduler(store, {
    maxTreeWaitMs: () => maxSubagentWaitMinutes * 60_000,
    inFlight,
  });
  const tracker = new ProviderSubagentTracker();
  const removeTimedQueue = contributeTimedQueue(server, {
    inFlight,
    bbHasReady: (agentId) => store.hasReadyItems(agentId),
    tracker,
  });
  let lastReconcileAt = 0;
  // Paseo hands the plugin its API only inside handlers and events; it is the same object for
  // the plugin process lifetime, so keep it for the sweep timer.
  let latestPaseo: PluginHandlerContext["paseo"] | null = null;
  let sweeping = false;

  const portFor = (paseo: PluginHandlerContext["paseo"]) => {
    latestPaseo = paseo;
    tracker.start(paseo);
    return createPaseoAgentPort(paseo, tracker);
  };

  const withWaiting = <T extends { agentId: string }>(detail: T) => ({
    ...detail,
    waitingReason: scheduler.getWaitingReason(detail.agentId),
    timeoutNotice: scheduler.getTimeoutNotice(detail.agentId),
  });

  const sweepTimer = setInterval(() => {
    if (!latestPaseo || sweeping) return;
    sweeping = true;
    void scheduler.sweep(portFor(latestPaseo)).finally(() => {
      sweeping = false;
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  const maybeReconcileReady = (paseo: PluginHandlerContext["paseo"]) => {
    const readyIds = store.listReadyAgentIds();
    if (readyIds.length === 0) return;
    const now = Date.now();
    if (now - lastReconcileAt < RECONCILE_INTERVAL_MS) return;
    lastReconcileAt = now;
    const port = portFor(paseo);
    for (const agentId of readyIds) {
      void scheduler.reconcileIdle(port, agentId);
    }
  };

  server.handle(ingestRpc, async (input, { paseo }) => {
    try {
      const cleanText = stripBbPrefix(input.text);
      const port = portFor(paseo);
      const result = await scheduler.submit(port, input.agentId, {
        text: cleanText,
        messageId: input.messageId,
        images: input.images,
        attachments: input.attachments,
        sessionMode: input.sessionMode,
      });
      return {
        agentId: result.agentId,
        accepted: true,
        ...(result.disposition === "queued" ? { deliveryStatus: "queued" as const } : {}),
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        agentId: input.agentId,
        accepted: false,
        error: message,
      };
    }
  });

  server.handle(setFrontendQueueHoldRpc, ({ agentId, hasFrontendItems }, { paseo }) => {
    scheduler.setFrontendHold(portFor(paseo), agentId, hasFrontendItems);
    return { ok: true };
  });

  server.handle(listQueueSummariesRpc, (_input, { paseo }) => {
    maybeReconcileReady(paseo);
    return {
      summaries: store.getSummaries().map(withWaiting),
    };
  });

  server.handle(getAgentQueueRpc, ({ agentId }, { paseo }) => {
    maybeReconcileReady(paseo);
    return withWaiting(store.getDetail(agentId));
  });

  server.handle(enqueueManualRpc, async ({ agentId, text }, { paseo }) => {
    const port = portFor(paseo);
    const cleanText = stripOptionalBbPrefix(text);
    const resolved = await scheduler.submit(port, agentId, { text: cleanText });
    return withWaiting(store.getDetail(resolved.agentId));
  });

  server.handle(updateQueueItemRpc, ({ agentId, itemId, text }) =>
    withWaiting(store.updateItemText(agentId, itemId, text)),
  );

  server.handle(
    sendQueueItemNowRpc,
    async ({ agentId, itemId, activeTurnBehavior }, { paseo }) =>
      withWaiting(
        await scheduler.sendItemNow(
          portFor(paseo),
          agentId,
          itemId,
          activeTurnBehavior ?? "steer",
        ),
      ),
  );

  server.handle(removeQueueItemRpc, ({ agentId, itemId }) =>
    withWaiting(store.removeItem(agentId, itemId)),
  );

  server.handle(moveQueueItemRpc, ({ agentId, itemId, direction }) =>
    withWaiting(store.moveItem(agentId, itemId, direction)),
  );

  server.handle(setQueuePausedRpc, async ({ agentId, paused }, { paseo }) => {
    if (paused) scheduler.resetTreeWait(agentId);
    const detail = store.setPaused(agentId, paused);
    if (!paused) {
      await scheduler.drainNext(portFor(paseo), agentId);
      return withWaiting(store.getDetail(agentId));
    }
    return withWaiting(detail);
  });

  server.handle(clearQueueRpc, ({ agentId }) => {
    scheduler.resetTreeWait(agentId);
    return withWaiting(store.clear(agentId));
  });

  server.on("agent.turn_started", ({ agent }, { paseo }) => {
    portFor(paseo);
    scheduler.onTurnStarted(agent.id);
  });

  server.on("agent.turn_ended", async ({ agent, outcome }, { paseo }) => {
    await scheduler.onTurnEnded(portFor(paseo), agent.id, outcome);
  });

  server.on("agent.permission_resolved", async ({ agent }, { paseo }) => {
    await scheduler.reconcileIdle(portFor(paseo), agent.id);
  });

  server.on("agent.archived", ({ agent }) => {
    store.purgeAgent(agent.id);
  });

  return () => {
    removeTimedQueue();
    clearInterval(sweepTimer);
    removeSettingsListener();
    scheduler.dispose();
    tracker.dispose();
  };
}
