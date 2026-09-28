import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  atriumTree,
  cpuSource,
  cpuTimeSeconds,
  environValue,
  envSource,
  parsePsEnv,
  parseProcStat,
  parsePs,
  parseWindowsPerf,
  treeCores,
  type CpuSnapshot,
} from "../server/platform/cpu-plan.ts";
import { ProcessCpu, snapshot } from "../server/platform/cpu.ts";

test("进程 CPU 来源按平台：Linux 读 /proc，macOS 等用 ps，Windows 查性能计数器", () => {
  assert.deepEqual(cpuSource("linux"), { kind: "proc" });
  assert.deepEqual(cpuSource("android"), { kind: "proc" });
  for (const platform of ["darwin", "freebsd", "openbsd"] as const)
    assert.deepEqual(cpuSource(platform), {
      kind: "command",
      read: "total",
      command: "ps",
      args: ["-A", "-o", "pid=,ppid=,time="],
    });
  const windows = cpuSource("win32");
  assert.equal(windows.kind, "command");
  if (windows.kind === "command") {
    assert.equal(windows.read, "rate");
    assert.equal(windows.command, "powershell.exe");
    assert.match(windows.args.at(-1)!, /\[wmisearcher\]/);
    assert.match(windows.args.at(-1)!, /PercentProcessorTime/);
    assert.match(windows.args.at(-1)!, /CreatingProcessID/);
  }
});

test("ps 累计 CPU：macOS 分:秒.百分秒（分可过 60）、procps 时:分:秒、带天数；看不懂为 null", () => {
  const cases: [string, number | null][] = [
    ["0:00.03", 0.03],
    ["9:52.40", 592.4],
    ["235:30.57", 14130.57],
    ["01:02:03", 3723],
    ["2-01:00:00", 2 * 86400 + 3600],
    [" 0:01.00 ", 1],
    ["", null],
    ["12", null],
    ["a:b", null],
    ["1:2:3:4", null],
  ];
  for (const [text, seconds] of cases) {
    const value = cpuTimeSeconds(text);
    if (seconds === null) assert.equal(value, null, text);
    else assert.ok(Math.abs(value! - seconds) < 1e-9, `${text} → ${value}`);
  }
});

test("解析 ps 输出：坏行跳过", () => {
  assert.deepEqual(
    parsePs(
      "    1     0  12:00.00\n  743     1 235:30.57\nfoo bar baz\n 88  1\n 90 88 0:01.50\n",
    ),
    [
      { pid: 1, ppid: 0, cpu: 720 },
      { pid: 743, ppid: 1, cpu: 14130.57 },
      { pid: 90, ppid: 88, cpu: 1.5 },
    ],
  );
});

test("解析 /proc/<pid>/stat：进程名带空格和括号也能取对父 pid、utime+stime 与已收回子进程的 cutime+cstime", () => {
  const stat = (name: string) =>
    `4242 (${name}) S 17 4242 4242 0 -1 4194560 100 0 0 0 250 50 700 100 20 0 1 0 100 0 0`;
  const read = { pid: 4242, ppid: 17, cpu: 3, children: 8 };
  assert.deepEqual(parseProcStat(stat("node")), read);
  assert.deepEqual(parseProcStat(stat("a) b (c")), read);
  assert.deepEqual(parseProcStat(stat("node"), 1000), {
    pid: 4242,
    ppid: 17,
    cpu: 0.3,
    children: 0.8,
  });
  assert.equal(
    parseProcStat("4242 (node) S 17 4242 4242 0 -1 4194560 100 0 0 0 250 50"),
    null,
    "缺 cutime、cstime",
  );
  assert.equal(parseProcStat(""), null);
  assert.equal(parseProcStat("x (y) S"), null);
  assert.equal(parseProcStat("12 (y) S 1"), null);
});

