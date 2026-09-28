/**
 * 临时错误与独占避让的运行时接入（#262）：假 opencode 按夹具输出证书校验错误并以 1 退出，
 * 走完「同一执行者重试一次 → 再失败换执行者 → 再失败留在失败」，以及自动挑人避开正忙的 opencode。
 * PATH 只留夹具 bin 与系统目录，免得挑到本机真装的执行者。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { getTask } from "../server/tasks/ledger/ledger.ts";
import { startApp, until } from "./task-fixture.ts";
import { isolatedPath, removeFakeBin, writeFakeBin } from "./fake-bin.ts";
import { fileURLToPath } from "node:url";

const OPENCODE = "opencode+opencode-go/mimo-v2.6-flash";

const sample = fileURLToPath(
  new URL("./fixtures/transient/opencode-cert.jsonl", import.meta.url),
);

/** failures：假 opencode 连续出错几次（计数文件在夹具目录）；kimiFails：假 kimi 也报网络错。 */
function transientFixture(
  fx: { root: string; env: Record<string, string>; workers: string },
  kimiFails: boolean,
) {
  const bin = join(fx.root, "bin");
  const left = join(fx.root, "opencode-failures");
  const script = (name: string, body: string) => {
    writeFakeBin(join(bin, name), `#!/bin/sh\n${body}\n`);
  };
  // 假 opencode：计数文件里还有次数就输出证书错误并以 1 退出，否则正常完成。
  // 有 hold 文件时一直占着，直到测试写 release（最多 20 秒），不靠固定睡眠：慢机器上 2 秒不够。
  const hold = join(fx.root, "hold-opencode");
  const release = join(fx.root, "release-opencode");
  script(
    "opencode",
    `n=$(cat '${left}' 2>/dev/null || echo 0)\nif [ "$n" -gt 0 ]; then echo $((n-1)) > '${left}'; cat '${sample}'; exit 1; fi\nif [ -f '${hold}' ]; then i=0; while [ ! -f '${release}' ] && [ $i -lt 200 ]; do sleep 0.1; i=$((i+1)); done; fi\necho '{"type":"text","part":{"text":"ok"}}'`,
  );
  script(
    "kimi",
    kimiFails
      ? 'echo "Error: read ECONNRESET" >&2\nexit 1'
      : 'echo "kimi 完成"',
  );
  removeFakeBin(join(bin, "grok"));
  fx.env.PATH = isolatedPath(bin);
  writeFileSync(
    join(fx.workers, "harness", "kimi.md"),
    "---\nchecks: []\n---\n",
  );
  return {
    fail: (times: number) => writeFileSync(left, String(times)),
  };
}

async function setup(
  t: Parameters<typeof startApp>[0],
  kimiFails = false,
  pace?: Parameters<typeof startApp>[2],
) {
  let fail: (times: number) => void = () => {};
  const app = await startApp(
    t,
    (fx) => {
      fail = transientFixture(fx, kimiFails).fail;
    },
    pace,
  );
  const db = new DatabaseSync(join(app.data, "atrium.sqlite"));
  t.after(() => db.close());
  const events = (ref: string) => getTask(db, ref).events;
  const kinds = (ref: string) => events(ref).map((e) => e.kind);
  const details = (ref: string, kind: string) =>
    events(ref)
      .filter((e) => e.kind === kind)
      .map((e) => JSON.parse(e.detail!));
  const inboxKinds = () =>
    (
      db.prepare("SELECT kind FROM task_inbox ORDER BY id").all() as {
        kind: string;
      }[]
    ).map((row) => row.kind);
  return {
    ...app,
    fail,
    kinds,
    details,
    inboxKinds,
    task: (ref: string) => getTask(db, ref),
  };
}

function retryGap() {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    pace: async () => {
      // 第一次是人工 run；第二次是同一执行者重试后的换人选择。
      if (++calls === 2) await gate;
      return undefined;
    },
    release,
  };
}

