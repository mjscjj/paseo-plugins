import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  AutoRetryScheduler,
  type AgentSnapshot,
  type RetryAgentPort,
  type TimelinePage,
  type TurnOutcome,
} from "./server/scheduler.ts";
import { AutoRetryStore } from "./server/store.ts";

function createPaseoRetryPort(paseo: PluginHandlerContext["paseo"]): RetryAgentPort {
  return {
    async refresh(agentId: string): Promise<AgentSnapshot | null> {
      const refreshed = await paseo.agents.ref(agentId).refresh();
      return (refreshed?.agent as AgentSnapshot | undefined) ?? null;
    },
    async refetchTimeline(agentId: string, limit: number): Promise<TimelinePage | null> {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ limit });
      return (page as unknown as TimelinePage) ?? null;
    },
    async send(
      agentId: string,
      text: string,
      options: { messageId: string },
    ): Promise<void> {
      await paseo.agents.ref(agentId).send(
        text,
        options as Parameters<ReturnType<PluginHandlerContext["paseo"]["agents"]["ref"]>["send"]>[1],
      );
    },
  };
}

export default function contribute(server: PluginServerContext) {
  const store = new AutoRetryStore();
  const scheduler = new AutoRetryScheduler(store);
  const cfg = store.readConfig();
  store.appendEvent({
    event: "plugin-started",
    enabled: cfg.enabled,
    retryDelaysSeconds: cfg.retryDelaysSeconds,
    scope: cfg.scope,
    dataDir: store.dataDir,
  });

  const cleanups = [
    server.addHook("agent.turn.before", ({ agent }) => {
      scheduler.onTurnStarted(agent.id);
    }),
    server.addHook("agent.turn.after", ({ agent, outcome }, { paseo }) => {
      scheduler.onTurnEnded(
        createPaseoRetryPort(paseo),
        agent.id,
        outcome as TurnOutcome,
      );
    }),
    server.addHook("agent.permission.before", ({ agent }) => {
      scheduler.onPermissionRequested(agent.id);
    }),
    server.addHook("agent.archive.after", ({ agent }) => {
      scheduler.onAgentArchived(agent.id);
    }),
    server.addHook("agent.close.after", ({ agent }) => {
      scheduler.onAgentClosed(agent.id);
    }),
  ];

  return () => {
    for (const cleanup of cleanups) {
      if (typeof cleanup === "function") cleanup();
    }
    scheduler.dispose();
    store.appendEvent({ event: "plugin-stopped" });
  };
}
