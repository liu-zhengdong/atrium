import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.ts";
import { userTokenPath } from "../server/user-auth.ts";
import {
  parseSecretNames,
  resolveSecrets,
  secretNameProblem,
  secretSection,
  secretValue,
  SECRET_VALUE_MAX,
  staleSecret,
  STALE_MS,
  TASK_SECRETS_MAX,
  withSecrets,
} from "../server/secrets/model.ts";
import { publishSecretHints } from "../server/secrets/hints.ts";
import { leaderRule, denyReason } from "../server/leaders/scope.ts";
import { eventLine } from "../server/leaders/wake.ts";
import { assignmentRefusal } from "../server/agent/plan.ts";
import type { Assignment } from "../server/hosts/protocol.ts";
import type { LeaderRunSpec } from "../server/leaders/runtime.ts";
import { workerGuard, workerReadable } from "../cli/worker-guard.ts";
import { fixture, startApp, until } from "./task-fixture.ts";

/**
 * 凭据（t194 第 3 步）：纯函数（名称、值、按节点链找、合进环境、清理线索、提示词段落、代理收指令）穷举；
 * 集成走内存服务：设值只存不显示、覆盖与恢复、任务声明与校验、归档恢复留下、leader 权限、真删、
 * 周期任务顺带发线索、旧运行时表；真派活时按名称注入执行者、提示词只写名称、值不进库与日志。
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 8, 28, 12).getTime();
const VALUE = "tg-bot-9f3c1e7a55d24b0c";

// ---- 纯函数 ----

test("凭据名称：大写环境变量名；系统变量、运行时自己设的与改变加载方式的前缀拒绝", () => {
  for (const ok of [
    "TELEGRAM_BOT_TOKEN",
    "A",
    "GH_TOKEN",
    "X1_2",
    "OPENAI_API_KEY",
  ])
    assert.equal(secretNameProblem(ok), null, ok);
  const cases: [string, RegExp][] = [
    ["", /不能为空/],
    ["telegram_token", /大写字母开头/],
    ["1TOKEN", /大写字母开头/],
    ["_TOKEN", /大写字母开头/],
    ["A-B", /大写字母开头/],
    ["A B", /大写字母开头/],
    ["A=B", /大写字母开头/],
    [`A${"B".repeat(64)}`, /64/],
    ["PATH", /本来就有/],
    ["HOME", /本来就有/],
    ["HTTPS_PROXY", /本来就有/],
    ["LC_ALL", /本来就有/],
    ["SYSTEMROOT", /本来就有/],
    ["PATHEXT", /本来就有/],
    ["NO_COLOR", /运行时自己设/],
    ["CLAUDECODE", /运行时自己设/],
    ["BASH_ENV", /运行时自己设/],
    ["ATRIUM_WORKER", /ATRIUM_\*/],
    ["ATRIUM_TASK", /ATRIUM_\*/],
    ["CLAUDE_CODE_OAUTH_TOKEN", /CLAUDE_CODE_\*/],
    ["PI_KEY", /PI_\*/],
    ["HERDR_PANE", /HERDR_\*/],
    ["NODE_OPTIONS", /NODE_\*/],
    ["GIT_SSH_COMMAND", /GIT_\*/],
    ["LD_PRELOAD", /LD_\*/],
    ["DYLD_INSERT_LIBRARIES", /DYLD_\*/],
  ];
  for (const [name, pattern] of cases)
    assert.match(secretNameProblem(name) ?? "", pattern, name);
});

test("任务的 --secret：逗号或空白分隔、去重、报参数名、有上限；空值表示不用", () => {
  assert.deepEqual(parseSecretNames(undefined), []);
  assert.deepEqual(parseSecretNames(""), []);
  assert.deepEqual(parseSecretNames(" A_TOKEN, B，A_TOKEN  C "), [
    "A_TOKEN",
    "B",
    "C",
  ]);
  assert.deepEqual(parseSecretNames(["X", "Y"]), ["X", "Y"]);
  assert.throws(() => parseSecretNames("ok,path"), /secret: .*大写字母开头/);
  assert.throws(
    () => parseSecretNames("PATH"),
    /secret: 是执行者环境.*（PATH）/,
  );
  assert.throws(() => parseSecretNames(3), /secret: 名称不能为空/);
  assert.throws(
    () =>
      parseSecretNames(
        Array.from({ length: TASK_SECRETS_MAX + 1 }, (_, i) => `S${i}`),
      ),
    new RegExp(`至多用 ${TASK_SECRETS_MAX} 个`),
  );
});

