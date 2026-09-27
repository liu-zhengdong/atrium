import { recordResult } from "./contract.ts";
import { clip, oneLine, width } from "../server/text-width.ts";

/** 终端输出的几个小工具：按显示宽度对齐的表格、时间、单行摘要。 */

export { clip, oneLine, width };
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

export const printJson = (value: unknown) => {
  recordResult(value);
  console.log(JSON.stringify(value, null, 2));
};
