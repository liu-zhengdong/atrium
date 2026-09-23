export declare function classifyRefreshError(
  error: unknown,
):
  | "登录已失效，需要重新登录"
  | "网络或超时，稍后自动重试"
  | "Provider 插件加载失败"
  | "未知错误";
