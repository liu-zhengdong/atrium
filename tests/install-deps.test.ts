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
import { delimiter, dirname, join } from "node:path";
import {
  DEPS_STAMP,
  INSTALL_COMMAND,
  depsPlan,
  installDeps,
  installFailure,
  parseDepsInstall,
  type DepsFacts,
} from "../server/tasks/merge/install-deps.ts";
import {
  checkDetail,
  runLocalCheck,
} from "../server/tasks/merge/local-check.ts";
import {
  checkSummary,
  classifyCheck,
} from "../server/tasks/merge/check-outcome.ts";
import { redact } from "../server/secret-redact.ts";
import { isolatedPath, writeFakeBin } from "./fake-bin.ts";
import { nodeCommand } from "./portable-shell.ts";
import { removeTemp, tempDir } from "./temp-dir.ts";

/**
 * 检查前装依赖（t252、t216）：每次跑检查前判一次依赖是否就绪——没装、锁文件变了、执行者装的比锁文件旧
 * 就 npm ci，已就绪直接跑；装不上算没跑成并写清原因与输出末尾（抹掉令牌）。全程用假 npm 与临时工作树。
 */

const ready: DepsFacts = {
  npm: true,
  modules: true,
  stamp: "abc",
  hash: "abc",
  lockMtime: null,
  installedMtime: null,
};

test("依赖就绪判定：没有锁文件不管，没装、锁文件变了、比上次安装新才装", () => {
  assert.deepEqual(depsPlan({ ...ready, npm: false, modules: false }), {
    install: false,
  });
  assert.deepEqual(depsPlan(ready), { install: false });
  assert.deepEqual(depsPlan({ ...ready, modules: false, stamp: null }), {
    install: true,
    why: "没有 node_modules",
  });
  assert.match(
    (depsPlan({ ...ready, hash: "def" }) as { why: string }).why,
    /和上次装的不一样/,
  );
  // 执行者自己装的（没有记号）：看 npm 的安装记录。
  const manual = { ...ready, stamp: null, hash: null };
  assert.deepEqual(
    depsPlan({ ...manual, lockMtime: 100, installedMtime: 200 }),
    { install: false },
  );
  assert.deepEqual(
    depsPlan({ ...manual, lockMtime: 200, installedMtime: 200 }),
    { install: false },
  );
  assert.match(
    (
      depsPlan({ ...manual, lockMtime: 300, installedMtime: 200 }) as {
        why: string;
      }
    ).why,
    /比上次安装新/,
  );
  assert.match(
    (
      depsPlan({ ...manual, lockMtime: 300, installedMtime: null }) as {
        why: string;
      }
    ).why,
    /没有 npm 的安装记录/,
  );
});

test("脱敏认得 npm 令牌与 .npmrc 的 _authToken", () => {
  const out = redact(
    "//registry.npmjs.org/:_authToken=abcdef123456secret\ntoken npm_abcdefghijklmnopqrstuvwxyz0123 bad",
  );
  assert.doesNotMatch(out, /abcdef123456secret|npm_abcdefghij/);
  assert.match(out, /_authToken=\*\*\*/);
});

test("装依赖没成的原因：退出码、超时、起不来，带 npm 最后一行报错", () => {
  assert.equal(
    installFailure({ code: 1, tail: "added 0\n" }),
    `装依赖失败（${INSTALL_COMMAND} 退出码 1）`,
  );
  assert.equal(
    installFailure({
      code: 1,
      tail: "npm error code EUSAGE\nnpm error `npm ci` can only install with an existing package-lock.json\n",
    }),
    `装依赖失败（${INSTALL_COMMAND} 退出码 1）：\`npm ci\` can only install with an existing package-lock.json`,
  );
  assert.equal(
    installFailure({ code: 1, tail: "npm ERR! code ENOTFOUND\n" }),
    `装依赖失败（${INSTALL_COMMAND} 退出码 1）：code ENOTFOUND`,
  );
  assert.equal(
    installFailure({ code: 127, tail: "sh: npm: command not found\n" }),
    `装依赖失败（${INSTALL_COMMAND} 退出码 127）`,
  );
  assert.equal(
    installFailure({ code: null, tail: "" }),
    `装依赖失败（${INSTALL_COMMAND} 退出码 未知）`,
  );
  assert.match(
    installFailure({ code: null, timedOut: true, tail: "npm error x\n" }),
    /^装依赖超时（.+ 超过 10 分钟）：x$/,
  );
  assert.match(
    installFailure({ code: null, error: "spawn ENOENT", tail: "" }),
    /起不来：spawn ENOENT/,
  );
  // npm 收尾那句「完整日志在哪」不是原因，取它前面那行。
  assert.equal(
    installFailure({
      code: 1,
      tail: "npm error network 取不到 registry\nnpm error A complete log of this run can be found in: /x.log\n",
    }),
    `装依赖失败（${INSTALL_COMMAND} 退出码 1）：network 取不到 registry`,
  );
});

