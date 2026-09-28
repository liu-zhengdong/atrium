import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMs,
  chooseHost,
  cloneName,
  connection,
  connectionText,
  hostFit,
  insideData,
  logAccept,
  ONLINE_MS,
  parseHostRef,
  reconcile,
  remoteLayout,
  runningHostLabel,
  repoAllowed,
  type HostCandidate,
  type HostNeed,
} from "../server/hosts/state.ts";

import {
  assignmentRefusal,
  commandRefusal,
  gitRefusal,
  nextChunk,
} from "../server/agent/plan.ts";
import { loggedIn } from "../server/hosts/info.ts";
import { queueHeads } from "../server/tasks/queue.ts";
import type { Assignment } from "../server/hosts/protocol.ts";

test("任务里的执行机器：本机省略，远程用名字，心跳过期标离线", () => {
  const now = 100_000;
  const host = { name: "ggb", joined_at: 1, last_seen_at: now };
  assert.equal(runningHostLabel(null, host, now), null);
  assert.equal(runningHostLabel(1, host, now), null);
  assert.equal(runningHostLabel(3, host, now), "ggb");
  assert.equal(
    runningHostLabel(3, { ...host, last_seen_at: now - ONLINE_MS }, now),
    "ggb",
  );
  assert.equal(
    runningHostLabel(3, { ...host, last_seen_at: now - ONLINE_MS - 1 }, now),
    "ggb（离线）",
  );
});

const local = (over: Partial<HostCandidate> = {}): HostCandidate => ({
  id: 1,
  kind: "local",
  connection: "local",
  paused: false,
  clis: null,
  repos: ["*"],
  running: 0,
  max: null,
  busy: null,
  ...over,
});
const remote = (over: Partial<HostCandidate> = {}): HostCandidate => ({
  id: 2,
  kind: "remote",
  connection: "online",
  paused: false,
  clis: { kimi: { installed: true, logged_in: null } },
  repos: ["o/r"],
  running: 0,
  max: 4,
  busy: null,
  ...over,
});
const need = (over: Partial<HostNeed> = {}): HostNeed => ({
  tool: "kimi",
  repo: "o/r",
  urgent: false,
  localOnly: null,
  ...over,
});

test("主机短号：只认 hN，其余给出参数名", () => {
  assert.equal(parseHostRef("h2"), 2);
  assert.equal(parseHostRef(" h12 "), 12);
  for (const bad of ["", "h0", "2", "H2", "h-1", "h2x", "h1234567890", 3])
    assert.throws(() => parseHostRef(bad, "--host"), /--host: 应为主机短号/);
});

test("连接状态：本机、待接入、过期、在线（长轮询挂着或一分钟内来过）、离线", () => {
  const base = {
    kind: "remote" as const,
    joined: true,
    joinExpiresAt: null,
    lastSeenAt: null,
    polling: false,
    now: 1_000_000,
  };
  assert.equal(connection({ ...base, kind: "local" }), "local");
  assert.equal(
    connection({ ...base, joined: false, joinExpiresAt: 1_000_001 }),
    "pending",
  );
  assert.equal(
    connection({ ...base, joined: false, joinExpiresAt: 999_999 }),
    "expired",
  );
  assert.equal(connection({ ...base, joined: false }), "expired");
  assert.equal(connection({ ...base, polling: true }), "online");
  assert.equal(
    connection({ ...base, lastSeenAt: base.now - ONLINE_MS }),
    "online",
  );
  assert.equal(
    connection({ ...base, lastSeenAt: base.now - ONLINE_MS - 1 }),
    "offline",
  );
  assert.equal(connection(base), "offline");
  const text = (state: Parameters<typeof connectionText>[0], paused = false) =>
    connectionText(state, {
      paused,
      lastSeenAt: base.now - 5 * 60_000,
      joinExpiresAt: base.now + 10 * 60_000,
      now: base.now,
    });
  assert.equal(text("local"), "本机");
  assert.equal(text("online", true), "在线 · 已暂停接活");
  assert.equal(text("offline"), "离线（5 分钟前最后心跳）");
  assert.equal(text("pending"), "待接入（接入码 10 分钟内有效）");
  assert.equal(text("expired"), "接入码已过期");
});

