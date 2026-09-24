import { recordResult } from "./contract.ts";

/** 终端输出的几个小工具：按显示宽度对齐的表格、时间、单行摘要。 */

// 中日韩文字、全角标点占两格，其余按一格；够用就好，不引入宽字符库。
const wide =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{20000}-\u{3FFFD}]/u;
export const width = (text: string) =>
  [...text].reduce((total, char) => total + (wide.test(char) ? 2 : 1), 0);
export const pad = (text: string, target: number) =>
  text + " ".repeat(Math.max(0, target - width(text)));

/** 第一行是表头；最后一列不补空格。 */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, width(cell));
    });
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1 ? cell : pad(cell, widths[index] ?? 0),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** 今天只给时分，今年给月日，更早给年份。 */
export function when(timestamp: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp),
    now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return clock;
  const day = `${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${clock}`
    : `${date.getFullYear()}-${day} ${clock}`;
}

/** 压成一行，超过给定显示宽度就截断。 */
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

export const printJson = (value: unknown) => {
  recordResult(value);
  console.log(JSON.stringify(value, null, 2));
};
