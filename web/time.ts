export const time = (value: number) =>
  new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);

/** 会话列表时间：今天显示时刻，昨天显示「昨天」，再早显示日期。 */
export const convTime = (value: number) => {
  if (!value) return "";
  const day = new Date(value),
    now = new Date();
  if (day.toDateString() === now.toDateString()) return time(value);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (day.toDateString() === yesterday.toDateString()) return "昨天";
  if (day.getFullYear() === now.getFullYear())
    return `${day.getMonth() + 1}月${day.getDate()}日`;
  return `${day.getFullYear()}/${day.getMonth() + 1}/${day.getDate()}`;
};
