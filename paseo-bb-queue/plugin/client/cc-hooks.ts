import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  type ActiveSendBehavior,
  type AgentQueueDetail,
  clearQueueRpc,
  enqueueManualRpc,
  getAgentQueueRpc,
  listQueueSummariesRpc,
  removeQueueItemRpc,
  sendQueueItemNowRpc,
  setQueuePausedRpc,
  updateQueueItemRpc,
} from "../shared/cc-contracts.ts";

export const QUEUE_SUMMARIES_KEY = ["cc-queue", "summaries"] as const;

export function agentQueueKey(agentId: string) {
  return ["cc-queue", "agent", agentId] as const;
}

export function useQueueSummaries(pollMs = 5_000) {
  const listSummaries = useRpc(listQueueSummariesRpc);
  return useQuery({
    queryKey: QUEUE_SUMMARIES_KEY,
    queryFn: async () => (await listSummaries({})).summaries,
    refetchInterval: pollMs,
  });
}

export function useAgentQueue(agentId: string, pollMs = 3_000) {
  const getQueue = useRpc(getAgentQueueRpc);
  const key = useMemo(() => agentQueueKey(agentId), [agentId]);
  return useQuery({
    queryKey: key,
    queryFn: () => getQueue({ agentId }),
    refetchInterval: pollMs,
  });
}

export function useAgentQueueActions(agentId: string) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = useMemo(() => agentQueueKey(agentId), [agentId]);

  const enqueueRpc = useRpc(enqueueManualRpc);
  const updateRpc = useRpc(updateQueueItemRpc);
  const sendNowRpc = useRpc(sendQueueItemNowRpc);
  const removeRpc = useRpc(removeQueueItemRpc);
  const setPausedRpc = useRpc(setQueuePausedRpc);
  const clearRpc = useRpc(clearQueueRpc);

  const onSuccess = (detail: AgentQueueDetail) => {
    queryClient.setQueryData(key, detail);
    void queryClient.invalidateQueries({ queryKey: QUEUE_SUMMARIES_KEY });
  };
  const onError = (error: unknown) => {
    toast.error(error instanceof Error ? error.message : String(error));
  };

  return {
    enqueue: useMutation({
      mutationFn: (text: string) => enqueueRpc({ agentId, text }),
      onSuccess,
      onError,
    }),
    updateText: useMutation({
      mutationFn: (vars: { itemId: string; text: string }) => updateRpc({ agentId, ...vars }),
      onSuccess,
      onError,
    }),
    sendNow: useMutation({
      mutationFn: (vars: { itemId: string; activeTurnBehavior?: ActiveSendBehavior }) =>
        sendNowRpc({ agentId, ...vars }),
      onSuccess: (detail) => {
        onSuccess(detail);
        toast.show("已立即发送", { variant: "success" });
      },
      onError,
    }),
    remove: useMutation({
      mutationFn: (itemId: string) => removeRpc({ agentId, itemId }),
      onSuccess,
      onError,
    }),
    setPaused: useMutation({
      mutationFn: (paused: boolean) => setPausedRpc({ agentId, paused }),
      onSuccess,
      onError,
    }),
    clear: useMutation({
      mutationFn: () => clearRpc({ agentId }),
      onSuccess,
      onError,
    }),
  };
}
