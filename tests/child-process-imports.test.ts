import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 子进程一律经平台层拉起（t167）：Windows 上没带 windowsHide 的子进程会新开可见的控制台窗口，
 * detached 的子进程没有控制台、它的子孙也会各自弹窗。平台层（server/platform）统一处理这两件事，
 * 其余代码只从那里拉起，不直接用 node:child_process（只引类型可以）。
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const SCANNED = ["server", "cli", "bin"];
const ALLOWED = join("server", "platform") + sep;

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") found.push(...sources(path));
    } else if (/\.(ts|mts|js|mjs|cjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** 文件里对 child_process 的非类型引用（import、动态 import、require）。 */
export function childProcessUses(text: string): string[] {
  const uses: string[] = [];
  const pattern =
    /(import\s+(type\s+)?[^;]*?from\s*["'](?:node:)?child_process["'])|((?:import|require)\s*\(\s*["'](?:node:)?child_process["']\s*\))/g;
  for (const match of text.matchAll(pattern))
    if (!match[2]) uses.push(match[0]);
  return uses;
}

test("识别 child_process 的引用：类型引用放行，值引用、动态 import、require 都算", () => {
  assert.deepEqual(
    childProcessUses(
      'import type { ChildProcess } from "node:child_process";\nimport type {\n  A,\n} from "child_process";',
    ),
    [],
  );
  assert.equal(
    childProcessUses('import { spawn } from "node:child_process";').length,
    1,
  );
  assert.equal(
    childProcessUses('import {\n  execFile,\n} from "child_process";').length,
    1,
  );
  assert.equal(
    childProcessUses('const cp = await import("node:child_process");').length,
    1,
  );
  assert.equal(
    childProcessUses('const cp = require("child_process");').length,
    1,
  );
});

test("server、cli、bin 里除平台层外不直接用 node:child_process", () => {
  const offenders: string[] = [];
  for (const dir of SCANNED)
    for (const file of sources(join(root, dir))) {
      const rel = relative(root, file);
      if (rel.startsWith(ALLOWED)) continue;
      for (const use of childProcessUses(readFileSync(file, "utf8")))
        offenders.push(`${rel}: ${use.replace(/\s+/g, " ")}`);
    }
  assert.deepEqual(
    offenders,
    [],
    "改用 server/platform 的 spawnInvocation / spawnCommand / spawnShell / runFile / runCommand / spawnNode",
  );
});
