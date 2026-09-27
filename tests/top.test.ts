import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ACTION_WIDTH,
  codexAction,
  firstSentence,
  recentAction,
  structuredAction,
} from "../server/tasks/action.ts";
import { commandGist } from "../server/tasks/command-gist.ts";
import { readLogTail } from "../server/tasks/log-view.ts";
import {
  advanceTask,
  addTaskNote,
  createTask,
  ensureTaskTables,
  noteTask,
} from "../server/tasks/ledger.ts";
import { enqueue, ensureQueueTable } from "../server/tasks/queue.ts";
import {
  countRows,
  RECENT_MS,
  reasonOf,
  selectRows,
  sortRows,
  topRows,
  type TopRow as LedgerRow,
} from "../server/tasks/top.ts";
import type { TaskEventRow } from "../server/tasks/ledger-model.ts";
import {
  renderTop,
  watch,
  WORKER_MIN_WIDTH,
  type Snapshot,
  type Terminal,
  type TopRow,
} from "../cli/top.ts";
import { Problem } from "../server/problem.ts";
import type { Client } from "../cli/service.ts";
import { width } from "../cli/format.ts";
import { commands, help } from "../cli/main.ts";
import { guide } from "../cli/guide.ts";
import { startApp } from "./task-fixture.ts";

/**
 * atrium top（#262）：最近动作的解析、看板的列宽与筛选规则。
 * 夹具是真执行者的日志片段，见 tests/fixtures/top/README.md。
 */

const FIXTURES = join(import.meta.dirname, "fixtures", "top");
const sample = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const lines = (name: string) => sample(name).split("\n").filter(Boolean);

test("最近动作 · codex：助手说的话优先，没有才概括 exec 与 apply patch", () => {
  // 末段是 exec，但前面有 codex 段说「先查看文件」：取那句话的首句。
  assert.deepEqual(
    recentAction({ tool: "codex", tail: sample("codex-tools.txt") }),
    {
      kind: "step",
      text: "我先查看文件内容，再把 line1 改为 first",
    },
  );
  // 中文长句：首句切在第一个句号，去掉行内代码记号，按 40 个汉字截断带省略号。
  const said = recentAction({ tool: "codex", tail: sample("codex-said.txt") })!;
  assert.equal(said.kind, "step");
  assert.match(said.text, /^已找到直接线索：t59 日志的最终 result 使用的是/);
  assert.ok(said.text.endsWith("…"));
  assert.ok(width(said.text) <= ACTION_WIDTH, `宽度 ${width(said.text)}`);
  assert.ok(!said.text.includes("我正在核对"), "只取首句");
  assert.deepEqual(
    recentAction({ tool: "codex", tail: sample("codex-final.txt") }),
    {
      kind: "step",
      text: "已将 edit.txt 中的 line1 改为 first，line2 保持不变",
    },
  );
  // 没有 codex 段：跨行的 heredoc 命令只给「跑 node 脚本」，不露脚本内容。
  assert.deepEqual(
    recentAction({ tool: "codex", tail: sample("codex-heredoc.txt") }),
    { kind: "tool", text: "跑 node 脚本" },
  );
  // 长管道 rg … | cut … | tail：只看第一段。
  assert.deepEqual(
    recentAction({ tool: "codex", tail: sample("codex-pipeline.txt") }),
    { kind: "tool", text: "搜代码" },
  );
  // 改文件只写文件名。
  assert.deepEqual(
    recentAction({ tool: "codex", tail: sample("codex-patch.txt") }),
    { kind: "tool", text: "改 edit.txt" },
  );
});

test("最近动作 · claude：文本块优先，工具调用概括成人话（跳过 user 的工具结果）", () => {
  // heredoc：python3 - <<'EOF' … 只给命令名。
  assert.deepEqual(
    recentAction({ tool: "claude", tail: sample("claude-heredoc.jsonl") }),
    { kind: "tool", text: "跑 python3 脚本" },
  );
  // 长管道：mkdir && for …; do …; done; ls; cat > harness.ts <<'EOF' → 建目录让位给写文件。
  assert.deepEqual(
    recentAction({ tool: "claude", tail: sample("claude-pipeline.jsonl") }),
    { kind: "tool", text: "写 harness.ts" },
  );
  // 中文说明在前、工具调用与工具结果在后：取那句话。
  const said = recentAction({
    tool: "claude",
    tail: sample("claude-said.jsonl"),
  })!;
  assert.equal(said.kind, "step");
  assert.match(
    said.text,
    /^全景的读取、context 截断、一次性登录和写入这几块服务端模块已写好/,
  );
  assert.ok(said.text.endsWith("…") && width(said.text) <= ACTION_WIDTH);
  const stream = lines("claude-stream.jsonl");
  assert.deepEqual(recentAction({ tool: "claude", tail: stream[0]! }), {
    kind: "tool",
    text: "看 CI",
  });
  assert.deepEqual(
    recentAction({ tool: "claude", tail: stream.slice(0, 2).join("\n") }),
    { kind: "tool", text: "看 CI" },
  );
  const english = recentAction({ tool: "claude", tail: stream.join("\n") })!;
  assert.equal(english.kind, "step");
  assert.match(english.text, /^I found and fixed the root cause/);
  assert.equal(recentAction({ tool: "claude", tail: "不是 JSON" }), undefined);
});

