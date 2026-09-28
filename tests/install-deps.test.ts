import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  INSTALL_COMMAND,
  installDeps,
  installFailure,
  installNeeded,
} from "../server/tasks/install-deps.ts";
import { runLocalCheck, LocalCheckQueue } from "../server/tasks/local-check.ts";
import { classifyCheck } from "../server/tasks/check-outcome.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { nodeCommand } from "./portable-shell.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * 检查前装依赖（t252）：本机为远程任务另建的合入工作树、代理的检查工作树都没装依赖，
 * 有锁文件就 npm ci（锁文件没变跳过），装不上算没跑成并写清原因。
 */

test("要不要装：没有 package.json 或锁文件不装，锁文件哈希和上次装好的一样不装", () => {
  const cases: [boolean, string | null, string | null, boolean][] = [
    [false, null, null, false],
    [false, "h1", null, false],
    [true, null, null, false],
    [true, null, "h1\n", false],
    [true, "h1", null, true],
    [true, "h1", "h1\n", false],
    [true, "h2", "h1\n", true],
    [true, "h1", "", true],
  ];
  for (const [hasPackage, lockHash, stamp, expected] of cases)
    assert.equal(
      installNeeded({ hasPackage, lockHash, stamp }),
      expected,
      JSON.stringify({ hasPackage, lockHash, stamp }),
    );
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
});

/** 假 npm：参数记进 calls，mode 文件写 fail 时照 npm 的样子报错退出，否则建 node_modules。 */
function setup(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "atrium-install-deps-"));
  t.after(() => removeTemp(root));
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
  assert.equal(await installDeps({ tree, log, env }), null);
  assert.deepEqual(count(), []);

  writeFileSync(join(tree, "package-lock.json"), '{"v":1}');
  assert.equal(await installDeps({ tree, log, env }), null);
  assert.deepEqual(count(), ["ci --prefer-offline --no-audit --no-fund"]);
  assert.ok(existsSync(join(tree, "node_modules", ".atrium-lock")));
  const text = readFileSync(log, "utf8");
  assert.match(text, /\[atrium\] 装依赖：npm ci/);
  assert.match(text, /added 3 packages/);

  assert.equal(await installDeps({ tree, log, env }), null);
  assert.equal(count().length, 1);

  writeFileSync(join(tree, "package-lock.json"), '{"v":2}');
  assert.equal(await installDeps({ tree, log, env }), null);
  assert.equal(count().length, 2);
});

test("本机检查带 install：装不上依赖算没跑成、写清原因，不跑检查命令；装上了接着跑检查", async (t) => {
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
    install: true,
    queue: new LocalCheckQueue(1),
  });
  assert.equal(failed.status, "error");
  assert.equal(
    failed.infra,
    `装依赖失败（${INSTALL_COMMAND} 退出码 1）：network 取不到 registry`,
  );
  assert.equal(failed.detail, failed.infra);
  assert.equal(existsSync(ran), false, "装不上依赖不该跑检查");
  assert.deepEqual(classifyCheck(failed, []), {
    outcome: "not_run",
    reason: failed.infra,
  });
  const failedLog = readFileSync(failed.log, "utf8");
  assert.match(failedLog, /npm error code ENOTFOUND/);
  assert.match(failedLog, /\[atrium\] 装依赖失败/);

  writeFileSync(mode, "");
  const passed = await runLocalCheck({
    worktree: tree,
    taskDir,
    env,
    install: true,
    queue: new LocalCheckQueue(1),
  });
  assert.equal(passed.status, "passed");
  assert.equal(passed.infra, undefined);
  assert.equal(count().length, 2);
  const log = readFileSync(passed.log, "utf8");
  // 这一轮的日志从头写：上一轮的报错不留，装依赖的输出在检查输出前面。
  assert.doesNotMatch(log, /ENOTFOUND/);
  assert.ok(log.indexOf("added 3 packages") < log.indexOf("checked"));

  // 不带 install（执行者自己装好依赖的工作树）不碰 npm。
  writeFileSync(join(tree, "package-lock.json"), '{"v":2}');
  const plain = await runLocalCheck({
    worktree: tree,
    taskDir,
    env,
    queue: new LocalCheckQueue(1),
  });
  assert.equal(plain.status, "passed");
  assert.equal(count().length, 2);
});