test("解析 Windows 性能计数器：单核 100% 换成 1 核，Idle/_Total（pid 0）与坏行不计", () => {
  assert.deepEqual(
    parseWindowsPerf("0 0 800\r\n0 0 790\r\n4 0 3\r\n500 400 150\r\nbad\r\n"),
    [
      { pid: 4, ppid: 0, cpu: 0.03 },
      { pid: 500, ppid: 400, cpu: 1.5 },
    ],
  );
});

test("Atrium 进程树：服务的全部后代加接管来的执行者，不含服务本身与别人的进程，成环不死循环", () => {
  const procs = [
    { pid: 1, ppid: 0, cpu: 0 },
    { pid: 100, ppid: 1, cpu: 0 }, // 服务
    { pid: 101, ppid: 100, cpu: 0 }, // 执行者
    { pid: 102, ppid: 101, cpu: 0 }, // 执行者起的测试
    { pid: 103, ppid: 102, cpu: 0 },
    { pid: 110, ppid: 100, cpu: 0 }, // 本地检查
    { pid: 200, ppid: 1, cpu: 0 }, // 接管来的执行者
    { pid: 201, ppid: 200, cpu: 0 },
    { pid: 300, ppid: 1, cpu: 0 }, // fileproviderd 之类
    { pid: 400, ppid: 401, cpu: 0 }, // 成环
    { pid: 401, ppid: 400, cpu: 0 },
    { pid: 500, ppid: 500, cpu: 0 },
  ];
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  assert.deepEqual(
    sorted(atriumTree(procs, { service: 100 })),
    [101, 102, 103, 110],
  );
  assert.deepEqual(
    sorted(atriumTree(procs, { service: 100, adopted: [200, 999, 100] })),
    [101, 102, 103, 110, 200, 201],
    "已不在的接管 pid 与服务自己不算",
  );
  assert.deepEqual(sorted(atriumTree(procs, { service: 400 })), [401]);
  assert.deepEqual(sorted(atriumTree(procs, { service: 500 })), []);
  assert.deepEqual(sorted(atriumTree([], { service: 100 })), []);
  assert.deepEqual(
    sorted(atriumTree(procs, { service: 100, extra: [300, 999, 100, 101] })),
    [101, 102, 103, 110, 300],
    "extra（上次在树里后被收养的、带标记的）连同后代算进来，已不在的与服务自己不算",
  );
});

test("占了几个核：累计读数按两次采样相减，新进程算全部，pid 复用按新进程；瞬时读数直接相加", () => {
  const tree = new Set([1, 2, 3, 4]);
  const at = (ms: number, procs: [number, number][]): CpuSnapshot => ({
    kind: "total",
    at: ms,
    procs: procs.map(([pid, cpu]) => ({ pid, ppid: 0, cpu })),
  });
  const before = at(0, [
    [1, 10],
    [2, 5],
    [9, 100],
  ]);
  // 1 号 10 秒里用了 20 秒 CPU（2 核），2 号用了 5 秒，3 号新起用了 5 秒，4 号 pid 复用（累计变小）按 3 秒算；
  // 9 号不在树里，用多少都不算。
  const after = at(10_000, [
    [1, 30],
    [2, 10],
    [3, 5],
    [4, 3],
    [9, 900],
  ]);
  const withReuse = {
    ...before,
    procs: [...before.procs, { pid: 4, ppid: 0, cpu: 50 }],
  };
  assert.equal(treeCores(withReuse, after, tree), 3.3);
  assert.equal(treeCores(before, after, tree), 3.3);
  assert.equal(treeCores(null, after, tree), null, "第一次采样不知道");
  assert.equal(treeCores(at(9_800, []), after, tree), null, "间隔太短不算");
  assert.equal(treeCores(after, before, tree), null, "时间倒流不算");
  assert.equal(treeCores(before, after, new Set()), 0);
  const rate: CpuSnapshot = {
    kind: "rate",
    at: 0,
    procs: [
      { pid: 1, ppid: 0, cpu: 1.5 },
      { pid: 2, ppid: 0, cpu: 0.25 },
      { pid: 9, ppid: 0, cpu: 8 },
    ],
  };
  assert.equal(treeCores(null, rate, tree), 1.75);
  assert.equal(treeCores(rate, after, tree), null, "种类不同不算");
});