test("能不能接：离线、没接入、暂停、没装、没登录、仓库没登记是接不了；满或太忙是排队；紧急跳过负载", () => {
  const cases: [HostCandidate, Partial<HostNeed>, boolean, string][] = [
    [remote(), {}, false, "ok"],
    [remote({ connection: "offline" }), {}, false, "never:h2 离线"],
    [remote({ connection: "pending" }), {}, true, "never:h2 还没接入"],
    [remote({ connection: "expired" }), {}, true, "never:h2 还没接入"],
    [remote({ paused: true }), {}, true, "never:h2 已暂停接活"],
    [local({ paused: true }), {}, false, "never:h1 已暂停接活"],
    [remote(), { tool: "codex" }, true, "never:h2 上没装 codex"],
    [
      remote({ clis: { kimi: { installed: true, logged_in: false } } }),
      {},
      true,
      "never:h2 上的 kimi 没登录",
    ],
    [remote(), { repo: "o/other" }, false, "never:h2 没登记能接仓库 o/other"],
    [remote(), { repo: "o/other" }, true, "ok"],
    [remote({ repos: ["*"] }), { repo: "?" }, false, "ok"],
    [remote({ repos: [] }), { repo: null }, false, "ok"],
    [remote({ repos: [] }), { repo: "o/r" }, false, "never:h2 没登记"],
    [remote(), { localOnly: "体验巡检要连回本机服务" }, true, "never:体验巡检"],
    [local(), { localOnly: "体验巡检要连回本机服务" }, false, "ok"],
    [remote({ running: 4 }), {}, false, "later:h2 同时最多跑 4 个"],
    [remote({ running: 4 }), { urgent: true }, false, "ok"],
    [remote({ busy: "这台太忙" }), {}, false, "later:这台太忙"],
    [local({ busy: "本机太忙" }), {}, false, "later:本机太忙"],
    [local({ busy: "本机太忙" }), { urgent: true }, false, "ok"],
    [remote({ max: null, running: 99 }), {}, false, "ok"],
  ];
  for (const [candidate, over, pinned, expected] of cases) {
    const fit = hostFit(candidate, need(over), pinned);
    const got = fit.ok ? "ok" : `${fit.kind}:${fit.reason}`;
    const [kind, reason] = expected.split(":");
    if (kind === "ok") assert.equal(got, "ok", JSON.stringify(over));
    else {
      assert.ok(got.startsWith(`${kind}:`), `${got} ≠ ${expected}`);
      assert.ok(got.includes(reason!), `${got} ≠ ${expected}`);
    }
  }
  assert.ok(repoAllowed(["O/R"], "o/r"));
  assert.ok(!repoAllowed([], "o/r"));
});

test("暂停接活（t227）：自动挑永不选；只有指定且放行时照派这一件，满了不排队，其余条件照判", () => {
  const paused = remote({ paused: true, repos: ["*"] });
  // 自动挑、排队拉起（不钉）：暂停的一律不选，就算它最空、本机满。
  for (const urgent of [false, true])
    assert.deepEqual(
      chooseHost([local({ busy: "本机太忙" }), paused], need({ urgent })),
      urgent
        ? { kind: "run", host: 1 }
        : { kind: "queue", host: null, reason: "本机太忙" },
    );
  // 放行只对指定的那台有效：自动挑时传了也不选暂停的。
  assert.deepEqual(
    chooseHost([local({ busy: "本机太忙" }), paused], need(), undefined, true),
    { kind: "queue", host: null, reason: "本机太忙" },
  );
  assert.deepEqual(hostFit(paused, need(), false, true), {
    ok: false,
    kind: "never",
    reason: "h2 已暂停接活",
  });
  // 指定、不放行（leader、排队行、改派）：拒绝，不排队。
  assert.deepEqual(chooseHost([local(), paused], need(), 2), {
    kind: "refuse",
    reason: "h2 已暂停接活",
  });
  // 指定且放行（用户或秘书 task run --host）：派这一件。
  assert.deepEqual(chooseHost([local(), paused], need(), 2, true), {
    kind: "run",
    host: 2,
  });
  assert.deepEqual(chooseHost([local({ paused: true })], need(), 1, true), {
    kind: "run",
    host: 1,
  });
  // 放行也不越过别的条件：离线、避开、没装照样拒。
  for (const [candidate, over, reason] of [
    [remote({ paused: true, connection: "offline" }), {}, "h2 离线"],
    [paused, { avoid: [2] }, "任务写了避开 h2（--avoid-host）"],
    [paused, { tool: "codex" as const }, "h2 上没装 codex"],
  ] as const)
    assert.deepEqual(chooseHost([local(), candidate], need(over), 2, true), {
      kind: "refuse",
      reason,
    });
  // 满了：暂停的主机上不排队（排着的只等不暂停的主机），直接说清。
  const full = chooseHost(
    [local(), remote({ paused: true, running: 4 })],
    need(),
    2,
    true,
  );
  assert.equal(full.kind, "refuse");
  assert.match(
    (full as { reason: string }).reason,
    /h2 同时最多跑 4 个.*h2 暂停接活中，指定过去的不排队/,
  );
});

