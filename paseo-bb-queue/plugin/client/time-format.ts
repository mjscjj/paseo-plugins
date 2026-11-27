function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "14:30", or "11-28 09:00" when not today. */
export function formatDue(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? hm : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;
}

export function formatCountdown(iso: string, nowMs: number = Date.now()): string {
  const due = Date.parse(iso);
  if (Number.isNaN(due)) return "";
  const minutes = Math.ceil((due - nowMs) / 60_000);
  if (minutes <= 0) return "已到点";
  if (minutes < 60) return `约 ${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `约 ${hours} 小时后` : `约 ${hours} 小时 ${rest} 分后`;
}