test("占了几个核（Linux）：两次采样之间退出的进程按父进程收回的累计算上，不重复算", () => {
  const snap = (
    ms: number,
    procs: [number, number, number, number][],
  ): CpuSnapshot => ({
    kind: "total",
    at: ms,
    procs: procs.map(([pid, ppid, cpu, children]) => ({
      pid,
      ppid,
      cpu,
      children,
    })),
  });
  // 服务 100 → 执行者 101 → 测试进程 102 → 测试文件 103；900 是别人的。
  const before = snap(0, [
    [100, 1, 5, 0],
    [101, 100, 10, 0],
    [102, 101, 2, 0],
    [103, 102, 4, 0],
    [900, 1, 100, 0],
  ]);
  // 10 秒里：执行者用了 2 秒，测试进程自己 1 秒；103 又用了 6 秒后退出（累计 10），
  // 另有几个测试文件起了又退、一共 20 秒，都被 102 收回（children 30）。实际用了 29 秒。
  const after = snap(10_000, [
    [100, 1, 6, 0],
    [101, 100, 12, 0],
    [102, 101, 3, 30],
    [900, 1, 200, 0],
  ]);
  const context = { previousTree: new Set([101, 102, 103]), service: 100 };
  assert.equal(treeCores(before, after, new Set([101, 102]), context), 2.9);
  assert.equal(
    treeCores(
      before,
      { ...after, procs: after.procs.slice(0, 2) },
      new Set([101]),
      context,
    ),
    0,
    "父子一起退出、孙子先被 1 号收养（收回的不是树里的）：这一轮少算，不出负数",
  );

  // 执行者整个退出，被服务收回：只算服务 children 的增量减去上次算过的。
  const worker = snap(0, [
    [100, 1, 5, 0],
    [101, 100, 10, 5],
  ]);
  const reaped = snap(10_000, [[100, 1, 5, 18]]);
  assert.equal(
    treeCores(worker, reaped, new Set(), {
      previousTree: new Set([101]),
      service: 100,
    }),
    0.3,
  );
  assert.equal(
    treeCores(worker, reaped, new Set(), { previousTree: new Set([101]) }),
    0,
    "不知道服务是谁时服务收回的不算",
  );

  // 被 1 号进程收养后退出的：收回的是 1 号，不减。
  const orphan = snap(0, [
    [100, 1, 0, 0],
    [101, 100, 10, 0],
    [104, 1, 7, 0],
  ]);
  const orphanGone = snap(10_000, [
    [100, 1, 0, 0],
    [101, 100, 11, 0],
  ]);
  assert.equal(
    treeCores(orphan, orphanGone, new Set([101]), {
      previousTree: new Set([101, 104]),
      service: 100,
    }),
    0.1,
  );
});

