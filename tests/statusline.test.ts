import assert from "node:assert/strict";
import { test } from "node:test";
import {
  renderStatusline,
  TASK_LINES,
  workerLabel,
  type StatuslineInput,
} from "../cli/statusline.ts";
import type { TopRow } from "../cli/top.ts";
import { HOLDER_WIDTH, type Holder } from "../server/tasks/holder.ts";
import { width } from "../server/text-width.ts";

const now = 10 * 60 * 60_000;
const row = (ref: string, holder: Holder | null, extra: Partial<TopRow> = {}) =>
  ({
    ref,
    title: `任务${ref}`,
    status: "running",
    worker: "claude+opus:high",
    started_at: now - 12 * 60_000,
    ended_at: null,
    queued_at: null,
    reason: null,
    updated_at: now,
    note: null,
    note_by: null,
    note_at: null,
    processing: false,
    log_at: 0,
    action: null,
    holder,
    ...extra,
  }) as TopRow & { holder: Holder | null };
const snapshot = (
  rows: ReturnType<typeof row>[],
  extra: Partial<StatuslineInput["snapshot"]> = {},
): StatuslineInput["snapshot"] => ({
  now,
  recent_ms: 0,
  subscriber: "secretary",
  counts: {
    running: 0,
    queued: 0,
    blocked: 0,
    processing: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    events: 0,
  },
  rows,
  truncated: false,
  ...extra,
});
const render = (input: Partial<StatuslineInput>) =>
  renderStatusline({
    snapshot: snapshot([]),
    plan: null,
    now,
    color: false,
    ...input,
  });

test("执行者标签：去掉强度与模型前缀", () => {
  assert.equal(workerLabel("codex+gpt-6-sol:high"), "codex · gpt-6-sol");
  assert.equal(
    workerLabel("opencode+opencode/space-bunny-free"),
    "opencode · space-bunny-free",
  );
  assert.equal(workerLabel("claude"), "claude");
  assert.equal(workerLabel(null), "?");
});

test("状态栏：空闲；已结束的不列", () => {
  assert.equal(render({}), "Atrium 空闲");
  assert.equal(
    render({ snapshot: snapshot([row("t1", null, { status: "done" })]) }),
    "Atrium 空闲",
  );
});

