import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { commands, help } from "../cli/main.ts";
import { example, guide } from "../cli/guide.ts";
import { exitCodes } from "../cli/contract.ts";
import { Problem, closest } from "../server/problem.ts";

test("说明书从命令表与退出码表生成；示例均通过参数解析", () => {
  const text = guide(commands);
  assert.match(help(), /atrium guide/);
  for (const [name, command] of Object.entries(commands)) {
    assert(text.includes(`atrium ${name} ${command.args}`), name);
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
