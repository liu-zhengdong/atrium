import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { commandRefusal } from "../server/agent/plan.ts";
import {
  addHost,
  ensureHostTables,
  ensureLocalHost,
} from "../server/hosts/model.ts";
import type { AgentCommand } from "../server/hosts/protocol.ts";
import type { HostInfo } from "../server/hosts/state.ts";
import { RemoteHosts } from "../server/hosts/remote.ts";
import type { Exec } from "../server/tasks/git.ts";
import {
  createTask,
  ensureTaskTables,
  getTask,
} from "../server/tasks/ledger.ts";
import {
  killLine,
  LEFTOVER_LIMIT,
  LEFTOVER_MS,
  leftoverMatch,
  leftoverTargets,
  runsTool,
  shiftTargets,
  targetsRefusal,
  workerTool,
  type LeftoverKill,
  type LeftoverRow,
  type LeftoverTarget,
} from "../server/tasks/leftovers.ts";
import { cleanHost, reapLeftovers } from "../server/tasks/leftovers-reap.ts";

/**
 * host clean 清残留执行者进程（t217）：哪些算残留（纯函数穷举）、本机与代理共用的核对结束（假进程读数）、
 * 远程经假主机连接（服务这一侧的长轮询与回执，不连真实主机）、回执逐条列出并记进任务事件。
 * 不读本机真实进程与环境。
 */

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const HOUR = 60 * 60_000;

const row = (over: Partial<LeftoverRow> = {}): LeftoverRow => ({
  id: 1,
  pid: 4312,
  worker: "claude+opus:high",
  status: "done",
  created_at: NOW - 3 * HOUR,
  ended_at: NOW - HOUR,
  updated_at: NOW - HOUR,
  ...over,
});

const target = (over: Partial<LeftoverTarget> = {}): LeftoverTarget => ({
  task: 1,
  pid: 4312,
  tool: "claude",
  created: NOW - 3 * HOUR,
  ended: NOW - HOUR,
  ...over,
});

test("执行者里的工具：取 + 或 : 前的一段，不认识的为 null", () => {
  assert.equal(workerTool("claude+opus:high"), "claude");
  assert.equal(workerTool("codex"), "codex");
  assert.equal(workerTool("cursor:high"), "cursor");
  assert.equal(workerTool("vim+x"), null);
  assert.equal(workerTool(""), null);
  assert.equal(workerTool(null), null);
});

test("哪些要核对：不在跑、服务手上没有、pid 合法、工具认识、一天内结束或停下的；最多 limit 个", () => {
  const empty = new Set<number>();
  const only = (r: LeftoverRow, active = empty) =>
    leftoverTargets([r], { now: NOW, active });
  assert.deepEqual(only(row()), [target()]);
  // 各种已不在跑的状态都算（停下的、排队重派的、卡住的也可能留着旧进程）。
  for (const status of ["done", "failed", "cancelled", "blocked", "todo"])
    assert.equal(only(row({ status })).length, 1, status);
  assert.deepEqual(only(row({ status: "running" })), [], "在跑的不动");
  assert.deepEqual(only(row(), new Set([1])), [], "服务手上还管着的不动");
  for (const pid of [null, 0, 1, -5, 1.5])
    assert.deepEqual(only(row({ pid })), [], `pid ${pid}`);
  for (const worker of [null, "", "vim", "bash+x"])
    assert.deepEqual(only(row({ worker })), [], `worker ${worker}`);
  // 没结束时刻（停下、卡住）按最后更新算。
  assert.deepEqual(
    only(
      row({ status: "blocked", ended_at: null, updated_at: NOW - 2 * HOUR }),
    ),
    [target({ ended: NOW - 2 * HOUR })],
  );
  // 一天为界：正好一天还算，再早不算。
  const early = NOW - 2 * LEFTOVER_MS;
  assert.equal(
    only(row({ created_at: early, ended_at: NOW - LEFTOVER_MS })).length,
    1,
  );
  assert.deepEqual(
    only(row({ created_at: early, ended_at: NOW - LEFTOVER_MS - 1 })),
    [],
  );
  // 坏记录：结束早于建立。
  assert.deepEqual(only(row({ ended_at: NOW - 4 * HOUR })), []);
  // 上限：按给的顺序（最后更新倒序）取前 limit 个。
  const many = Array.from({ length: 5 }, (_, i) => row({ id: i + 1 }));
  assert.deepEqual(
    leftoverTargets(many, { now: NOW, active: empty, limit: 2 }).map(
      (t) => t.task,
    ),
    [1, 2],
  );
  assert.equal(
    leftoverTargets(
      Array.from({ length: LEFTOVER_LIMIT + 10 }, (_, i) => row({ id: i + 1 })),
      { now: NOW, active: empty },
    ).length,
    LEFTOVER_LIMIT,
  );
});

