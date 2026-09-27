/**
 * 额度用尽的运行时接入（#267 2）：假 codex 输出真实额度报文、假 grok 报 429 无恢复时间，
 * 走完「受阻 → 记账号标记 → 换执行者重派一次 / 全被标记时排队 → 到点解除并重派」。
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
import { clock, listHolds } from "../server/tasks/quota-holds.ts";
import { startApp, until } from "./task-fixture.ts";

const HOUR = 3_600_000;

function quotaFixture(fx: {
  root: string;
  env: Record<string, string>;
  workers: string;
}) {
  const bin = join(fx.root, "bin");
  const flag = join(fx.root, "codex-quota");
  const script = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const sample = new URL(
    "./fixtures/quota/codex-usage-limit.txt",
    import.meta.url,
  ).pathname;
  // 假 codex：标记文件在时输出真实额度报文并以 1 退出，否则正常完成。
  script(
    "codex",
    `if [ -f '${flag}' ]; then cat '${sample}'; exit 1; fi\necho "codex ok"`,
  );
  // 假 grok：429 但没有恢复时间。
  script("grok", 'echo "Error: 429 Too Many Requests"\nexit 1');
  const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  if (!existsSync(join(bin, "git"))) symlinkSync(git, join(bin, "git"));
  fx.env.PATH = `${bin}:/usr/bin:/bin`;
  writeFileSync(
    join(fx.workers, "harness", "codex.md"),
    "---\ntrust: high\nmax_risk: high\nchecks: []\n---\n",
  );
  writeFileSync(
    join(fx.workers, "harness", "grok.md"),
    "---\ntrust: low\nmax_risk: low\nchecks: []\n---\n",
  );
  writeFileSync(
    join(fx.workers, "harness", "opencode.md"),
    "---\ntrust: low\nmax_risk: low\nchecks: []\n---\n",
  );
  writeFileSync(
    join(fx.workers, "harness", "kimi.md"),
    "---\ntrust: low\nmax_risk: low\nchecks: []\n---\n",
  );
  writeFileSync(join(flag), "");
  return { flag };
}

test("额度用尽：受阻原因与时刻、账号避让、换执行者重派一次、全被标记排队、到点解除重派", async (t) => {
  let flag = "";
  const { data, call } = await startApp(t, (fx) => {
    flag = quotaFixture(fx).flag;
  });
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  const kinds = (ref: string) => getTask(db, ref).events.map((e) => e.kind);
  const detail = (ref: string, kind: string) =>
    JSON.parse(getTask(db, ref).events.find((e) => e.kind === kind)!.detail!);

  // 1. codex 报额度用尽：受阻、记标记、换到 opencode 重派一次并完成。
  await call("POST", "/api/tasks", { title: "quota one" });
  const before = Date.now();
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "codex" })).status,
    200,
  );
  const t1 = (await call("GET", "/api/tasks/t1/wait?timeout=20")).body.task;
  assert.equal(t1.status, "done", JSON.stringify(kinds("t1")));
  assert.match(t1.worker, /^opencode\b/);
  const hold = listHolds(db).find((h) => h.provider === "codex")!;
  assert.ok(
    Math.abs(hold.until! - (before + 6826 * 60_000)) < 30_000,
    "按报文的 6826 分钟算恢复时刻",
  );
  const block = detail("t1", "block");
  assert.equal(
    block.detail.reason,
    `额度用尽：codex，预计 ${clock(hold.until!)} 恢复`,
  );
  const switched = detail("t1", "quota_switch");
  assert.match(switched.from, /^codex\b/);
  assert.match(switched.to, /^opencode\b/);
  assert.ok(
    kinds("t1").indexOf("quota_switch") < kinds("t1").lastIndexOf("start"),
  );
  assert.ok(
    !kinds("t1")
      .slice(0, kinds("t1").indexOf("quota_switch"))
      .includes("gates"),
    "额度用尽的那一轮不跑关卡",
  );
  let events = (await call("GET", "/api/events/wait?as=secretary&timeout=0"))
    .body.events;
  const outcome = events.find((e: { task: string }) => e.task === "t1");
  assert.equal(outcome.count, 2, "换执行者与完成合并在同一去重键");
  assert.equal(outcome.kind, "done");

  // 2. 到期前 codex 不再被选：不写执行者挑 opencode；写死 codex 就排队并写明等到何时。
  await call("POST", "/api/tasks", { title: "auto pick" });
  const auto = await call("POST", "/api/tasks/t2/run", {});
  assert.match(auto.body.task.worker, /^opencode\b/);
  await call("GET", "/api/tasks/t2/wait?timeout=20");
  await call("POST", "/api/tasks", { title: "pinned codex" });
  const pinned = await call("POST", "/api/tasks/t3/run", { worker: "codex" });
  assert.equal(pinned.body.queued, true);
  assert.match(
    detail("t3", "queued").reason,
    new RegExp(`codex 额度用尽，等到 ${clock(hold.until!)} 恢复后自动拉起`),
  );

  // 3. 其余账号都被标记时，grok 报 429 无恢复时间：兜底 1 小时，留在排队并写明等到何时。
  const now = Date.now();
  for (const provider of ["opencode", "kimi"])
    db.prepare(
      "INSERT INTO quota_holds(provider,until,reason,since) VALUES (?,?,?,?)",
    ).run(provider, now + HOUR, "test", now);
  await call("POST", "/api/tasks", { title: "all held" });
  await call("POST", "/api/tasks/t4/run", { worker: "grok" });
  await until(() => kinds("t4").includes("queued"));
  assert.equal(getTask(db, "t4").status, "blocked");
  assert.equal(
    detail("t4", "block").detail.reason,
    "额度用尽：grok，恢复时间未知",
  );
  const grok = listHolds(db).find((h) => h.provider === "grok")!;
  assert.ok(
    Math.abs(grok.until! - (now + HOUR)) < 30_000,
    "恢复时间未知兜底 1 小时",
  );
  assert.match(detail("t4", "queued").reason, /等到 .* 额度恢复后派给 codex/);
  events = (await call("GET", "/api/events/wait?as=secretary&timeout=0")).body
    .events;
  const queued = events.find((e: { task: string }) => e.task === "t4");
  assert.equal(queued.kind, "quota_queued");
  assert.equal(queued.detail.wait_until, hold.until);
  assert.equal(
    (await call("GET", "/api/tasks/t4/wait?timeout=0")).body.timed_out,
    true,
    "排队中的任务还没结束",
  );

  // 4. 把到期时间拨到现在：标记全部解除、发额度恢复事件、排队的 t3、t4 重新派出并完成。
  rmSync(flag);
  db.prepare("UPDATE quota_holds SET until=?").run(Date.now() - 1);
  for (const ref of ["t3", "t4"])
    assert.equal(
      (await call("GET", `/api/tasks/${ref}/wait?timeout=20`)).body.task.status,
      "done",
      ref,
    );
  assert.deepEqual(listHolds(db), []);
  assert.match(getTask(db, "t4").worker ?? "", /^codex\b/);
  events = (await call("GET", "/api/events/wait?as=secretary&timeout=0")).body
    .events;
  assert.deepEqual(
    events
      .filter((e: { kind: string }) => e.kind === "quota_restored")
      .map((e: { key: string }) => e.key)
      .sort(),
    ["quota:codex", "quota:grok", "quota:kimi", "quota:opencode"],
  );
});

test("手工解除占用后立即派发因该占用排队的任务，写解除事件；非法账号不改占用", async (t) => {
  let flag = "";
  const { data, call } = await startApp(t, (fx) => {
    flag = quotaFixture(fx).flag;
  });
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", { title: "先触发额度占用" });
  await call("POST", "/api/tasks/t1/run", { worker: "codex" });
  await call("GET", "/api/tasks/t1/wait?timeout=20");
  await call("POST", "/api/tasks", { title: "等 codex 恢复" });
  const queued = await call("POST", "/api/tasks/t2/run", { worker: "codex" });
  assert.equal(queued.body.queued, true);
  assert.equal((await call("POST", "/api/quota/Bad%20Name/clear")).status, 400);
  assert.ok(listHolds(db).some((h) => h.provider === "codex"));
  rmSync(flag);
  const cleared = await call("POST", "/api/quota/codex/clear");
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.dispatched, 1);
  assert.equal(
    (await call("GET", "/api/tasks/t2/wait?timeout=20")).body.task.status,
    "done",
  );
  assert.equal(
    listHolds(db).some((h) => h.provider === "codex"),
    false,
  );
  const events = (await call("GET", "/api/events/wait?as=secretary&timeout=5"))
    .body.events;
  assert.ok(events.some((e: { kind: string }) => e.kind === "quota_cleared"));
  assert.equal((await call("POST", "/api/quota/codex/clear")).status, 404);
});

test("高风险任务额度换人时，低 max_risk 或低 trust 的候选都不能接手", async (t) => {
  const { data, call } = await startApp(t, (fx) => {
    quotaFixture(fx);
    writeFileSync(
      join(fx.workers, "harness", "opencode.md"),
      "---\ntrust: low\nmax_risk: low\nchecks: []\n---\n",
    );
  });
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  await call("POST", "/api/tasks", { title: "高风险任务" });
  assert.equal(
    (await call("POST", "/api/tasks/t1/run", { worker: "codex", risk: "high" }))
      .status,
    200,
  );
  await until(() => getTask(db, "t1").status === "blocked");
  const task = getTask(db, "t1");
  assert.equal(
    task.events.some((e) => e.kind === "quota_switch"),
    false,
  );
  assert.ok(task.events.some((e) => e.kind === "quota_exhausted"));
  const events = (await call("GET", "/api/events/wait?as=secretary&timeout=5"))
    .body.events;
  assert.ok(
    events.some(
      (e: { kind: string; detail?: { note?: string } }) =>
        e.kind === "blocked" && /没有可换的执行者/.test(e.detail?.note ?? ""),
    ),
  );
});