test("状态栏按持球人显示：等你在最前且只有它醒目，受阻有 PR 不再叫待验收", () => {
  const out = render({
    snapshot: snapshot(
      [
        row("t92", {
          kind: "worker",
          who: "claude+opus:high",
          text: "本地检查没过 · a1 已交回执行者",
        }),
        row("t93", {
          kind: "worker",
          who: "claude+opus:high",
          text: "claude+opus:high 在做",
        }),
        row(
          "t80",
          { kind: "leader", who: "a1", text: "本地检查没过 · 等 a1 处理" },
          {
            status: "blocked",
            pr_url: "https://github.com/o/r/pull/1",
          } as never,
        ),
        row("t81", { kind: "merge", who: null, text: "排队合入" }),
        row("t82", { kind: "queue", who: null, text: "排队：额度用尽" }),
        row("t70", { kind: "user", who: "u1", text: "会审上交，等你拍板" }),
      ],
      {
        counts: { ...snapshot([]).counts, events: 3 },
        leaders: [
          {
            ref: "a1",
            name: "运行时",
            nodes: ["o5"],
            wake: {
              at: now,
              ended_at: null,
              status: "running",
              summary: "t80 受阻",
              note: null,
              failures: 0,
              count: 1,
            },
            events: 2,
          },
          { ref: "a2", name: "闲着", nodes: [], wake: null, events: 0 },
        ],
      },
    ),
    plan: {
      groups: { running: [], ready: [{}] as never, waiting: [], blocked: [] },
      next_after: null,
    },
  });
  assert.deepEqual(out.split("\n"), [
    "Atrium 在做 2 · leader 处理 1 · 合入 1 · 排队 1 · 等你 1 · 秘书未处理事件 3",
    "✱ t70 「任务t70」 等你：会审上交，等你拍板",
    "● t92 「任务t92」 claude · opus 12m · 本地检查没过 · a1 已交回执行者",
    "● t93 「任务t93」 claude · opus 12m",
    "◇ t80 「任务t80」 本地检查没过 · 等 a1 处理",
    "◆ t81 「任务t81」 排队合入",
    "◌ t82 「任务t82」 排队：额度用尽",
    "◎ a1 运行时 处理中：t80 受阻 · 待处理 2 件",
    "接下来：就绪 1 · 等待中 0",
  ]);
  assert.doesNotMatch(out, /待验收/);
  const colored = render({
    snapshot: snapshot([
      row("t70", { kind: "user", who: "u1", text: "等你拍板" }),
      row("t71", { kind: "leader", who: "a1", text: "等 a1 处理" }),
    ]),
    color: true,
  });
  // 醒目的红只给等你。
  assert.match(colored, /\x1b\[1m\x1b\[31m等你 1/);
  assert.equal(colored.split("\n")[2]!.includes("\x1b[31m"), false);
});

test("状态栏：任务多了折叠并提示 atrium top", () => {
  const rows = Array.from({ length: TASK_LINES + 3 }, (_, i) =>
    row(`t${i + 1}`, { kind: "queue", who: null, text: "排队" }),
  );
  const lines = render({ snapshot: snapshot(rows) }).split("\n");
  assert.equal(lines.length, 1 + TASK_LINES + 1);
  assert.equal(lines.at(-1), "  …还有 3 个，atrium top 看全部");
});

test("状态栏：紧急任务标「紧急」，暂停派新活时写清是哪条线", () => {
  const worker: Holder = { kind: "worker", text: "claude 在做" } as Holder;
  const queue: Holder = { kind: "queue", text: "排队：本机太忙" } as Holder;
  const host = {
    cores: 8,
    load: 18,
    busy_load: 32,
    own_cores: 6.3,
    busy_cores: 6,
    running: 3,
    max_workers: 6,
    checks: { running: 0, waiting: 0, max: 2 },
    test_concurrency: 2,
    paused: "本机太忙（Atrium 自己占了 6.3 核，超过 6），降下来后自动拉起",
    paused_by: "own" as const,
  };
  const text = render({
    snapshot: snapshot(
      [
        row("t112", worker, { title: "修全景网页", urgent: true }),
        row("t9", queue, { status: "todo" }),
      ],
      { host },
    ),
  });
  const [head, ...lines] = text.split("\n");
  assert.match(head!, /本机太忙，排队中（Atrium 自己占了 6\.3 核，超过 6）/);
  assert.match(
    lines.find((line) => line.includes("t112"))!,
    /t112 紧急 「修全景网页」/,
  );
  assert.doesNotMatch(
    lines.find((line) => line.includes("t9"))!,
    /紧急/,
  );
  const byLoad = render({
    snapshot: snapshot([row("t9", queue, { status: "todo" })], {
      host: { ...host, load: 35, own_cores: 1, paused_by: "load" },
    }),
  });
  assert.match(byLoad, /本机太忙，排队中（整机负载 35，超过 32）/);
});

test("状态栏：旧服务给的整篇原因与多行标题只出一行，按显示宽度截断", () => {
  const essay = `合入没过（审阅打回（t132，codex）：## 必须改的问题\n\n1. **性能目标没达到**：${"很长".repeat(80)}\n## 可选建议\n- 改名） · 已交回执行者`;
  const out = render({
    snapshot: snapshot([
      row(
        "t123",
        { kind: "worker", who: "claude+opus:high", text: essay },
        { title: "第一行标题\n第二行" },
      ),
    ]),
  });
  const lines = out.split("\n");
  assert.equal(lines.length, 2, out);
  assert.match(
    lines[1]!,
    /^● t123 「第一行标题」 claude · opus 12m · 合入没过/,
  );
  assert.ok(!out.includes("可选建议") && !out.includes("第二行"), out);
  const story = lines[1]!.split(" · ").slice(2).join(" · ");
  assert.ok(width(story) <= HOLDER_WIDTH + 12, story);
  assert.ok(story.endsWith("## 必须改的问题"), story);
});
