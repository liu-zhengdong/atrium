import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  carriedEnvironment,
  installSteps,
  lingerOn,
  parseStatus,
  serviceDefinitionFiles,
  serviceLayout,
  statusQuery,
  uninstallSteps,
  type ServiceInput,
  type ServiceLayout,
  type ServicePlatform,
} from "../server/agent/service-plan.ts";
import {
  installService,
  serviceStatus,
  uninstallService,
} from "../server/agent/service.ts";
import { agentAlive, runAgent } from "../server/agent/run.ts";
import { AgentState } from "../server/agent/state.ts";
import { killTree, spawnNode } from "../server/platform/index.ts";
import { writeFakeBin } from "./fake-bin.ts";
import { removeTemp } from "./temp-dir.ts";

/**
 * 代理装成系统服务（t183）：服务定义与步骤按三平台穷举（纯函数）；
 * 安装、幂等、状态、卸载在本机平台上用假的 launchctl / systemctl / schtasks / loginctl 跑一遍，不往本机注册服务。
 */

const SECRET_PATH = "/opt/secret-path-marker/bin";

function input(platform: ServicePlatform, extra: Partial<ServiceInput> = {}) {
  const win = platform === "win32";
  return {
    platform,
    node: win ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node",
    script: win
      ? "C:\\Users\\ggb\\AppData\\Roaming\\npm\\node_modules\\atrium\\bin\\atrium.mjs"
      : "/usr/local/lib/node_modules/atrium/bin/atrium.mjs",
    data: win ? "C:\\Users\\ggb\\.atrium-agent" : "/home/ggb/.atrium-agent",
    home: win ? "C:\\Users\\ggb" : "/home/ggb",
    env: {
      PATH: SECRET_PATH,
      HTTPS_PROXY: "http://user:pass@proxy:7890",
      ANTHROPIC_API_KEY: "sk-should-not-appear",
      GH_TOKEN: "ghp_should_not_appear",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      ATRIUM_MAX_WORKERS: "3",
      LC_ALL: "zh_CN.UTF-8",
      USERNAME: "ggb",
      USERDOMAIN: "DESKTOP-H3",
      SystemRoot: "C:\\Windows",
    },
    uid: 501,
    user: "ggb",
    ...extra,
  } satisfies ServiceInput;
}

function layoutOf(
  platform: ServicePlatform,
  extra: Partial<ServiceInput> = {},
): ServiceLayout {
  const layout = serviceLayout(input(platform, extra));
  assert.ok(!("error" in layout), JSON.stringify(layout));
  return layout;
}

test("带上的环境：PATH、语言、出网代理、并发上限；凭据与身份类不带", () => {
  const carried = carriedEnvironment(input("darwin").env, "darwin");
  assert.deepEqual(Object.keys(carried).sort(), [
    "ATRIUM_MAX_WORKERS",
    "HTTPS_PROXY",
    "LC_ALL",
    "PATH",
  ]);
  // Windows 上变量名不分大小写，按大写落键。
  assert.deepEqual(
    carriedEnvironment({ Path: "C:\\bin", ApiToken: "x" }, "win32"),
    { PATH: "C:\\bin" },
  );
});

for (const platform of ["darwin", "linux", "win32"] as const)
  test(`${platform}：服务定义里只有命令行，不带令牌与环境值；环境单放 0600 文件`, () => {
    const layout = layoutOf(platform);
    const definitions = serviceDefinitionFiles(layout);
    assert.ok(definitions.length >= 1);
    for (const file of definitions) {
      for (const secret of [
        SECRET_PATH,
        "user:pass",
        "sk-should-not-appear",
        "ghp_should_not_appear",
      ])
        assert.ok(!file.content.includes(secret), `${file.path} 含 ${secret}`);
      assert.ok(!file.secret);
    }
    const env = layout.files.filter((file) => file.secret);
    assert.equal(env.length, 1);
    assert.match(env[0]!.path, /service-env\.json$/);
    assert.equal(JSON.parse(env[0]!.content).PATH, SECRET_PATH);
    assert.ok(!env[0]!.content.includes("sk-should-not-appear"));
    assert.deepEqual(layout.program.slice(2), [
      "agent",
      "--service",
      "--data",
      input(platform).data,
    ]);
    assert.ok(layout.locations.length >= 2);
  });