test("挑主机：指定的只看那台；自动挑最空的、一样空本机优先；都满排队且本机原因优先", () => {
  const two = [local(), remote()];
  assert.deepEqual(chooseHost(two, need(), 2), { kind: "run", host: 2 });
  assert.deepEqual(chooseHost(two, need(), 9), {
    kind: "refuse",
    reason: "没有主机 h9",
  });
  assert.equal(
    chooseHost([local(), remote({ connection: "offline" })], need(), 2).kind,
    "refuse",
  );
  assert.deepEqual(chooseHost([local(), remote({ running: 4 })], need(), 2), {
    kind: "queue",
    host: 2,
    reason: "h2 同时最多跑 4 个执行者，有执行者结束后自动拉起",
  });
  // 一样空：本机优先。
  assert.deepEqual(chooseHost(two, need()), { kind: "run", host: 1 });
  // 本机有活在跑、远程空着：去远程（不限上限的按千分之一算占用）。
  assert.deepEqual(chooseHost([local({ running: 1 }), remote()], need()), {
    kind: "run",
    host: 2,
  });
  assert.deepEqual(
    chooseHost([local({ running: 1, max: 4 }), remote({ running: 1 })], need()),
    { kind: "run", host: 1 },
  );
  // 本机太忙：去远程。
  assert.deepEqual(
    chooseHost([local({ busy: "本机太忙" }), remote()], need()),
    { kind: "run", host: 2 },
  );
  // 远程没登记这个仓库：本机太忙就排队，原因是本机的。
  assert.deepEqual(
    chooseHost([local({ busy: "本机太忙" }), remote()], need({ repo: "x/y" })),
    { kind: "queue", host: null, reason: "本机太忙" },
  );
  // 都满：本机的原因优先。
  assert.deepEqual(
    chooseHost([local({ busy: "本机满" }), remote({ running: 4 })], need()),
    { kind: "queue", host: null, reason: "本机满" },
  );
  // 本机暂停、远程满：排队说远程的原因。
  assert.deepEqual(
    chooseHost([local({ paused: true }), remote({ busy: "这台太忙" })], need()),
    { kind: "queue", host: null, reason: "这台太忙" },
  );
  // 谁都接不了：排队，说清本机为什么不行。
  const none = chooseHost(
    [local({ paused: true }), remote({ connection: "offline" })],
    need(),
  );
  assert.equal(none.kind, "queue");
  assert.match(
    (none as { reason: string }).reason,
    /h1 已暂停接活，也没有别的主机能接/,
  );
  // 只有本机：与只看本机闸门时一样。
  assert.deepEqual(chooseHost([local()], need()), { kind: "run", host: 1 });
  assert.deepEqual(chooseHost([local({ busy: "本机满" })], need()), {
    kind: "queue",
    host: null,
    reason: "本机满",
  });
  assert.deepEqual(
    chooseHost([local({ busy: "本机满" })], need({ urgent: true })),
    { kind: "run", host: 1 },
  );
});