test("命令行是不是那个工具：路径的一段或独立一词；嵌在别的词里不算；Windows 不分大小写", () => {
  const yes: [string, string, string][] = [
    ["linux", "/usr/local/bin/claude -p hi", "claude"],
    ["darwin", "claude", "claude"],
    [
      "darwin",
      "node /opt/lib/node_modules/@anthropic-ai/claude-code/cli.js -p",
      "claude",
    ],
    [
      "linux",
      "node /usr/lib/node_modules/@openai/codex/bin/codex.js exec",
      "codex",
    ],
    ["linux", '"/home/u/.local/bin/cursor-agent" -p', "cursor-agent"],
    [
      "win32",
      '"C:\\Program Files\\nodejs\\node.exe" C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      "claude",
    ],
    ["win32", "C:\\Users\\u\\AppData\\Roaming\\npm\\CODEX.cmd exec", "codex"],
    ["linux", "/usr/bin/python3 /home/u/.local/bin/kimi --print", "kimi"],
  ];
  for (const [platform, command, executable] of yes)
    assert.equal(
      runsTool(platform as NodeJS.Platform, command, executable),
      true,
      command,
    );
  const no: [string, string, string][] = [
    ["linux", "/usr/bin/myclaude -p", "claude"],
    ["linux", "/usr/bin/claudette", "claude"],
    ["linux", "vim notes-about-codex.txt", "codex"],
    ["linux", "/usr/bin/Claude", "claude"],
    ["darwin", "grep kimi", "codex"],
    ["linux", "", "claude"],
    ["linux", "claude", ""],
    // cursor 的可执行文件是 cursor-agent：只写 cursor 的不算。
    ["linux", "/Applications/Cursor.app/Contents/MacOS/Cursor", "cursor-agent"],
  ];
  for (const [platform, command, executable] of no)
    assert.equal(
      runsTool(platform as NodeJS.Platform, command, executable),
      false,
      command,
    );
  // 正则元字符按字面。
  assert.equal(runsTool("linux", "/bin/a+b", "a+b"), true);
  assert.equal(runsTool("linux", "/bin/aab", "a+b"), false);
});

test("认不认：进程在、启动时刻看得懂且落在任务建立与结束之间（留容差）、命令行是那个工具", () => {
  const t = target();
  const probe = (start: number | null, command = "/usr/bin/claude -p") => ({
    start,
    command,
  });
  assert.equal(leftoverMatch([t], probe(NOW - 2 * HOUR), "linux"), t);
  assert.equal(leftoverMatch([t], null, "linux"), null, "进程已不在");
  assert.equal(
    leftoverMatch([t], probe(null), "linux"),
    null,
    "时刻看不懂不认",
  );
  assert.equal(
    leftoverMatch([t], probe(NOW - 2 * HOUR, "/usr/bin/vim"), "linux"),
    null,
    "命令行不是这个工具",
  );
  // 用户在任务结束后自己开的同名工具，pid 碰巧复用：启动晚，不认。
  assert.equal(leftoverMatch([t], probe(NOW - 30 * 60_000), "linux"), null);
  // 任务建立之前就在的进程：不认。
  assert.equal(leftoverMatch([t], probe(NOW - 4 * HOUR), "linux"), null);
  // 边界：容差内算。
  assert.equal(leftoverMatch([t], probe(t.ended + 5_000), "linux"), t);
  assert.equal(leftoverMatch([t], probe(t.ended + 5_001), "linux"), null);
  assert.equal(leftoverMatch([t], probe(t.created - 5_000), "linux"), t);
  assert.equal(leftoverMatch([t], probe(t.created - 5_001), "linux"), null);
  // 同一个 pid 被两件任务先后用过：按启动时刻认是哪件。
  const older = target({
    task: 7,
    tool: "codex",
    created: NOW - 10 * HOUR,
    ended: NOW - 8 * HOUR,
  });
  assert.equal(
    leftoverMatch(
      [t, older],
      probe(NOW - 9 * HOUR, "node /x/codex.js"),
      "linux",
    ),
    older,
  );
  assert.equal(
    leftoverMatch(
      [t, older],
      probe(NOW - 9 * HOUR, "/usr/bin/claude"),
      "linux",
    ),
    null,
    "时刻对上的那件工具对不上",
  );
});