test("macOS：launchd 用户代理，登录时启动、非 0 退出才重起，日志追加到数据目录", () => {
  const layout = layoutOf("darwin", {
    data: "/Users/a&b/.atrium-agent",
  });
  assert.equal(
    layout.definition,
    "/home/ggb/Library/LaunchAgents/dev.atrium.agent.plist",
  );
  assert.equal(layout.target, "gui/501/dev.atrium.agent");
  const plist = serviceDefinitionFiles(layout)[0]!.content;
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(
    plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
  );
  assert.match(plist, /<string>\/Users\/a&amp;b\/\.atrium-agent<\/string>/);
  assert.match(
    plist,
    /<key>StandardErrorPath<\/key>\s*<string>\/Users\/a&amp;b\/\.atrium-agent\/agent-service\.log<\/string>/,
  );
  assert.deepEqual(serviceLayout({ ...input("darwin"), uid: undefined }), {
    error: "取不到当前用户 id，装不了 launchd 用户代理",
  });
});

test("Linux：systemd 用户服务，只停代理进程、异常退出重起；% 与 $ 与引号转义", () => {
  const layout = layoutOf("linux", {
    data: '/home/ggb/100%$HOME "x"',
    env: { ...input("linux").env, XDG_CONFIG_HOME: "/cfg" },
  });
  assert.equal(layout.definition, "/cfg/systemd/user/atrium-agent.service");
  const unit = serviceDefinitionFiles(layout)[0]!.content;
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartSec=10$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.match(
    unit,
    /^ExecStart="\/usr\/local\/bin\/node" "\/usr\/local\/lib\/node_modules\/atrium\/bin\/atrium\.mjs" "agent" "--service" "--data" "\/home\/ggb\/100%%\$\$HOME \\"x\\""$/m,
  );
  assert.match(
    unit,
    /^StandardOutput=append:\/home\/ggb\/100%%\$HOME "x"\/agent-service\.log$/m,
  );
  // 相对的 XDG_CONFIG_HOME 不认，回到 ~/.config。
  assert.equal(
    layoutOf("linux", {
      env: { ...input("linux").env, XDG_CONFIG_HOME: "cfg" },
    }).definition,
    "/home/ggb/.config/systemd/user/atrium-agent.service",
  );
});

