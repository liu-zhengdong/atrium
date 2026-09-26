import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { commands, help, main } from "../cli/main.ts";
import { example, guide } from "../cli/guide.ts";
import { correction, exitCodes, failure } from "../cli/contract.ts";
import { cliErrorMessage, optionError } from "../cli/error-message.ts";
import { dataDirectory } from "../server/service-state.ts";
import { join } from "node:path";
import { when } from "../cli/format.ts";
import { Problem, closest } from "../server/problem.ts";

test("说明书从命令表与退出码表生成；示例均通过参数解析", () => {
  const text = guide(commands);
  assert.match(help(), /atrium guide/);
  assert.match(help(), /^服务\n  atrium\s+启动/m);
  assert.match(
    text,
    /atrium send a1 正文[\s\S]*atrium group 项目群 甲；atrium invite c2 乙/,
  );
  for (const [name, command] of Object.entries(commands)) {
    assert(text.includes(`atrium ${name} ${command.args}`.trimEnd()), name);
    const invocation = example(name, command);
    const tokens = invocation
      .slice(`atrium ${name}`.length)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const parsed = parseArgs({
      args: tokens,
      options: command.options ?? {},
      allowPositionals: true,
      strict: true,
    });
    assert(
      parsed.positionals.length >= command.positionals[0] &&
        parsed.positionals.length <= command.positionals[1],
      invocation,
    );
  }
  for (const [code, exit] of Object.entries(exitCodes))
    assert(text.includes(`${exit}  ${code}`));
});

test("命令组的 --help 列出该组全部子命令，条目与 atrium --help 一致", async () => {
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.join(" "));
  };
  try {
    assert.equal(await main(["task", "--help"]), 0);
    assert.equal(await main(["events", "--help"]), 0);
  } finally {
    console.log = original;
  }
  assert.equal(captured.length, 2, "两组各打一份帮助，不报不认识的命令");
  const [taskHelp, eventsHelp] = captured as [string, string];
  assert.match(taskHelp, /^用法：atrium task <子命令> …/);
  assert.match(eventsHelp, /^用法：atrium events <子命令> …/);
  const members = (group: string) =>
    Object.keys(commands).filter((name) => name.startsWith(`${group} `));
  for (const [group, text] of [
    ["task", taskHelp],
    ["events", eventsHelp],
  ] as const) {
    assert.ok(members(group).length >= 2, `${group} 组要有子命令`);
    for (const name of members(group))
      assert(text.includes(`atrium ${name} `), `${group} 组缺 ${name}`);
    // 条目就是 atrium --help 里的那一条。
    for (const line of text.split("\n"))
      if (line.startsWith("  atrium ")) assert(help().includes(line), line);
  }
  assert(!taskHelp.includes("events wait"), "task 组不混入 events 子命令");
  assert(!eventsHelp.includes("task add"), "events 组不混入 task 子命令");
  assert.match(taskHelp, /全部命令：atrium --help/);
});

test("runner drain timeout is a distinct retryable CLI result, not an internal error", () => {
  const timedOut = failure(new Problem(409, "身份未排空", "runner_busy"));
  assert.equal(timedOut.code, "runner_busy");
  assert.equal(timedOut.exit, 124);
  assert.match(guide(commands), /124  runner_busy/);
  assert.equal(
    failure(new Problem(409, "正在排空", "runner_draining")).code,
    "runner_draining",
  );
  assert.equal(
    failure(new Problem(503, "代际变化", "runner_changed")).code,
    "runner_changed",
  );
});

test("错误码与候选最多三项，短号优先", () => {
  assert.equal(new Problem(404, "不存在").code, "not_found");
  const candidates = closest("lris", [
    { ref: "c15", name: "Iris" },
    { ref: "c21", name: "Iris 验收群" },
    { ref: "c19", name: "其他" },
    { ref: "c9", name: "远方" },
  ]);
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0]?.ref, "c15");
  assert.equal(candidates[1]?.ref, "c21");
  assert.equal(
    closest("c21", [{ ref: "c21", name: "Iris 验收群" }, ...candidates])[0]
      ?.ref,
    "c21",
  );
  const agent = { ref: "a1", name: "test", secret: "must-not-leak" };
  const safe = closest("test", [agent]);
  assert.deepEqual(safe, [{ ref: "a1", name: "test" }]);
});

test("错误修正按类型给具体命令；没有修正时绝不退回 --help", () => {
  for (const code of Object.keys(exitCodes) as (keyof typeof exitCodes)[])
    assert.notEqual(correction(code), "atrium --help", code);
  assert.equal(
    failure(new Problem(404, "账号不存在", "account_not_found")).next,
    "atrium accounts",
  );
  assert.equal(failure(new Problem(404, "资源不存在")).next, null);
  assert.equal(
    failure(new Problem(404, "模型不存在", "model_not_found")).exit,
    3,
  );
  assert.equal(correction("usage"), null);
  assert.equal(failure(new Problem(401, "认证过期", "auth_required")).exit, 6);
  assert.equal(correction("auth_required"), "atrium auth rotate");
  assert.equal(correction("usage", "atrium list"), "atrium list");
  const log = join(dataDirectory(), "service.log");
  const service = failure(
    new Problem(503, `启动失败；请检查 ${log}`, "service_unavailable"),
  );
  assert.equal(service.message.split(log).length - 1, 1);
  assert.match(
    service.message,
    new RegExp(`日志：${log.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});

test("校验错误展示选项名或参数名，不显示接口字段与英文验证句", () => {
  assert.equal(
    cliErrorMessage(
      "heartbeat_seconds: Invalid input: expected number, received null",
      commands.config,
    ),
    "--heartbeat 要填秒数（5～3600 的整数）",
  );
  assert.equal(
    cliErrorMessage("body: 请输入内容或添加附件", commands.send),
    "正文不能为空；也可用 --file 添加附件",
  );
  assert.match(
    cliErrorMessage("model: 写法是 provider/id", commands.model),
    /^模型：写法是 provider\/id$/,
  );
  assert.equal(
    cliErrorMessage("mystery_code: Invalid input", commands.profile),
    "参数不符合要求",
  );
  try {
    parseArgs({ args: ["--nosuch"], options: {}, allowPositionals: true });
    assert.fail("应拒绝未知选项");
  } catch (error) {
    assert.equal(optionError(error), "不认识的选项：--nosuch");
  }
});

test("当日结束时间仅写时分", () => {
  assert.match(when(Date.now()), /^\d{2}:\d{2}$/);
});
