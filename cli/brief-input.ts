import { readFileSync } from "node:fs";
import { Problem } from "../server/problem.ts";
import {
  BRIEF_MAX_BYTES,
  briefBytes,
  briefTooLong,
} from "../server/tasks/ledger/brief.ts";

/**
 * `--brief 文件` 与 `--brief -`（标准输入）读成详述内容（#355）：命令行读、服务存库，
 * 之后派活与查看都用库里的内容，原文件改了或删了都不影响。
 */

export type BriefInput = { brief: string; brief_path?: string };

async function readStdin(stdin: NodeJS.ReadStream): Promise<string> {
  if (stdin.isTTY)
    throw new Problem(
      400,
      "--brief - 从标准输入读详述，需要用管道或重定向传入，如 atrium task add 标题 --brief - < 详述.md",
      "usage",
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    // 多读一点就够判超限，不把超大输入整个收进内存。
    if (size > BRIEF_MAX_BYTES + 4) throw briefTooLong(size, "--brief");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function briefInput(
  value: string,
  resolvePath: (value: string) => string,
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<BriefInput> {
  const fromStdin = value === "-";
  const path = fromStdin ? undefined : resolvePath(value);
  let text: string;
  if (path === undefined) text = await readStdin(stdin);
  else
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new Problem(400, `--brief 读不到：${path}`, "usage");
    }
  text = text.replace(/^﻿/, "");
  const bytes = briefBytes(text);
  if (bytes > BRIEF_MAX_BYTES) throw briefTooLong(bytes, "--brief");
  if (!text.trim())
    throw new Problem(
      400,
      `--brief ${fromStdin ? "标准输入" : path} 是空的；要清空详述用 --brief ''`,
      "usage",
    );
  return { brief: text, ...(path ? { brief_path: path } : {}) };
}
