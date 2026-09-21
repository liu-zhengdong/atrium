/** 聊天记录页的三块内容。图片和文件都是附件，只是 kind 不同。 */
export type RecordTab = "messages" | "images" | "files";
/** 三块内容共享的筛选。日期是 input[type=date] 给的当地日期串。 */
export type RecordFilters = {
  chat: string | null;
  sender: string | null;
  from: string;
  to: string;
  q: string;
};
export const emptyFilters: RecordFilters = {
  chat: null,
  sender: null,
  from: "",
  to: "",
  q: "",
};

/** 当地零点。日期串无效时返回 undefined，让这个筛选整个不生效。 */
export function dayStart(date: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const time = new Date(`${date}T00:00:00`).getTime();
  return Number.isNaN(time) ? undefined : time;
}

/**
 * 次日零点。结束日期用这个值做开区间上界，选中的那天才整天都算在内。
 * 用 setDate 加一天而不是加 86400000，跨夏令时那天才不会差一小时。
 */
export function dayAfter(date: string): number | undefined {
  const start = dayStart(date);
  if (start === undefined) return undefined;
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** 把筛选拼成请求路径。before 是上一页最后一条的游标。 */
export function recordsPath(
  tab: RecordTab,
  filters: RecordFilters,
  before?: number,
): string {
  const params = new URLSearchParams();
  if (filters.chat) params.set("chat", filters.chat);
  if (filters.sender) params.set("sender", filters.sender);
  const from = dayStart(filters.from);
  if (from !== undefined) params.set("from", String(from));
  const to = dayAfter(filters.to);
  if (to !== undefined) params.set("to", String(to));
  if (tab !== "messages")
    params.set("kind", tab === "images" ? "image" : "file");
  const keyword = filters.q.trim();
  if (keyword) params.set("q", keyword);
  if (before !== undefined) params.set("before", String(before));
  const endpoint = tab === "messages" ? "messages" : "files";
  const query = params.toString();
  return `/records/${endpoint}${query ? `?${query}` : ""}`;
}

/** 颠倒的时间范围服务端会拒绝；先在这里说清楚，不用等一次失败的请求。 */
export function rangeError(filters: RecordFilters): string {
  const from = dayStart(filters.from);
  const to = dayAfter(filters.to);
  if (from === undefined || to === undefined || from < to) return "";
  return "开始日期要早于结束日期";
}
