import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepTestRun } from "./fixture-signal.ts";
import { importsOf, parseTestArgs, relatedTests } from "./select-tests.ts";

// npm test                               跑 tests/ 下全部（npm run check 带上；全量由运行时跑，执行者不跑）
// npm test -- tests/a.test.ts b.test.ts  只跑列出的文件
// npm test -- --changed                  只跑与 origin/main 相比改动文件相关的测试
// 其余 - 开头的参数（如 --test-name-pattern=…）原样交给 node --test。
const root = fileURLToPath(new URL("../", import.meta.url));
const allTests = readdirSync(join(root, "tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `tests/${name}`);
const args = parseTestArgs(process.argv.slice(2));
if (args.mode === "error") {
  console.error(args.message);
  process.exit(2);
}
const selected = selectTests();
if (!selected) process.exit(process.exitCode ?? 0);
const runId = randomUUID();
// 运行时给执行者与本地检查注入测试并发上限（#358），免得每个 worktree 各占满全部核；没设按 node 缺省。
const concurrency = process.env.ATRIUM_TEST_CONCURRENCY?.trim() ?? "";
const limit = /^[1-9][0-9]{0,5}$/.test(concurrency)
  ? [`--test-concurrency=${concurrency}`]
  : [];
// 直接用 node 跑 tsx 的命令行：Windows 上 node_modules/.bin/tsx 是 .cmd，不能直接拉起。
const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const child = spawn(
  process.execPath,
  [
    tsx,
    "--test",
    ...limit,
    ...args.passthrough,
    ...selected.map((file) => join(root, file)),
  ],
  {
    cwd: root,
    // 自带额度读取不碰开发者本机的登录与供应商接口；读取器测试显式注入假凭据。
    env: {
      ...process.env,
      ATRIUM_TEST_RUN_ID: runId,
      ATRIUM_QUOTA_READERS: "off",
    },
    stdio: "inherit",
  },
);
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

/** 要跑的测试（仓库相对路径）；没有可跑的返回 null，退出码已设好。 */
function selectTests(): string[] | null {
  if (args.mode === "all") return allTests;
  if (args.mode === "files") {
    const picked = new Set<string>();
    for (const file of args.files) {
      const found = locate(file);
      if (!found) {
        console.error(`找不到测试文件：${file}（写成 tests/名字.test.ts）`);
        process.exitCode = 2;
        return null;
      }
      picked.add(found);
    }
    console.error(`只跑 ${picked.size} 个测试文件。`);
    return [...picked];
  }
  const changed = changedFiles();
  if (!changed) {
    process.exitCode = 2;
    return null;
  }
  const imports = new Map(
    allTests.map((file) => [
      file,
      importsOf(file, readFileSync(join(root, file), "utf8")),
    ]),
  );
  const { tests, unmatched } = relatedTests(changed, imports);
  if (unmatched.length)
    console.error(
      `这些改动没匹配到测试：${unmatched.join("，")}\n` +
        "按需指定：npm test -- tests/名字.test.ts",
    );
  if (!tests.length) {
    console.error(
      changed.length
        ? "改动没匹配到任何测试，没跑。"
        : "与 origin/main 相比没有改动，没跑。",
    );
    return null;
  }
  console.error(`按改动跑 ${tests.length} 个测试文件：${tests.join(" ")}`);
  return tests;
}

/** 命令行给的测试文件 → 仓库相对路径；依次按当前目录、仓库根、tests/ 找。 */
function locate(file: string): string | null {
  for (const base of [process.cwd(), root, join(root, "tests")]) {
    const full = resolve(base, file);
    if (!full.endsWith(".test.ts") || !existsSync(full)) continue;
    if (!statSync(full).isFile()) continue;
    const rel = relative(root, full);
    if (rel.startsWith("..")) continue;
    return rel.split(sep).join("/");
  }
  return null;
}

/** 与 origin/main 分叉点相比改过（含未提交、未跟踪）且还在的文件。 */
function changedFiles(): string[] | null {
  const git = (...argv: string[]) =>
    execFileSync("git", ["-c", "core.quotepath=off", ...argv], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    const base = git("merge-base", "HEAD", "origin/main").trim();
    const listed = [
      ...git("diff", "--name-only", "--diff-filter=d", base).split("\n"),
      ...git("ls-files", "--others", "--exclude-standard").split("\n"),
    ];
    return [...new Set(listed.map((file) => file.trim()).filter(Boolean))];
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.error(
      `取不到与 origin/main 的改动（${detail}）；先 git fetch origin，或直接列出测试文件。`,
    );
    return null;
  }
}
