import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
  cmdShimTarget,
  commandLineInvocation,
  commandInvocation,
  executableNames,
  findExecutable,
  hasParentSegment,
  isAbsolutePath,
  isBatchFile,
  killTree,
  killTreePlan,
  launchInvocation,
  openUrlInvocation,
  pathDelimiter,
  pathExtensions,
  processAlive,
  samePath,
  quoteCmdArg,
  shellInvocation,
  spawnInvocation,
  hiddenLaunch,
  HIDDEN_LAUNCHER,
  spawnShell,
  trimTrailingSeparators,
  type Platform,
} from "../server/platform/index.ts";
import { serviceEnvironment } from "../server/service-env.ts";
import {
  workerAllowed,
  workerEnvironment,
} from "../server/tasks/worker-env.ts";
import { readNumberLine, waitExit } from "./child-output.ts";
import { removeTemp } from "./temp-dir.ts";

const PLATFORMS: Platform[] = ["darwin", "linux", "win32"];

test("结束进程树：Unix 给进程组发原信号，Windows 一律 taskkill /T /F", () => {
  for (const platform of PLATFORMS)
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      const plan = killTreePlan(platform, 4321, signal);
      if (platform === "win32")
        assert.deepEqual(plan, {
          command: "taskkill",
          args: ["/T", "/F", "/PID", "4321"],
        });
      else assert.deepEqual(plan, { kind: "group", pid: -4321, signal });
    }
});

test("shell 命令：Unix /bin/sh -c，Windows cmd.exe /d /s /c 整条加引号", () => {
  for (const platform of PLATFORMS) {
    const call = shellInvocation(platform, "npm run check && echo ok");
    if (platform === "win32") {
      assert.deepEqual(call, {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", '"npm run check && echo ok"'],
        verbatim: true,
      });
      assert.equal(
        shellInvocation(platform, "x", "C:\\Windows\\system32\\cmd.exe")
          .command,
        "C:\\Windows\\system32\\cmd.exe",
      );
    } else
      assert.deepEqual(call, {
        command: "/bin/sh",
        args: ["-c", "npm run check && echo ok"],
      });
  }
});

test("可执行文件名：Windows 按 PATHEXT 补扩展名，已带扩展名只找原名；Unix 原名", () => {
  assert.deepEqual(pathExtensions(undefined), [".com", ".exe", ".bat", ".cmd"]);
  assert.deepEqual(pathExtensions(".EXE; .CMD;;junk"), [".exe", ".cmd"]);
  for (const platform of PLATFORMS) {
    const names = executableNames(platform, "codex", ".EXE;.CMD");
    if (platform === "win32") {
      assert.deepEqual(names, ["codex.exe", "codex.cmd"]);
      assert.deepEqual(executableNames(platform, "npm.CMD", ".EXE;.CMD"), [
        "npm.CMD",
      ]);
      assert.equal(pathDelimiter(platform), ";");
    } else {
      assert.deepEqual(names, ["codex"]);
      assert.equal(pathDelimiter(platform), ":");
    }
    assert.equal(isBatchFile(platform, "C:\\a\\x.CMD"), platform === "win32");
    assert.equal(isBatchFile(platform, "C:\\a\\x.bat"), platform === "win32");
    assert.equal(isBatchFile(platform, "C:\\a\\x.exe"), false);
  }
});

test("cmd.exe 参数转义：引号、结尾反斜杠、元字符；npm .bin 包装二次转义", () => {
  assert.equal(quoteCmdArg("plain"), '^"plain^"');
  assert.equal(quoteCmdArg("a b"), '^"a^ b^"');
  assert.equal(quoteCmdArg('say "hi"'), '^"say^ \\^"hi\\^"^"');
  assert.equal(quoteCmdArg("C:\\dir\\"), '^"C:\\dir\\\\^"');
  assert.equal(quoteCmdArg("a&b|c>d<e^f%g!h"), '^"a^&b^|c^>d^<e^^f^%g^!h^"');
  assert.equal(quoteCmdArg("&", true), '^^^"^^^&^^^"');
});