test("最近动作 · opencode：文本事件优先，heredoc 与 gh 命令概括", () => {
  assert.deepEqual(
    recentAction({ tool: "opencode", tail: sample("opencode-said.jsonl") }),
    { kind: "step", text: "已有一次提交并推送到 origin/task-t29-1" },
  );
  const heredoc = lines("opencode-heredoc.jsonl");
  const each = heredoc.map((line) =>
    recentAction({ tool: "opencode", tail: line }),
  );
  assert.deepEqual(each, [
    // mkdir -p … && cat > …/openquota <<'EOF'
    { kind: "tool", text: "写 openquota" },
    // gh pr create … --body "$(cat <<'EOF' … EOF)"
    { kind: "tool", text: "开 PR" },
    // cd … && python3 - <<'PY'
    { kind: "tool", text: "跑 python3 脚本" },
  ]);
  assert.deepEqual(
    recentAction({ tool: "opencode", tail: sample("opencode-tools.jsonl") }),
    { kind: "tool", text: "读 .gitconfig" },
  );
  assert.deepEqual(
    recentAction({ tool: "opencode", tail: sample("opencode-text.jsonl") }),
    { kind: "step", text: "完成" },
  );
  assert.deepEqual(
    structuredAction(
      '{"type":"tool_use","part":{"tool":"edit","state":{"input":{"filePath":"/w/server/x.ts"}}}}',
    ),
    { kind: "tool", text: "改 x.ts" },
  );
  // 不认识的工具不猜，照名字显示。
  assert.deepEqual(
    structuredAction(
      '{"type":"tool_use","part":{"tool":"whatever","state":{"input":{}}}}',
    ),
    { kind: "tool", text: "whatever" },
  );
  assert.deepEqual(
    structuredAction(
      '{"type":"tool_use","part":{"tool":"todowrite","state":{"input":{}}}}',
    ),
    { kind: "tool", text: "列待办" },
  );
});

test("最近动作 · 命令的人话：常见命令映射，其余只给命令名", () => {
  const cases: [string, string][] = [
    ["npm run check", "跑完整检查"],
    ["npm run check 2>&1 | tail -50", "跑完整检查"],
    ["cd /w && NODE_OPTIONS=--x npm test", "跑测试"],
    ["npm run format:check", "查格式"],
    ["npx prettier --write server/a.ts", "排版"],
    ["npx tsc --noEmit", "类型检查"],
    ["git push -u origin task-t69-top", "推送"],
    [
      "git add -A && git commit -q -F - <<'EOF'\n标题\n\n正文 | 不是管道; 也不是分隔\nEOF",
      "暂存改动",
    ],
    ["git commit -m 'a; b | c'", "提交"],
    ["git -C /w status --short", "看改动"],
    [
      "gh pr create -R a/b --title 'x' --body \"$(cat <<'EOF'\nRefs #1\nEOF\n)\"",
      "开 PR",
    ],
    ["sleep 60; gh pr checks 278 -R a/b --watch", "看 CI"],
    ["gh -R a/b issue view 322", "看 issue"],
    ["gh run view 1 --log-failed | tail", "看 CI"],
    ["rg -n 'a|b' server | head", "搜代码"],
    ["sed -n '1,80p' server/tasks/action.ts", "读 action.ts"],
    ["cat /Users/x/.gitconfig 2>/dev/null; echo ---", "读 .gitconfig"],
    [
      "python3 - <<'EOF'\np='README.md'\nopen(p).read()\nEOF",
      "跑 python3 脚本",
    ],
    ["node -e 'console.log(1)'", "跑 node 脚本"],
    ["node --test tests/a.test.ts", "跑测试"],
    [
      "ATRIUM_PORT=4399 ATRIUM_DATA=/w/.atrium node bin/atrium.mjs top --once",
      "跑 atrium top",
    ],
    ["timeout 30 cargo test --all", "跑 cargo"],
    ["mkdir -p /tmp/x && for i in 1 2; do mkdir -p /tmp/x/$i; done", "建目录"],
    ["for i in 1 2; do tail -c 10 /a/$i/log > /tmp/$i/log; done", "复制文件"],
    ["echo hi", "跑 echo"],
    ["sleep 60", "等待"],
    ["", "跑命令"],
  ];
  for (const [command, expected] of cases)
    assert.equal(commandGist(command), expected, command);
});