test("值：去掉结尾一个换行，空、空字符、超限、非文本拒绝；报错不带值", () => {
  assert.equal(secretValue(`${VALUE}\n`), VALUE);
  assert.equal(secretValue(`${VALUE}\r\n`), VALUE);
  assert.equal(secretValue(`a\nb\n\n`), "a\nb\n");
  assert.equal(secretValue(" 前后空格 "), " 前后空格 ");
  const bad: [unknown, RegExp][] = [
    ["", /是空的/],
    ["\n", /是空的/],
    [`${VALUE}\0x`, /空字符/],
    ["字".repeat(SECRET_VALUE_MAX), /超过 16 KB/],
    [42, /应为文本/],
    [undefined, /应为文本/],
  ];
  for (const [value, pattern] of bad) {
    let message = "";
    try {
      secretValue(value);
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, pattern);
    assert.doesNotMatch(message, new RegExp(VALUE));
  }
});

test("按节点链找：同名取最近一层，不在链上的不算，缺的按声明顺序列出", () => {
  const candidates = [
    { id: 1, node_id: 1, name: "A" },
    { id: 2, node_id: 3, name: "A" },
    { id: 3, node_id: 2, name: "B" },
    { id: 4, node_id: 9, name: "C" },
  ];
  // 链：o3 → o2 → o1。
  assert.deepEqual(
    resolveSecrets(["B", "A", "C", "D"], [3, 2, 1], candidates),
    {
      found: [
        { id: 3, node_id: 2, name: "B" },
        { id: 2, node_id: 3, name: "A" },
      ],
      missing: ["C", "D"],
    },
  );
  // 只到 o1 的链：A 取 o1 的。
  assert.deepEqual(resolveSecrets(["A"], [1], candidates).found, [
    { id: 1, node_id: 1, name: "A" },
  ]);
  assert.deepEqual(resolveSecrets([], [1], candidates), {
    found: [],
    missing: [],
  });
  assert.deepEqual(resolveSecrets(["A"], [], candidates).missing, ["A"]);
});

test("合进环境：按名称逐个放行，不改原环境；盖系统变量或运行时标记的名称直接报错，报错不带值", () => {
  const base = { PATH: "/bin", ATRIUM_WORKER: "1" };
  const env = withSecrets(base, { TELEGRAM_BOT_TOKEN: VALUE });
  assert.deepEqual(env, { ...base, TELEGRAM_BOT_TOKEN: VALUE });
  assert.deepEqual(base, { PATH: "/bin", ATRIUM_WORKER: "1" });
  assert.equal(withSecrets(base, undefined), base);
  for (const name of ["PATH", "ATRIUM_WORKER", "lower", "NODE_OPTIONS"])
    assert.throws(
      () => withSecrets(base, { [name]: VALUE }),
      (error: Error) =>
        /凭据名称不合规/.test(error.message) && !error.message.includes(VALUE),
      name,
    );
  assert.throws(() => withSecrets(base, { OK: "a\0b" }), /OK 的值无效/);
});