test("占了几个核（macOS）：拿不到收回的累计时，整机用掉的减去看得见的，按进出进程里 Atrium 的占比分", () => {
  const snap = (
    ms: number,
    procs: [number, number, number][],
    busy: number,
    total: number,
  ): CpuSnapshot => ({
    kind: "total",
    at: ms,
    procs: procs.map(([pid, ppid, cpu]) => ({ pid, ppid, cpu })),
    system: { busy, total, cores: 8 },
  });
  const before = snap(
    0,
    [
      [100, 1, 1],
      [101, 100, 10],
      [103, 101, 3],
      [900, 1, 50],
      [901, 1, 1],
    ],
    1000,
    5000,
  );
  // 10 秒里整机忙 5/8 → 5 核 × 10 秒 = 50 秒；看得见的：101 用 5、新起的 104/105 用 2+3、900 用 10，共 20；
  // 差额 30 秒是退出的进程用的。进出的进程 4 个（新起 104、105，退出 103、901），Atrium 的 3 个 → 22.5 秒。
  const after = snap(
    10_000,
    [
      [100, 1, 1],
      [101, 100, 15],
      [104, 101, 2],
      [105, 101, 3],
      [900, 1, 60],
    ],
    1050,
    5080,
  );
  const tree = new Set([101, 104, 105]);
  const context = { previousTree: new Set([101, 103]), service: 100 };
  assert.equal(treeCores(before, after, tree, context), 3.25);
  assert.equal(
    treeCores(before, { ...after, system: undefined }, tree, context),
    1,
    "没有整机读数只算看得见的",
  );
  assert.equal(
    treeCores(
      before,
      { ...after, system: { busy: 1005, total: 5080, cores: 8 } },
      tree,
      context,
    ),
    0.5,
    "不超过整机用掉的",
  );
  const still: CpuSnapshot = {
    ...after,
    procs: before.procs.map((proc) => ({ ...proc, cpu: proc.cpu + 1 })),
  };
  assert.equal(
    treeCores(before, still, new Set([101, 103]), context),
    0.2,
    "没有进程进出时差额不分给 Atrium",
  );
  const linux: CpuSnapshot = {
    ...after,
    procs: after.procs.map((proc) => ({ ...proc, children: 0 })),
  };
  assert.equal(
    treeCores(before, linux, tree, context),
    1,
    "有收回的累计（Linux）不估算",
  );
});

test("读别的进程的环境：Linux 读 /proc，macOS 等用 ps -E，Windows 读不到", () => {
  assert.deepEqual(envSource("linux", [1, 2]), { kind: "proc" });
  assert.equal(envSource("win32", [1]), null);
  assert.deepEqual(envSource("darwin", [12, 34]), {
    kind: "command",
    command: "ps",
    args: ["-E", "-ww", "-o", "pid=,command=", "-p", "12,34"],
  });
  assert.deepEqual(
    [
      ...parsePsEnv(
        "  12 node server.js PATH=/bin ATRIUM_SPAWN=abc/t7 HOME=/u\n" +
          "34 /bin/zsh PATH=/bin\n" +
          "56 grep XATRIUM_SPAWN=nope\n" +
          "78 node ATRIUM_SPAWN=def/t9\nbad line\n",
        "ATRIUM_SPAWN",
      ),
    ],
    [
      [12, "abc/t7"],
      [78, "def/t9"],
    ],
  );
  assert.equal(
    environValue("PATH=/bin\0ATRIUM_SPAWN=abc/t7\0HOME=/u\0", "ATRIUM_SPAWN"),
    "abc/t7",
  );
  assert.equal(environValue("PATH=/bin\0", "ATRIUM_SPAWN"), null);
});

