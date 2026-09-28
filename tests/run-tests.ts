import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepTestRun } from "./fixture-signal.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
// `npm test -- tests/a.test.ts …` 只跑给定的文件（t203：改动过程中别反复跑全量），环境与清理照旧。
const picked = process.argv.slice(2).map((file) => resolve(file));
const tests = picked.length
  ? picked
  : readdirSync(join(root, "tests"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => join(root, "tests", name));
const runId = randomUUID();
// 运行时给执行者与本地检查注入测试并发上限（#358），免得每个 worktree 各占满全部核；没设按 node 缺省。
const concurrency = process.env.ATRIUM_TEST_CONCURRENCY?.trim() ?? "";
const limit = /^[1-9][0-9]{0,5}$/.test(concurrency)
  ? [`--test-concurrency=${concurrency}`]
  : [];
// 直接用 node 跑 tsx 的命令行：Windows 上 node_modules/.bin/tsx 是 .cmd，不能直接拉起。
const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const child = spawn(process.execPath, [tsx, "--test", ...limit, ...tests], {
  cwd: root,
  // 自带额度读取不碰开发者本机的登录与供应商接口；读取器测试显式注入假凭据。
  env: {
    ...process.env,
    ATRIUM_TEST_RUN_ID: runId,
    ATRIUM_QUOTA_READERS: "off",
  },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
const result = await new Promise<number>((resolve) => {
  child.on("error", () => resolve(1));
  child.on("exit", (code) => resolve(code ?? 1));
});
const leaked = sweepTestRun(runId);
if (leaked.length)
  console.error(`测试结束后遗留临时服务，已清理：${leaked.join("，")}`);
process.exitCode = result || (leaked.length ? 1 : 0);