test("Windows：本人登录时启动的计划任务，wscript 隐藏窗口拉起，不限运行时长", () => {
  const layout = layoutOf("win32");
  const [launcher, task] = serviceDefinitionFiles(layout);
  assert.equal(task!.encoding, "utf16le");
  assert.equal(layout.definition, task!.path);
  assert.match(task!.content, /<UserId>DESKTOP-H3\\ggb<\/UserId>/);
  assert.match(task!.content, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(task!.content, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(task!.content, /<Priority>5<\/Priority>/);
  assert.match(
    task!.content,
    /<Command>C:\\Windows\\System32\\wscript\.exe<\/Command>/,
  );
  assert.match(
    task!.content,
    /<Arguments>\/\/B \/\/Nologo \/\/E:JScript &quot;C:\\Users\\ggb\\\.atrium-agent\\agent-service\.js&quot;<\/Arguments>/,
  );
  assert.equal(
    launcher!.path,
    "C:\\Users\\ggb\\.atrium-agent\\agent-service.js",
  );
  // 隐藏窗口（Run 的第二个参数 0）、等退出、非 0 才重来。
  assert.match(launcher!.content, /shell\.Run\(command, 0, true\)/);
  assert.match(launcher!.content, /if \(code === 0\) break;/);
  const command = JSON.parse(
    /var command = (.*);/.exec(launcher!.content)![1]!,
  ) as string;
  assert.equal(
    command,
    'cmd.exe /d /s /c ""C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\ggb\\AppData\\Roaming\\npm\\node_modules\\atrium\\bin\\atrium.mjs" "agent" "--service" "--data" "C:\\Users\\ggb\\.atrium-agent" >> "C:\\Users\\ggb\\.atrium-agent\\agent-service.log" 2>&1"',
  );
  // 没有域名时只写用户名。
  assert.match(
    serviceDefinitionFiles(
      layoutOf("win32", {
        env: { USERNAME: "ggb" },
      }),
    )[1]!.content,
    /<UserId>ggb<\/UserId>/,
  );
});

test("装不进服务定义的参数给出原因", () => {
  assert.match(
    (serviceLayout({ ...input("linux"), data: "rel/dir" }) as { error: string })
      .error,
    /代理数据目录应为绝对路径/,
  );
  assert.match(
    (
      serviceLayout({ ...input("linux"), data: "/a\nb" }) as {
        error: string;
      }
    ).error,
    /换行/,
  );
  assert.match(
    (
      serviceLayout({
        ...input("win32"),
        data: "C:\\Users\\100%\\.atrium-agent",
      }) as { error: string }
    ).error,
    /" 或 %/,
  );
  assert.match(
    (
      serviceLayout({ ...input("win32"), env: {} }) as {
        error: string;
      }
    ).error,
    /USERNAME/,
  );
});

const commands = (steps: ReturnType<typeof installSteps>) =>
  steps.map((step) =>
    step.kind === "run"
      ? `${step.command} ${step.args.join(" ")}${step.allowFail ? " ?" : ""}`
      : step.kind,
  );

test("安装与卸载步骤：已装的先停再按新定义起；卸载时没装的步骤失败不要紧", () => {
  const mac = layoutOf("darwin");
  assert.deepEqual(commands(installSteps(mac, { installed: false })), [
    "launchctl enable gui/501/dev.atrium.agent ?",
    "launchctl bootstrap gui/501 /home/ggb/Library/LaunchAgents/dev.atrium.agent.plist",
  ]);
  assert.deepEqual(commands(installSteps(mac, { installed: true })), [
    "launchctl bootout gui/501/dev.atrium.agent ?",
    "launchctl enable gui/501/dev.atrium.agent ?",
    "launchctl bootstrap gui/501 /home/ggb/Library/LaunchAgents/dev.atrium.agent.plist",
  ]);
  assert.deepEqual(commands(uninstallSteps(mac)), [
    "launchctl bootout gui/501/dev.atrium.agent ?",
  ]);
  const linux = layoutOf("linux");
  assert.deepEqual(commands(installSteps(linux, { installed: true })), [
    "systemctl --user daemon-reload",
    "systemctl --user enable atrium-agent.service",
    "systemctl --user restart atrium-agent.service",
  ]);
  assert.deepEqual(commands(uninstallSteps(linux)), [
    "systemctl --user disable --now atrium-agent.service ?",
  ]);
  const win = layoutOf("win32");
  assert.deepEqual(commands(installSteps(win, { installed: false })), [
    "schtasks /Create /TN AtriumAgent /XML C:\\Users\\ggb\\.atrium-agent\\agent-service.xml /F",
    "schtasks /Run /TN AtriumAgent",
  ]);
  assert.deepEqual(commands(installSteps(win, { installed: true })), [
    "schtasks /End /TN AtriumAgent ?",
    "stop-agent",
    "schtasks /Create /TN AtriumAgent /XML C:\\Users\\ggb\\.atrium-agent\\agent-service.xml /F",
    "schtasks /Run /TN AtriumAgent",
  ]);
  assert.deepEqual(commands(uninstallSteps(win)), [
    "schtasks /End /TN AtriumAgent ?",
    "schtasks /Delete /TN AtriumAgent /F ?",
    "stop-agent",
  ]);
});

test("读状态：launchctl print、systemctl show、schtasks 只看退出码", () => {
  const mac = layoutOf("darwin");
  assert.deepEqual(statusQuery(mac), {
    command: "launchctl",
    args: ["print", "gui/501/dev.atrium.agent"],
  });
  assert.deepEqual(
    parseStatus("darwin", {
      ok: true,
      stdout:
        "gui/501/dev.atrium.agent = {\n\tstate = running\n\tpid = 4242\n}",
    }),
    { installed: true, running: true, pid: 4242, enabled: true },
  );
  assert.deepEqual(
    parseStatus("darwin", {
      ok: true,
      stdout: "gui/501/dev.atrium.agent = {\n\tstate = not running\n}",
    }),
    { installed: true, running: false, pid: null, enabled: true },
  );
  assert.deepEqual(parseStatus("darwin", { ok: false, stdout: "" }), {
    installed: false,
    running: false,
    pid: null,
    enabled: false,
  });
  assert.deepEqual(
    parseStatus("linux", {
      ok: true,
      stdout:
        "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=77\nUnitFileState=enabled\n",
    }),
    { installed: true, running: true, pid: 77, enabled: true },
  );
  assert.deepEqual(
    parseStatus("linux", {
      ok: true,
      stdout:
        "LoadState=not-found\nActiveState=inactive\nMainPID=0\nUnitFileState=\n",
    }),
    { installed: false, running: false, pid: null, enabled: false },
  );
  assert.deepEqual(
    parseStatus("linux", {
      ok: true,
      stdout:
        "LoadState=loaded\nActiveState=activating\nMainPID=0\nUnitFileState=disabled\n",
    }),
    { installed: true, running: false, pid: null, enabled: false },
  );
  assert.deepEqual(parseStatus("win32", { ok: true, stdout: "任意语言" }), {
    installed: true,
    running: null,
    pid: null,
    enabled: true,
  });
  assert.deepEqual(parseStatus("win32", { ok: false, stdout: "" }), {
    installed: false,
    running: false,
    pid: null,
    enabled: false,
  });
  assert.equal(lingerOn({ ok: true, stdout: "Linger=yes\n" }), true);
  assert.equal(lingerOn({ ok: true, stdout: "Linger=no\n" }), false);
  assert.equal(lingerOn({ ok: false, stdout: "Linger=yes\n" }), false);
});

// ---- IO：本机平台 + 假系统命令 ----

/** 假的 launchctl / systemctl / schtasks / loginctl：调用记进 calls.log，状态放 state.json。 */
const FAKE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const name = path.basename(process.argv[1]).replace(/\.(cmd|js)$/, "");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify([name, ...args]) + "\n");
const file = path.join(dir, "state.json");
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const out = (text) => process.stdout.write(text);
if (name === "launchctl") {
  if (args[0] === "print") {
    if (!state.loaded) { out("Could not find service"); process.exit(113); }
    out("x = {\n\tstate = running\n\tpid = 4242\n}\n");
  } else if (args[0] === "bootstrap") { state.loaded = true; save(); }
  else if (args[0] === "bootout") { if (!state.loaded) process.exit(3); state.loaded = false; save(); }
} else if (name === "systemctl") {
  const verb = args[1];
  if (verb === "show")
    out(state.loaded
      ? "LoadState=loaded\nActiveState=" + (state.active ? "active" : "inactive") + "\nMainPID=" + (state.active ? 77 : 0) + "\nUnitFileState=" + (state.enabled ? "enabled" : "disabled") + "\n"
      : "LoadState=not-found\nActiveState=inactive\nMainPID=0\nUnitFileState=\n");
  else if (verb === "enable") { state.loaded = true; state.enabled = true; save(); }
  else if (verb === "restart") { state.active = true; save(); }
  else if (verb === "disable") { state.loaded = false; state.enabled = false; state.active = false; save(); }
} else if (name === "loginctl") {
  if (args[0] === "show-user") out("Linger=" + (state.linger ? "yes" : "no") + "\n");
  else if (args[0] === "enable-linger") { state.linger = true; save(); }
} else if (name === "schtasks") {
  const verb = args[0];
  if (verb === "/Query") process.exit(state.created ? 0 : 1);
  if (verb === "/Create") { state.created = true; state.xml = fs.readFileSync(args[4]).subarray(0, 2).toString("hex"); save(); }
  if (verb === "/Delete") { if (!state.created) process.exit(1); state.created = false; save(); }
}
`;

function fakeSystem(root: string) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["launchctl", "systemctl", "loginctl", "schtasks"])
    writeFakeBin(join(bin, name), FAKE);
  const sep = process.platform === "win32" ? ";" : ":";
  // 只放假命令与 node：本机真的 launchctl / systemctl / schtasks 找不到。
  const env: NodeJS.ProcessEnv = {
    PATH: [bin, dirname(process.execPath)].join(sep),
    USERNAME: "tester",
    USERDOMAIN: "BOX",
    SystemRoot: process.env.SystemRoot,
    PATHEXT: process.env.PATHEXT,
    ANTHROPIC_API_KEY: "sk-should-not-appear",
  };
  const calls = () =>
    existsSync(join(bin, "calls.log"))
      ? readFileSync(join(bin, "calls.log"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[])
      : [];
  const state = () =>
    JSON.parse(readFileSync(join(bin, "state.json"), "utf8")) as Record<
      string,
      unknown
    >;
  return { bin, env, calls, state };
}

/** 改系统状态的调用（查询不算）。 */
const mutations = (calls: string[][]) =>
  calls.filter(
    ([name, first, second]) =>
      !(
        (name === "launchctl" && first === "print") ||
        (name === "systemctl" && second === "show") ||
        (name === "loginctl" && first === "show-user") ||
        (name === "schtasks" && first === "/Query")
      ),
  );

// 路径写法跟着本机：Unix 上 macOS 与 Linux 两种都跑，Windows 上跑计划任务。
const LOCAL: ServicePlatform[] =
  process.platform === "win32" ? ["win32"] : ["darwin", "linux"];

for (const platform of LOCAL)
  test(`${platform}（假系统命令）：装、再装不动、环境变了重装、看状态、卸载、再卸载`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "atrium-agent-service-"));
    t.after(() => removeTemp(root));
    const fake = fakeSystem(root);
    const data = join(root, "agent-data");
    mkdirSync(data);
    const home = join(root, "home");
    const deps = {
      platform,
      env: fake.env,
      home,
      uid: 501,
      user: "tester",
      retryMs: 0,
    };
    const first = await installService(data, deps);
    assert.equal(first.unchanged, false);
    const env = JSON.parse(
      readFileSync(join(data, "service-env.json"), "utf8"),
    ) as Record<string, string>;
    assert.equal(env.PATH, fake.env.PATH);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    if (process.platform !== "win32")
      assert.equal(
        statSync(join(data, "service-env.json")).mode & 0o777,
        0o600,
      );
    if (platform === "darwin") {
      assert.ok(
        existsSync(
          join(home, "Library", "LaunchAgents", "dev.atrium.agent.plist"),
        ),
      );
      assert.deepEqual(mutations(fake.calls()), [
        ["launchctl", "enable", "gui/501/dev.atrium.agent"],
        [
          "launchctl",
          "bootstrap",
          "gui/501",
          join(home, "Library", "LaunchAgents", "dev.atrium.agent.plist"),
        ],
      ]);
      assert.equal(first.running, true);
      assert.equal(first.pid, 4242);
    } else if (platform === "linux") {
      assert.ok(
        existsSync(
          join(home, ".config", "systemd", "user", "atrium-agent.service"),
        ),
      );
      assert.deepEqual(mutations(fake.calls()), [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "atrium-agent.service"],
        ["systemctl", "--user", "restart", "atrium-agent.service"],
        ["loginctl", "enable-linger", "tester"],
      ]);
      assert.equal(first.running, true);
      assert.equal(first.linger, true);
      assert.equal(first.lingerHint, null);
    } else {
      assert.ok(existsSync(join(data, "agent-service.js")));
      assert.equal(fake.state().xml, "fffe", "任务 XML 按 UTF-16 LE 带 BOM 写");
      assert.deepEqual(
        mutations(fake.calls()).map((call) => call.slice(0, 2)),
        [
          ["schtasks", "/Create"],
          ["schtasks", "/Run"],
        ],
      );
      // Windows 上在不在跑看代理登记的 pid：假装服务里的代理起来了（用本测试进程，不会被结束）。
      new AgentState(data).savePid({
        pid: process.pid,
        service: true,
        startedAt: Date.now(),
      });
    }

    // 再装一遍：定义没变、在跑，不动系统。
    const before = fake.calls().length;
    const again = await installService(data, deps);
    assert.equal(again.unchanged, true);
    assert.equal(again.running, true);
    assert.deepEqual(mutations(fake.calls().slice(before)), []);

    // 环境变了（PATH 多了一段）：按新定义重装，先停旧的。
    const changed = { ...deps, env: { ...fake.env, LANG: "zh_CN.UTF-8" } };
    const mark = fake.calls().length;
    const reinstall = await installService(data, changed);
    assert.equal(reinstall.unchanged, false);
    const redo = mutations(fake.calls().slice(mark)).map((call) =>
      call.slice(0, 2),
    );
    if (platform === "darwin")
      assert.deepEqual(redo, [
        ["launchctl", "bootout"],
        ["launchctl", "enable"],
        ["launchctl", "bootstrap"],
      ]);
    else if (platform === "linux")
      assert.deepEqual(redo, [
        ["systemctl", "--user"],
        ["systemctl", "--user"],
        ["systemctl", "--user"],
      ]);
    else
      assert.deepEqual(redo, [
        ["schtasks", "/End"],
        ["schtasks", "/Create"],
        ["schtasks", "/Run"],
      ]);

    // 看状态：装了、在跑；换个环境看不算过时，换了 Atrium 入口才算。
    appendFileSync(
      join(data, "agent-service.log"),
      "Atrium 代理（系统服务）\n[10:00:00] 已连上 http://127.0.0.1:4310\n",
    );
    const status = await serviceStatus(data, deps);
    assert.equal(status.installed, true);
    assert.equal(status.running, true);
    assert.equal(status.stale, false);
    assert.equal(status.host, null);
    assert.deepEqual(status.tail.slice(-1), [
      "[10:00:00] 已连上 http://127.0.0.1:4310",
    ]);
    assert.equal(
      (await serviceStatus(data, { ...deps, script: join(root, "moved.mjs") }))
        .stale,
      true,
    );

    // 卸载：删服务定义，令牌与 service-env.json 留在数据目录。
    const removed = await uninstallService(data, changed);
    assert.equal(removed.absent, false);
    assert.ok(removed.removed.length >= 1);
    for (const file of removed.removed) assert.ok(!existsSync(file), file);
    assert.ok(existsSync(join(data, "service-env.json")));
    const gone = await serviceStatus(data, changed);
    assert.equal(gone.installed, false);
    assert.equal((await uninstallService(data, changed)).absent, true);
  });

test("同一数据目录只跑一个代理：服务里的代理等前台的停下，前台的遇到服务里的拒绝", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atrium-agent-lock-"));
  t.after(() => removeTemp(root));
  const data = join(root, "data");
  const state = new AgentState(data);
  state.saveConfig({
    server: "http://127.0.0.1:9",
    host: "h9",
    token: "h9-token",
  });
  // 一个命令行带 agent 的活进程，冒充另一个代理。
  const other = spawnNode(["-e", "setTimeout(() => {}, 30000)", "agent"], {
    stdio: "ignore",
  });
  t.after(() => {
    if (other.pid) killTree(other.pid, "SIGKILL");
  });
  const pid = other.pid!;
  const plain = spawnNode(["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
  });
  t.after(() => {
    if (plain.pid) killTree(plain.pid, "SIGKILL");
  });
  assert.equal(await agentAlive({ pid, service: false, startedAt: 0 }), true);
  assert.equal(
    await agentAlive({ pid: plain.pid!, service: false, startedAt: 0 }),
    false,
    "命令行里没有 agent 的不算（pid 复用）",
  );
  assert.equal(
    await agentAlive({ pid: process.pid, service: true, startedAt: 0 }),
    false,
  );
  assert.equal(await agentAlive(null), false);

  state.savePid({ pid, service: false, startedAt: Date.now() });
  assert.equal(await runAgent({ data, service: true }), 1);
  state.savePid({ pid, service: true, startedAt: Date.now() });
  await assert.rejects(runAgent({ data }), /已有代理在跑（系统服务，PID/);
  // 别的代理登记的 pid 不动。
  assert.equal(state.pid()?.pid, pid);
  writeFileSync(state.pidFile, "坏的");
  assert.equal(state.pid(), null);
});
