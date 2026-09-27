import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  atriumTree,
  cpuSource,
  cpuTimeSeconds,
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

test("解析 /proc/<pid>/stat：进程名带空格和括号也能取对父 pid 与 utime+stime", () => {
  const stat = (name: string) =>
    `4242 (${name}) S 17 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 1 0 100 0 0`;
  assert.deepEqual(parseProcStat(stat("node")), {
    pid: 4242,
    ppid: 17,
    cpu: 3,
  });
  assert.deepEqual(parseProcStat(stat("a) b (c")), {
    pid: 4242,
    ppid: 17,
    cpu: 3,
  });
  assert.deepEqual(parseProcStat(stat("node"), 1000), {
    pid: 4242,
    ppid: 17,
    cpu: 0.3,
  });
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
  if (process.platform === "win32") return t.skip("Windows 由 CI 覆盖");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    stdio: "ignore",
  });
  t.after(() => child.kill());
  await new Promise((resolve) => child.once("spawn", resolve));
  const shot = await snapshot();
  assert.equal(shot.kind, "total");
  assert.ok(shot.procs.length > 1);
  assert.ok(atriumTree(shot.procs, { service: process.pid }).has(child.pid!));
});