test("远程目录布局：按那台的系统拼路径，工作树与本机同一规则；路径必须在代理数据目录里", () => {
  assert.equal(
    cloneName("git@github.com:liu-zhengdong/atrium.git"),
    "liu-zhengdong-atrium",
  );
  assert.equal(cloneName("https://github.com/o/r/"), "o-r");
  assert.equal(cloneName("/tmp/x/origin.git"), "x-origin");
  assert.equal(cloneName("::"), "repo");
  assert.deepEqual(
    remoteLayout(
      { os: "linux", data_dir: "/home/u/.atrium-agent" },
      { id: 7, slug: "fix" },
      "git@github.com:o/r.git",
    ),
    {
      dir: "/home/u/.atrium-agent/tasks/7",
      cwd: "/home/u/.atrium-agent/repos/o-r-t7-fix",
      clone: "/home/u/.atrium-agent/repos/o-r",
      worktree: "/home/u/.atrium-agent/repos/o-r-t7-fix",
    },
  );
  assert.deepEqual(
    remoteLayout({ os: "linux", data_dir: "/d" }, { id: 7, slug: null }, null),
    { dir: "/d/tasks/7", cwd: "/d/tasks/7/work", clone: null, worktree: null },
  );
  assert.equal(
    remoteLayout(
      { os: "win32", data_dir: "C:\\a" },
      { id: 3, slug: "x" },
      "https://h/o/r",
    ).worktree,
    "C:\\a\\repos\\o-r-t3-x",
  );
  assert.ok(insideData("linux", "/d", "/d/tasks/1"));
  assert.ok(!insideData("linux", "/d", "/d"));
  assert.ok(!insideData("linux", "/d", "/d/../etc"));
  assert.ok(!insideData("linux", "/d", "/dx/tasks"));
  assert.ok(!insideData("linux", "/d", "tasks/1"));
  assert.ok(insideData("win32", "C:\\a", "C:\\a\\tasks\\1"));
  assert.ok(!insideData("win32", "C:\\a", "D:\\a\\tasks"));
});

test("日志续传：接上写、重叠跳过前缀、缺口与旧段让代理从服务的位置重传", () => {
  assert.deepEqual(logAccept(10, { offset: 10, length: 5 }), {
    kind: "append",
    skip: 0,
  });
  assert.deepEqual(logAccept(10, { offset: 8, length: 5 }), {
    kind: "append",
    skip: 2,
  });
  assert.deepEqual(logAccept(10, { offset: 5, length: 5 }), { kind: "stale" });
  assert.deepEqual(logAccept(10, { offset: 12, length: 5 }), { kind: "gap" });
  assert.deepEqual(logAccept(0, { offset: 0, length: 0 }), { kind: "stale" });
  assert.deepEqual(nextChunk(0, 10, 4), { offset: 0, length: 4 });
  assert.deepEqual(nextChunk(8, 10, 4), { offset: 8, length: 2 });
  assert.equal(nextChunk(10, 10, 4), null);
  assert.equal(nextChunk(12, 10, 4), null);
});

test("重连对账：账本有代理没有的判丢失，代理在跑账本不认的让它结束", () => {
  assert.deepEqual(
    reconcile(
      [
        { task: 1, run: 1 },
        { task: 2, run: 3 },
        { task: 3, run: 1 },
      ],
      [
        { task: 1, run: 1, state: "running" },
        { task: 2, run: 2, state: "running" },
        { task: 4, run: 1, state: "running" },
        { task: 5, run: 1, state: "exited" },
      ],
    ),
    {
      lost: [
        { task: 2, run: 3 },
        { task: 3, run: 1 },
      ],
      orphans: [
        { task: 2, run: 2, state: "running" },
        { task: 4, run: 1, state: "running" },
      ],
    },
  );
  assert.deepEqual(reconcile([], []), { lost: [], orphans: [] });
  assert.deepEqual(
    [0, 1, 2, 3, 4, 10, 99].map(backoffMs),
    [1000, 2000, 4000, 8000, 15000, 15000, 15000],
  );
});

