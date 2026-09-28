import { test } from "node:test";
import assert from "node:assert/strict";
import { acpAdapter } from "../server/tasks/adapters/acp.ts";
import {
  agentCommand,
  parseToolSpec,
  type AcpToolSpec,
} from "../server/tasks/adapters/acp-spec.ts";
import { syncCustomTools } from "../server/tasks/adapters/custom.ts";
import {
  ADAPTERS,
  isTool,
  toolNames,
  TOOLS,
} from "../server/tasks/adapters/index.ts";
import { parseFrontmatter } from "../server/tasks/frontmatter.ts";
import { parseWorker } from "../server/tasks/profiles.ts";
import {
  profileNameProblem,
  writeProfile,
} from "../server/tasks/worker-profiles.ts";
import { profileDb } from "./profile-fixture.ts";

const rules = (front: string) => parseFrontmatter(`---\n${front}\n---\n`).data;

test("档案接入字段：写全的解析成配置，缺省 allow、不独占、额度账号是工具名", () => {
  const { spec, problems } = parseToolSpec(
    "pi",
    rules(
      'protocol: acp\ncommand: pi\nargs: [--acp, "--cwd={cwd}"]\nmodel_args: [--model, "{model}"]\nefforts: [low, high]\neffort_args: [--thinking, "{effort}"]',
    ),
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(spec, {
    name: "pi",
    command: "pi",
    args: ["--acp", "--cwd={cwd}"],
    modelArgs: ["--model", "{model}"],
    efforts: ["low", "high"],
    effortArgs: ["--thinking", "{effort}"],
    permissions: "allow",
    exclusive: false,
    quota: "pi",
  });
  const minimal = parseToolSpec(
    "opencode-acp",
    rules(
      "protocol: acp\ncommand: opencode\nargs: [acp]\npermissions: reject\nexclusive: true\nquota: opencode",
    ),
  );
  assert.deepEqual(minimal.problems, []);
  assert.equal(minimal.spec?.permissions, "reject");
  assert.equal(minimal.spec?.exclusive, true);
  assert.equal(minimal.spec?.quota, "opencode");
});

test("档案接入字段：破坏输入逐项说清", () => {
  const cases: [string, string, RegExp][] = [
    [
      "claude",
      "protocol: acp\ncommand: claude",
      /内置工具，不能写 protocol、command.*harness\/claude-acp/,
    ],
    ["pi", "command: pi", /须写 protocol: acp 与 command/],
    ["pi", "protocol: cli\ncommand: pi", /protocol 只能是 acp/],
    ["pi", "protocol: acp", /command 须是可执行文件名/],
    ["pi", 'protocol: acp\ncommand: "pi --acp"', /文件名不含空格/],
    [
      "pi",
      'protocol: acp\ncommand: "C:\\Program Files\\pi\\pi.exe"\nargs: ["{bad}"]\nexclusive: 1',
      /exclusive 只能是/,
    ],
    [
      "pi",
      "protocol: acp\ncommand: pi\nmodel_args: [--model]",
      /model_args 里须有 \{model\}/,
    ],
    [
      "pi",
      "protocol: acp\ncommand: pi\nefforts: [High]",
      /efforts 须是小写字母/,
    ],
    [
      "pi",
      'protocol: acp\ncommand: pi\neffort_args: [-e, "{effort}"]',
      /写了 effort_args 就要用 efforts/,
    ],
    [
      "pi",
      "protocol: acp\ncommand: pi\npermissions: ask",
      /permissions 只能是 allow、reject/,
    ],
    [
      "pi",
      "protocol: acp\ncommand: pi\nexclusive: yes",
      /exclusive 只能是 true 或 false/,
    ],
    ["pi", "protocol: acp\ncommand: pi\nquota: a b", /quota 须是额度账号 id/],
    [
      "pi",
      "protocol: acp\ncommand: pi\nargs: [{a: 1}]",
      /args 须是一行文字的列表/,
    ],
    ["Pi", "protocol: acp\ncommand: pi", /新工具名须是小写字母开头/],
  ];
  for (const [name, front, pattern] of cases) {
    const { spec, problems } = parseToolSpec(name, rules(front));
    assert.equal(spec, undefined, front);
    assert.match(problems.join("；"), pattern, front);
  }
  // 内置工具不写接入字段就没有问题（照旧只写规则与叮嘱）。
  assert.deepEqual(parseToolSpec("codex", rules("trust: high")), {
    problems: [],
  });
});

const spec: AcpToolSpec = {
  name: "pi",
  command: "pi",
  args: ["--mode", "acp", "--root", "{cwd}"],
  modelArgs: ["--model", "{model}"],
  efforts: ["low", "high"],
  permissions: "allow",
  exclusive: false,
  quota: "pi",
};

test("工具命令行：{cwd} 展开，有模型追加 model_args，没写 effort_args 的强度交给会话配置", () => {
  assert.deepEqual(agentCommand(spec, { cwd: "/w" }), {
    command: "pi",
    args: ["--mode", "acp", "--root", "/w"],
    viaSession: {},
  });
  assert.deepEqual(
    agentCommand(spec, { cwd: "/w", model: "glm-5", effort: "high" }),
    {
      command: "pi",
      args: ["--mode", "acp", "--root", "/w", "--model", "glm-5"],
      viaSession: { effort: "high" },
    },
  );
  const bare = { ...spec, modelArgs: undefined, effortArgs: ["-e={effort}"] };
  assert.deepEqual(
    agentCommand(bare, { cwd: "/w", model: "m", effort: "low" }),
    {
      command: "pi",
      args: ["--mode", "acp", "--root", "/w", "-e=low"],
      viaSession: { model: "m" },
    },
  );
});

test("适配器：拉起桥，工具命令在 -- 之后，stdin 读提示词，即时捎话开消息流，续上带会话 id", () => {
  const adapter = acpAdapter(spec);
  assert.equal(adapter.tool, "pi");
  assert.equal(adapter.executable, "pi");
  assert.equal(adapter.tell, "stdin");
  assert.equal(adapter.logFormat, "claude-stream");
  assert.deepEqual(adapter.efforts, ["low", "high"]);
  assert.deepEqual(adapter.defaultRules, { trust: "unknown", max_risk: "low" });
  const input = {
    promptFile: "/tmp/t/prompt.md",
    prompt: "做事",
    cwd: "/tmp/w",
  };
  const launch = adapter.build({
    ...input,
    model: "glm-5",
    effort: "high",
    live: true,
  });
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.stdin, input.promptFile);
  assert.equal(launch.input, "stream-json");
  const split = launch.args.indexOf("--");
  assert.deepEqual(launch.args.slice(split), [
    "--",
    "pi",
    "--mode",
    "acp",
    "--root",
    "/tmp/w",
    "--model",
    "glm-5",
  ]);
  const bridge = launch.args.slice(0, split);
  assert.match(bridge.join(" "), /bridge-main\.ts|acp-bridge\.js/);
  assert.deepEqual(bridge.slice(bridge.indexOf("--tool")), [
    "--tool",
    "pi",
    "--input",
    "stream-json",
    "--permissions",
    "allow",
    "--effort",
    "high",
  ]);
  const quiet = adapter.build(input);
  assert.equal(quiet.input, undefined);
  assert.ok(quiet.args.includes("text"));
  const resumed = adapter.resume!({ ...input, session: "w-1" });
  assert.deepEqual(
    resumed.args.slice(
      resumed.args.indexOf("--resume"),
      resumed.args.indexOf("--resume") + 2,
    ),
    ["--resume", "w-1"],
  );
  assert.throws(
    () => adapter.resume!({ ...input, session: "a b" }),
    /会话 id 不合法/,
  );
  assert.throws(
    () => adapter.build({ ...input, effort: "max" }),
    /思考强度只能是 low、high/,
  );
  assert.throws(
    () =>
      acpAdapter({ ...spec, efforts: undefined }).build({
        ...input,
        effort: "low",
      }),
    /不支持指定思考强度/,
  );
  assert.equal(
    adapter.sessionOf!(
      '[atrium] x\n{"type":"system","subtype":"init","session_id":"w-3","tool":"pi"}\n',
    ),
    "w-3",
  );
  assert.equal(adapter.sessionOf!('{"type":"result"}'), undefined);
});