test("重派选择期间 wait 不返回瞬时 failed，最终才投递失败", async (t) => {
  const gap = retryGap();
  const { call, fail, kinds, details, inboxKinds, task } = await setup(
    t,
    true,
    gap.pace,
  );
  fail(5);
  await call("POST", "/api/tasks", { title: "retry gap" });
  await call("POST", "/api/tasks/t1/run", { worker: "opencode" });
  const waiting = call("GET", "/api/tasks/t1/wait?timeout=20");
  await until(
    () =>
      task("t1").status === "failed" && details("t1", "exit_fail").length === 2,
  );
  const early = await Promise.race([
    waiting.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(early, false, "wait 在重派间隙提前返回");
  assert.equal(inboxKinds().includes("failed"), false);
  gap.release();
  const result = await waiting;
  assert.equal(result.body.task.status, "failed", JSON.stringify(kinds("t1")));
  assert.equal(details("t1", "transient_retry").length, 2);
  assert.equal(inboxKinds().filter((kind) => kind === "failed").length, 1);
});

test("服务关闭时放弃在途重派，不再访问已关闭的数据库", async (t) => {
  const gap = retryGap();
  const { app, call, fail, task, details } = await setup(t, true, gap.pace);
  fail(5);
  await call("POST", "/api/tasks", { title: "close during retry" });
  await call("POST", "/api/tasks/t1/run", { worker: "opencode" });
  await until(
    () =>
      task("t1").status === "failed" && details("t1", "exit_fail").length === 2,
  );
  await app.close();
  gap.release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(details("t1", "transient_retry").length, 1);
});

test("临时错误：同一执行者重试一次后完成，事件写明原因", async (t) => {
  const { call, fail, kinds, details } = await setup(t);
  fail(1);
  await call("POST", "/api/tasks", { title: "transient once" });
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "opencode" })).status,
    200,
  );
  const task = (await call("GET", "/api/tasks/t1/wait?timeout=20")).body.task;
  assert.equal(task.status, "done", JSON.stringify(kinds("t1")));
  const [retry] = details("t1", "transient_retry");
  assert.equal(retry.retry, "same");
  assert.equal(retry.from, retry.to);
  assert.match(
    retry.reason,
    /供应商或网络临时错误：证书校验出错；执行者退出码 1/,
  );
  assert.match(retry.evidence, /unknown certificate verification error/);
  const failed = details("t1", "exit_fail")[0];
  assert.match(failed.detail.reason, /证书校验出错/);
  assert.equal(details("t1", "start")[1].detail.retry, true);
});

test("临时错误：两次失败换执行者重派；换过去仍失败就留在失败", async (t) => {
  const { call, fail, kinds, details } = await setup(t, true);
  fail(5);
  await call("POST", "/api/tasks", { title: "transient twice" });
  await call("POST", "/api/tasks/t1/run", { worker: "opencode" });
  const task = (await call("GET", "/api/tasks/t1/wait?timeout=30")).body.task;
  assert.equal(task.status, "failed", JSON.stringify(kinds("t1")));
  const retries = details("t1", "transient_retry");
  assert.deepEqual(
    retries.map((r) => [r.retry, r.from, r.to]),
    [
      ["same", OPENCODE, OPENCODE],
      ["switch", OPENCODE, "kimi"],
    ],
  );
  assert.equal(task.worker, "kimi");
  assert.match(
    details("t1", "exit_fail").at(-1).detail.reason,
    /网络连接出错；执行者退出码 1/,
  );
  // 人工再派重新计数：再次出错时又从同一执行者重试开始。
  fail(1);
  await call("POST", "/api/tasks/t1/run", { worker: "opencode" });
  const again = (await call("GET", "/api/tasks/t1/wait?timeout=20")).body.task;
  assert.equal(again.status, "done", JSON.stringify(kinds("t1")));
  assert.equal(details("t1", "transient_retry").at(-1).retry, "same");
});

test("自动挑人：opencode 正忙时挑空闲的 kimi，不排队", async (t) => {
  const { fx, call, kinds } = await setup(t);
  writeFileSync(join(fx.root, "hold-opencode"), "");
  await call("POST", "/api/tasks", { title: "busy one" });
  await call("POST", "/api/tasks", { title: "busy two" });
  // 固定顺序里 opencode 在 kimi 前面：第一个自动挑到 opencode。
  const first = await call("POST", "/api/tasks/t1/run", {});
  assert.equal(first.body.task.worker, OPENCODE);
  const second = await call("POST", "/api/tasks/t2/run", {});
  assert.equal(second.status, 200);
  assert.equal(second.body.queued, false, JSON.stringify(kinds("t2")));
  assert.equal(second.body.task.worker, "kimi");
  writeFileSync(join(fx.root, "release-opencode"), "");
  for (const ref of ["t1", "t2"])
    assert.equal(
      (await call("GET", `/api/tasks/${ref}/wait?timeout=20`)).body.task.status,
      "done",
    );
});