test("清理线索：归档与留下不提；90 天没用才提；从没用过按设值时间算，用过按最后使用算", () => {
  const base = {
    archived_at: null,
    keep_at: null,
    updated_at: NOW - 100 * DAY,
    last_used_at: null,
  };
  assert.deepEqual(staleSecret(base, NOW), { reason: "设上后 100 天没用过" });
  assert.equal(staleSecret({ ...base, archived_at: NOW - DAY }, NOW), null);
  assert.equal(staleSecret({ ...base, keep_at: NOW - DAY }, NOW), null);
  assert.equal(
    staleSecret({ ...base, updated_at: NOW - STALE_MS + 1 }, NOW),
    null,
  );
  assert.deepEqual(staleSecret({ ...base, updated_at: NOW - STALE_MS }, NOW), {
    reason: "设上后 90 天没用过",
  });
  assert.deepEqual(
    staleSecret(
      { ...base, updated_at: NOW - 200 * DAY, last_used_at: NOW - 95 * DAY },
      NOW,
    ),
    { reason: "95 天没用过" },
  );
  assert.equal(
    staleSecret(
      { ...base, updated_at: NOW - 200 * DAY, last_used_at: NOW - 10 * DAY },
      NOW,
    ),
    null,
  );
  // 用过但之后又设了新值：按新值算。
  assert.equal(
    staleSecret(
      { ...base, updated_at: NOW - 5 * DAY, last_used_at: NOW - 150 * DAY },
      NOW,
    ),
    null,
  );
});

test("提示词段落只写名称与节点；代理收指令时凭据名称与值逐个查，报错不带值", () => {
  assert.equal(secretSection([]), undefined);
  const text = secretSection([{ name: "TELEGRAM_BOT_TOKEN", node: "o4" }])!;
  assert.match(text, /`TELEGRAM_BOT_TOKEN`（挂在 o4）/);
  assert.match(text, /不要打印/);

  const data = "/agent";
  const a: Assignment = {
    task: 1,
    ref: "t1",
    run: 1,
    worker: "kimi",
    tool: "kimi",
    prompt: "做",
    dir: "/agent/tasks/1",
    cwd: "/agent/tasks/1/work",
  };
  assert.equal(assignmentRefusal(a, "linux", data), null);
  assert.equal(
    assignmentRefusal({ ...a, secrets: { TOKEN: VALUE } }, "linux", data),
    null,
  );
  for (const [secrets, pattern] of [
    [{ PATH: VALUE }, /凭据名称不合法/],
    [{ lower: VALUE }, /凭据名称不合法/],
    [{ TOKEN: "" }, /TOKEN 的值不合法/],
    [{ TOKEN: 3 }, /TOKEN 的值不合法/],
    [["x"], /凭据不合法/],
  ] as const) {
    const refusal = assignmentRefusal(
      { ...a, secrets: secrets as unknown as Record<string, string> },
      "linux",
      data,
    );
    assert.match(refusal ?? "", pattern);
    assert.doesNotMatch(refusal ?? "", new RegExp(VALUE));
  }
});

test("leader 权限表与事件行：设值、归档、恢复、留下按节点判，真删拒绝；线索事件只列名称", () => {
  assert.equal(leaderRule("PUT", "/api/secrets"), "secret");
  for (const action of ["archive", "restore", "keep"])
    assert.equal(leaderRule("POST", `/api/secrets/${action}`), "secret");
  assert.equal(leaderRule("GET", "/api/secrets"), "read");
  assert.equal(leaderRule("DELETE", "/api/secrets"), "deny");
  assert.match(denyReason("a1", "DELETE", "/api/secrets"), /真删凭据/);
  assert.equal(
    eventLine({
      id: 7,
      task: null,
      kind: "secret_stale",
      count: 1,
      detail: {
        node: "o3",
        secrets: [
          { name: "OLD_TOKEN", node: "o3", reason: "设上后 100 天没用过" },
        ],
        more: 2,
      },
    }),
    "- #7 疑似没用的凭据 o3：o3 OLD_TOKEN（设上后 100 天没用过）；另有 2 个",
  );
  // 执行者环境里 secret 命令一律拒绝（只放行 material get）。
  for (const sub of ["set", "ls", "rm"])
    assert.equal(workerReadable("secret", [sub]), false);
  assert.throws(() => workerGuard({ ATRIUM_WORKER: "1" }));
});

// ---- 集成 ----