test("ProcessCpu：父进程退出后被收养的子孙照算，带本服务标记的也算并列为孤儿；查环境按间隔、只查新进程", async () => {
  let now = 0;
  let procs: { pid: number; ppid: number; cpu: number }[] = [];
  const lookups: number[][] = [];
  const marks = new Map([
    [500, "aaaaaaaaaaaa/t3"],
    [600, "bbbbbbbbbbbb/t3"],
    [100, "aaaaaaaaaaaa/t1"],
  ]);
  const cpu = new ProcessCpu(
    async () => ({ kind: "total", at: now, procs }),
    100,
    {
      mark: { name: "ATRIUM_SPAWN", prefix: "aaaaaaaaaaaa/" },
      lookup: async (pids) => {
        lookups.push([...pids]);
        return marks;
      },
      lookupMs: 30_000,
      now: () => now,
    },
  );
  // 服务 100 → 执行者 101 → 测试 102；500 是服务重启前留下、带标记的隔离服务（501 是它的子进程）；
  // 600 带别的服务的标记。
  procs = [
    { pid: 100, ppid: 1, cpu: 0 },
    { pid: 101, ppid: 100, cpu: 0 },
    { pid: 102, ppid: 101, cpu: 0 },
    { pid: 500, ppid: 1, cpu: 0 },
    { pid: 501, ppid: 500, cpu: 0 },
    { pid: 600, ppid: 1, cpu: 0 },
  ];
  await cpu.refresh();
  assert.deepEqual(lookups, [[500, 501, 600]], "服务自己与树里的不查");
  assert.deepEqual(cpu.orphans(), [{ pid: 500, mark: "aaaaaaaaaaaa/t3" }]);
  assert.equal(cpu.cores(), null);
  // 5 秒后：执行者退出，102 被 1 号收养；102、500、501、600 各占 1 核。
  now = 5_000;
  procs = [
    { pid: 100, ppid: 1, cpu: 0 },
    { pid: 102, ppid: 1, cpu: 5 },
    { pid: 500, ppid: 1, cpu: 5 },
    { pid: 501, ppid: 500, cpu: 5 },
    { pid: 600, ppid: 1, cpu: 5 },
    { pid: 700, ppid: 1, cpu: 0 },
  ];
  await cpu.refresh();
  assert.equal(cpu.cores(), 3, "600 不是本服务的");
  assert.equal(lookups.length, 1, "没到间隔不查");
  now = 30_000;
  procs = procs.map((proc) => ({ ...proc, cpu: proc.cpu + 25 }));
  await cpu.refresh();
  assert.deepEqual(lookups[1], [102, 700], "只查没查过的");
  assert.equal(cpu.cores(), 3);
  // pid 被复用（累计变小）就不再是上次那个进程。
  now = 35_000;
  procs = procs.map((proc) =>
    proc.pid === 102 ? { ...proc, cpu: 1 } : { ...proc, cpu: proc.cpu + 5 },
  );
  await cpu.refresh();
  assert.equal(cpu.cores(), 2);
});

test("ProcessCpu：第二次采样起给核数，采样失败回到不知道，同时来的几次合成一次", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const cpu = new ProcessCpu(async () => {
    calls++;
    if (fail) throw new Error("ps 不在");
    now += 2000;
    return {
      kind: "total",
      at: now,
      procs: [
        { pid: 100, ppid: 1, cpu: 0 },
        { pid: 101, ppid: 100, cpu: now / 1000 }, // 一直占满 1 核
        { pid: 300, ppid: 1, cpu: now / 100 },
      ],
    };
  }, 100);
  assert.equal(cpu.cores(), null);
  await Promise.all([cpu.refresh(), cpu.refresh()]);
  assert.equal(calls, 1);
  assert.equal(cpu.cores(), null);
  await cpu.refresh();
  assert.equal(cpu.cores(), 1);
  fail = true;
  await cpu.refresh();
  assert.equal(cpu.cores(), null);
  fail = false;
  await cpu.refresh();
  assert.equal(cpu.cores(), null, "失败后重新从第一次算起");
  await cpu.refresh();
  assert.equal(cpu.cores(), 1);
});

test("本机实测：能列出进程，并认出自己起的子进程", async (t) => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], {
    stdio: "ignore",
  });
  t.after(() => child.kill());
  await new Promise((resolve) => child.once("spawn", resolve));
  // Windows 读性能计数器（瞬时读数），新进程可能晚一两秒才出现在计数器里。
  const deadline = Date.now() + 10_000;
  for (;;) {
    const shot = await snapshot();
    assert.equal(shot.kind, process.platform === "win32" ? "rate" : "total");
    assert.ok(shot.procs.length > 1);
    const found = atriumTree(shot.procs, { service: process.pid }).has(
      child.pid!,
    );
    if (found || Date.now() > deadline) {
      assert.ok(found);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});
