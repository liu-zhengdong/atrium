// 与 format.js 同名的类型声明，只给测试与类型检查用（浏览器直接加载 format.js）。
export function escapeHtml(value: unknown): string;
export function linkify(text: unknown): string;
export function liveText(
  page: string,
  data: { page?: string; node?: { counts?: { running?: number } } } | null,
  now: { running?: number } | null,
): string;