async function open(t: { after: (fn: () => unknown) => void }) {
  // 周期任务到点会按 task run 真派发：用假执行者与临时档案，不拉起本机真实的执行者 CLI。
  // 数据目录放在夹具根下，收尾时按命令行里的夹具路径结束还没退出的假执行者（Windows 上它占着工作目录）。
  const fx = fixture(t);
  for (const name of ["kimi", "grok", "opencode"]) fx.script(name, "echo 完成");
  const data = join(fx.root, "data");
  mkdirSync(data);
  // 旧运行时留下的凭据表：不读不写，也不妨碍启动。
  const legacy = new DatabaseSync(join(data, "atrium.sqlite"));
  legacy.exec(
    "CREATE TABLE runner_credentials (id TEXT PRIMARY KEY, secret TEXT); INSERT INTO runner_credentials VALUES ('x','旧凭据');" +
      "CREATE TABLE credential_modes (runner TEXT PRIMARY KEY, mode TEXT); INSERT INTO credential_modes VALUES ('x','旧');",
  );
  legacy.close();
  let behave: (spec: LeaderRunSpec) => Promise<"ok"> = async () => "ok";
  let clock = NOW;
  const created = await createApp({
    data,
    auth: true,
    controlToken: "c".repeat(64),
    tasks: {
      env: fx.env,
      workersDir: fx.workers,
      exec: fx.run,
      pace: async () => undefined,
      usagePace: async () => undefined,
    },
    leaders: { batchMs: 0, pollMs: 20, run: async (spec) => behave(spec) },
    schedules: { tickMs: 3_600_000, now: () => clock },
  });
  t.after(() => created.app.close());
  const user = `Bearer ${readFileSync(userTokenPath(data), "utf8").trim()}`;
  const call = async (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
    authorization = user,
  ) => {
    const response = await created.app.inject({
      method,
      url,
      headers: { host: "127.0.0.1", authorization },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      status: response.statusCode,
      text: response.body,
      body: response.body ? (response.json() as Record<string, any>) : {},
    };
  };
  const ok = async (...args: Parameters<typeof call>) => {
    const result = await call(...args);
    assert(
      result.status < 300,
      `${args[0]} ${args[1]} → ${result.status} ${result.text}`,
    );
    assert.doesNotMatch(result.text, new RegExp(VALUE));
    return result.body;
  };
  for (const [parent, slug, kind, name] of [
    [undefined, "org", "org", "组织"],
    ["o1", "atrium", "project", "Atrium"],
    ["o2", "rules", "module", "组织和规矩"],
    ["o1", "quota", "project", "OpenQuota"],
  ] as const)
    await ok("POST", "/api/org/nodes", {
      ...(parent ? { parent } : {}),
      slug,
      kind,
      name,
      reason: "建",
    });
  return {
    ...created,
    data,
    call,
    ok,
    set: (next: typeof behave) => {
      behave = next;
    },
    tick: (ms: number) => {
      clock += ms;
      return clock;
    },
  };
}

/** 数据库文件（含 WAL）里有没有这个值：值只该在凭据区的文件里。 */
function dbHas(data: string, value: string) {
  return readdirSync(data)
    .filter((f) => f.startsWith("atrium.sqlite"))
    .some((f) => readFileSync(join(data, f)).includes(value));
}

test("设值只存不显示：覆盖、归档后再设即恢复；破坏输入逐条拒绝且报错不回显；值只在凭据区；旧表不动", async (t) => {
  const x = await open(t);
  const set = await x.ok("PUT", "/api/secrets", {
    node: "o2",
    name: "TELEGRAM_BOT_TOKEN",
    value: `${VALUE}\n`,
  });
  assert.equal(set.created, true);
  assert.equal(set.node, "o2");
  assert.equal(set.name, "TELEGRAM_BOT_TOKEN");
  assert.equal("value" in set, false);
  const file = join(x.data, "secrets", "1");
  assert.equal(readFileSync(file, "utf8"), VALUE);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(x.data, "secrets")).mode & 0o777, 0o700);
  }
  // 覆盖：同一节点同名。
  const again = await x.ok("PUT", "/api/secrets", {
    node: "atrium",
    name: "TELEGRAM_BOT_TOKEN",
    value: `${VALUE}-2`,
  });
  assert.equal(again.created, false);
  assert.equal(readFileSync(file, "utf8"), `${VALUE}-2`);
  const listed = await x.ok("GET", "/api/secrets");
  assert.deepEqual(
    listed.secrets.map((s: { name: string; node: string }) => [s.node, s.name]),
    [["o2", "TELEGRAM_BOT_TOKEN"]],
  );
  assert.equal(listed.secrets[0].last_used_at, null);
  assert.equal(listed.next_before, null);

  const bad: [unknown, number, RegExp][] = [
    [{ node: "o2", name: "lower", value: VALUE }, 400, /名称: .*大写字母开头/],
    [{ node: "o2", name: "PATH", value: VALUE }, 400, /是执行者环境.*（PATH）/],
    [{ node: "o2", name: "OK", value: "" }, 400, /值: 是空的/],
    [{ node: "o2", name: "OK", value: `${VALUE}\0` }, 400, /空字符/],
    [{ node: "o2", name: "OK", value: 5 }, 400, /值: 应为文本/],
    [
      { node: "o2", name: "OK", value: VALUE, extra: 1 },
      400,
      /extra: 是未知字段/,
    ],
    [{ name: "OK", value: VALUE }, 400, /节点: 要挂在哪个节点上/],
    [{ node: "../o2", name: "OK", value: VALUE }, 404, /./],
    [{ node: "o99", name: "OK", value: VALUE }, 404, /./],
    [[VALUE], 400, /请求体应为对象/],
  ];
  for (const [payload, status, pattern] of bad) {
    const result = await x.call("PUT", "/api/secrets", payload);
    assert.equal(
      result.status,
      status,
      `${JSON.stringify(payload)} → ${result.text}`,
    );
    assert.match(result.body.error ?? "", pattern);
    assert.doesNotMatch(result.text, new RegExp(VALUE));
  }
  assert.equal((await x.call("GET", "/api/secrets?limit=0")).status, 400);
  assert.equal((await x.call("GET", "/api/secrets?before=x")).status, 400);

  // 归档：不进列表（--archived 才列），再设即恢复。
  await x.ok("POST", "/api/secrets/archive", {
    node: "o2",
    name: "TELEGRAM_BOT_TOKEN",
    note: "换号了",
  });
  assert.equal((await x.ok("GET", "/api/secrets")).secrets.length, 0);
  const archived = await x.ok("GET", "/api/secrets?archived=1");
  assert.equal(archived.secrets[0].archive_note, "换号了");
  assert.equal(
    (
      await x.call("POST", "/api/secrets/archive", {
        node: "o2",
        name: "TELEGRAM_BOT_TOKEN",
      })
    ).status,
    409,
  );
  const restored = await x.ok("PUT", "/api/secrets", {
    node: "o2",
    name: "TELEGRAM_BOT_TOKEN",
    value: VALUE,
  });
  assert.equal(restored.restored, true);
  assert.equal(restored.archived, false);
  // 留下要写原因。
  assert.equal(
    (
      await x.call("POST", "/api/secrets/keep", {
        node: "o2",
        name: "TELEGRAM_BOT_TOKEN",
      })
    ).status,
    400,
  );
  const missing = await x.call("POST", "/api/secrets/keep", {
    node: "o3",
    name: "TELEGRAM_BOT_TOKEN",
    note: "x",
  });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /o3 上没有凭据 TELEGRAM_BOT_TOKEN/);

  // 值不在库里；旧运行时的表原样。
  assert.equal(dbHas(x.data, VALUE), false);
  assert.deepEqual(
    x.db
      .prepare("SELECT * FROM runner_credentials")
      .all()
      .map((r) => ({ ...r })),
    [{ id: "x", secret: "旧凭据" }],
  );

  // 真删：记录与值文件一起删。
  const removed = await x.ok("DELETE", "/api/secrets", {
    node: "o2",
    name: "TELEGRAM_BOT_TOKEN",
  });
  assert.equal(removed.name, "TELEGRAM_BOT_TOKEN");
  assert.equal(existsSync(file), false);
  assert.equal(
    (await x.ok("GET", "/api/secrets?archived=1")).secrets.length,
    0,
  );
});