test("远程时钟：按下发时刻平移任务时刻；派来的清单逐条校验", () => {
  assert.deepEqual(shiftTargets([target()], 90_000), [
    target({ created: NOW - 3 * HOUR + 90_000, ended: NOW - HOUR + 90_000 }),
  ]);
  assert.deepEqual(shiftTargets([], 5), []);
  assert.equal(targetsRefusal([target()]), null);
  assert.equal(targetsRefusal([]), null);
  assert.equal(targetsRefusal("x"), "清理清单应为数组");
  assert.match(
    targetsRefusal(Array.from({ length: LEFTOVER_LIMIT + 1 }, () => target()))!,
    /最多/,
  );
  const bad: [unknown, RegExp][] = [
    [null, /条目不合法/],
    [target({ task: 0 }), /任务号/],
    [target({ pid: 1 }), /进程号/],
    [target({ pid: 2.5 }), /进程号/],
    [{ ...target(), tool: "vim" }, /不认识的执行者工具/],
    [target({ created: Number.NaN }), /时刻/],
    [target({ ended: NOW - 5 * HOUR }), /时刻/],
  ];
  for (const [item, pattern] of bad)
    assert.match(targetsRefusal([item])!, pattern, JSON.stringify(item));
  const clean = (over: Record<string, unknown>) =>
    ({
      id: "c1",
      kind: "clean",
      now: NOW,
      targets: [target()],
      ...over,
    }) as AgentCommand;
  assert.equal(commandRefusal(clean({}), "linux", "/srv/agent"), null);
  assert.match(
    commandRefusal(clean({ now: "x" }), "linux", "/srv/agent")!,
    /下发时刻/,
  );
  assert.match(
    commandRefusal(
      clean({ targets: [target({ pid: -3 })] }),
      "linux",
      "/srv/agent",
    )!,
    /进程号/,
  );
  assert.equal(
    killLine({ task: 12, pid: 4312, tool: "claude" }),
    "t12 pid 4312 claude",
  );
});

/** 假进程表：pid → ps 输出；记下结束了谁、查了谁。 */
function fakeProcs(table: Record<number, string>, platform = "linux") {
  const killed: number[] = [];
  const probed: number[] = [];
  const exec: Exec = async (command, args) => {
    const pid = Number(
      platform === "win32"
        ? /ProcessId=(\d+)/.exec(args.at(-1)!)![1]
        : args.at(-1),
    );
    probed.push(pid);
    const text = table[pid];
    return text === undefined
      ? { ok: false, stdout: "", stderr: "" }
      : { ok: true, stdout: text, stderr: "" };
  };
  return {
    killed,
    probed,
    deps: {
      exec,
      platform: platform as NodeJS.Platform,
      alive: (pid: number) => pid in table,
      kill: (pid: number) => void killed.push(pid),
      now: () => NOW,
      self: 999,
    },
  };
}

test("核对并结束（本机与代理共用）：还活着且认得上的整树结束；不在的不查，认不上的、自己不碰", async () => {
  const procs = fakeProcs({
    // 两小时前启动的 claude：t1 的残留。
    4312: "02:00:00 /usr/bin/claude -p\n",
    // pid 已被用户后来开的 claude 复用（半小时前启动）。
    5000: "30:00 /usr/bin/claude\n",
    // 命令行不是 codex。
    6000: "02:00:00 /usr/bin/vim\n",
    999: "02:00:00 /usr/bin/claude\n",
  });
  const killed = await reapLeftovers(
    [
      target(),
      target({ task: 2, pid: 5000 }),
      target({ task: 3, pid: 6000, tool: "codex" }),
      target({ task: 4, pid: 7000 }),
      target({ task: 5, pid: 999 }),
    ],
    procs.deps,
  );
  assert.deepEqual(killed, [{ task: 1, pid: 4312, tool: "claude" }]);
  assert.deepEqual(procs.killed, [4312]);
  assert.deepEqual(procs.probed, [4312, 5000, 6000], "不在的与自己不查");
  // 同一 pid 两个候选只查一次、结束一次。
  const again = fakeProcs({ 4312: "02:00:00 /usr/bin/claude -p\n" });
  assert.deepEqual(
    await reapLeftovers(
      [
        target({ task: 9, created: NOW - 10 * HOUR, ended: NOW - 9 * HOUR }),
        target(),
      ],
      again.deps,
    ),
    [{ task: 1, pid: 4312, tool: "claude" }],
  );
  assert.deepEqual(again.probed, [4312]);
  // Windows：按 CreationDate 与命令行认（中转进程的命令行里带着真正的程序）。
  const win = fakeProcs(
    {
      4312: '20260928180000.000000+480\r\n"C:\\node.exe" -e "…" -- {} C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js -p\r\n',
    },
    "win32",
  );
  assert.deepEqual(await reapLeftovers([target()], win.deps), [
    { task: 1, pid: 4312, tool: "claude" },
  ]);
  // 读不到进程信息（ps 失败）：不结束。
  const failing = fakeProcs({ 4312: "x" });
  failing.deps.exec = async () => ({ ok: false, stdout: "", stderr: "denied" });
  assert.deepEqual(await reapLeftovers([target()], failing.deps), []);
  assert.deepEqual(failing.killed, []);
});