test("代理只照做四种指令：git 只跑查询与清理、路径在数据目录里，拉起的工具与分支要合法", () => {
  const data = "/home/u/.atrium-agent";
  const ok = (args: string[]) => gitRefusal(args, "linux", data);
  assert.equal(
    ok(["-C", `${data}/repos/o-r`, "remote", "get-url", "origin"]),
    null,
  );
  assert.equal(
    ok([
      "--no-optional-locks",
      "-C",
      `${data}/repos/o-r-t1-x`,
      "status",
      "--porcelain",
    ]),
    null,
  );
  assert.equal(ok(["-C", data, "worktree", "list"]), null);
  assert.match(ok(["-C", "/etc", "status"])!, /不在代理数据目录里/);
  assert.match(ok(["-C"])!, /不在代理数据目录里/);
  assert.match(ok(["-C", `${data}/x`, "push", "origin"])!, /不接受 git push/);
  assert.match(ok(["clone", "x"])!, /不接受 git clone/);
  assert.match(ok([])!, /不接受 git/);
  assert.match(
    ok(["-C", `${data}/x`, "log", "-c", "core.pager=sh"])!,
    /改 git 配置/,
  );
  assert.match(
    ok(["-C", `${data}/x`, "diff", "--config-env=x"])!,
    /改 git 配置/,
  );
  assert.match(gitRefusal([1 as unknown as string], "linux", data)!, /文本/);
  const assignment: Assignment = {
    task: 3,
    ref: "t3",
    run: 1,
    worker: "kimi",
    tool: "kimi",
    prompt: "做事",
    dir: `${data}/tasks/3`,
    cwd: `${data}/repos/o-r-t3-x`,
    repo: {
      url: "git@github.com:o/r.git",
      clone: `${data}/repos/o-r`,
      worktree: `${data}/repos/o-r-t3-x`,
      branch: "task-t3-x",
      base: "main",
    },
  };
  assert.equal(assignmentRefusal(assignment, "linux", data), null);
  const bad: [Partial<Assignment>, RegExp][] = [
    [{ task: 0 }, /任务号/],
    [{ run: 0 }, /轮号/],
    [{ tool: "rm" as "kimi" }, /不认识的执行者工具/],
    [{ prompt: " " }, /提示词为空/],
    [{ dir: "/tmp/x" }, /不在代理数据目录里/],
    [{ cwd: `${data}/../x` }, /不在代理数据目录里/],
    [{ repo: { ...assignment.repo!, url: "--upload-pack=x" } }, /仓库地址/],
    [{ repo: { ...assignment.repo!, url: "a b" } }, /仓库地址/],
    [{ repo: { ...assignment.repo!, branch: "-x" } }, /分支名/],
    [{ repo: { ...assignment.repo!, base: "a;b" } }, /基础分支名/],
    [{ repo: { ...assignment.repo!, clone: "/etc" } }, /不在代理数据目录里/],
  ];
  for (const [over, reason] of bad)
    assert.match(
      assignmentRefusal({ ...assignment, ...over }, "linux", data)!,
      reason,
    );
  assert.equal(
    commandRefusal(
      { id: "1", kind: "stop", task: 1, run: 1, signal: "SIGTERM" },
      "linux",
      data,
    ),
    null,
  );
  assert.match(
    commandRefusal(
      { id: "1", kind: "stop", task: 1, run: 1, signal: "SIGHUP" as "SIGTERM" },
      "linux",
      data,
    )!,
    /信号/,
  );
  assert.match(
    commandRefusal(
      { id: "1", kind: "check", task: 1, worktree: "/tmp", urgent: false },
      "linux",
      data,
    )!,
    /不在代理数据目录里/,
  );
  assert.match(
    commandRefusal(
      { id: "1", kind: "nope" } as unknown as Parameters<
        typeof commandRefusal
      >[0],
      "linux",
      data,
    )!,
    /不认识的指令/,
  );
});

test("是否登录：只看登录文件在不在；codex 没文件就是没登录，macOS 上的 claude 判不出", () => {
  const none = () => false;
  const all = () => true;
  assert.equal(loggedIn("codex", "linux", all), true);
  assert.equal(loggedIn("codex", "linux", none), false);
  assert.equal(loggedIn("claude", "linux", none), false);
  assert.equal(loggedIn("claude", "darwin", none), null);
  assert.equal(loggedIn("claude", "darwin", all), true);
  assert.equal(loggedIn("kimi", "linux", none), null);
  assert.equal(loggedIn("opencode", "linux", none), null);
});

test("排队队首：指定了主机的另排一队，不挡自动挑主机的同一工具", () => {
  const heads = queueHeads([
    {
      task_id: 1,
      tool: "kimi",
      worker: "kimi",
      risk: "low",
      queued_at: 1,
      urgent: false,
      idle: false,
      host_id: 2,
    },
    {
      task_id: 2,
      tool: "kimi",
      worker: "kimi",
      risk: "low",
      queued_at: 2,
      urgent: false,
      idle: false,
      host_id: null,
    },
    {
      task_id: 3,
      tool: "kimi",
      worker: "kimi",
      risk: "low",
      queued_at: 3,
      urgent: false,
      idle: false,
      host_id: null,
    },
    {
      task_id: 4,
      tool: "kimi",
      worker: "kimi",
      risk: "low",
      queued_at: 4,
      urgent: false,
      idle: false,
      host_id: 2,
    },
  ]);
  assert.deepEqual(
    heads.map((head) => head.task_id),
    [1, 2],
  );
});