test("任务声明：按归属部分往上找，找不到给设值命令；改声明记事件；归档后再声明被拒；事件与回执不带值", async (t) => {
  const x = await open(t);
  await x.ok("PUT", "/api/secrets", { node: "o2", name: "BOT", value: VALUE });
  const missing = await x.call("POST", "/api/tasks", {
    title: "发通知",
    part: "o3",
    deliver: "none",
    secret: "BOT,OTHER",
  });
  assert.equal(missing.status, 400);
  assert.match(
    missing.body.error,
    /secret: 在 o3 及上级节点上没有（或已归档）凭据 OTHER/,
  );
  assert.equal(missing.body.nextCommand, "atrium secret set o3 OTHER");
  // o4 不在 o2 下面：找不到。
  const elsewhere = await x.call("POST", "/api/tasks", {
    title: "别处",
    part: "o4",
    deliver: "none",
    secret: "BOT",
  });
  assert.equal(elsewhere.status, 400);
  const task = await x.ok("POST", "/api/tasks", {
    title: "发通知",
    part: "o3",
    deliver: "none",
    secret: "BOT",
  });
  assert.deepEqual(task.secrets, ["BOT"]);
  assert.deepEqual((await x.ok("GET", `/api/tasks/${task.ref}`)).secrets, [
    "BOT",
  ]);
  await x.ok("PUT", "/api/secrets", { node: "o3", name: "MORE", value: "m" });
  const changed = await x.ok("PATCH", `/api/tasks/${task.ref}`, {
    secret: "BOT,MORE",
  });
  assert.deepEqual(changed.secrets, ["BOT", "MORE"]);
  const shown = await x.ok("GET", `/api/tasks/${task.ref}`);
  const event = shown.events.find(
    (e: { kind: string }) => e.kind === "secrets",
  );
  assert.deepEqual(JSON.parse(event.detail), {
    from: ["BOT"],
    to: ["BOT", "MORE"],
  });
  // 清空。
  assert.equal(
    "secrets" in
      (await x.ok("PATCH", `/api/tasks/${task.ref}`, { secret: "" })),
    false,
  );
  await x.ok("POST", "/api/secrets/archive", { node: "o2", name: "BOT" });
  const archived = await x.call("PATCH", `/api/tasks/${task.ref}`, {
    secret: "BOT",
  });
  assert.equal(archived.status, 400);
  assert.match(archived.body.error, /已归档/);
  assert.equal(dbHas(x.data, VALUE), false);
});

