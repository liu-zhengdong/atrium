import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { bridgeEntryArgs } from "../server/acp/bridge-entry.ts";
import { userLine } from "../server/tasks/live-input.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * ACP 执行者的契约测试（#418）：经真实的桥进程驱动一个 ACP 工具，查运行时依赖的那几条：
 * 建会话写 init（带会话 id）、一轮结束写 result、捎话排到本轮之后并回显、权限按档案答复、续上会话、出错时非 0 退出。
 *
 * 缺省驱动假执行者（tests/fixtures/fake-acp-worker.mjs）。接入新工具前照着跑一遍「基本」用例：
 *   ATRIUM_ACP_CONTRACT='["opencode","acp"]' npm test -- tests/acp-contract.test.ts
 * 给了 ATRIUM_ACP_CONTRACT 时只跑不依赖假执行者行为的用例（会用真实模型、花真实额度）；
 * 再给 ATRIUM_ACP_CONTRACT_MODEL=<模型 id> 时经 ACP 会话配置选这个模型（验档案不写 model_args 行不行）。
 */

const FAKE = join(import.meta.dirname, "fixtures", "fake-acp-worker.mjs");
const REAL = process.env.ATRIUM_ACP_CONTRACT
  ? (JSON.parse(process.env.ATRIUM_ACP_CONTRACT) as string[])
  : undefined;
const AGENT = REAL ?? [process.execPath, FAKE];
const MODEL = REAL ? process.env.ATRIUM_ACP_CONTRACT_MODEL : undefined;
const fakeOnly = { skip: REAL ? "只对假执行者" : false };

type Event = Record<string, unknown>;
type Run = {
  code: number | null;
  events: Event[];
  stderr: string;
};

/**
 * 拉起桥：messages 依次写进标准输入（stream-json 用户消息）；after 是「看到哪类事件后再写这条」。
 * 见到 result 且消息都写完了就关标准输入（与运行时 live-input.ts 一样）。
 */
function runBridge(
  t: { after: (fn: () => void) => void },
  options: {
    messages: { text: string; uuid?: string; after?: (e: Event) => boolean }[];
    args?: string[];
    agent?: string[];
    env?: NodeJS.ProcessEnv;
    input?: "text" | "stream-json";
    limitMs?: number;
  },
): Promise<Run & { cwd: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "atrium-acp-"));
  t.after(() => removeTemp(cwd));
  const [command, ...agentArgs] = options.agent ?? AGENT;
  const input = options.input ?? "stream-json";
  const child = spawn(
    process.execPath,
    [
      ...bridgeEntryArgs(),
      "--tool",
      "fake",
      "--input",
      input,
      ...(options.args ?? []),
      "--",
      command!,
      ...agentArgs,
    ],
    {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const events: Event[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const pending = [...options.messages];
  const send = () => {
    while (pending.length && !pending[0]!.after) {
      const next = pending.shift()!;
      if (input === "text") child.stdin.write(next.text);
      else child.stdin.write(userLine(next.text, next.uuid));
    }
    if (input === "text" && !pending.length) child.stdin.end();
  };
  send();
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event: Event;
    try {
      event = JSON.parse(line) as Event;
    } catch {
      return;
    }
    events.push(event);
    const head = pending[0];
    if (head?.after?.(event)) {
      delete head.after;
      send();
    }
    if (event.type === "result" && !pending.length) child.stdin.end();
  });
  child.stdin.on("error", () => {});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `桥 ${options.limitMs ?? 20_000} 毫秒没退出；事件：${JSON.stringify(events).slice(0, 2000)}；stderr：${stderr.slice(-1000)}`,
        ),
      );
    }, options.limitMs ?? 20_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, events, stderr, cwd });
    });
  });
}

const results = (events: Event[]) =>
  events.filter((event) => event.type === "result");
const kinds = (events: Event[]) =>
  events.map((event) =>
    event.type === "assistant"
      ? `assistant:${(event.message as { content: { type: string }[] }).content[0]!.type}`
      : event.type === "system"
        ? `system:${String(event.subtype)}`
        : event.type === "user"
          ? event.isReplay
            ? "echo"
            : "tool_result"
          : String(event.type),
  );

test("基本：建会话写 init，一轮结束写 result（end_turn），退出码 0", async (t) => {
  const run = await runBridge(t, {
    messages: [{ text: "只回复 OK 两个字母，不要调用任何工具。" }],
    args: MODEL ? ["--model", MODEL] : [],
    limitMs: REAL ? 180_000 : 20_000,
  });
  assert.equal(run.code, 0, run.stderr.slice(-1000));
  const init = run.events.find((event) => event.subtype === "init");
  assert.ok(init, "有 init 事件");
  assert.equal(typeof init.session_id, "string");
  assert.ok((init.session_id as string).length > 0);
  const [result] = results(run.events);
  assert.equal(result?.is_error, false);
  assert.equal(result?.stop_reason, "end_turn");
  assert.ok(String(result?.result).trim(), "result 带本轮最后的回复");
});

