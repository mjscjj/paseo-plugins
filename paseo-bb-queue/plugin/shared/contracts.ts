import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const BB_PLUGIN_ID = "bb-queue";
export const BB_PREFIX = "bb ";
export const BB_PREFIX_REGEX = /^\s*bb[^\S\r\n]+/i;
export const BB_INGEST_METHOD = "bb.ingest";

export const DEFAULT_MAX_SUBAGENT_WAIT_MINUTES = 60;
export const MAX_SUBAGENT_WAIT_LIMIT_MINUTES = 24 * 60;

/** 0 means wait for subagents without a limit. */
export const waitSettings = defineSettings({
  id: "subagent-wait",
  scope: "host",
  version: 1,
  schema: z.object({
    maxSubagentWaitMinutes: z
      .number()
      .int("请输入整数分钟")
      .min(0, "不能小于 0")
      .max(MAX_SUBAGENT_WAIT_LIMIT_MINUTES, "最多 1440 分钟（24 小时）")
      .default(DEFAULT_MAX_SUBAGENT_WAIT_MINUTES),
  }),
});

export const ActiveSendBehaviorSchema = z.enum(["steer", "interrupt"]);
export type ActiveSendBehavior = z.infer<typeof ActiveSendBehaviorSchema>;

export const ImagePayloadSchema = z.object({
  data: z.string(),
  mimeType: z.string(),
});

export const QueuedItemViewSchema = z.object({
  id: z.string(),
  messageId: z.string().optional(),
  text: z.string(),
  imageCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  sessionMode: z.string().optional(),
  createdAt: z.string(),
});

export type QueuedItemView = z.infer<typeof QueuedItemViewSchema>;

export const AgentQueueSummarySchema = z.object({
  agentId: z.string(),
  count: z.number().int().nonnegative(),
  paused: z.boolean(),
  pauseReason: z.string().nullable(),
  firstItemPreview: z.string().nullable(),
  updatedAt: z.string(),
  /** Why the head item has not been sent although the agent is idle (e.g. subagents running). */
  waitingReason: z.string().nullable().optional(),
});

export type AgentQueueSummary = z.infer<typeof AgentQueueSummarySchema>;

export const AgentQueueDetailSchema = z.object({
  agentId: z.string(),
  paused: z.boolean(),
  pauseReason: z.string().nullable(),
  items: z.array(QueuedItemViewSchema),
  withdrawnMessageIds: z.array(z.string()),
  dispatchedTexts: z.record(z.string(), z.string()),
  waitingReason: z.string().nullable().optional(),
  /** Set for a while after a message was sent because the subagent wait limit ran out. */
  timeoutNotice: z.string().nullable().optional(),
});

export type AgentQueueDetail = z.infer<typeof AgentQueueDetailSchema>;

export const ingestRpc = defineRpc({
  name: BB_INGEST_METHOD,
  input: z.object({
    agentId: z.string().min(1),
    text: z.string(),
    messageId: z.string().optional(),
    sessionMode: z.string().optional(),
    images: z.array(ImagePayloadSchema).optional(),
    attachments: z.array(z.unknown()).optional(),
  }),
  output: z.object({
    agentId: z.string(),
    accepted: z.boolean(),
    deliveryStatus: z.literal("queued").optional(),
    error: z.string().nullable(),
  }),
});

export const listQueueSummariesRpc = defineRpc({
  name: "queue.summaries",
  input: z.object({}),
  output: z.object({
    summaries: z.array(AgentQueueSummarySchema),
  }),
});

export const getAgentQueueRpc = defineRpc({
  name: "queue.get",
  input: z.object({
    agentId: z.string().min(1),
  }),
  output: AgentQueueDetailSchema,
});

export const enqueueManualRpc = defineRpc({
  name: "queue.enqueue",
  input: z.object({
    agentId: z.string().min(1),
    text: z.string(),
  }),
  output: AgentQueueDetailSchema,
});

export const updateQueueItemRpc = defineRpc({
  name: "queue.update",
  input: z.object({
    agentId: z.string().min(1),
    itemId: z.string().min(1),
    text: z.string(),
  }),
  output: AgentQueueDetailSchema,
});

export const sendQueueItemNowRpc = defineRpc({
  name: "queue.send_now",
  input: z.object({
    agentId: z.string().min(1),
    itemId: z.string().min(1),
    activeTurnBehavior: ActiveSendBehaviorSchema.optional(),
  }),
  output: AgentQueueDetailSchema,
});

export const removeQueueItemRpc = defineRpc({
  name: "queue.remove",
  input: z.object({
    agentId: z.string().min(1),
    itemId: z.string().min(1),
  }),
  output: AgentQueueDetailSchema,
});

export const moveQueueItemRpc = defineRpc({
  name: "queue.move",
  input: z.object({
    agentId: z.string().min(1),
    itemId: z.string().min(1),
    direction: z.enum(["up", "down"]),
  }),
  output: AgentQueueDetailSchema,
});

export const setQueuePausedRpc = defineRpc({
  name: "queue.set_paused",
  input: z.object({
    agentId: z.string().min(1),
    paused: z.boolean(),
  }),
  output: AgentQueueDetailSchema,
});

export const clearQueueRpc = defineRpc({
  name: "queue.clear",
  input: z.object({
    agentId: z.string().min(1),
  }),
  output: AgentQueueDetailSchema,
});

export const setFrontendQueueHoldRpc = defineRpc({
  name: "queue.frontend_hold",
  input: z.object({
    agentId: z.string().min(1),
    hasFrontendItems: z.boolean(),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});
