import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { needsInstall } from "../server/tasks/check-deps.ts";
import { runLocalCheck } from "../server/tasks/local-check.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { nodeCommand } from "./portable-shell.ts";
import { removeTemp } from "./temp-dir.ts";

test("要不要装依赖：记过哈希按哈希比，没记过看执行者是否在锁文件变动后装过", () => {
  const cases: [Parameters<typeof needsInstall>[0], boolean][] = [
    [{ lock: null, stamp: null, installedAfterLock: false }, false],
    [{ lock: null, stamp: "a", installedAfterLock: true }, false],
    [{ lock: "a", stamp: "a", installedAfterLock: false }, false],
    [{ lock: "a", stamp: "a", installedAfterLock: true }, false],
    [{ lock: "b", stamp: "a", installedAfterLock: false }, true],
    [{ lock: "b", stamp: "a", installedAfterLock: true }, true],
    [{ lock: "a", stamp: null, installedAfterLock: true }, false],
    [{ lock: "a", stamp: null, installedAfterLock: false }, true],
  ];
  for (const [state, expected] of cases)
    assert.equal(needsInstall(state), expected, JSON.stringify(state));
});

/**
 * 假仓库：检查命令要 node_modules/tool 在才过（没装依赖时像 tsc 找不到那样退 127）；
 * 假 npm 记下被调了几次、装出 node_modules/tool 与 npm 自己的 .package-lock.json，有 npm-fail 文件时失败
 * （检查环境按白名单传，不能用自定义变量控制）。
 */
function setup(t: { after: (fn: () => void) => void }, lock = true) {
  const root = mkdtempSync(join(tmpdir(), "atrium-check-deps-"));
  t.after(() => removeTemp(root));
  const tree = join(root, "tree");
  const bin = join(root, "bin");
  const calls = join(root, "npm-calls");
  const failFlag = join(root, "npm-fail");
  mkdirSync(join(tree, ".agents"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(tree, "package.json"), "{}\n");
  if (lock) writeFileSync(join(tree, "package-lock.json"), '{"v":1}\n');
  writeFileSync(
    join(tree, ".agents", "check"),
    nodeCommand(
      "process.exit(require('fs').existsSync('node_modules/tool') ? 0 : 127)",
    ),
  );
  writeFakeBin(
    join(bin, "npm"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");`,
      'console.log("fake npm " + process.argv.slice(2).join(" "));',
      `if (fs.existsSync(${JSON.stringify(failFlag)})) process.exit(1);`,
      'fs.rmSync("node_modules", { recursive: true, force: true });',
      'fs.mkdirSync("node_modules");',
      'fs.writeFileSync("node_modules/tool", "");',
      'fs.writeFileSync("node_modules/.package-lock.json", "{}");',
      "",
    ].join("\n"),
  );
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
  const count = () =>
    existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length
      : 0;
  const check = () =>
    runLocalCheck({
      worktree: tree,
      taskDir: join(root, "task"),
      env,
      install: true,
    });
  const failNpm = (fail: boolean) =>
    fail ? writeFileSync(failFlag, "") : rmSync(failFlag, { force: true });
  return { tree, count, check, failNpm };
}

test("本机合入检查：没装依赖先 npm ci，输出进检查日志；锁文件没变不重装，变了重装", async (t) => {
  const { tree, count, check } = setup(t);
  const first = await check();
  assert.equal(first.status, "passed", first.detail);
  assert.equal(count(), 1);
  const log = readFileSync(first.log, "utf8");
  assert.match(log, /\[atrium\] 装依赖：npm ci/);
  assert.match(log, /fake npm ci --no-audit --no-fund/);

  const again = await check();
  assert.equal(again.status, "passed", again.detail);
  assert.equal(count(), 1, "锁文件没变不重装");
  assert.doesNotMatch(readFileSync(again.log, "utf8"), /装依赖/);

  writeFileSync(join(tree, "package-lock.json"), '{"v":2}\n');
  const changed = await check();
  assert.equal(changed.status, "passed", changed.detail);
  assert.equal(count(), 2, "锁文件变了重装");
});

test("执行者在锁文件变动后自己装过依赖：沿用，不重装", async (t) => {
  const { tree, count, check } = setup(t);
  mkdirSync(join(tree, "node_modules"));
  writeFileSync(join(tree, "node_modules", "tool"), "");
  writeFileSync(join(tree, "node_modules", ".package-lock.json"), "{}");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(tree, "package-lock.json"), old, old);
  const result = await check();
  assert.equal(result.status, "passed", result.detail);
  assert.equal(count(), 0);

  // rebase 带来了新锁文件（比执行者装的新）：重装。
  const now = new Date(Date.now() + 60_000);
  utimesSync(join(tree, "package-lock.json"), now, now);
  const rebased = await check();
  assert.equal(rebased.status, "passed", rebased.detail);
  assert.equal(count(), 1);
});

test("装依赖失败算没跑成，原因写进结果与日志，不跑检查命令", async (t) => {
  const { count, check, failNpm } = setup(t);
  failNpm(true);
  const result = await check();
  assert.equal(result.status, "error");
  assert.equal(result.infra, "装依赖失败（npm ci 退出码 1）");
  assert.equal(result.detail, result.infra);
  assert.equal(count(), 1);
  const log = readFileSync(result.log, "utf8");
  assert.match(log, /fake npm ci/);
  assert.match(log, /\[atrium\] 装依赖失败（npm ci 退出码 1）/);

  // 下次（npm 恢复）照常装上再检查。
  failNpm(false);
  const next = await check();
  assert.equal(next.status, "passed", next.detail);
  assert.equal(count(), 2);
});

test("没有 package-lock.json 的仓库不装依赖", async (t) => {
  const { count, check } = setup(t, false);
  const result = await check();
  assert.equal(count(), 0);
  // 没装依赖、检查命令找不到：照旧按 t204 记没跑成。
  assert.ok(result.infra, result.detail);
});