test("leader 令牌：负责的部分里能设值、归档、留下，别处的不行；不能真删", async (t) => {
  const x = await open(t);
  await x.ok("PUT", "/api/secrets", {
    node: "o4",
    name: "QUOTA",
    value: VALUE,
  });
  await x.ok("POST", "/api/leaders", { name: "规矩负责人", worker: "codex" });
  await x.ok("PATCH", "/api/org/nodes/o3", { leader: "a1", reason: "指派" });
  await x.ok("POST", "/api/tasks", {
    title: "待处理",
    part: "o3",
    deliver: "none",
  });
  let checked = false;
  let failure: unknown;
  x.set(async (spec) => {
    if (checked || failure) return "ok";
    try {
      const token = `Bearer ${spec.env.ATRIUM_LEADER_TOKEN}`;
      const own = await x.call(
        "PUT",
        "/api/secrets",
        { node: "o3", name: "BOT", value: VALUE },
        token,
      );
      assert.equal(own.status, 200, own.text);
      assert.equal(own.body.created_by, "a1");
      assert.doesNotMatch(own.text, new RegExp(VALUE));
      const outside = await x.call(
        "PUT",
        "/api/secrets",
        { node: "o4", name: "QUOTA", value: "x" },
        token,
      );
      assert.equal(outside.status, 403);
      assert.match(outside.body.error, /不在你负责的部分里/);
      assert.equal(
        (
          await x.call(
            "POST",
            "/api/secrets/keep",
            { node: "o3", name: "BOT", note: "还要" },
            token,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await x.call(
            "POST",
            "/api/secrets/archive",
            { node: "o4", name: "QUOTA" },
            token,
          )
        ).status,
        403,
      );
      const listed = await x.call("GET", "/api/secrets", undefined, token);
      assert.equal(listed.status, 200);
      assert.doesNotMatch(listed.text, new RegExp(VALUE));
      const rm = await x.call(
        "DELETE",
        "/api/secrets",
        { node: "o3", name: "BOT" },
        token,
      );
      assert.equal(rm.status, 403);
      assert.match(rm.body.error, /真删凭据/);
      checked = true;
    } catch (error) {
      failure = error;
    }
    return "ok";
  });
  const { publishTask } = await import("../server/tasks/notice.ts");
  publishTask(x.taskRunner.inbox, x.db, 1, "failed", { reason: "测试没过" });
  await until(() => checked || failure !== undefined, 20000);
  if (failure) throw failure;
  // 值是 o4 原来的，没被 leader 改掉。
  assert.equal(readFileSync(join(x.data, "secrets", "1"), "utf8"), VALUE);
});

test("清理线索：周期任务到点时把 90 天没用过的凭据投给这一块的负责人，隔 30 天再提，留下后不提；事件里没有值", async (t) => {
  const x = await open(t);
  await x.ok("PUT", "/api/secrets", { node: "o3", name: "OLD", value: VALUE });
  await x.ok("PUT", "/api/secrets", { node: "o3", name: "FRESH", value: "f" });
  x.db
    .prepare(
      "UPDATE node_secrets SET updated_at=?,created_at=? WHERE name='OLD'",
    )
    .run(NOW - 100 * DAY, NOW - 100 * DAY);
  x.db
    .prepare("UPDATE node_secrets SET updated_at=? WHERE name='FRESH'")
    .run(NOW - DAY);
  const events = () =>
    x.db
      .prepare(
        "SELECT subscriber,kind,detail FROM task_inbox WHERE kind='secret_stale' ORDER BY id",
      )
      .all() as { subscriber: string; kind: string; detail: string }[];
  const schedule = await x.ok("POST", "/api/schedules", {
    node: "o3",
    title: "例行巡检",
    every: "1d",
    // 指定夹具里的假执行者：不指定会挑到本机 PATH 上真实的执行者 CLI。
    worker: "kimi",
  });
  const round = await x.ok("POST", `/api/schedules/${schedule.ref}/run`, {});
  // 派出的任务收完尾再结束用例：假执行者还占着工作目录时 Windows 上删不掉临时目录。
  const waited = await x.ok(
    "GET",
    `/api/tasks/${round.task.ref}/wait?timeout=20`,
  );
  assert.equal(waited.timed_out, false);
  assert.equal(waited.task.worker, "kimi");
  const list = events();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.subscriber, "secretary");
  assert.doesNotMatch(list[0]!.detail, new RegExp(VALUE));
  const detail = JSON.parse(list[0]!.detail);
  assert.equal(detail.node, "o3");
  assert.deepEqual(detail.secrets, [
    { name: "OLD", node: "o3", reason: "设上后 100 天没用过" },
  ]);
  // ls 也带线索。
  const listed = await x.ok("GET", "/api/secrets?node=o3");
  assert.deepEqual(
    listed.secrets.map((s: { name: string; stale: string | null }) => [
      s.name,
      s.stale !== null,
    ]),
    [
      ["FRESH", false],
      ["OLD", true],
    ],
  );
  const inbox = x.taskRunner.inbox;
  assert.deepEqual(publishSecretHints(x.db, inbox, 3, NOW + DAY), { stale: 0 });
  assert.equal(publishSecretHints(x.db, inbox, 3, NOW + 31 * DAY).stale, 1);
  await x.ok("POST", "/api/secrets/keep", {
    node: "o3",
    name: "OLD",
    note: "年底续费要用",
  });
  assert.equal(publishSecretHints(x.db, inbox, 3, NOW + 62 * DAY).stale, 0);
  // 上一层的节点另有范围：o4 下没有凭据。
  assert.equal(publishSecretHints(x.db, inbox, 4, NOW + 62 * DAY).stale, 0);
});