/** 假 npm：参数记进 calls，mode 文件写 fail 时照 npm 的样子报错退出，否则建 node_modules。 */
function setup(t: { after: (fn: () => void) => void }) {
  const root = tempDir(t, "atrium-install-deps-");
  const bin = join(root, "bin");
  const tree = join(root, "tree");
  const calls = join(root, "calls");
  const mode = join(root, "mode");
  mkdirSync(bin);
  mkdirSync(tree);
  writeFakeBin(
    join(bin, "npm"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");`,
      `const mode = fs.existsSync(${JSON.stringify(mode)}) ? fs.readFileSync(${JSON.stringify(mode)}, "utf8").trim() : "";`,
      'if (mode === "fail") { console.error("npm error code ENOTFOUND"); console.error("npm error network 取不到 registry"); process.exit(1); }',
      'fs.mkdirSync("node_modules", { recursive: true });',
      'console.log("added 3 packages");',
      "",
    ].join("\n"),
  );
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const count = () =>
    existsSync(calls)
      ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean)
      : [];
  return { root, tree, env, mode, count };
}

test("有锁文件就 npm ci，装好记下锁文件哈希，没变下次跳过，变了重装；没锁文件不装", async (t) => {
  const { root, tree, env, count } = setup(t);
  const log = join(root, "check.log");
  writeFileSync(log, "");
  writeFileSync(join(tree, "package.json"), "{}");
  assert.equal(await installDeps({ tree, log, env }), undefined);
  assert.deepEqual(count(), []);

  writeFileSync(join(tree, "package-lock.json"), '{"v":1}');
  assert.equal((await installDeps({ tree, log, env }))?.status, "installed");
  assert.deepEqual(count(), ["ci --prefer-offline --no-audit --no-fund"]);
  assert.ok(existsSync(join(tree, DEPS_STAMP)));
  const text = readFileSync(log, "utf8");
  assert.match(text, /\[atrium\] 没有 node_modules，先装依赖：npm ci/);
  assert.match(text, /added 3 packages/);

  assert.equal(await installDeps({ tree, log, env }), undefined);
  assert.equal(count().length, 1);

  writeFileSync(join(tree, "package-lock.json"), '{"v":2}');
  assert.equal((await installDeps({ tree, log, env }))?.status, "installed");
  assert.equal(count().length, 2);
});

test("本机检查：装不上依赖算没跑成、写清原因，不跑检查命令；装上了接着跑检查", async (t) => {
  const { root, tree, env, mode, count } = setup(t);
  const taskDir = join(root, "task");
  writeFileSync(join(tree, "package.json"), "{}");
  writeFileSync(join(tree, "package-lock.json"), '{"v":1}');
  mkdirSync(join(tree, ".agents"));
  const ran = join(root, "check-ran");
  writeFileSync(
    join(tree, ".agents", "check"),
    nodeCommand(
      "require('fs').writeFileSync(process.argv[1], 'x'); console.log('checked')",
      ran,
    ),
  );
  writeFileSync(mode, "fail");
  const failed = await runLocalCheck({
    worktree: tree,
    taskDir,
    env,
  });
  assert.equal(failed.status, "error");
  assert.equal(
    failed.infra,
    `装依赖失败（${INSTALL_COMMAND} 退出码 1）：network 取不到 registry`,
  );
  assert.ok(failed.detail.startsWith(`${failed.infra}；输出末尾：`));
  assert.match(failed.detail, /npm error code ENOTFOUND/);
  assert.equal(existsSync(ran), false, "装不上依赖不该跑检查");
  assert.deepEqual(classifyCheck(failed, []), {
    outcome: "not_run",
    reason: failed.infra,
  });
  const failedLog = readFileSync(failed.log, "utf8");
  assert.match(failedLog, /npm error code ENOTFOUND/);
  assert.match(failedLog, /\[atrium\] 装依赖失败/);
  assert.equal(existsSync(join(tree, DEPS_STAMP)), false);

  writeFileSync(mode, "");
  const passed = await runLocalCheck({
    worktree: tree,
    taskDir,
    env,
  });
  assert.equal(passed.status, "passed");
  assert.equal(passed.infra, undefined);
  assert.equal(count().length, 2);
  const log = readFileSync(passed.log, "utf8");
  // 这一轮的日志从头写：上一轮的报错不留，装依赖的输出在检查输出前面。
  assert.doesNotMatch(log, /ENOTFOUND/);
  assert.ok(log.indexOf("added 3 packages") < log.indexOf("checked"));

  // 锁文件没变：再跑不碰 npm。
  const plain = await runLocalCheck({
    worktree: tree,
    taskDir,
    env,
  });
  assert.equal(plain.status, "passed");
  assert.equal(count().length, 2);
});

