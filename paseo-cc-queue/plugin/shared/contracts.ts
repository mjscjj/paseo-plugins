import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const CC_PLUGIN_ID = "cc-queue";
export const CC_PREFIX = "cc ";
export const CC_PREFIX_REGEX = /^\s*cc[^\S\r\n]+/i;
export const CC_INGEST_METHOD = "cc.ingest";
/** The shared frontend bridge falls back to this for owners without `matches`. */
export const BB_PREFIX_REGEX = /^\s*bb[^\S\r\n]+/i;

export const DEFAULT_INTERVAL_MINUTES = 30;
export const MAX_INTERVAL_MINUTES = 24 * 60;
export const DEFAULT_MAX_SUBAGENT_WAIT_MINUTES = 60;

export const timingSettings = defineSettings({
  id: "timing",
  scope: "host",
  version: 1,
  schema: z.object({
    intervalMinutes: z
      .number()
      .int("请输入整数分钟")
      .min(1, "至少 1 分钟")
      .max(MAX_INTERVAL_MINUTES, "最多 1440 分钟（24 小时）")
      .default(DEFAULT_INTERVAL_MINUTES),
    /** After a message is due: longest wait for busy subagents once the root is idle; 0 = no limit. */
    maxSubagentWaitMinutes: z
      .number()
      .int("请输入整数分钟")
      .min(0, "不能小于 0")
      .max(MAX_INTERVAL_MINUTES, "最多 1440 分钟（24 小时）")
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
  /** When the message becomes eligible to send. */
  dueAt: z.string(),
});

export type QueuedItemView = z.infer<typeof QueuedItemViewSchema>;

export const AgentQueueSummarySchema = z.object({
  agentId: z.string(),
  count: z.number().int().nonnegative(),
  paused: z.boolean(),
  pauseReason: z.string().nullable(),
  firstItemPreview: z.string().nullable(),
  nextDueAt: z.string().nullable(),
  updatedAt: z.string(),
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
  intervalMinutes: z.number().int().positive().optional(),
  waitingReason: z.string().nullable().optional(),
  timeoutNotice: z.string().nullable().optional(),
});

export type AgentQueueDetail = z.infer<typeof AgentQueueDetailSchema>;

export const ingestRpc = defineRpc({
  name: CC_INGEST_METHOD,
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
  input: z.object({ agentId: z.string().min(1) }),
  output: AgentQueueDetailSchema,
});

export const enqueueManualRpc = defineRpc({
  name: "queue.enqueue",
  input: z.object({ agentId: z.string().min(1), text: z.string() }),
  output: AgentQueueDetailSchema,
});

export const updateQueueItemRpc = defineRpc({
  name: "queue.update",
  input: z.object({ agentId: z.string().min(1), itemId: z.string().min(1), text: z.string() }),
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
  input: z.object({ agentId: z.string().min(1), itemId: z.string().min(1) }),
  output: AgentQueueDetailSchema,
});

export const setQueuePausedRpc = defineRpc({
  name: "queue.set_paused",
  input: z.object({ agentId: z.string().min(1), paused: z.boolean() }),
  output: AgentQueueDetailSchema,
});

export const clearQueueRpc = defineRpc({
  name: "queue.clear",
  input: z.object({ agentId: z.string().min(1) }),
  output: AgentQueueDetailSchema,
});

export const setFrontendQueueHoldRpc = defineRpc({
  name: "queue.frontend_hold",
  input: z.object({ agentId: z.string().min(1), hasFrontendItems: z.boolean() }),
  output: z.object({ ok: z.boolean() }),
});