test("派活：声明的凭据按名称注入执行者（本机拉起），提示词只写名称，值不进库、日志与事件；归档后派不出去", async (t) => {
  const { fx, data, call, app } = await startApp(t);
  const inject = async (
    method: "PUT" | "POST" | "DELETE",
    url: string,
    payload: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: { host: "127.0.0.1" },
      payload,
    });
    assert(response.statusCode < 300, response.body);
    return response.json();
  };
  for (const [parent, slug, kind, name] of [
    [undefined, "org", "org", "组织"],
    ["o1", "atrium", "project", "Atrium"],
  ] as const)
    await call("POST", "/api/org/nodes", {
      ...(parent ? { parent } : {}),
      slug,
      kind,
      name,
      reason: "建",
    });
  await inject("PUT", "/api/secrets", {
    node: "o1",
    name: "TELEGRAM_BOT_TOKEN",
    value: VALUE,
  });
  const created = await call("POST", "/api/tasks", {
    title: "Add done file",
    repo: fx.repo,
    part: "o2",
    secret: "TELEGRAM_BOT_TOKEN",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const started = await call("POST", "/api/tasks/t1/run", { worker: "kimi" });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  await call("GET", "/api/tasks/t1/wait?timeout=20");
  const seen = readFileSync(join(fx.root, "env-seen.txt"), "utf8");
  assert.ok(seen.split("\n").includes(`TELEGRAM_BOT_TOKEN=${VALUE}`));
  assert.match(seen, /^ATRIUM_WORKER=1$/m);
  const prompt = readFileSync(join(data, "tasks", "1", "prompt.md"), "utf8");
  assert.match(prompt, /## 可用的凭据[\s\S]*`TELEGRAM_BOT_TOKEN`（挂在 o1）/);
  assert.doesNotMatch(prompt, new RegExp(VALUE));
  const log = await call("GET", "/api/tasks/t1/log?after=0");
  assert.doesNotMatch(log.body.text, new RegExp(VALUE));
  const task = (await call("GET", "/api/tasks/t1")).body;
  assert.doesNotMatch(JSON.stringify(task), new RegExp(VALUE));
  const injected = task.events.find(
    (e: { kind: string }) => e.kind === "secrets_injected",
  );
  assert.deepEqual(JSON.parse(injected.detail), {
    names: ["TELEGRAM_BOT_TOKEN"],
  });
  const listed = (await call("GET", "/api/secrets")).body.secrets;
  assert.equal(listed[0].last_used_task, "t1");
  assert.notEqual(listed[0].last_used_at, null);
  assert.equal(dbHas(data, VALUE), false);

  // 归档后：同一声明派不出去，任务留在待办，报错给恢复或设值的命令。
  await inject("POST", "/api/secrets/archive", {
    node: "o1",
    name: "TELEGRAM_BOT_TOKEN",
  });
  await call("POST", "/api/tasks", {
    title: "Second",
    repo: fx.repo,
    part: "o2",
  });
  const db = new DatabaseSync(join(data, "atrium.sqlite"));
  t.after(() => db.close());
  db.prepare(
    "INSERT INTO task_secrets(task_id,name,pos) VALUES (2,'TELEGRAM_BOT_TOKEN',0)",
  ).run();
  const refused = await call("POST", "/api/tasks/t2/run", { worker: "kimi" });
  assert.equal(refused.status, 409);
  assert.match(
    refused.body.error,
    /t2 要用的凭据 TELEGRAM_BOT_TOKEN 在 o2 及上级节点上都没有（或已归档）/,
  );
  assert.equal((await call("GET", "/api/tasks/t2")).body.status, "todo");
});
