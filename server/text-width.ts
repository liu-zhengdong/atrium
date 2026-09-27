/**
 * 按终端显示宽度量文字与截断：中日韩文字、全角标点占两格，其余按一格；
 * 够用就好，不引入宽字符库。命令行排版与看板的最近动作共用。
 */

const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;

export const width = (text: string) =>
  [...text].reduce((total, char) => total + (wide.test(char) ? 2 : 1), 0);

/** 压成一行，超过给定显示宽度就截断，末尾带省略号（省略号算一格）。 */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (width(line) <= max) return line;
  let out = "";
  for (const char of line) {
    if (width(out + char) > max - 1) break;
    out += char;
  }
  return `${out}…`;
}
