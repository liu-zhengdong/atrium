// Only fixed labels cross the worker IPC boundary; never send an exception or provider response.
export function classifyRefreshError(error) {
  let text;
  try {
    text =
      typeof error === "object" && error !== null
        ? JSON.stringify(error) + " " + String(error.message ?? "")
        : String(error ?? "");
  } catch {
    text = "";
  }
  if (/plugin|extension|插件加载失败/i.test(text))
    return "Provider 插件加载失败";
  if (
    /invalid.grant|unauthoriz|\b401\b|expired|revoked|重新登录|登录失效/i.test(
      text,
    )
  )
    return "登录已失效，需要重新登录";
  if (
    /network|timeout|timed.out|fetch.failed|econn|enotfound|\b429\b|\b50[234]\b/i.test(
      text,
    )
  )
    return "网络或超时，稍后自动重试";
  return "未知错误";
}
