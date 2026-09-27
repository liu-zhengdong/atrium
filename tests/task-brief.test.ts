import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { briefInput } from "../cli/brief-input.ts";
import {
  BRIEF_MAX_BYTES,
  briefText,
  clipBrief,
} from "../server/tasks/brief.ts";
import { ensureTaskTables } from "../server/tasks/ledger-schema.ts";
import { createTask, getTask, updateTask } from "../server/tasks/ledger.ts";
import { prepareRun } from "../server/tasks/workspace.ts";

const stdin = (text: string, tty = false) =>
  Object.assign(Readable.from([Buffer.from(text)]), {
    isTTY: tty,
  }) as unknown as NodeJS.ReadStream;
const same = (path: string) => path;

test("详述内容校验：非文本拒绝、空白算没有、超限说明大小与精简办法", () => {
  assert.equal(briefText(undefined), null);
  assert.equal(briefText("  \n"), null);
  assert.equal(briefText("﻿# 详述"), "# 详述");
  assert.throws(() => briefText(3), /brief: 应为文本/);
  assert.equal(briefText("a".repeat(BRIEF_MAX_BYTES))?.length, BRIEF_MAX_BYTES);
  assert.throws(
    () => briefText("字".repeat(BRIEF_MAX_BYTES / 3 + 1)),
    /brief: 任务详述 65 KB，超过上限 64 KB；请精简/,
  );
  assert.equal(clipBrief("短"), "短");
});

test("--brief 文件或 -：读成内容带来源；空、超限、终端上的 - 都报错", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-brief-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "b.md");
  writeFileSync(file, "# 文件详述");
  assert.deepEqual(await briefInput(file, same), {
    brief: "# 文件详述",
    brief_path: file,
  });
  assert.deepEqual(await briefInput("-", same, stdin("# 管道详述")), {
    brief: "# 管道详述",
  });
  await assert.rejects(
    briefInput("-", same, stdin("", true)),
    /--brief - 从标准输入读详述，需要用管道或重定向传入/,
  );
  await assert.rejects(
    briefInput("-", same, stdin(" \n")),
    /--brief 标准输入 是空的/,
  );
  await assert.rejects(
    briefInput("-", same, stdin("x".repeat(BRIEF_MAX_BYTES + 10))),
    /--brief: 任务详述 65 KB，超过上限 64 KB/,
  );
  writeFileSync(file, "x".repeat(BRIEF_MAX_BYTES + 1));
  await assert.rejects(briefInput(file, same), /超过上限 64 KB/);
  await assert.rejects(
    briefInput(join(dir, "none.md"), same),
    /--brief 读不到/,
  );
});

test("建任务存详述内容，改文件不影响；改详述事件只记字数；派活读库里的内容", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atrium-brief-ledger-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  ensureTaskTables(db);
  const file = join(dir, "b.md");
  writeFileSync(file, "原来的详述");
  // 只给路径（旧调用方）：建任务当下读入。
  const byPath = createTask(db, { title: "按路径", brief_path: file });
  writeFileSync(file, "改过的文件");
  assert.equal(getTask(db, byPath.ref).brief, "原来的详述");
  assert.throws(
    () => createTask(db, { title: "读不到", brief_path: join(dir, "x.md") }),
    /brief_path: 任务详述读不到/,
  );
  assert.throws(
    () => createTask(db, { title: "相对", brief_path: "b.md" }),
    /brief_path: 相对路径需要任务有仓库/,
  );
  assert.throws(
    () =>
      createTask(db, { title: "太长", brief: "x".repeat(BRIEF_MAX_BYTES + 1) }),
    /超过上限 64 KB/,
  );
  const byText = createTask(db, { title: "给内容", brief: "管道来的" });
  assert.equal(getTask(db, byText.ref).brief, "管道来的");
  assert.equal(getTask(db, byText.ref).brief_path, null);
  updateTask(db, byText.ref, { brief: "新的详述内容" });
  const edited = getTask(db, byText.ref).events.findLast(
    (e) => e.kind === "edited",
  );
  assert.match(edited!.detail!, /已更新（6 字）/);
  assert.doesNotMatch(edited!.detail!, /新的详述内容/);
  updateTask(db, byText.ref, { brief: "" });
  assert.equal(getTask(db, byText.ref).brief, null);
  // 旧任务回填没读到：只有来源路径，派活报错并给补上的命令。
  db.prepare("UPDATE tasks SET brief=NULL WHERE id=?").run(byPath.id);
  await assert.rejects(
    prepareRun(
      getTask(db, byPath.ref),
      {
        worker: { tool: "claude", profile: { rules: {} } } as never,
        risk: "low",
      },
      { data: dir, env: {} },
    ),
    (error: Error & { nextCommand?: string }) =>
      /任务详述没有进库/.test(error.message) &&
      error.nextCommand === `atrium task set ${byPath.ref} --brief 文件`,
  );
});