const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*
`;

test("npm 的 .cmd 包装：认出 node 脚本与原生程序，其余交回 cmd.exe", () => {
  assert.deepEqual(cmdShimTarget(NPM_SHIM, "C:\\npm\\"), {
    program: "node",
    target: "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode",
  });
  assert.deepEqual(
    cmdShimTarget(
      '@ECHO off\r\n"%~dp0\\node_modules\\x\\bin\\x.exe"   %*\r\n',
      "C:\\npm",
    ),
    { program: "direct", target: "C:\\npm\\node_modules\\x\\bin\\x.exe" },
  );
  // 解释器不是 node（例如 sh 脚本）、或认不出的批处理：不猜。
  assert.equal(
    cmdShimTarget(
      NPM_SHIM.replaceAll('_prog=node"', '_prog=sh"').replace(
        '_prog=%dp0%\\node.exe"',
        '_prog=%dp0%\\sh.exe"',
      ),
      "C:\\npm",
    ),
    undefined,
  );
  assert.equal(
    cmdShimTarget("@echo off\r\nnode x.js %*\r\n", "C:\\"),
    undefined,
  );
});

test("拉起调用：Unix 与 Windows 非批处理原样；批处理走包装目标或 cmd.exe", () => {
  for (const platform of PLATFORMS)
    assert.deepEqual(
      launchInvocation({
        platform,
        file: "/usr/bin/codex",
        args: ["exec", "-"],
      }),
      { command: "/usr/bin/codex", args: ["exec", "-"] },
    );
  // Unix 上 .cmd 只是个普通文件名。
  assert.deepEqual(
    launchInvocation({ platform: "linux", file: "/x/a.cmd", args: ["p\nq"] }),
    { command: "/x/a.cmd", args: ["p\nq"] },
  );
  const prompt = '第一行\n第二行 & "引号"';
  assert.deepEqual(
    launchInvocation({
      platform: "win32",
      file: "C:\\npm\\opencode.cmd",
      args: ["run", "--", prompt],
      shim: { text: NPM_SHIM, dir: "C:\\npm" },
      nodePath: "C:\\node\\node.exe",
    }),
    {
      command: "C:\\node\\node.exe",
      args: [
        "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode",
        "run",
        "--",
        prompt,
      ],
    },
  );
  const viaCmd = launchInvocation({
    platform: "win32",
    file: "C:\\Program Files\\nodejs\\npm.cmd",
    args: ["run", "check"],
    comspec: "C:\\Windows\\cmd.exe",
  });
  assert.deepEqual(viaCmd, {
    command: "C:\\Windows\\cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      '"C:\\Program^ Files\\nodejs\\npm.cmd ^"run^" ^"check^""',
    ],
    verbatim: true,
  });
  assert.throws(
    () =>
      launchInvocation({
        platform: "win32",
        file: "C:\\tools\\kimi.bat",
        args: ["-p", "a\nb"],
      }),
    /参数含换行/,
  );
});

test("路径：绝对路径与 .. 段按平台判定", () => {
  const cases: Array<[string, boolean, boolean]> = [
    // 路径, Unix 绝对, Windows 绝对
    ["/srv/repo", true, true],
    ["C:\\repo", false, true],
    ["c:/repo", false, true],
    ["\\\\server\\share", false, true],
    ["C:repo", false, false],
    ["repo", false, false],
    ["\\repo", false, true],
  ];
  for (const [path, unix, win] of cases) {
    assert.equal(isAbsolutePath("linux", path), unix, path);
    assert.equal(isAbsolutePath("darwin", path), unix, path);
    assert.equal(isAbsolutePath("win32", path), win, path);
  }
  assert.equal(hasParentSegment("linux", "/a/../b"), true);
  assert.equal(hasParentSegment("linux", "/a/..b"), false);
  assert.equal(hasParentSegment("linux", "C:\\a\\..\\b"), false);
  assert.equal(hasParentSegment("win32", "C:\\a\\..\\b"), true);
  assert.equal(hasParentSegment("win32", "C:/a/../b"), true);
});

test("打开链接：macOS open、Windows explorer、Linux xdg-open", () => {
  assert.equal(openUrlInvocation("darwin", "u").command, "open");
  assert.equal(openUrlInvocation("win32", "u").command, "explorer");
  assert.equal(openUrlInvocation("linux", "u").command, "xdg-open");
  assert.deepEqual(openUrlInvocation("linux", "http://x").args, ["http://x"]);
});

test("环境白名单：Windows 变量名不分大小写并放行系统变量，凭据照样丢弃", () => {
  const base = {
    Path: "C:\\bin",
    SystemRoot: "C:\\Windows",
    PATHEXT: ".EXE;.CMD",
    ComSpec: "C:\\Windows\\cmd.exe",
    USERPROFILE: "C:\\Users\\u",
    GITHUB_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    HERDR_PANE: "1",
    ATRIUM_PORT: "4999",
  };
  const win = workerEnvironment(base, "win32");
  assert.equal(win.PATH, "C:\\bin");
  assert.equal(win.SYSTEMROOT, "C:\\Windows");
  assert.equal(win.COMSPEC, "C:\\Windows\\cmd.exe");
  assert.equal(win.USERPROFILE, "C:\\Users\\u");
  for (const key of [
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "HERDR_PANE",
    "ATRIUM_PORT",
  ])
    assert.equal(win[key], undefined, key);
  assert.equal(win.ATRIUM_WORKER, "1");
  // Unix 不认 Windows 专有变量，也不改名。
  const unix = workerEnvironment(base, "linux");
  assert.equal(unix.PATH, undefined);
  assert.equal(unix.SYSTEMROOT, undefined);
  assert.equal(workerAllowed("SystemRoot", "darwin"), false);
  assert.equal(workerAllowed("SystemRoot", "win32"), true);
  assert.equal(workerAllowed("path", "win32"), true);

  const service = serviceEnvironment(base, "win32");
  assert.equal(service.env.PATH, "C:\\bin");
  assert.equal(service.env.SYSTEMROOT, "C:\\Windows");
  assert.equal(service.env.ATRIUM_PORT, "4999");
  assert.deepEqual(service.droppedSensitive, [
    "GITHUB_TOKEN",
    "HERDR_PANE",
    "OPENAI_API_KEY",
  ]);
  assert.equal(serviceEnvironment(base, "linux").env.SYSTEMROOT, undefined);
});

test("本机：按名字找可执行文件、拉起 shell 命令、判断进程存活", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-platform-"));
  t.after(() => removeTemp(root));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const name = process.platform === "win32" ? "tool.cmd" : "tool";
  writeFileSync(
    join(bin, name),
    process.platform === "win32" ? "@echo hi\r\n" : "#!/bin/sh\necho hi\n",
    {
      mode: 0o755,
    },
  );
  const path = [join(root, "missing"), bin].join(delimiter);
  assert.equal(findExecutable("tool", path), join(bin, name));
  assert.equal(findExecutable("absent", path), undefined);
  const call = commandInvocation("tool", ["x"], { PATH: path });
  if (process.platform === "win32") assert.equal(call.verbatim, true);
  else assert.deepEqual(call, { command: join(bin, name), args: ["x"] });

  const child = spawnShell("echo platform-ok", {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout!.on("data", (chunk) => (out += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.match(out, /platform-ok/);
  assert.equal(processAlive(process.pid), true);
  assert.equal(processAlive(child.pid!), false);
});

test("本机：结束进程树连孙进程一起结束", async (t) => {
  // 子进程再拉一个孙进程并报出其 pid，然后都常驻。
  const script = `
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    g.on("error", (error) => { console.error(error.message); process.exit(1); });
    process.stdout.write(g.pid + "\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawnInvocation(
    { command: process.execPath, args: ["-e", script] },
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let grandchild: number | undefined;
  // 中途断言失败也要收掉整棵树：否则常驻的子进程开着管道，整份测试文件结束不了。
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      killTree(child.pid!, "SIGKILL");
    if (grandchild && processAlive(grandchild))
      process.kill(grandchild, "SIGKILL");
  });
  grandchild = await readNumberLine(child, "孙进程 pid");
  assert.ok(processAlive(grandchild), `孙进程 ${grandchild} 拉起后不在`);
  killTree(child.pid!, "SIGTERM");
  await waitExit(child, "killTree SIGTERM 后子进程没有退出");
  const deadline = Date.now() + 10_000;
  while (processAlive(grandchild) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    processAlive(grandchild),
    false,
    `killTree SIGTERM 后 10 秒孙进程 ${grandchild} 仍在`,
  );
});

