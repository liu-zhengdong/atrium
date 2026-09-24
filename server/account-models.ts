import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { privateWrite } from "./account-files.ts";
import { modelEntry, type CustomConfig } from "./custom-providers.ts";
import { Problem } from "./store.ts";

type Member = {
  key: string;
  start: number;
  valueStart: number;
  valueEnd: number;
};
const space = (text: string, from: number) => {
  while (/\s/.test(text[from] ?? "")) from++;
  return from;
};
// Locate JSON member boundaries without serializing unrelated providers (or changing their bytes).
function valueEnd(text: string, start: number): number {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      if (depth === 0) return i;
      depth--;
    } else if (c === "," && depth === 0) return i;
  }
  return text.length;
}
function members(
  text: string,
  open: number,
): { entries: Member[]; close: number } {
  const entries: Member[] = [];
  let i = space(text, open + 1);
  while (text[i] !== "}") {
    const start = i;
    if (text[i] !== '"') throw new Error("JSON 对象格式错误");
    let escape = false;
    i++;
    while (i < text.length) {
      if (escape) escape = false;
      else if (text[i] === "\\") escape = true;
      else if (text[i] === '"') break;
      i++;
    }
    const key = JSON.parse(text.slice(start, ++i)) as string;
    i = space(text, i);
    if (text[i++] !== ":") throw new Error("JSON 对象格式错误");
    const valueStart = space(text, i),
      end = valueEnd(text, valueStart);
    entries.push({ key, start, valueStart, valueEnd: end });
    i = space(text, end);
    if (text[i] === ",") i = space(text, i + 1);
    else if (text[i] !== "}") throw new Error("JSON 对象格式错误");
  }
  return { entries, close: i };
}
function updateProvider(
  text: string,
  provider: string,
  config?: CustomConfig,
): string {
  const root = members(text, space(text, 0));
  const providers = root.entries.find((item) => item.key === "providers");
  if (!providers) {
    if (!config) return text;
    const insert = `${root.entries.length ? "," : ""}\n  "providers": ${JSON.stringify({ [provider]: modelEntry(config) })}\n`;
    return text.slice(0, root.close) + insert + text.slice(root.close);
  }
  const list = members(text, providers.valueStart);
  const index = list.entries.findIndex((item) => item.key === provider);
  if (index >= 0) {
    const item = list.entries[index]!;
    if (config)
      return (
        text.slice(0, item.valueStart) +
        JSON.stringify(modelEntry(config)) +
        text.slice(item.valueEnd)
      );
    const next = list.entries[index + 1];
    if (next) return text.slice(0, item.start) + text.slice(next.start);
    const prev = list.entries[index - 1];
    return (
      text.slice(0, prev ? prev.valueEnd : item.start) + text.slice(list.close)
    );
  }
  if (!config) return text;
  const insert = `${list.entries.length ? "," : ""}\n    ${JSON.stringify(provider)}: ${JSON.stringify(modelEntry(config))}\n`;
  return text.slice(0, list.close) + insert + text.slice(list.close);
}
export function setAccountModel(
  directory: string,
  provider: string,
  config?: CustomConfig,
) {
  const file = join(directory, "models.json");
  if (!existsSync(file)) {
    if (config)
      privateWrite(file, { providers: { [provider]: modelEntry(config) } });
    return;
  }
  const text = readFileSync(file, "utf8");
  try {
    JSON.parse(text);
  } catch {
    throw new Problem(409, "身份 models.json 无法读取，未覆盖");
  }
  const updated = updateProvider(text, provider, config);
  JSON.parse(updated);
  if (updated === text) return;
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, updated, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}