test("最近动作 · 首句与宽度：去 Markdown 记号、切在句末、中英混排按显示宽度截断", () => {
  assert.equal(firstSentence("正在补单测。接着跑检查。"), "正在补单测");
  assert.equal(
    firstSentence("## 进度\n\n- **正在**改 `action.ts`：加首句解析"),
    "进度",
  );
  assert.equal(
    firstSentence("```\ncode\n```\n看 [PR #1](https://x/1) 的评论！"),
    "看 PR #1 的评论",
  );
  assert.equal(firstSentence("Bump v0.1.59. Then push."), "Bump v0.1.59");
  assert.equal(firstSentence("\n  \n"), undefined);
  const long = `正在${"补".repeat(60)}单测`;
  const step = structuredAction(
    JSON.stringify({ type: "text", part: { text: long } }),
  )!;
  // 汉字占两格：39 个字加省略号正好不超 40 个字宽。
  assert.equal(width(step.text), ACTION_WIDTH - 1);
  assert.ok(step.text.endsWith("…"));
  const mixed = structuredAction(
    JSON.stringify({
      type: "text",
      part: {
        text: `改 server/tasks/action.ts 里的首句解析，顺带${"整理".repeat(20)}`,
      },
    }),
  )!;
  assert.ok(width(mixed.text) <= ACTION_WIDTH && mixed.text.endsWith("…"));
  assert.ok(mixed.text.length > 40, "英文按半格算，能多放几个字");
});

test("最近动作 · 没样本的工具不猜：grok、kimi 与未知执行者都交回空", () => {
  const codexLog = sample("codex-tools.txt");
  assert.equal(recentAction({ tool: "grok", tail: codexLog }), undefined);
  assert.equal(recentAction({ tool: "kimi", tail: codexLog }), undefined);
  assert.equal(recentAction({ tool: undefined, tail: codexLog }), undefined);
  // codex 的分段纯文本不能拿去当结构化日志解析，反之亦然。
  assert.equal(codexAction(sample("opencode-tools.jsonl")), undefined);
  assert.equal(structuredAction(codexLog), undefined);
});

test("日志尾部：固定字节数有界，开头切在半个字符上不乱码", async () => {
  const dir = join(
    process.env.TMPDIR ?? "/tmp",
    `atrium-top-tail-${process.pid}`,
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "log");
  const body = `${"中".repeat(200)}\n尾巴一行\n`;
  writeFileSync(file, body);
  const short = await readLogTail(file, 10);
  assert.ok(!short.text.includes("�"), "不能有半个字符");
  assert.ok(body.endsWith(short.text), "尾部要对得上");
  assert.equal(short.size, Buffer.byteLength(body));
  const full = await readLogTail(file);
  assert.equal(full.text, body);
  assert.ok(full.at > 0, "带日志最后写入时刻");
  const missing = await readLogTail(join(dir, "nope"));
  assert.equal(missing.text, "");
  assert.equal(missing.at, 0);
});

// ---- 看板 ----

const NOW = new Date(2026, 8, 27, 8, 42, 0).getTime();
const minute = 60_000;
const row = (over: Partial<TopRow>): TopRow => ({
  ref: "t1",
  title: "标题",
  status: "running",
  worker: "codex+gpt-6-sol",
  started_at: NOW - 41 * minute,
  ended_at: null,
  queued_at: null,
  reason: null,
  updated_at: NOW,
  note: null,
  note_by: null,
  note_at: null,
  processing: false,
  log_at: NOW - 12_000,
  action: { text: "写 server/org/write.ts", kind: "tool" },
  ...over,
});
const snapshot = (rows: TopRow[], over: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW,
  recent_ms: RECENT_MS,
  subscriber: "secretary",
  counts: {
    running: 0,
    queued: 0,
    blocked: 0,
    processing: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    events: 1,
    ...(over.counts ?? {}),
  },
  rows,
  truncated: false,
  ...over,
});