test("去掉结尾分隔符：保留根路径，Windows 两种分隔符都去", () => {
  const cases: Array<[Platform, string, string]> = [
    ["linux", "/repo/atrium/", "/repo/atrium"],
    ["linux", "/repo/atrium//", "/repo/atrium"],
    ["linux", "/", "/"],
    ["linux", "C:\\repo\\", "C:\\repo\\"],
    ["darwin", "/a", "/a"],
    ["win32", "C:\\repo\\", "C:\\repo"],
    ["win32", "C:\\repo/", "C:\\repo"],
    ["win32", "/repo/atrium/", "/repo/atrium"],
    ["win32", "C:\\", "C:\\"],
    ["win32", "C:/", "C:/"],
    ["win32", "\\\\server\\share\\", "\\\\server\\share\\"],
  ];
  for (const [platform, path, expected] of cases)
    assert.equal(
      trimTrailingSeparators(platform, path),
      expected,
      `${platform} ${path}`,
    );
});

test("detached：Unix 与不 detached 的原样；Windows 要求 detached 的经隐藏控制台中转", () => {
  const direct = {
    command: "C:\\bin\\codex.exe",
    args: ["exec", "多行\n提示"],
  };
  const viaCmd = shellInvocation("win32", "npm run check");
  const input = { nodePath: "C:\\node\\node.exe", stdin: false };
  for (const requested of [false, undefined]) {
    assert.deepEqual(hiddenLaunch("win32", direct, requested, input), {
      invocation: direct,
      detached: requested,
    });
    assert.deepEqual(hiddenLaunch("win32", viaCmd, requested, input), {
      invocation: viaCmd,
      detached: requested,
    });
  }
  for (const platform of ["darwin", "linux"] as const)
    for (const requested of [true, false, undefined])
      assert.deepEqual(hiddenLaunch(platform, direct, requested, input), {
        invocation: direct,
        detached: requested,
      });
  assert.deepEqual(
    hiddenLaunch("win32", direct, true, { ...input, stdin: true }),
    {
      invocation: {
        command: "C:\\node\\node.exe",
        args: [
          "-e",
          HIDDEN_LAUNCHER,
          "--",
          '{"stdin":true,"verbatim":false}',
          "C:\\bin\\codex.exe",
          "exec",
          "多行\n提示",
        ],
      },
      detached: true,
    },
  );
  // 经 cmd.exe 的也中转（中转下 cmd.exe 有控制台和管道，输出不丢），中转本身不再原样拼命令行。
  const wrapped = hiddenLaunch("win32", viaCmd, true, input);
  assert.equal(wrapped.detached, true);
  assert.equal(wrapped.invocation.verbatim, undefined);
  assert.deepEqual(wrapped.invocation.args.slice(3), [
    '{"stdin":false,"verbatim":true}',
    viaCmd.command,
    ...viaCmd.args,
  ]);
});

