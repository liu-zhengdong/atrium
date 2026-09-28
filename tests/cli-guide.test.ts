import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { commands, help, main } from "../cli/main.ts";
import { example, groups, guide, hiddenGroups } from "../cli/guide.ts";
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
    /atrium task add 目标[\s\S]*atrium org tree[\s\S]*atrium events wait --as secretary/,
  );
  assert.match(
    text,
    /每类东西放哪[^\n]*→ 技能[^\n]*的要点[^\n]*→ 执行者档案[^\n]*判断顺序/,
  );
  // 新能力的做法（t236）：先试点再铺开、上线即验、PR 写组合说明。
  assert.match(
    text,
    /先试点再铺开[^\n]*task note tN 试点结果[^\n]*端到端验证[^\n]*碰到哪些已有能力/,
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

test("atrium --help 的分组取自 guide 的 groups：非隐藏组都列出，隐藏组不列", () => {
  const text = help();
  const lines = text.split("\n");
  const entryLine = (name: string) =>
    `  atrium ${name} ${commands[name]!.args}  ${commands[name]!.about}`;
  for (const [group, members] of Object.entries(groups)) {
    const listed = members.filter((name) => name in commands);
    if (hiddenGroups.has(group)) {
      assert(!lines.includes(group), `隐藏组 ${group} 不该出现`);
      for (const name of listed)
        assert(!text.includes(`  atrium ${name} `), `隐藏组命令 ${name}`);
      continue;
    }
    assert(lines.includes(group), `缺组 ${group}`);
    if (group === "服务") continue;
    for (const name of listed)
      assert(text.includes(entryLine(name)), `${group} 组缺 ${name}`);
  }
  assert.match(text, /^技能\n  atrium skill /m);
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
  assert.match(eventsHelp, /^用法：atrium events \[--as 订阅者\]/);
  assert.match(eventsHelp, /atrium events <子命令> …/);
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

test("全景组的 --help 先讲裸命令：atrium map 打开网页，并列出 --depth / --no-open / --json", async () => {
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => captured.push(args.join(" "));
  try {
    assert.equal(await main(["map", "--help"]), 0);
  } finally {
    console.log = original;
  }
  assert.equal(captured.length, 1);
  const text = captured[0]!;
  assert.match(
    text,
    /^用法：atrium map \[节点\] \[--depth N\] \[--no-open\] \[--json\]/,
  );
  assert.match(text, /atrium map <子命令> …/);
  assert.match(text, /打开本机网页/);
  assert.match(text, /--depth/);
  assert.match(text, /--no-open/);
  assert.match(text, /--json/);
  for (const name of ["map", "map context", "map edit", "map add"])
    assert(text.includes(`atrium ${name} `), `全景组缺 ${name}`);
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
  assert.equal(failure(new Problem(404, "资源不存在")).next, null);
  assert.equal(failure(new Problem(404, "任务不存在", "not_found")).exit, 3);
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
      "brief_path: Invalid input: expected string, received null",
      commands["task add"],
    ),
    "--brief不符合要求",
  );
  assert.equal(
    cliErrorMessage("title: 标题不能为空", commands["task add"]),
    "标题：标题不能为空",
  );
  assert.equal(
    cliErrorMessage("role: 岗位不存在", commands["task add"]),
    "--role：岗位不存在",
  );
  assert.equal(
    cliErrorMessage("mystery_code: Invalid input", commands["task add"]),
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

test("时间按本地时区显示：UTC 12:07 在 Asia/Shanghai 为 20:07", () => {
  const original = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    const rendered = when(Date.UTC(2026, 8, 27, 12, 7));
    assert.match(rendered, /20:07/);
    assert.doesNotMatch(rendered, /12:07/);
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
