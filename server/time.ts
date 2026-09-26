/**
 * 投递给 Agent 的时间一律用这个格式：本机时区的可读时间，带上偏移量，
 * 例如 2026-09-26 11:14:32 +08:00。created_at 的毫秒时间戳 Agent 读不出来，
 * 投递、回执、读历史都在毫秒旁边附一份这个。
 */
export function readableTime(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