/** 在本机直接跑中转脚本（判定只在 Windows 上启用它，脚本本身三平台一样）。 */
function runLauncher(
  root: string,
  options: { stdin: boolean; stdio: ("ignore" | "pipe" | number)[] },
  command: string,
  args: string[],
) {
  return spawn(
    process.execPath,
    [
      "-e",
      HIDDEN_LAUNCHER,
      "--",
      JSON.stringify({ stdin: options.stdin, verbatim: false }),
      command,
      ...args,
    ],
    { cwd: root, stdio: options.stdio, windowsHide: true },
  );
}

test("本机：隐藏控制台中转把输出写进日志、转发标准输入、按程序退出码退出", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-launcher-"));
  t.after(() => removeTemp(root));
  const log = join(root, "worker.log");
  writeFileSync(log, "[atrium] 抬头\n");
  const out = openSync(log, "a");
  const child = runLauncher(
    root,
    { stdin: true, stdio: ["pipe", out, out] },
    process.execPath,
    [
      "-e",
      `let s = "";
       process.stdin.on("data", (c) => (s += c));
       process.stdin.on("end", () => {
         process.stdout.write("收到 " + s.trim() + "\\n");
         process.stderr.write("错误输出\\n");
         process.exit(7);
       });`,
    ],
  );
  closeSync(out);
  child.stdin!.end("多行\n提示");
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 7);
  const text = readFileSync(log, "utf8");
  assert.match(text, /^\[atrium\] 抬头\n/);
  assert.match(text, /收到 多行\n提示/);
  assert.match(text, /错误输出/);
});

