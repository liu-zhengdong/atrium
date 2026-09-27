import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepTestRun } from "./fixture-signal.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const tests = readdirSync(join(root, "tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => join(root, "tests", name));
const runId = randomUUID();
const child = spawn(join(root, "node_modules/.bin/tsx"), ["--test", ...tests], {
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