function db() {
  const db = new DatabaseSync(":memory:");
  ensureHostTables(db);
  ensureLocalHost(db, {
    hostname: "local",
    os: "linux",
    arch: "x64",
    cpus: 8,
    mem_mb: 8192,
    node: "v24",
    version: "0.0.0",
    data_dir: "/unused",
    clis: {},
    max_workers: null,
  } as HostInfo);
  ensureTaskTables(db);
  return db;
}

/** 假主机连接：挂一条长轮询等指令（代理在线），领到后按 answer 回执。 */
async function fakeAgent(
  remote: RemoteHosts,
  host: number,
  answer: (command: AgentCommand) => unknown,
) {
  const reply = await remote.poll(host, {
    load: { load: 0, running: 0, busy: null },
    busy: [],
  });
  const commands = reply.commands;
  for (const command of commands)
    remote.reply(host, command.id, answer(command));
  return commands;
}

test("远程清理经主机连接：下发清单与服务时钟，只收清单里的回执；离线、没来领、旧版代理都报原因", async () => {
  const store = db();
  const { id } = addHost(store, { name: "ggb" });
  const remote = new RemoteHosts(store, "/unused", {
    pollMs: 5_000,
    pickupMs: 500,
    now: () => NOW,
  });
  // 离线：不下发。
  await assert.rejects(
    remote.clean(id, [target()]),
    /离线：那台的残留进程没清/,
  );

  const agent = fakeAgent(remote, id, (command) => {
    assert.equal(command.kind, "clean");
    return {
      killed: [
        { task: 1, pid: 4312, tool: "claude" },
        // 清单外的（代理乱报）不收。
        { task: 99, pid: 1234, tool: "codex" },
      ],
    };
  });
  const killed = await remote.clean(id, [
    target(),
    target({ task: 2, pid: 77 }),
  ]);
  const [sent] = await agent;
  assert.deepEqual(killed, [{ task: 1, pid: 4312, tool: "claude" }]);
  assert.equal(sent!.kind, "clean");
  assert.deepEqual(sent, {
    id: sent!.id,
    kind: "clean",
    now: NOW,
    targets: [target(), target({ task: 2, pid: 77 })],
  });

  // 旧版代理不认这条指令：回 { ok: false, error }。
  const old = fakeAgent(remote, id, () => ({
    ok: false,
    error: "不认识的指令",
  }));
  await assert.rejects(
    remote.clean(id, [target()]),
    /代理没清：不认识的指令（代理版本太旧时先在那台升级 Atrium）/,
  );
  await old;
  // 刚来过（算在线）却没人来领：不干等整个回执时限。
  await assert.rejects(remote.clean(id, [target()]), /秒内没来领/);
  remote.close();
});

function lane(
  store: DatabaseSync,
  over: {
    running?: { id: number; host: number }[];
    reapLocal?: (targets: readonly LeftoverTarget[]) => Promise<LeftoverKill[]>;
    remote?: (
      host: number,
      targets: readonly LeftoverTarget[],
    ) => Promise<LeftoverKill[]>;
  },
) {
  const stops: string[] = [];
  const seen: { host: number | "local"; targets: readonly LeftoverTarget[] }[] =
    [];
  const clean = (host: number, by?: string) =>
    cleanHost(store, host, {
      running: over.running ?? [],
      active: new Set(),
      stop: (ref) => void stops.push(ref),
      reapLocal: async (targets) => {
        seen.push({ host: "local", targets });
        return over.reapLocal ? over.reapLocal(targets) : [];
      },
      remote: async (host, targets) => {
        seen.push({ host, targets });
        return over.remote ? over.remote(host, targets) : [];
      },
      by,
    });
  return { clean, stops, seen };
}

/** 建一件在 host 上跑过、已结束的任务（pid 与执行者照账本写法）。 */
function endedTask(
  store: DatabaseSync,
  input: { host: number | null; pid: number; worker: string; status?: string },
) {
  const task = createTask(store, { title: "跑过的" });
  const now = Date.now();
  store
    .prepare(
      "UPDATE tasks SET status=?,pid=?,worker=?,host_id=?,created_at=?,ended_at=?,updated_at=? WHERE id=?",
    )
    .run(
      input.status ?? "failed",
      input.pid,
      input.worker,
      input.host,
      now - 3 * HOUR,
      input.status === "running" ? null : now - HOUR,
      now - HOUR,
      task.id,
    );
  return task.id;
}