test("本机：隐藏控制台中转不转发标准输入时照常退出，拉不起程序时记原因并退出 127", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-launcher-"));
  t.after(() => removeTemp(root));
  const ok = runLauncher(
    root,
    { stdin: false, stdio: ["ignore", "pipe", "pipe"] },
    process.execPath,
    ["-e", "process.stdout.write('pipe-ok')"],
  );
  let text = "";
  ok.stdout!.on("data", (chunk) => (text += chunk));
  assert.equal(await new Promise((resolve) => ok.on("close", resolve)), 0);
  assert.equal(text, "pipe-ok");

  const missing = runLauncher(
    root,
    { stdin: false, stdio: ["ignore", "ignore", "pipe"] },
    join(root, "no-such-program"),
    [],
  );
  let err = "";
  missing.stderr!.on("data", (chunk) => (err += chunk));
  assert.equal(
    await new Promise((resolve) => missing.on("close", resolve)),
    127,
  );
  assert.match(err, /拉起 .*no-such-program 失败/);
});

test("同一路径：Windows 不分大小写、两种分隔符等同；Unix 严格比较", () => {
  assert.equal(
    samePath("win32", "C:/Users/a/repo-t1", "c:\\users\\A\\repo-t1"),
    true,
  );
  assert.equal(samePath("win32", "C:\\a\\b\\", "C:/a/b"), true);
  assert.equal(samePath("win32", "C:\\a\\b", "C:\\a\\c"), false);
  assert.equal(samePath("linux", "/a/B", "/a/b"), false);
  assert.equal(samePath("darwin", "/a/b/", "/a/b"), true);
  assert.equal(samePath("linux", "/a\\b", "/a/b"), false);
});

test("读进程命令行：Unix ps -ww，Windows 经 PowerShell 查 Win32_Process；进程号须为正整数", () => {
  assert.deepEqual(commandLineInvocation("linux", 42), {
    command: "ps",
    args: ["-ww", "-o", "command=", "-p", "42"],
  });
  assert.deepEqual(commandLineInvocation("darwin", 42).command, "ps");
  const win = commandLineInvocation("win32", 42);
  assert.equal(win.command, "powershell.exe");
  assert.match(win.args.at(-1)!, /ProcessId=42\b/);
  for (const bad of [0, -1, 1.5, Number.NaN])
    assert.throws(() => commandLineInvocation("linux", bad), /进程号不合法/);
});