test(
  "日志：思考、工具调用、工具结果、回复依次写出，入参带命令",
  fakeOnly,
  async (t) => {
    const run = await runBridge(t, {
      messages: [{ text: "做事 WRITE:done.txt" }],
    });
    assert.equal(run.code, 0);
    assert.deepEqual(kinds(run.events), [
      "system:init",
      "assistant:thinking",
      "assistant:tool_use",
      "tool_result",
      "assistant:text",
      "result",
    ]);
    const use = run.events[2]!.message as {
      content: { name: string; input: Record<string, unknown> }[];
    };
    assert.equal(use.content[0]!.name, "bash");
    assert.equal(use.content[0]!.input.command, "ls -la");
    assert.equal(use.content[0]!.input.description, "看看目录");
    assert.match(String(results(run.events)[0]!.result), /^收到：做事/);
    assert.ok(
      existsSync(join(run.cwd, "done.txt")),
      "工具在桥的工作目录里干活",
    );
  },
);

test(
  "捎话：运行中写入的消息排到本轮之后，送进去时回显，全部送完才写一次 result",
  fakeOnly,
  async (t) => {
    const run = await runBridge(t, {
      messages: [
        { text: "慢慢做 SLOW" },
        {
          text: "改用 v2",
          uuid: "tell-1",
          after: (event) => event.type === "assistant",
        },
      ],
    });
    assert.equal(run.code, 0, run.stderr);
    const order = kinds(run.events);
    assert.equal(order.filter((kind) => kind === "result").length, 1);
    assert.ok(order.indexOf("echo") > order.indexOf("assistant:tool_use"));
    assert.equal(order.at(-1), "result");
    const echo = run.events.find((event) => event.isReplay === true)!;
    assert.equal(echo.uuid, "tell-1");
    assert.match(String(results(run.events)[0]!.result), /^收到：改用 v2/);
  },
);

test(
  "权限：allow 选允许一次，reject 选拒绝一次，都记进日志",
  fakeOnly,
  async (t) => {
    for (const [policy, option] of [
      ["allow", "yes"],
      ["reject", "no"],
    ] as const) {
      const run = await runBridge(t, {
        messages: [{ text: "PERM 清理" }],
        args: ["--permissions", policy],
      });
      assert.equal(run.code, 0);
      const note = run.events.find((event) => event.subtype === "permission")!;
      assert.equal(note.outcome, option);
      assert.equal(note.title, "rm -rf build");
      const text = run.events
        .filter((event) => event.type === "assistant")
        .map((event) => JSON.stringify(event))
        .join("");
      assert.match(text, new RegExp(`权限：${option}`));
    }
  },
);

test(
  "选模型与思考强度：经会话配置设；工具不报配置时说清并非 0 退出",
  fakeOnly,
  async (t) => {
    const run = await runBridge(t, {
      messages: [{ text: "看模型" }],
      args: ["--model", "fake-large", "--effort", "high"],
    });
    assert.equal(run.code, 0, run.stderr);
    assert.match(
      String(results(run.events)[0]!.result),
      /模型 fake-large，强度 high/,
    );
    const unknown = await runBridge(t, {
      messages: [{ text: "看模型" }],
      args: ["--model", "gpt-9"],
    });
    assert.equal(unknown.code, 1);
    assert.match(
      String(results(unknown.events)[0]!.result),
      /可选模型里没有 gpt-9；可选：fake-small、fake-large/,
    );
    const bare = await runBridge(t, {
      messages: [{ text: "看模型" }],
      args: ["--model", "fake-large"],
      env: { ATRIUM_FAKE_ACP_BARE: "1" },
    });
    assert.equal(bare.code, 1);
    assert.match(String(results(bare.events)[0]!.result), /model_args/);
  },
);

test(
  "续上会话：按会话 id session/load，回放的历史不进日志",
  fakeOnly,
  async (t) => {
    const run = await runBridge(t, {
      messages: [{ text: "接着做" }],
      args: ["--resume", "w-7"],
      input: "text",
    });
    assert.equal(run.code, 0, run.stderr);
    const init = run.events.find((event) => event.subtype === "init")!;
    assert.equal(init.session_id, "w-7");
    assert.doesNotMatch(JSON.stringify(run.events), /历史回放/);
    const gone = await runBridge(t, {
      messages: [{ text: "接着做" }],
      args: ["--resume", "x-1"],
      input: "text",
    });
    assert.equal(gone.code, 1);
    assert.match(String(results(gone.events)[0]!.result), /no such session/);
  },
);

test(
  "出错：拒绝、请求出错、工具中途退出都写 is_error 的 result 并非 0 退出",
  fakeOnly,
  async (t) => {
    for (const [text, pattern] of [
      ["REFUSE", /本轮以 refusal 结束/],
      ["FAIL", /ACP 请求出错：上游 502 Bad Gateway/],
      ["DIE", /ACP 请求出错：.*已退出（退出码 3）/],
    ] as const) {
      const run = await runBridge(t, { messages: [{ text }] });
      assert.equal(run.code, 1, text);
      const [result] = results(run.events);
      assert.equal(result?.is_error, true, text);
      assert.match(String(result?.result), pattern);
    }
  },
);

test("工具起不来：写 is_error 的 result，非 0 退出", fakeOnly, async (t) => {
  const run = await runBridge(t, {
    messages: [{ text: "hi" }],
    agent: [join(tmpdir(), "atrium-no-such-acp-tool")],
  });
  assert.equal(run.code, 1);
  assert.match(String(results(run.events)[0]!.result), /ACP 会话没建起来/);
});
