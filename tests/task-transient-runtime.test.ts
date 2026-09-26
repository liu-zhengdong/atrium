/**
 * 临时错误与独占避让的运行时接入（#262）：假 opencode 按夹具输出证书校验错误并以 1 退出，
 * 走完「同一执行者重试一次 → 再失败换执行者 → 再失败留在失败」，以及自动挑人避开正忙的 opencode。
 * PATH 只留夹具 bin 与系统目录，免得挑到本机真装的执行者。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { getTask } from "../server/tasks/ledger.ts";
import { startApp } from "./task-fixture.ts";

const OPENCODE = "opencode+opencode-go/mimo-v2.6-flash";

const sample = new URL(
  "./fixtures/transient/opencode-cert.jsonl",
  import.meta.url,
).pathname;

/** failures：假 opencode 连续出错几次（计数文件在夹具目录）；kimiFails：假 kimi 也报网络错。 */
function transientFixture(
  fx: { root: string; env: Record<string, string>; workers: string },
  kimiFails: boolean,
) {
  const bin = join(fx.root, "bin");
  const left = join(fx.root, "opencode-failures");
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // 假 opencode：计数文件里还有次数就输出证书错误并以 1 退出，否则正常完成。
  script(
    "opencode",
    `n=$(cat '${left}' 2>/dev/null || echo 0)\nif [ "$n" -gt 0 ]; then echo $((n-1)) > '${left}'; cat '${sample}'; exit 1; fi\n[ -f "$PWD/../hold-opencode" ] && sleep 2\necho '{"type":"text","part":{"text":"ok"}}'`,
  );
  script(
    "kimi",
    kimiFails
      ? 'echo "Error: read ECONNRESET" >&2\nexit 1'
      : 'echo "kimi 完成"',
  );
  rmSync(join(bin, "grok"), { force: true });
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  if (!existsSync(join(bin, "git"))) symlinkSync(git, join(bin, "git"));
  fx.env.PATH = `${bin}:/usr/bin:/bin`;
  writeFileSync(
    join(fx.workers, "harness", "kimi.md"),
    "---\nchecks: []\n---\n",
  );
  return {
    fail: (times: number) => writeFileSync(left, String(times)),
  };
}

async function setup(t: Parameters<typeof startApp>[0], kimiFails = false) {
  let fail: (times: number) => void = () => {};
  const app = await startApp(t, (fx) => {
    fail = transientFixture(fx, kimiFails).fail;
  });
  const db = new DatabaseSync(join(app.data, "atrium.sqlite"));
  t.after(() => db.close());
  const events = (ref: string) => getTask(db, ref).events;
  const kinds = (ref: string) => events(ref).map((e) => e.kind);
  const details = (ref: string, kind: string) =>
    events(ref)
      .filter((e) => e.kind === kind)
      .map((e) => JSON.parse(e.detail!));
  return { ...app, fail, kinds, details };
}

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
  for (const ref of ["t1", "t2"])
    assert.equal(
      (await call("GET", `/api/tasks/${ref}/wait?timeout=20`)).body.task.status,
      "done",
    );
});