test("host clean：停掉那台在跑的执行者；远程按那台的账本交代理清、本机自己清；逐条回执并记任务事件", async () => {
  const store = db();
  const { id: h } = addHost(store, { name: "ggb" });
  const local1 = endedTask(store, { host: null, pid: 111, worker: "codex" });
  const remote1 = endedTask(store, {
    host: h,
    pid: 4312,
    worker: "claude+opus",
  });
  const remote2 = endedTask(store, { host: h, pid: 5000, worker: "kimi" });
  endedTask(store, { host: h, pid: 6000, worker: "claude", status: "running" });
  const fixture = lane(store, {
    running: [
      { id: 50, host: h },
      { id: 52, host: 1 },
    ],
    remote: async (_host, targets) => [
      {
        task: targets.find((t) => t.pid === 4312)!.task,
        pid: 4312,
        tool: "claude",
      },
    ],
  });
  const result = await fixture.clean(h, "t9");
  assert.deepEqual(fixture.stops, ["t50"], "只停这台的执行者");
  assert.equal(fixture.seen.length, 1);
  assert.equal(fixture.seen[0]!.host, h);
  assert.deepEqual(
    fixture.seen[0]!.targets.map((t) => [t.task, t.pid, t.tool]).sort(),
    [
      [remote1, 4312, "claude"],
      [remote2, 5000, "kimi"],
    ],
    "只交这台上已结束任务的执行者，本机的与在跑的不交",
  );
  assert.deepEqual(result.killed, [
    { task: `t${remote1}`, pid: 4312, tool: "claude" },
  ]);
  assert.equal(result.checked, 2);
  assert.equal(result.unreached, undefined);
  assert.equal(
    result.detail,
    `h${h}：停掉 1 个在跑的执行者（t50），结束 1 个残留进程树：t${remote1} pid 4312 claude`,
  );
  const events = getTask(store, remote1).events.filter(
    (event) => event.kind === "leftover_killed",
  );
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]!.detail!), {
    host: `h${h}`,
    pid: 4312,
    tool: "claude",
    by: "t9",
  });
  assert.equal(
    getTask(store, remote2).events.some((e) => e.kind === "leftover_killed"),
    false,
  );

  // 本机：服务自己核对，只交本机任务。
  const localLane = lane(store, {
    reapLocal: async () => [{ task: local1, pid: 111, tool: "codex" }],
  });
  const local = await localLane.clean(1);
  assert.deepEqual(
    localLane.seen.map((s) => s.host),
    ["local"],
  );
  assert.deepEqual(
    localLane.seen[0]!.targets.map((t) => t.task),
    [local1],
  );
  assert.deepEqual(local.killed, [
    { task: `t${local1}`, pid: 111, tool: "codex" },
  ]);
  assert.match(
    local.detail,
    /^h1：停掉 0 个在跑的执行者，结束 1 个残留进程树：t\d+ pid 111 codex$/,
  );
  const localEvent = getTask(store, local1).events.find(
    (event) => event.kind === "leftover_killed",
  );
  assert.deepEqual(JSON.parse(localEvent!.detail!), {
    host: "h1",
    pid: 111,
    tool: "codex",
  });
});

test("host clean：远程离线或代理没清成时写明原因、不记事件；没有候选不找代理", async () => {
  const store = db();
  const { id: h } = addHost(store, { name: "ggb" });
  const task = endedTask(store, { host: h, pid: 4312, worker: "claude" });
  const fixture = lane(store, {
    remote: async () => {
      throw new Error(`h${h} 离线：那台的残留进程没清，代理连上后再清`);
    },
  });
  const result = await fixture.clean(h);
  assert.equal(
    result.unreached,
    `h${h} 离线：那台的残留进程没清，代理连上后再清`,
  );
  assert.deepEqual(result.killed, []);
  assert.match(result.detail, /残留进程没清：h\d+ 离线/);
  assert.equal(
    getTask(store, task).events.some((e) => e.kind === "leftover_killed"),
    false,
  );
  // 没有候选：不找代理。
  const none = lane(db(), {});
  const empty = await none.clean(h);
  assert.deepEqual(none.seen, []);
  assert.equal(empty.checked, 0);
  assert.equal(
    empty.detail,
    `h${h}：停掉 0 个在跑的执行者，结束 0 个残留进程树`,
  );
});
