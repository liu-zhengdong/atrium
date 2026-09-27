/**
 * 按终端显示宽度量文字与截断：中日韩文字、全角标点占两格，其余按一格；
 * 够用就好，不引入宽字符库。命令行排版与看板的最近动作共用。
 */

const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;

export const width = (text: string) =>
  [...text].reduce((total, char) => total + (wide.test(char) ? 2 : 1), 0);

/** 压成一行，超过给定显示宽度就截断，末尾带省略号（省略号算一格）。换行并成空格，适合要保留全文意思的场合。 */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (width(line) <= max) return line;
  let out = "";
  for (const char of line) {
    if (width(out + char) > max - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/**
 * 进状态栏、top、全景任务行的文字统一过这里：多行只取第一行有字的，压掉多余空白，
 * 超过显示宽度截断加「…」。整篇原文（审阅意见、检查日志）留给 `task show`。
 */
export function oneLine(text: string, max: number): string {
  const first = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return clip(first, max);
}
