import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_QUOTA_RESERVE_PERCENT,
  parseQuotaReservePercent,
  readQuotaReservePercent,
} from "../server/tasks/budget.ts";
import { chooseWorker } from "../server/tasks/worker-choice.ts";

test("章程预算：解析嵌套字段和注释；文件或字段缺失取默认，坏值拒绝", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const charter = join(dir, "charter.md");
  assert.equal(DEFAULT_QUOTA_RESERVE_PERCENT, 20);
  assert.equal(await readQuotaReservePercent(charter), 20);
  assert.equal(parseQuotaReservePercent("---\nstatus: 草稿\n---\n正文"), 20);
  writeFileSync(
    charter,
    "---\nbudget:\n  quota_reserve_percent: 25 # 给用户\n---\n正文",
  );
  assert.equal(await readQuotaReservePercent(charter), 25);
  for (const value of ["-1", "101", "NaN", ""])
    assert.throws(
      () =>
        parseQuotaReservePercent(
          `---\nbudget:\n  quota_reserve_percent: ${value}\n---\n`,
        ),
      /quota_reserve_percent/,
    );
});

test("指定执行者触及章程预算时拒绝并给出可选执行者；自动派活避开该账号", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-budget-choice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const workersDir = join(dir, "workers");
  mkdirSync(bin);
  mkdirSync(workersDir);
  for (const name of ["grok", "kimi", "codex"]) {
    const file = join(bin, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  const charterPath = join(dir, "charter.md");
  writeFileSync(
    charterPath,
    "---\nbudget:\n  quota_reserve_percent: 20\n---\n",
  );
  const options = {
    data: dir,
    workersDir,
    env: { PATH: bin },
    charterPath,
    pace: async () => [
      { providerId: "grok", usedPercent: 89, sparePercent: 90 },
      { providerId: "kimi", usedPercent: 12, sparePercent: 40 },
      { providerId: "codex", usedPercent: 80, sparePercent: 50 },
    ],
  };
  await assert.rejects(
    chooseWorker({ worker: "grok" }, options),
    /grok.*89%.*80%.*可选的其他执行者：kimi/,
  );
  assert.equal((await chooseWorker({}, options)).worker.tool, "kimi");
  writeFileSync(
    charterPath,
    "---\nbudget:\n  quota_reserve_percent: 10\n---\n",
  );
  assert.equal(
    (await chooseWorker({ worker: "grok" }, options)).worker.tool,
    "grok",
  );
});