test("挑主机（t232）：要带技能的优先能挂技能的主机，挂不了的仍能接、只排在后面", () => {
  const old = remote({ id: 2, skills: false });
  const fresh = remote({ id: 3, skills: true });
  // 本机有活、两台远程一样空：带技能的挑能挂的 h3，不带技能的照旧按短号挑 h2。
  const busyLocal = local({ running: 1 });
  assert.deepEqual(
    chooseHost([busyLocal, old, fresh], need({ skills: true })),
    {
      kind: "run",
      host: 3,
    },
  );
  assert.deepEqual(chooseHost([busyLocal, old, fresh], need()), {
    kind: "run",
    host: 2,
  });
  // 能挂技能比更空更要紧：h3 有一个在跑也先派 h3；本机（总能挂）一样空时仍本机优先。
  assert.deepEqual(
    chooseHost(
      [
        local({ running: 2, max: 4 }),
        old,
        remote({ id: 3, skills: true, running: 1 }),
      ],
      need({ skills: true }),
    ),
    { kind: "run", host: 3 },
  );
  assert.deepEqual(chooseHost([local(), old], need({ skills: true })), {
    kind: "run",
    host: 1,
  });
  // 只有挂不了的能接：照样派过去（派活时记 skills_skipped、回执写明），不无限排队。
  assert.deepEqual(
    chooseHost([local({ busy: "本机太忙" }), old], need({ skills: true })),
    { kind: "run", host: 2 },
  );
  // 指定主机不受影响。
  assert.deepEqual(
    chooseHost([local(), old, fresh], need({ skills: true }), 2),
    { kind: "run", host: 2 },
  );
});

test("代理收到的技能（t232）：名字、编号、文件路径不合法就拒绝整条拉起指令，Windows 数据目录同样", () => {
  const skill = {
    id: 1,
    slug: "web-design",
    rev: 2,
    description: "前端设计约定",
    via: "o3 atrium/web",
    files: {
      "SKILL.md": "---\nname: web-design\ndescription: 前端设计约定\n---\n",
      "ref/grid.md": "8px",
    },
  };
  for (const [os, data, sep] of [
    ["linux", "/home/u/.atrium-agent", "/"],
    ["win32", "C:\\Users\\u\\.atrium-agent", "\\"],
  ] as const) {
    const assignment: Assignment = {
      task: 3,
      ref: "t3",
      run: 1,
      worker: "claude",
      tool: "claude",
      prompt: "做事",
      dir: [data, "tasks", "3"].join(sep),
      cwd: [data, "tasks", "3", "work"].join(sep),
      skills: [skill],
    };
    assert.equal(assignmentRefusal(assignment, os, data), null, os);
    const bad: [unknown, RegExp][] = [
      ["x", /技能清单不合法/],
      [[{ ...skill, slug: "../evil" }], /技能名不合法/],
      [[{ ...skill, slug: "Web" }], /技能名不合法/],
      [[skill, skill], /重复/],
      [[{ ...skill, rev: 0 }], /修订号不合法/],
      [[{ ...skill, description: undefined }], /缺少简介/],
      [[{ ...skill, files: { "..\\x": "y", "SKILL.md": "x" } }], /路径不合法/],
      [[{ ...skill, files: { "../x": "y", "SKILL.md": "x" } }], /路径不合法/],
      [[{ ...skill, files: { "C:/x": "y", "SKILL.md": "x" } }], /路径不合法/],
      [[{ ...skill, files: { "ref/grid.md": "8px" } }], /缺少 SKILL\.md/],
      [
        Array.from({ length: 9 }, (_, i) => ({ ...skill, slug: `s${i}` })),
        /超过 8 个/,
      ],
    ];
    for (const [skills, reason] of bad)
      assert.match(
        assignmentRefusal(
          { ...assignment, skills: skills as Assignment["skills"] },
          os,
          data,
        )!,
        reason,
        `${os} ${JSON.stringify(skills).slice(0, 80)}`,
      );
  }
});