test("看板：四种状态一行四样，时长与最近动作按内容对齐", () => {
  const frame = renderTop(
    snapshot(
      [
        row({ ref: "t22" }),
        row({
          ref: "t23",
          title: "识别思考耗尽单次输出并换执行者重跑",
          worker: "claude+opus",
          action: { text: "跑 npm run check", kind: "tool" },
          log_at: NOW - 3000,
          started_at: NOW - 18 * minute,
        }),
        row({
          ref: "t24",
          status: "todo",
          queued_at: NOW - 60_000,
          worker: "opencode+mimo",
          reason: "opencode 同一时刻只跑一个",
          action: null,
          log_at: 0,
          started_at: null,
        }),
        row({
          ref: "t19",
          title: "任务交付物类型",
          status: "blocked",
          reason: "CI 未运行",
          worker: "codex+gpt-6-sol",
          action: null,
          log_at: NOW - minute,
        }),
      ],
      {
        counts: {
          running: 2,
          queued: 1,
          blocked: 1,
          processing: 0,
          done: 0,
          failed: 0,
          cancelled: 0,
          events: 1,
        },
      },
    ),
    { width: 100, now: NOW, footer: true, color: false },
  );
  const lines = frame.split("\n");
  assert.match(
    lines[0]!,
    /^Atrium · 在跑 2 · 排队 1 · 处理中 0 · 卡住 1 · 未处理事件 1 {2,}08:42 刷新$/,
  );
  assert.match(
    lines[1]!,
    /^● t22 {2}标题 {24,}codex\+gpt-6-sol {2}41m {2}写 server\/org\/write\.ts · 12s 前$/,
  );
  assert.match(lines[2]!, /跑 npm run check · 3s 前$/);
  assert.match(
    lines[3]!,
    /^◌ t24 {2}标题 +opencode\+mimo {2,}排队（opencode 同一时刻只跑一个）$/,
  );
  assert.match(
    lines[4]!,
    /^✕ t19 {2}任务交付物类型 +codex\+gpt-6-sol {2}卡住：CI 未运行$/,
  );
  assert.equal(lines[5], "动作：atrium task show t22");
  for (const line of lines)
    assert.ok(width(line) <= 100, `超宽：${width(line)}｜${line}`);
});

test("看板：卡住后补备注显示处理中，备注列在任务行下并受终端宽度约束", () => {
  const frame = renderTop(
    snapshot([
      row({
        status: "blocked",
        reason: "等 CI",
        processing: true,
        note: "fork 浸泡测试在跑",
        note_by: "a2",
        note_at: NOW,
      }),
    ]),
    { width: 80, now: NOW, footer: false, color: false },
  );
  const lines = frame.split("\n");
  assert.match(lines[1]!, /^● t1.*处理中：等 CI/);
  assert.match(lines[2]!, /^  备注（a2.*fork 浸泡测试在跑/);
  assert.ok(lines.every((line) => width(line) <= 80));
});

test("看板：窄终端省掉执行者列，再窄就截标题与最近动作", () => {
  const rows = [
    row({ ref: "t22" }),
    row({
      ref: "t23",
      title: "识别思考耗尽单次输出并换执行者重跑",
      worker: "claude+opus",
      action: { text: "跑 npm run check", kind: "tool" },
    }),
  ];
  const narrow = renderTop(snapshot(rows), {
    width: 60,
    now: NOW,
    footer: false,
    color: false,
  });
  const lines = narrow.split("\n");
  assert.ok(!narrow.includes("codex+gpt-6-sol"), "60 列不给执行者列");
  assert.ok(!narrow.includes("claude+opus"));
  assert.match(
    lines[1]!,
    /^● t22 {2}标题 {2,}41m {2}写 server\/org\/write\.…$/,
  );
  // 标题最多占 55%，剩下的留给最近动作；不够就截断，不许顶出屏幕。
  assert.ok(
    width(lines[1]!) <= 60 && lines[1]!.endsWith("…"),
    `窄屏要截断：${lines[1]}`,
  );
  for (const line of lines)
    assert.ok(width(line) <= 60, `超宽：${width(line)}｜${line}`);
  const tiny = renderTop(snapshot(rows), {
    width: 40,
    now: NOW,
    footer: false,
    color: false,
  });
  for (const line of tiny.split("\n"))
    assert.ok(width(line) <= 40, `超宽：${width(line)}｜${line}`);
  assert.match(tiny, /…/);
  // 恰好 80 列给执行者列。
  assert.ok(
    renderTop(snapshot(rows), {
      width: WORKER_MIN_WIDTH,
      now: NOW,
      footer: false,
      color: false,
    }).includes("codex+gpt-6-sol"),
  );
});