test("登记：库里写了 protocol 的工具层档案成为工具，写坏的跳过并记日志，删掉的注销；内置不动", () => {
  const db = profileDb();
  const write = (name: string, source: string) =>
    writeProfile(db, {
      layer: "harness",
      name,
      source,
      author: "u1",
      reason: "t",
    });
  write(
    "fakeacp",
    "---\nprotocol: acp\ncommand: node\nmodel: fake-small\n---\n",
  );
  write("broken", "---\nprotocol: acp\n---\n");
  write("codex", "---\ntrust: high\n---\n");
  const logs: string[] = [];
  try {
    assert.deepEqual(
      syncCustomTools(db, (line) => logs.push(line)),
      ["fakeacp"],
    );
    assert.match(logs.join("\n"), /harness\/broken 没登记：command 须是/);
    assert.ok(isTool("fakeacp"));
    assert.ok(!isTool("broken"));
    assert.deepEqual(toolNames(), [...TOOLS, "fakeacp"]);
    assert.deepEqual(parseWorker("fakeacp+fake-large:high"), {
      tool: "fakeacp",
      model: "fake-large",
      effort: "high",
    });
    assert.equal(ADAPTERS.codex.tool, "codex");
    db.prepare("DELETE FROM worker_profiles WHERE name='fakeacp'").run();
    assert.deepEqual(
      syncCustomTools(db, () => {}),
      [],
    );
    assert.ok(!isTool("fakeacp"));
    assert.throws(() => parseWorker("fakeacp"), /未知的执行者工具：fakeacp/);
    assert.equal(Object.keys(ADAPTERS).length, TOOLS.length);
  } finally {
    syncCustomTools(profileDb(), () => {});
  }
});

test("档案名：工具层可以是内置工具或新工具名，新工具名不含 + 与 :", () => {
  assert.equal(profileNameProblem("harness", "codex"), null);
  assert.equal(profileNameProblem("harness", "pi"), null);
  assert.equal(profileNameProblem("harness", "my-tool2"), null);
  for (const bad of ["Pi", "pi+glm", "pi:high", "-pi", "..", "a".repeat(41)])
    assert.match(
      String(profileNameProblem("harness", bad)),
      /工具层档案名/,
      bad,
    );
});