/** 假工作树 + 假 npm：ci 记一笔、建 node_modules；run check 记一笔；有 ../npm-fail 时 ci 带着令牌输出失败。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "atrium-deps-"));
  const bin = join(root, "bin");
  const work = join(root, "work");
  mkdirSync(bin);
  mkdirSync(work);
  writeFakeBin(
    join(bin, "npm"),
    [
      "#!/bin/sh",
      'echo "$1" >> ../npm-calls',
      'if [ "$1" = ci ]; then',
      "  if [ -f ../npm-fail ]; then",
      "    echo 'npm ERR! network request to https://registry.npmjs.org failed'",
      "    echo '//registry.npmjs.org/:_authToken=abcdef123456secret'",
      "    echo 'npm ERR! A complete log of this run can be found in: x.log'",
      "    exit 1",
      "  fi",
      "  mkdir -p node_modules",
      "  echo '{}' > node_modules/.package-lock.json",
      "  echo 'added 1 package'",
      "  exit 0",
      "fi",
      "echo checked",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ scripts: { check: "whatever" } }),
  );
  writeFileSync(join(work, "package-lock.json"), '{"lockfileVersion":3}\n');
  // Windows 上假 npm 的 .cmd 包装要用 node：node 目录接在最后，假 npm 仍排在前面。
  const env = {
    PATH: `${isolatedPath(bin)}${delimiter}${dirname(process.execPath)}`,
  };
  const calls = () => {
    try {
      return readFileSync(join(root, "npm-calls"), "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };
  const run = () =>
    runLocalCheck({
      worktree: work,
      taskDir: join(root, "task"),
      env,
    });
  return { root, work, env, calls, run };
}

test("本地检查：没装→先 npm ci 再跑；已装→直接跑；锁文件变了→重装", async (t) => {
  const fx = fixture();
  t.after(() => removeTemp(fx.root));

  const first = await fx.run();
  assert.equal(first.status, "passed", first.detail);
  assert.deepEqual(fx.calls(), ["ci", "run"]);
  assert.equal(first.install?.status, "installed");
  assert.equal(first.install?.why, "没有 node_modules");
  assert.ok(existsSync(join(fx.work, DEPS_STAMP)));
  const detail = checkDetail(first);
  assert.deepEqual(Object.keys(detail).slice(0, 2), ["status", "deps"]);
  assert.match(detail.deps!, /先装了依赖（npm ci，\d+ 秒）/);
  const log = readFileSync(first.log, "utf8");
  assert.match(log, /没有 node_modules，先装依赖：npm ci/);
  assert.match(log, /依赖装好，用时 \d+ 秒/);
  assert.ok(log.indexOf("added 1 package") < log.indexOf("checked"));

  const second = await fx.run();
  assert.equal(second.status, "passed");
  assert.equal(second.install, undefined);
  assert.equal("deps" in checkDetail(second), false);
  assert.deepEqual(fx.calls(), ["ci", "run", "run"]);
  assert.doesNotMatch(readFileSync(second.log, "utf8"), /装依赖/);

  writeFileSync(join(fx.work, "package-lock.json"), '{"lockfileVersion":4}\n');
  const third = await fx.run();
  assert.equal(third.status, "passed");
  assert.match(third.install!.why, /和上次装的不一样/);
  assert.deepEqual(fx.calls(), ["ci", "run", "run", "ci", "run"]);
});

test("本地检查：执行者自己装的依赖不比锁文件旧就不重装，锁文件更新了就装", async (t) => {
  const fx = fixture();
  t.after(() => removeTemp(fx.root));
  mkdirSync(join(fx.work, "node_modules"));
  const installed = join(fx.work, "node_modules", ".package-lock.json");
  writeFileSync(installed, "{}\n");
  const lock = join(fx.work, "package-lock.json");
  utimesSync(lock, new Date(1_000_000), new Date(1_000_000));
  const kept = await fx.run();
  assert.equal(kept.status, "passed");
  assert.equal(kept.install, undefined);
  assert.deepEqual(fx.calls(), ["run"]);
  utimesSync(installed, new Date(1_000_000), new Date(1_000_000));
  utimesSync(lock, new Date(2_000_000), new Date(2_000_000));
  const redone = await fx.run();
  assert.equal(redone.status, "passed");
  assert.match(redone.install!.why, /比上次安装新/);
  assert.deepEqual(fx.calls(), ["run", "ci", "run"]);
});

test("本地检查：没有 package-lock.json 的仓库不装依赖", async (t) => {
  const fx = fixture();
  t.after(() => removeTemp(fx.root));
  rmSync(join(fx.work, "package-lock.json"));
  const result = await fx.run();
  assert.equal(result.status, "passed");
  assert.equal(result.install, undefined);
  assert.deepEqual(fx.calls(), ["run"]);
});

test("本地检查：npm ci 失败是检查没跑成，不跑检查，写明原因与输出末尾且抹掉令牌", async (t) => {
  const fx = fixture();
  t.after(() => removeTemp(fx.root));
  writeFileSync(join(fx.root, "npm-fail"), "");
  const result = await fx.run();
  assert.equal(result.status, "error");
  assert.equal(result.install?.status, "failed");
  assert.deepEqual(fx.calls(), ["ci"]);
  const why = `装依赖失败（${INSTALL_COMMAND} 退出码 1）：network request to https://registry.npmjs.org failed`;
  assert.ok(result.detail.startsWith(`${why}；输出末尾：\n`), result.detail);
  assert.match(result.detail, /network request to https:\/\/registry/);
  assert.doesNotMatch(result.detail, /abcdef123456secret/);
  assert.match(checkDetail(result).deps!, /装依赖失败/);
  // 按 t204 归「没跑成」：infra 只一句原因，输出末尾留在 detail，事件里不重复一份。
  assert.equal(result.infra, why);
  assert.equal(classifyCheck(result, []).outcome, "not_run");
  assert.equal(
    (checkDetail(result).install as { detail?: string }).detail,
    undefined,
  );
  assert.equal(existsSync(join(fx.work, DEPS_STAMP)), false);
  // 下次照样重装，不因为上次失败就当装好了。
  rmSync(join(fx.root, "npm-fail"));
  const retried = await fx.run();
  assert.equal(retried.status, "passed");
  assert.deepEqual(fx.calls(), ["ci", "ci", "run"]);
});

test("远程回执里的装依赖记录：形状不对当没有，文本截断", () => {
  for (const bad of [
    undefined,
    null,
    "installed",
    { status: "ok", ms: 1, why: "" },
    { status: "installed", ms: -1, why: "" },
    { status: "installed", ms: Number.NaN, why: "" },
    { status: "failed", why: "没装" },
  ])
    assert.equal(parseDepsInstall(bad), undefined);
  assert.deepEqual(
    parseDepsInstall({ status: "installed", ms: 3000, why: 1 }),
    {
      status: "installed",
      ms: 3000,
      why: "",
    },
  );
  const long = parseDepsInstall({
    status: "failed",
    ms: 5,
    why: "没装",
    error: "npm ci 退出码 1",
    detail: "x".repeat(10_000),
  })!;
  assert.equal(long.error, "npm ci 退出码 1");
  assert.equal(long.detail!.length, 2500);
});

test("task show 的本地检查一行带上装依赖与用时", () => {
  assert.equal(
    checkSummary({
      kind: "merge_check",
      detail: {
        outcome: "passed",
        status: "passed",
        host: "h1",
        deps: "先装了依赖（npm ci，42 秒）",
      },
    }),
    "合入前过（h1）；先装了依赖（npm ci，42 秒）",
  );
  assert.equal(
    checkSummary({
      kind: "merge_check",
      detail: {
        outcome: "not_run",
        status: "error",
        reason: "装依赖失败：npm ci 退出码 1",
        deps: "装依赖失败（npm ci，3 秒）",
      },
    }),
    "合入前没跑成（基础设施问题）：装依赖失败：npm ci 退出码 1；装依赖失败（npm ci，3 秒）",
  );
  assert.equal(
    checkSummary({
      kind: "merge_check",
      detail: { outcome: "passed", status: "passed" },
    }),
    "合入前过",
  );
});