test("看板：刚结束的淡化、没日志的说法、空视图与截断提示", () => {
  const done = renderTop(
    snapshot([
      row({
        ref: "t5",
        status: "done",
        started_at: NOW - 30 * minute,
        ended_at: NOW - 2 * minute,
        action: null,
        log_at: NOW - 2 * minute,
      }),
    ]),
    { width: 90, now: NOW, footer: false, color: true },
  );
  assert.match(done.split("\n")[1]!, /^\x1b\[2m✓ t5/);
  assert.ok(done.includes(RESET_TAIL));
  const failed = renderTop(
    snapshot([
      row({
        ref: "t5",
        status: "failed",
        started_at: NOW - 30 * minute,
        ended_at: NOW - minute,
        action: { text: "跑 npm run check", kind: "tool" },
        log_at: NOW - minute,
      }),
    ]),
    { width: 90, now: NOW, footer: false, color: true },
  );
  assert.match(failed.split("\n")[1]!, /^\x1b\[2m✕ t5/);
  const empty = renderTop(snapshot([]), {
    width: 80,
    now: NOW,
    footer: true,
    color: false,
  });
  assert.equal(empty.split("\n").at(-2), "现在没有在跑、排队或受阻的任务");
  assert.equal(empty.split("\n").at(-1), "动作：atrium task add 标题");
  const cut = renderTop(snapshot([row({})], { truncated: true }), {
    width: 80,
    now: NOW,
    footer: false,
    color: false,
  });
  assert.match(cut, /（任务过多，只显示前 1 个）/);
});
const RESET_TAIL = "\x1b[0m";

test("看板：时长与距今多久的写法", () => {
  const text = (over: Partial<TopRow>) =>
    renderTop(snapshot([row(over)]), {
      width: 100,
      now: NOW,
      footer: false,
      color: false,
    });
  assert.match(text({ started_at: NOW - 45_000 }), / 45s {2}/);
  assert.match(text({ started_at: NOW - 41 * minute }), / 41m {2}/);
  assert.match(text({ started_at: NOW - 65 * minute }), / 1h5m {2}/);
  assert.match(text({ started_at: NOW - 120 * minute }), / 2h {2}/);
  assert.match(text({ log_at: NOW - 3000 }), /· 3s 前/);
  assert.match(text({ log_at: NOW - 25 * minute }), /· 25m 前/);
  assert.match(text({ log_at: NOW }), /· 0s 前/);
  // 结束后的时长按跑过的时间算，不是距今多久。
  assert.match(
    text({
      status: "done",
      started_at: NOW - 30 * minute,
      ended_at: NOW - 10 * minute,
    }),
    / 20m /,
  );
  assert.match(text({ started_at: null }), / — /);
});

// ---- 筛选规则 ----

function empty() {
  const db = new DatabaseSync(":memory:");
  ensureTaskTables(db);
  ensureQueueTable(db);
  return db;
}

test("筛选：只看在跑、受阻、排队与十分钟内结束的，不列历史", () => {
  const db = empty();
  const add = (title: string) => createTask(db, { title }).id;
  const running = add("在跑");
  const blocked = add("受阻");
  const queued = add("排队");
  const justDone = add("刚结束");
  const longDone = add("早结束");
  const todo = add("待办");
  advanceTask(
    db,
    running,
    { kind: "start" },
    { worker: "codex" },
    undefined,
    NOW,
  );
  advanceTask(db, blocked, { kind: "block" }, {}, { reason: "CI 未运行" }, NOW);
  enqueue(db, {
    task_id: queued,
    tool: "opencode",
    worker: "opencode+mimo",
    risk: "low",
    queued_at: NOW - 30_000,
  });
  noteTask(db, queued, "queued", { reason: "opencode 同一时刻只跑一个" }, NOW);
  advanceTask(
    db,
    justDone,
    { kind: "start" },
    { worker: "codex" },
    undefined,
    NOW - 9 * minute,
  );
  advanceTask(db, justDone, { kind: "exit_ok" }, {}, undefined, NOW - 60_000);
  advanceTask(
    db,
    longDone,
    { kind: "start" },
    { worker: "codex" },
    undefined,
    NOW - 60 * minute,
  );
  advanceTask(
    db,
    longDone,
    { kind: "exit_ok" },
    {},
    undefined,
    NOW - 11 * minute,
  );

  const { rows, truncated } = topRows(db, NOW);
  assert.equal(truncated, false);
  assert.deepEqual(
    rows.map((item) => item.ref),
    ["t1", "t3", "t2", "t4"],
    "在跑 → 排队 → 受阻 → 刚结束",
  );
  assert.equal(
    rows.find((item) => item.ref === "t2")?.reason,
    "CI 未运行",
    "受阻原因取 block 事件",
  );
  assert.equal(rows.find((item) => item.ref === "t2")?.processing, false);
  addTaskNote(db, "t2", { text: "有人接手", by: "a2" }, NOW);
  const noted = topRows(db, NOW).rows;
  assert.equal(noted.find((item) => item.ref === "t2")?.processing, true);
  assert.equal(noted.find((item) => item.ref === "t2")?.note, "有人接手");
  assert.equal(countRows(noted).processing, 1);
  assert.equal(countRows(noted).blocked, 0);
  assert.equal(
    rows.find((item) => item.ref === "t3")?.reason,
    "opencode 同一时刻只跑一个",
  );
  assert.equal(
    rows.find((item) => item.ref === "t3")?.worker,
    "opencode+mimo",
    "排队的执行者取自队列，账本里还没有",
  );
  assert.equal(rows.find((item) => item.ref === "t3")?.queued_at, NOW - 30_000);
  assert.ok(
    !rows.some((item) => item.ref === `t${todo}`),
    "没在途的 todo 不出现",
  );
  assert.ok(
    !rows.some((item) => item.ref === `t${longDone}`),
    "十分钟前的结束不出现",
  );
  assert.deepEqual(countRows(rows), {
    running: 1,
    queued: 1,
    blocked: 1,
    processing: 0,
    done: 1,
    failed: 0,
    cancelled: 0,
  });
  // 边界：结束时间正好等于窗口边界仍在视图里，再晚一毫秒就出窗口。
  const edge = add("边界");
  advanceTask(
    db,
    edge,
    { kind: "start" },
    { worker: "codex" },
    undefined,
    NOW - 20 * minute,
  );
  advanceTask(db, edge, { kind: "exit_ok" }, {}, undefined, NOW - RECENT_MS);
  assert.ok(
    topRows(db, NOW).rows.some((item) => item.ref === `t${edge}`),
    "结束时间正好等于窗口边界仍在视图里",
  );
  assert.ok(
    !topRows(db, NOW + 1).rows.some((item) => item.ref === `t${edge}`),
    "再晚一毫秒就出窗口",
  );
  assert.ok(selectRows(db, NOW, RECENT_MS, 1).truncated, "超过上限要报截断");
  db.close();
});

test("次序：在跑的按跑了多久、排队按入队顺序、受阻与刚结束新的在前", () => {
  // 账本侧的行没有 log_at/action，命令行的行多这两列；排序只按前九个字段。
  const item = (over: Partial<LedgerRow>): LedgerRow => ({
    ref: "t1",
    tells: null,
    title: "标题",
    status: "running",
    worker: "codex+gpt-6-sol",
    started_at: NOW - 41 * minute,
    ended_at: null,
    queued_at: null,
    reason: null,
    updated_at: NOW,
    note: null,
    note_by: null,
    note_at: null,
    processing: false,
    ...over,
  });
  const rows: LedgerRow[] = [
    item({
      ref: "t9",
      status: "done",
      ended_at: NOW - 5 * minute,
      updated_at: NOW - 5 * minute,
    }),
    item({
      ref: "t8",
      status: "done",
      ended_at: NOW - 1 * minute,
      updated_at: NOW - 1 * minute,
    }),
    item({
      ref: "t7",
      status: "blocked",
      updated_at: NOW - 2 * minute,
      reason: "卡住",
    }),
    item({
      ref: "t6",
      status: "blocked",
      updated_at: NOW - 9 * minute,
      reason: "卡住",
    }),
    item({ ref: "t5", status: "todo", queued_at: NOW - 1000 }),
    item({ ref: "t4", status: "todo", queued_at: NOW - 9000 }),
    item({ ref: "t3", started_at: NOW - 60_000 }),
    item({ ref: "t1", started_at: NOW - 30 * minute }),
  ];
  assert.deepEqual(
    sortRows(rows).map((entry) => entry.ref),
    ["t1", "t3", "t4", "t5", "t7", "t6", "t8", "t9"],
  );
  // 排队重派会把账本状态改回 todo，视图里仍按排队算。
  assert.equal(
    rows.find((entry) => entry.ref === "t5")?.queued_at === NOW - 1000,
    true,
  );
});

test("原因：detail 写坏或没有 reason 时不失败", () => {
  const events = (list: Partial<TaskEventRow>[]) => list as TaskEventRow[];
  assert.equal(
    reasonOf(
      events([{ kind: "queued", detail: '{"reason":"额度用尽"}' }]),
      "queued",
    ),
    "额度用尽",
  );
  assert.equal(
    reasonOf(events([{ kind: "queued", detail: "{坏" }]), "queued"),
    null,
  );
  assert.equal(
    reasonOf(events([{ kind: "queued", detail: '{"reason":3}' }]), "queued"),
    null,
  );
  assert.equal(
    reasonOf(events([{ kind: "queued", detail: '{"reason":"  "}' }]), "queued"),
    null,
  );
  assert.equal(reasonOf([], "queued"), null);
});

// ---- 接口与命令表 ----

test("接口 /api/tasks/top：路由不被 :id 吃掉，每行带最近动作与日志时刻", async (t) => {
  const { data, call } = await startApp(t);
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  const at = Date.now() - 41 * minute;
  createTask(db, { title: "组织树第 1 步：节点与修订历史" });
  createTask(db, { title: "识别思考耗尽单次输出并换执行者重跑" });
  createTask(db, { title: "任务交付物类型" });
  advanceTask(
    db,
    "t1",
    { kind: "start" },
    { worker: "opencode+mimo", pid: 999_999, worktree: "/w/atrium-t1" },
    undefined,
    at,
  );
  advanceTask(db, "t2", { kind: "block" }, {}, { reason: "CI 未运行" });
  enqueue(db, {
    task_id: 3,
    tool: "opencode",
    worker: "opencode+mimo",
    risk: "low",
    queued_at: Date.now() - 30_000,
  });
  noteTask(db, "t3", "queued", { reason: "opencode 同一时刻只跑一个" });
  const logs = join(data, "tasks");
  mkdirSync(join(logs, "1"), { recursive: true });
  mkdirSync(join(logs, "2"), { recursive: true });
  writeFileSync(
    join(logs, "1", "log"),
    `${sample("opencode-tools.jsonl")}\n${JSON.stringify({ type: "tool_use", part: { tool: "bash", state: { status: "completed", input: { command: "npm run check" } } } })}\n`,
  );
  writeFileSync(join(logs, "2", "log"), sample("codex-final.txt"));
  const past = new Date(Date.now() - 12_000);
  utimesSync(join(logs, "1", "log"), past, past);

  const ok = await call("GET", "/api/tasks/top");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const body = ok.body as Snapshot;
  assert.equal(body.subscriber, "secretary");
  assert.equal(body.recent_ms, RECENT_MS);
  assert.equal(body.truncated, false);
  assert.deepEqual(
    body.rows.map((item) => item.ref),
    ["t1", "t3", "t2"],
    "在跑 → 排队 → 受阻",
  );
  assert.deepEqual(
    {
      running: body.counts.running,
      queued: body.counts.queued,
      blocked: body.counts.blocked,
      processing: body.counts.processing,
      events: body.counts.events,
    },
    { running: 1, queued: 1, blocked: 1, processing: 0, events: 0 },
  );
  const running = body.rows[0]!;
  assert.equal(running.status, "running");
  assert.equal(running.worker, "opencode+mimo");
  assert.deepEqual(running.action, { text: "跑完整检查", kind: "tool" });
  assert.ok(
    Math.abs(running.log_at - past.getTime()) < 2000,
    `log_at 应是日志写入时刻：${running.log_at}`,
  );
  assert.equal(body.rows[1]!.reason, "opencode 同一时刻只跑一个");
  assert.equal(body.rows[1]!.worker, "opencode+mimo");
  assert.equal(body.rows[1]!.action, null);
  assert.equal(body.rows[2]!.reason, "CI 未运行");
  // top 不是任务短号：单独确认没被 :id 路由吃掉。
  assert.equal((await call("GET", "/api/tasks/t1")).body.ref, "t1");
  assert.match(
    (await call("GET", "/api/tasks/top?as=%E7%81%BE%E5%A1%9E")).body.subscriber,
    /秘书|.\S+/,
  );
  assert.equal(
    (await call("GET", "/api/tasks/top?as=%E4%B8%8D%20%E5%90%88%E6%B3%95"))
      .status,
    400,
  );
  // 事件数跟着收件箱走：投递一条未确认的，汇总行就该加一。
  db.prepare(
    "INSERT INTO task_inbox(subscriber,task_id,source,kind,dedupe_key,actor,detail,created_at,updated_at,ready_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "secretary",
    1,
    "runner",
    "failed",
    "k",
    null,
    "{}",
    Date.now(),
    Date.now(),
    Date.now(),
  );
  assert.equal((await call("GET", "/api/tasks/top")).body.counts.events, 1);
  assert.equal(
    (await call("GET", "/api/tasks/top?as=%E4%BB%A3%E7%90%86")).body.counts
      .events,
    0,
  );
  // 破坏输入：订阅者名带引号与 SQL 片段一律按 usage 拒，接口与其余读命令照常。
  for (const bad of [
    "a%27%20OR%201%3D1--",
    "%E4%BD%A0%27%3BDROP%20TABLE%20tasks%3B--",
    "..%2F..%2Fetc",
  ]) {
    const rejected = await call("GET", `/api/tasks/top?as=${bad}`);
    assert.equal(rejected.status, 400, bad);
    assert.match(rejected.body.error, /订阅者名只能用字母、数字/, bad);
  }
  const intact = await call("GET", "/api/tasks/top");
  assert.equal(intact.status, 200);
  assert.equal(intact.body.rows.length, 3, "破坏输入之后表还在、行数不变");
});

test("实时模式：退出按键一到就收手，终端状态一定还原", async () => {
  const frames: string[] = [];
  const calls: string[] = [];
  let quit: (() => void) | undefined;
  let drawn = 0;
  const terminal: Terminal = {
    columns: () => 80,
    color: () => false,
    enter: () => calls.push("enter"),
    leave: () => calls.push("leave"),
    frame: (text) => {
      frames.push(text);
      // 第二屏就模拟用户按 q。
      if (++drawn === 2) quit?.();
    },
    onQuit: (handler) => {
      calls.push("onQuit");
      quit = handler;
    },
    offQuit: () => {
      calls.push("offQuit");
      quit = undefined;
    },
  };
  const api = { get: async () => snapshot([row({})]) } as unknown as Client;
  assert.equal(await watch(api, undefined, 0, terminal), 0);
  assert.equal(frames.length, 2, "按键之后不再多画一屏");
  assert.match(frames[1]!, /^Atrium · 在跑 0/);
  assert.ok(
    frames[1]!.endsWith("动作：atrium task show t1"),
    "实时模式把下一步放在屏里",
  );
  assert.deepEqual(calls, ["enter", "onQuit", "offQuit", "leave"]);
  // --once 只画一屏，也不碰终端。
  const quiet: string[] = [];
  const once = await watch(
    api,
    undefined,
    0,
    {
      ...terminal,
      enter: () => calls.push("once-enter"),
      leave: () => calls.push("once-leave"),
      frame: (text) => quiet.push(text),
    },
    true,
  );
  assert.equal(once, 0);
  assert.equal(quiet.length, 1);
  assert.ok(!calls.includes("once-enter") && !calls.includes("once-leave"));
});

test("实时模式：服务暂时不可用就把原因留在屏上，不退出", async () => {
  const frames: string[] = [];
  let drawn = 0;
  let quit: (() => void) | undefined;
  const api = {
    get: async () => {
      if (++drawn === 1)
        throw new Problem(503, "服务正在重启", "service_unavailable");
      return snapshot([row({})]);
    },
  } as unknown as Client;
  await watch(
    api,
    undefined,
    0,
    {
      columns: () => 80,
      color: () => false,
      enter: () => {},
      leave: () => {},
      frame: (text) => {
        frames.push(text);
        if (frames.length === 2) quit?.();
      },
      onQuit: (handler) => {
        quit = handler;
      },
      offQuit: () => {},
    },
    false,
  );
  assert.equal(frames[0], "Atrium · 服务正在重启");
  assert.match(
    frames[1]!,
    /^Atrium · 在跑 0 · 排队 0 · 处理中 0 · 卡住 0 · 未处理事件 1/,
  );
  // 这一屏用真实时钟渲染，时长单位会随时钟走（45s / 41m / 1h3m），只断言形状不写死。
  assert.match(frames[1]!, /写 server\/org\/write\.ts · [0-9hms]+ 前/);
  assert.ok(frames[1]!.endsWith("动作：atrium task show t1"));
});

test("命令表：help、guide 与参数校验都认 top", async () => {
  assert.match(help(), /atrium top \[--once\]/);
  assert.match(guide(commands), /看谁在干什么：atrium top/);
  assert.deepEqual(commands.top?.positionals, [0, 0]);
  // 参数校验在连服务之前就该拒绝，给出可执行的修正。
  const cases: [Record<string, string>, RegExp][] = [
    [{ interval: "0" }, /--interval 应为 1～60 的整数秒/],
    [{ interval: "61" }, /--interval 应为 1～60 的整数秒/],
    [{ interval: "1.5" }, /--interval 应为 1～60 的整数秒/],
    [{ width: "10" }, /--width 应为 20～500 的整数列数/],
    [{ width: "600" }, /--width 应为 20～500 的整数列数/],
    [{ as: " " }, /--as 不能为空/],
  ];
  for (const [values, message] of cases) {
    await assert.rejects(
      commands.top!.run({ positionals: [], values, json: false }),
      (error: Error) => {
        assert.match(error.message, message);
        return true;
      },
      JSON.stringify(values),
    );
  }
});

test("看板：有 leader 时单列一段，写负责的节点、最近一次唤醒在处理什么与待处理件数", () => {
  const text = renderTop(
    snapshot([], {
      leaders: [
        {
          ref: "a1",
          name: "Atrium 负责人",
          nodes: ["o2"],
          wake: {
            at: NOW - 60_000,
            ended_at: null,
            status: "running",
            summary: "t5 failed",
            note: null,
            failures: 0,
            count: 3,
          },
          events: 2,
        },
        {
          ref: "a2",
          name: "OpenQuota 负责人",
          nodes: [],
          wake: null,
          events: 0,
        },
      ],
    }),
    { now: NOW, width: 120, color: false, footer: false },
  );
  assert.match(
    text,
    /\nleader\n {2}a1 Atrium 负责人 · 负责 o2 · .*起处理中：t5 failed · 待处理 2\n {2}a2 OpenQuota 负责人 · 负责 （无） · 还没唤醒过/,
  );
  assert.doesNotMatch(
    renderTop(snapshot([]), {
      now: NOW,
      width: 120,
      color: false,
      footer: false,
    }),
    /\nleader\n/,
  );
});
