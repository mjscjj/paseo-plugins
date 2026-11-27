export const MARKER = "[paseo-auto-retry:";

const PERMANENT =
  /unauthori[sz]ed|forbidden|access token|sign[ -]?in|log[ -]?in|authenticat|quota|billing|usage limit|credit balance|context[ _-]?(?:window|length)|maximum context|permission denied|(?:user|manually) (?:cancel|interrupt)|(?:cancel|interrupt)(?:ed)? by (?:the )?user|invalid (?:api )?key|invalid (?:params|parameters|arguments)|model (?:not found|does not exist)|certificate (?:has expired|verify failed)|["']?\b(?:retryable|retriable)["']?\s*[:=]\s*false|登录失效|未授权|权限不足|额度(?:耗尽|用尽)|余额不足|上下文.*(?:超限|过长)|用户.*(?:取消|中止)/i;

const NETWORK =
  /stream ended without turnEnded|stream disconnected before completion|stream (?:ended|closed|terminated) (?:unexpectedly|prematurely)|connection (?:reset|dropped|lost|closed|refused|terminated|error)|socket (?:hang up|closed|disconnected)|\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_SOCKET|NetworkError|ConnectionError|TransportError|RemoteProtocolError|ChunkedEncodingError|RemoteDisconnected|ServerDisconnectedError)\b|network (?:connection|error|request failed|is unreachable)|fetch failed|failed to fetch|DNS (?:lookup|resolution).*fail|premature (?:close|end)|unexpected EOF|unexpected end of (?:stream|file)|transport (?:error|closed)|网络(?:连接)?(?:中断|异常|失败)|连接(?:中断|重置|断开)/i;

const TIMEOUT =
  /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|[A-Za-z]*TimeoutError)\b|(?:request|connection|connect|read|write|socket|stream|operation|upstream|response|ping|keepalive|heartbeat) (?:has )?(?:timed out|timeout)|deadline exceeded|超时/i;

const OVERLOAD =
  /overloaded|at capacity|server (?:is )?busy|temporarily unavailable|temporary (?:failure|error)|service unavailable|\[unavailable\]|bad gateway|gateway timeout|internal server error|服务(?:暂时不可用|繁忙)|系统繁忙/i;

const RETRIABLE =
  /\b(?:Retriable|Retryable)Error\b|"retryable"\s*:\s*true|\bretriable\s*[:=]\s*true/i;

const RATE_LIMIT = /rate[ _-]?limit|too many requests|请求过于频繁|限流/i;

export type ErrorCategory =
  | "requires-intervention"
  | "rate-limit"
  | "network"
  | "timeout"
  | "server-unavailable"
  | "provider-retriable"
  | "unclassified";

export interface ErrorClassification {
  category: ErrorCategory;
  retryable: boolean;
}

export function renderedError(text: unknown): boolean {
  if (typeof text !== "string" || text.length > 16_384) return false;
  const value = text.trim();
  if (!value) return false;
  // Paseo system error marker or machine-formatted error headline.
  if (/^\[System Error\]\s+/.test(value)) return true;
  if (
    !/^(?:Error:\s*|[A-Za-z_$][\w.$]*(?:Error|Exception):\s*|(?:错误|报错)[:：]\s*)/i.test(
      value,
    )
  ) {
    return false;
  }
  // Accept structured/stack lines after headline, reject normal prose discussing an error.
  return value
    .split(/\r?\n/)
    .slice(1)
    .every(
      (line) =>
        !line.trim() ||
        /^\s*(?:at\s+|Caused by:|cause:|code:|details?:|diagnostic:|request[ _-]?id:|trace[ _-]?id:|status(?: code)?:|retry-after:|please (?:try|retry)\b|\{|\}|\[|\]|"[\w_-]+"\s*:)/i.test(
          line,
        ),
    );
}

export function classifyError(
  text: unknown,
  rendered = false,
): ErrorClassification | null {
  if (typeof text !== "string" || !text.trim()) return null;
  if (rendered && !renderedError(text)) return null;

  const statusMatch =
    text.match(
      /\b(?:HTTP(?:\/[\d.]+)?(?:[ _]?error)?|status(?:[_ ]?code)?|API[ _]?error|error[ _]?code)[\s"':=(]*(\d{3})\b/i,
    )?.[1] ??
    text.match(/^(?:\[System Error\]\s*)?(?:Error:\s*)?(\d{3})\b/)?.[1];
  const status = statusMatch ? Number(statusMatch) : Number.NaN;

  if (
    PERMANENT.test(text) ||
    [400, 401, 402, 403, 404, 405, 413, 422, 501, 505, 511].includes(status)
  ) {
    return { category: "requires-intervention", retryable: false };
  }
  if (RATE_LIMIT.test(text) || status === 429) {
    return { category: "rate-limit", retryable: true };
  }
  if (NETWORK.test(text)) {
    return { category: "network", retryable: true };
  }
  if (TIMEOUT.test(text) || status === 408 || status === 504) {
    return { category: "timeout", retryable: true };
  }
  if (
    OVERLOAD.test(text) ||
    [500, 502, 503, 520, 521, 522, 523, 524, 529].includes(status)
  ) {
    return { category: "server-unavailable", retryable: true };
  }
  if (RETRIABLE.test(text)) {
    return { category: "provider-retriable", retryable: true };
  }
  return { category: "unclassified", retryable: false };
}

export function extractRetryAfterSeconds(text: string): number {
  const match = text.match(/retry[- ]after\s*[:=]?\s*(\d+)\b/i);
  if (!match) return 0;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

export function redactError(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "<URL>")
    .replace(/\b(?:sk-|sk_)[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "[REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)["']?[^\s,;"'}]+["']?/gi,
      "$1[REDACTED]",
    )
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[REDACTED]")
    .slice(0, 400);
}

export function buildRecoveryPrompt(
  messageId: string,
  attempt: number,
  total: number,
  category: ErrorCategory,
): string {
  return (
    `${MARKER}${messageId}] 自动重试 ${attempt}/${total}（原因：${category}）。\n` +
    "上一轮因临时超时、网络抖动、限流或上游服务异常而中断。请在当前会话中继续用户最后一个尚未完成的请求，保持原有约束和权限范围。\n" +
    "先检查上一轮已经完成的修改、命令和外部操作，从中断处接着推进；不要重复提交、发布、发消息或其他已经成功的操作。\n" +
    "若原任务已完成、用户已要求停止，或需要用户补充信息/授权，请简明说明并停止。"
  );
}
