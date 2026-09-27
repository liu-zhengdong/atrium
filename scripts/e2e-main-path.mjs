#!/usr/bin/env node
// 主路径端到端（#353 第 2、3 步）：用打包出的 atrium、隔离数据目录与假执行者，走一遍
//   atrium（起服务）→ task add / run / wait → org tree → quota → events wait
//   → restart（在跑的执行者被新服务接管、任务不丢）→ stop
// macOS、Linux、Windows 共用；每一步有断言，失败时打印是哪一步、命令与输出、服务日志末尾。
//
//   node scripts/e2e-main-path.mjs [--tarball <atrium-x.y.z.tgz> | --bin <包>/bin/atrium.mjs] [--keep]
//
// 缺省：在本仓库 npm pack（prepack 会编译 dist/），装进临时 prefix，跑装好的命令。
// --tarball：装这份已打好的包（如在 macOS 上打包、拷进 Linux 虚拟机跑）。
// --bin：直接用已经装好的包。--keep：通过时也保留临时目录（失败时总是保留）。
// 全程只用临时目录：HOME 指向临时目录，执行者档案从临时目录导入，OpenQuota 指向不存在的路径；
// macOS 上另关掉自带额度读取（它会读钥匙串）。不连、不动 4310 上的安装版服务。
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const { values } = parseArgs({
  options: {
    bin: { type: "string" },
    tarball: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

const root = mkdtempSync(join(tmpdir(), "atrium-e2e-"));
const home = join(root, "home");
const data = join(root, "data");
const bin = join(root, "bin");
const workers = join(root, "workers");
const repo = join(root, "repo");
const hold = join(root, "hold");
const pidsFile = join(root, "worker-pids.txt");
for (const dir of [home, bin, join(workers, "harness")])
  mkdirSync(dir, { recursive: true });

class StepFailure extends Error {}
let current = "准备";
let last; // 最近一条命令的结果，失败时打印
let started = false;

function fail(message) {
  throw new StepFailure(message);
}

function show(result) {
  if (!result) return "";
  return [
    `命令：${result.label}`,
    `退出码：${result.status ?? result.signal ?? result.error?.message}`,
    result.stdout.trim() && `标准输出：\n${result.stdout.trimEnd()}`,
    result.stderr.trim() && `标准错误：\n${result.stderr.trimEnd()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
    ...options,
  });
  last = {
    label: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  return last;
}

async function step(name, body) {
  current = name;
  last = undefined;
  const start = Date.now();
  console.log(`▶ ${name}`);
  await body();
  console.log(`  ✓ ${((Date.now() - start) / 1000).toFixed(1)} 秒`);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---- 装包 ----------------------------------------------------------------

function npm(args, cwd) {
  // npm 在 Windows 上是 npm.cmd，只能经 shell 跑；参数都是本脚本给的路径，不含引号。
  return windows
    ? run(
        "npm",
        args.map((arg) => (/[\s&^|<>]/.test(arg) ? `"${arg}"` : arg)),
        {
          cwd,
          shell: true,
          timeout: 600_000,
        },
      )
    : run("npm", args, { cwd, timeout: 600_000 });
}

function pack() {
  const packed = npm(["pack", "--json", "--pack-destination", root], repoRoot);
  if (packed.status !== 0) fail("npm pack 失败");
  return join(root, JSON.parse(packed.stdout)[0].filename);
}

function install(tarball) {
  const prefix = join(root, "prefix");
  const installed = npm(
    ["install", "-g", "--no-audit", "--no-fund", "--prefix", prefix, tarball],
    root,
  );
  if (installed.status !== 0) fail("npm install -g 失败");
  const pkg = windows
    ? join(prefix, "node_modules", "atrium")
    : join(prefix, "lib", "node_modules", "atrium");
  const shim = windows
    ? join(prefix, "atrium.cmd")
    : join(prefix, "bin", "atrium");
  if (!existsSync(shim)) fail(`装好后没有全局命令 ${shim}`);
  return { entry: join(pkg, "bin", "atrium.mjs"), shim };
}

// ---- 隔离环境 --------------------------------------------------------------

async function freePort() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

// 继承的 ATRIUM_* 一律丢掉（如执行者自带的 ATRIUM_WORKER），只留本脚本给的。
const base = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toUpperCase().startsWith("ATRIUM_"),
  ),
);
const env = {
  ...base,
  HOME: home,
  ...(windows ? { USERPROFILE: home } : {}),
  PATH: `${bin}${delimiter}${process.env.PATH ?? process.env.Path ?? ""}`,
  ATRIUM_DATA: data,
  ATRIUM_WORKERS_DIR: workers,
  ATRIUM_OPENQUOTA_BIN: join(root, "no-openquota"),
  // 本机负载不是这里要验的：别让忙碌的机器把任务压在队列里。
  ATRIUM_MAX_WORKERS: "off",
  ATRIUM_BUSY_CORES: "off",
  ATRIUM_BUSY_LOAD: "off",
  ...(process.platform === "darwin" ? { ATRIUM_QUOTA_READERS: "off" } : {}),
};
if (windows) delete env.Path;

let entry;
const atrium = (...args) => {
  const timeout = args.includes("--timeout")
    ? (Number(args[args.indexOf("--timeout") + 1]) + 60) * 1000
    : 120_000;
  const result = run(process.execPath, [entry, ...args], { env, timeout });
  result.label = `atrium ${args.join(" ")}`;
  return result;
};
const ok = (result, what) => {
  if (result.status !== 0) fail(`${what}：退出码 ${result.status}`);
  return result;
};
const json = (result, what) => {
  ok(result, what);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`${what}：输出不是 JSON`);
  }
};
const expect = (text, pattern, what) => {
  if (!pattern.test(text)) fail(`${what}：输出里没有 ${pattern}`);
};

/** 假 Claude Code：按 stream-json 输出进展与收尾；hold 文件在时一直等（用来跨重启）。 */
function writeFakeClaude() {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const hold = ${JSON.stringify(hold)};
const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + "\\n");
say({ type: "system", subtype: "init", session_id: require("node:crypto").randomUUID() });
say({ type: "assistant", message: { content: [{ type: "text", text: "开始（pid " + process.pid + "）" }] } });
const finish = () => {
  fs.writeFileSync("e2e-done.txt", "ok\\n");
  say({ type: "assistant", message: { content: [{ type: "text", text: "写好了 e2e-done.txt" }] } });
  say({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "假执行者完成" });
  process.exit(0);
};
if (!fs.existsSync(hold)) finish();
let beat = 0;
setInterval(() => {
  if (!fs.existsSync(hold)) finish();
  if (++beat % 25 === 0) say({ type: "assistant", message: { content: [{ type: "text", text: "等待中" }] } });
}, 200);
setTimeout(() => process.exit(3), 600000);
`;
  if (!windows) {
    writeFileSync(join(bin, "claude"), script);
    chmodSync(join(bin, "claude"), 0o755);
    return;
  }
  // Windows：npm 风格的 .cmd 包装，平台层认得它，绕开 cmd.exe 直接用 node 跑目标。
  writeFileSync(join(bin, "claude-fake.cjs"), script);
  writeFileSync(
    join(bin, "claude.cmd"),
    [
      "@ECHO off",
      "SETLOCAL",
      'SET "dp0=%~dp0"',
      'SET "_prog=node"',
      '"%_prog%" "%dp0%\\claude-fake.cjs" %*',
      "",
    ].join("\r\n"),
  );
}

function setupRepo() {
  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = e2e\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n",
  );
  const git = (cwd, ...args) =>
    ok(run("git", args, { cwd, env }), `git ${args.join(" ")}`);
  git(root, "init", "--bare", "-q", "-b", "main", join(root, "origin.git"));
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# e2e\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "remote", "add", "origin", join(root, "origin.git"));
  git(repo, "push", "-q", "-u", "origin", "main");
}

/** atrium status 报的服务 PID；没在运行就判失败。 */
function servicePid() {
  const status = ok(atrium("status"), "atrium status");
  const pid = Number(/正在运行 · PID (\d+)/.exec(status.stdout)?.[1]);
  if (!pid) fail("atrium status 没说服务在运行");
  return pid;
}

async function showTask(ref) {
  return json(atrium("task", "show", ref, "--json"), `task show ${ref}`).result;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function killLeftovers() {
  if (!existsSync(pidsFile)) return;
  for (const line of readFileSync(pidsFile, "utf8").split("\n")) {
    const pid = Number(line.trim());
    if (!pid || !alive(pid)) continue;
    console.error(`清理残留的假执行者 pid ${pid}`);
    if (windows)
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
      });
    else
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
  }
}

// ---- 主路径 ----------------------------------------------------------------

let failed = false;
try {
  await step("装包：npm pack 的产物装进临时 prefix", async () => {
    if (values.bin) {
      entry = resolve(values.bin);
      if (!existsSync(entry)) fail(`没有找到 ${entry}`);
      console.log(`  用已装好的包：${entry}`);
      return;
    }
    const tarball = values.tarball ? resolve(values.tarball) : pack();
    if (!existsSync(tarball)) fail(`没有找到 ${tarball}`);
    const installed = install(tarball);
    entry = installed.entry;
    console.log(`  ${installed.shim}`);
    // 全局命令本身能跑（Windows 上是 npm 生成的 .cmd 包装）。
    const help = windows
      ? run(`"${installed.shim}"`, ["--help"], { env, shell: true })
      : run(installed.shim, ["--help"], { env });
    ok(help, "全局命令 atrium --help");
    expect(help.stdout, /task add/, "atrium --help");
  });

  await step("准备：假执行者、档案与工作仓库", async () => {
    // 派活要求工作仓库所在磁盘至少空 15 GB（章程下限的底线）；有的 Linux 把 /tmp 挂成小 tmpfs。
    const disk = statfsSync(root);
    const freeGb = (disk.bavail * disk.bsize) / 1e9;
    if (freeGb < 16)
      fail(
        `临时目录 ${root} 所在磁盘只空 ${freeGb.toFixed(1)} GB，派活要求至少 15 GB；设 TMPDIR 指向更大的盘再跑`,
      );
    env.ATRIUM_PORT = String(await freePort());
    writeFakeClaude();
    writeFileSync(
      join(workers, "harness", "claude.md"),
      "---\nlimits: {startup_minutes: 10}\n---\n端到端用的假 Claude Code。\n",
    );
    setupRepo();
    console.log(`  临时目录 ${root}，端口 ${env.ATRIUM_PORT}`);
  });

  await step("atrium：起服务", async () => {
    const out = ok(atrium("--no-open"), "起服务");
    started = true;
    expect(
      `${out.stdout}\n${out.stderr}`,
      new RegExp(env.ATRIUM_PORT),
      "起服务回执",
    );
    servicePid();
  });

  await step("task add / run / wait：假执行者做完一件事", async () => {
    const added = json(
      atrium(
        "task",
        "add",
        "e2e-quick",
        "--repo",
        repo,
        "--deliver",
        "none",
        "--json",
      ),
      "task add",
    );
    if (added.result?.ref !== "t1")
      fail(`第一件任务应是 t1，收到 ${added.result?.ref}`);
    const ran = ok(
      atrium("task", "run", "t1", "--worker", "claude"),
      "task run t1",
    );
    if (/排队/.test(ran.stdout)) fail("task run t1 进了排队");
    const waited = json(
      atrium("task", "wait", "t1", "--timeout", "120", "--json"),
      "task wait t1",
    );
    if (waited.result?.timed_out) fail("task wait t1 超时");
    const task = waited.result?.task;
    if (task?.status !== "done")
      fail(
        `t1 应为 done，实际 ${task?.status}：${JSON.stringify(task?.events?.slice(-5) ?? task)}`,
      );
    const ls = ok(atrium("task", "ls"), "task ls");
    expect(ls.stdout, /t1/, "task ls");
  });

  await step("org tree：导入根章程、加一个项目节点，组织树可读", async () => {
    const charter = join(root, "charter.md");
    writeFileSync(charter, "---\n---\n端到端验证用的根章程。\n");
    ok(atrium("org", "import", charter, "--apply"), "org import --apply");
    const added = json(
      atrium(
        "org",
        "add",
        "o1",
        "e2e",
        "--kind",
        "project",
        "--name",
        "端到端",
        "--reason",
        "e2e",
        "--repo",
        repo,
        "--json",
      ),
      "org add",
    );
    const node = /o\d+/.exec(added.next ?? "")?.[0];
    if (!node) fail("org add 回执里没有新节点短号");
    ok(atrium("task", "set", "t1", "--part", node), "task set t1 --part");
    const tree = ok(atrium("org", "tree"), "org tree");
    expect(
      tree.stdout,
      new RegExp(`o1 \\[组织\\][\\s\\S]*${node} \\[项目\\] 端到端`),
      "org tree",
    );
    const listed = json(atrium("org", "tree", "--json"), "org tree --json");
    const found = listed.result.find((row) => row.ref === node);
    if (
      !found ||
      found.parent_id !== listed.result.find((row) => row.ref === "o1")?.id
    )
      fail(`org tree --json 里 ${node} 不在 o1 下`);
    if (
      (await showTask("t1")).part?.ref !== node &&
      !JSON.stringify(await showTask("t1")).includes(node)
    )
      fail(`t1 的归属部分不是 ${node}`);
  });

  await step(
    "quota：额度表可读（隔离环境没有登录，各账号说明读不到）",
    async () => {
      const quota = ok(atrium("quota"), "quota");
      expect(quota.stdout, /^claude\b/m, "quota");
      expect(quota.stdout, /给你留的份额/, "quota");
      const listed = json(atrium("quota", "--json"), "quota --json");
      const accounts = listed.result?.accounts ?? [];
      const claude = accounts.find((row) => row.providerId === "claude");
      if (!claude) fail("quota --json 没有 claude 账号");
      if (claude.usedPercent !== null) fail("隔离环境里不该读到 claude 用量");
    },
  );

  await step("events wait：取到 t1 的结束事件并确认", async () => {
    const got = json(
      atrium(
        "events",
        "wait",
        "--all",
        "--timeout",
        "30",
        "--settle",
        "0",
        "--json",
      ),
      "events wait",
    );
    const events = got.result?.events ?? [];
    const done = events.filter((event) => event.task === "t1");
    if (!done.length)
      fail(
        `events wait 没有 t1 的事件：${JSON.stringify(events.map((e) => [e.task, e.kind]))}`,
      );
    ok(
      atrium("events", "ack", ...events.map((event) => String(event.id))),
      "events ack",
    );
  });

  let pid;
  await step("restart：在跑的执行者被新服务接管，任务不丢", async () => {
    writeFileSync(hold, "");
    json(
      atrium(
        "task",
        "add",
        "e2e-across-restart",
        "--repo",
        repo,
        "--deliver",
        "none",
        "--json",
      ),
      "task add t2",
    );
    ok(atrium("task", "run", "t2", "--worker", "claude"), "task run t2");
    const deadline = Date.now() + 60_000;
    for (;;) {
      const task = await showTask("t2");
      pid = task.pid;
      if (task.status === "running" && pid && alive(pid)) break;
      if (task.status !== "running" && task.status !== "todo")
        fail(`t2 没跑起来：${task.status}`);
      if (Date.now() > deadline) fail("t2 60 秒内没跑起来");
      await sleep(300);
    }
    const before = servicePid();
    const restarting = ok(atrium("restart"), "restart");
    expect(restarting.stdout, /平滑重启已启动/, "restart");
    ok(atrium("restart", "--wait", "--timeout", "120"), "restart --wait");
    const after = servicePid();
    if (after === before) fail(`重启后服务 PID 没变（${before}）`);
    if (alive(before)) fail(`旧服务 PID ${before} 仍在`);
    if (!alive(pid)) fail(`执行者 pid ${pid} 随旧服务一起退出了`);
    // 接管在新服务启动后异步进行（Windows 上查进程命令行经 PowerShell，慢一些）。
    const adoptDeadline = Date.now() + 60_000;
    for (;;) {
      const task = await showTask("t2");
      if (task.status !== "running")
        fail(`重启后 t2 应仍在跑，实际 ${task.status}`);
      const adopted = task.events.find((event) => event.kind === "adopted");
      if (adopted) {
        console.log(
          `  新服务按 pid ${JSON.parse(adopted.detail).pid} 接管了 t2`,
        );
        break;
      }
      if (Date.now() > adoptDeadline) fail("新服务 60 秒内没有接管 t2");
      await sleep(500);
    }
    const ls = ok(atrium("task", "ls"), "task ls");
    for (const ref of ["t1", "t2"])
      expect(ls.stdout, new RegExp(`\\b${ref}\\b`), "重启后的 task ls");
  });

  await step("接管后收尾：放行执行者，t2 按日志判完成", async () => {
    rmSync(hold);
    const waited = json(
      atrium("task", "wait", "t2", "--timeout", "120", "--json"),
      "task wait t2",
    );
    const task = waited.result?.task;
    if (waited.result?.timed_out || task?.status !== "done")
      fail(
        `t2 应为 done，实际 ${task?.status}：${JSON.stringify(task?.events?.slice(-5))}`,
      );
    // 接管的进程没有退出码：按 stream-json 收尾的 result 事件判正常结束。
    const log = ok(atrium("task", "log", "t2"), "task log t2");
    expect(log.stdout, /按日志判为正常结束/, "task log t2");
    const deadline = Date.now() + 10_000;
    while (alive(pid)) {
      if (Date.now() > deadline) fail(`执行者 pid ${pid} 完成后没退出`);
      await sleep(200);
    }
    const got = json(
      atrium(
        "events",
        "wait",
        "--all",
        "--timeout",
        "30",
        "--settle",
        "0",
        "--json",
      ),
      "events wait（t2）",
    );
    const events = got.result?.events ?? [];
    if (!events.some((event) => event.task === "t2"))
      fail(
        `events wait 没有 t2 的事件：${JSON.stringify(events.map((e) => [e.task, e.kind]))}`,
      );
    ok(
      atrium("events", "ack", ...events.map((event) => String(event.id))),
      "events ack",
    );
  });

  await step("stop：停服务", async () => {
    const service = servicePid();
    ok(atrium("stop"), "stop");
    started = false;
    const deadline = Date.now() + 20_000;
    while (alive(service)) {
      if (Date.now() > deadline) fail(`stop 后服务 PID ${service} 仍在`);
      await sleep(200);
    }
    const status = atrium("status");
    expect(
      `${status.stdout}\n${status.stderr}`,
      /Atrium 未运行/,
      "stop 后的 atrium status",
    );
  });
  console.log("通过：主路径端到端全部走通");
} catch (error) {
  failed = true;
  console.error(
    `\n✗ 失败在「${current}」：${error instanceof StepFailure ? error.message : error.stack}`,
  );
  const detail = show(last);
  if (detail) console.error(detail);
  const log = join(data, "service.log");
  if (existsSync(log)) {
    const lines = readFileSync(log, "utf8").trimEnd().split("\n");
    console.error(`服务日志末尾（${log}）：\n${lines.slice(-40).join("\n")}`);
  }
  const tasks = join(data, "tasks");
  if (existsSync(tasks))
    for (const dir of readdirSync(tasks)) {
      const file = join(tasks, dir, "log");
      if (existsSync(file))
        console.error(
          `执行日志 ${file} 末尾：\n${readFileSync(file, "utf8").slice(-2000)}`,
        );
    }
} finally {
  if (started) atrium("stop");
  killLeftovers();
  if (failed || values.keep) console.error(`临时目录保留在 ${root}`);
  else rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
