import {
  BRIEF_MAX_BYTES,
  briefBytes,
  briefTooLong
} from "./chunk-FA7LVUBN.js";
import {
  Problem
} from "./chunk-XWXBA3CJ.js";

// cli/brief-input.ts
import { readFileSync } from "node:fs";
async function readStdin(stdin) {
  if (stdin.isTTY)
    throw new Problem(
      400,
      "--brief - \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\u8BE6\u8FF0\uFF0C\u9700\u8981\u7528\u7BA1\u9053\u6216\u91CD\u5B9A\u5411\u4F20\u5165\uFF0C\u5982 atrium task add \u6807\u9898 --brief - < \u8BE6\u8FF0.md",
      "usage"
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > BRIEF_MAX_BYTES + 4) throw briefTooLong(size, "--brief");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function briefInput(value, resolvePath, stdin = process.stdin) {
  const fromStdin = value === "-";
  const path = fromStdin ? void 0 : resolvePath(value);
  let text;
  if (path === void 0) text = await readStdin(stdin);
  else
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new Problem(400, `--brief \u8BFB\u4E0D\u5230\uFF1A${path}`, "usage");
    }
  text = text.replace(/^﻿/, "");
  const bytes = briefBytes(text);
  if (bytes > BRIEF_MAX_BYTES) throw briefTooLong(bytes, "--brief");
  if (!text.trim())
    throw new Problem(
      400,
      `--brief ${fromStdin ? "\u6807\u51C6\u8F93\u5165" : path} \u662F\u7A7A\u7684\uFF1B\u8981\u6E05\u7A7A\u8BE6\u8FF0\u7528 --brief ''`,
      "usage"
    );
  return { brief: text, ...path ? { brief_path: path } : {} };
}

export {
  briefInput
};
