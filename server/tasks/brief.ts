import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { usage } from "./ledger-model.ts";

/**
 * 任务详述进库（#355）：内容存在 tasks.brief，brief_path 只记来源文件，派活、查看、审阅都读库里的内容。
 * 校验与路径解析是纯函数；读文件只在建任务、改任务（调用方只给了路径）和启动回填时发生。
 */

/** 详述上限：按 UTF-8 字节算，超了让调用方精简。 */
export const BRIEF_MAX_BYTES = 64 * 1024;

export const briefBytes = (text: string) => Buffer.byteLength(text, "utf8");

/** 超限说明：带实际大小与精简办法，命令行与接口共用。 */
export function briefTooLong(bytes: number, field = "brief") {
  return usage(
    `${field}: 任务详述 ${Math.ceil(bytes / 1024)} KB，超过上限 ${BRIEF_MAX_BYTES / 1024} KB；请精简，长材料放进仓库文件、详述里写路径`,
  );
}

/** 校验详述内容：文本、去掉首尾空白后非空才算有，不超上限。 */
export function briefText(value: unknown, field = "brief"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw usage(`${field}: 应为文本`);
  const text = value.replace(/^﻿/, "");
  if (!text.trim()) return null;
  const bytes = briefBytes(text);
  if (bytes > BRIEF_MAX_BYTES) throw briefTooLong(bytes, field);
  return text;
}

/** 运行时自己生成的详述（审阅、专员审查、会审）：超限截断并注明，不因原详述过长而建不出任务。 */
export function clipBrief(text: string): string {
  if (briefBytes(text) <= BRIEF_MAX_BYTES) return text;
  const note = "\n\n（详述过长，以下已截断）";
  const room = BRIEF_MAX_BYTES - briefBytes(note);
  let out = Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
  // 截在多字节字符中间会留下替换符，去掉。
  out = out.replace(/\uFFFD+$/, "");
  return `${out}${note}`;
}

/** 来源路径解析成绝对路径；相对路径按任务仓库算，没有仓库就解析不了。 */
export function briefFile(
  path: string,
  repo: string | null,
): string | undefined {
  if (isAbsolute(path)) return path;
  return repo ? join(repo, path) : undefined;
}

/** 按来源路径读详述（兼容只给 brief_path 的调用方）；读不到或超限报用法错误，空文件存空串。 */
export function readBriefFile(path: string, repo: string | null): string {
  const file = briefFile(path, repo);
  if (!file)
    throw usage(`brief_path: 相对路径需要任务有仓库（--repo）：${path}`);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw usage(`brief_path: 任务详述读不到：${file}`);
  }
  return briefText(text, "brief_path") ?? "";
}
