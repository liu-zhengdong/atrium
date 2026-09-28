/**
 * 执行者档案用的极简 frontmatter 解析（#262）：只支持档案里实际出现的写法——
 * `键: 值`、行内数组 `[a, b]`、行内映射 `{k: 1}`、数字、带引号字符串和行尾 `# 注释`。
 * 不支持多行值与嵌套块；解析不了的行记进 warnings，不抛错。
 */
export type FrontValue =
  string | number | boolean | FrontValue[] | { [key: string]: FrontValue };

export type Frontmatter = {
  data: Record<string, FrontValue>;
  body: string;
  warnings: string[];
};

export function parseFrontmatter(text: string): Frontmatter {
  const source = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(source);
  if (!match) return { data: {}, body: source.trim(), warnings: [] };
  const data: Record<string, FrontValue> = {};
  const warnings: string[] = [];
  for (const raw of match[1].split("\n")) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const pair = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) {
      warnings.push(`无法解析的行：${raw.trim()}`);
      continue;
    }
    data[pair[1]] = parseValue(pair[2].trim());
  }
  return { data, body: source.slice(match[0].length).trim(), warnings };
}

/** 去掉引号外、前面是空白的 `#` 及其后内容。 */
function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1])))
      return line.slice(0, i);
  }
  return line;
}

function parseValue(value: string): FrontValue {
  if (value.startsWith("[") && value.endsWith("]"))
    return splitTop(value.slice(1, -1)).map(parseValue);
  if (value.startsWith("{") && value.endsWith("}")) {
    const out: Record<string, FrontValue> = {};
    for (const item of splitTop(value.slice(1, -1))) {
      const at = item.indexOf(":");
      if (at <= 0) continue;
      out[unquote(item.slice(0, at).trim())] = parseValue(
        item.slice(at + 1).trim(),
      );
    }
    return out;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true" || value === "false") return value === "true";
  return unquote(value);
}

/** 按顶层逗号切分，括号与引号内的逗号不切。 */
function splitTop(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    (value[0] === '"' || value[0] === "'") &&
    value.at(-1) === value[0]
  )
    return value.slice(1, -1);
  return value;
}
