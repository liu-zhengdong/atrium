import { posix, win32 } from "node:path";
import { envKey, type Invocation, type Platform } from "../platform/plan.ts";

/**
 * 代理装成系统服务（t183）的纯判定：三平台各写什么文件、跑哪些系统命令、怎么读状态。
 * IO 在 `service.ts`；这里只吃参数，按平台穷举测试（`tests/agent-service.test.ts`）。
 *
 * - macOS：launchd 用户代理 `~/Library/LaunchAgents/dev.atrium.agent.plist`（登录时启动，异常退出 10 秒后重起）。
 * - Linux：systemd 用户服务 `~/.config/systemd/user/atrium-agent.service`（开机启动要 linger）；
 *   `KillMode=process`：停服务只停代理，执行者照跑（和前台代理 Ctrl-C 一样）。
 * - Windows：计划任务 `AtriumAgent`，本人登录时启动；经 wscript 跑一个 JScript 以隐藏窗口拉起代理
 *   （与 t167 不弹窗一致），异常退出 10 秒后重来。
 *
 * 服务定义里只有命令行（node、atrium 入口、`agent --service --data 数据目录`），不写令牌也不写环境变量：
 * 令牌在数据目录的 `agent.json`（0600），代理要带的环境（PATH、语言、出网代理、并发上限）写进
 * 数据目录的 `service-env.json`（0600），代理以服务身份起来时自己读。
 * 代理令牌失效时以 0 退出（重起也没用），其余异常以非 0 退出，由系统按上面的规则重起。
 */

export type ServicePlatform = "darwin" | "linux" | "win32";

export const LAUNCHD_LABEL = "dev.atrium.agent";
export const SYSTEMD_UNIT = "atrium-agent.service";
export const WINDOWS_TASK = "AtriumAgent";
/** 异常退出后多久重起（秒）。 */
export const RESTART_SECONDS = 10;

export const SERVICE_ENV_FILE = "service-env.json";
export const SERVICE_LOG_FILE = "agent-service.log";

export function servicePlatform(platform: Platform): ServicePlatform | null {
  return platform === "darwin" || platform === "linux" || platform === "win32"
    ? platform
    : null;
}

/** 代理以服务身份运行时要带上的环境：和前台运行时一样出得了网、找得到编码 CLI、守同样的并发上限。 */
const CARRIED = new Set([
  "PATH",
  "LANG",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "ATRIUM_BUSY_CORES",
  "ATRIUM_BUSY_LOAD",
  "ATRIUM_CHECK_TIMEOUT_MINUTES",
  "ATRIUM_MAX_CHECKS",
  "ATRIUM_MAX_WORKERS",
  "ATRIUM_QUOTA_READERS",
  "ATRIUM_TEST_CONCURRENCY",
]);

/** 白名单里的环境（Windows 上变量名按大写落键）；白名单外的不看值。 */
export function carriedEnvironment(
  env: NodeJS.ProcessEnv,
  platform: Platform,
): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    const name = platform === "win32" ? envKey(platform, key) : key;
    if (CARRIED.has(name) || /^LC_[A-Z_]+$/.test(name)) carried[name] = value;
  }
  return Object.fromEntries(
    Object.entries(carried).sort(([a], [b]) => a.localeCompare(b)),
  );
}

export type ServiceInput = {
  platform: ServicePlatform;
  /** node 可执行文件的绝对路径。 */
  node: string;
  /** Atrium 命令行入口（包里的 bin/atrium.mjs）。 */
  script: string;
  /** 代理数据目录（绝对路径）。 */
  data: string;
  home: string;
  /** 当前环境：取要带上的变量，Linux 取 XDG_CONFIG_HOME，Windows 取 USERDOMAIN、USERNAME、SystemRoot。 */
  env: NodeJS.ProcessEnv;
  /** macOS 的用户 id（launchctl 的 gui/<uid> 域）。 */
  uid?: number;
  /** Linux 的用户名（查 linger）。 */
  user?: string;
};

export type ServiceFile = {
  path: string;
  content: string;
  /** Windows 计划任务的 XML 按 UTF-16 写（schtasks /XML 认 UTF-16）。 */
  encoding: "utf8" | "utf16le";
  /** 只留给本人（0600）：service-env.json 里可能有带口令的出网代理地址。 */
  secret?: boolean;
};

export type ServiceLayout = {
  platform: ServicePlatform;
  /** launchd 标签、systemd 单元名或计划任务名。 */
  name: string;
  /** launchctl 的服务目标 gui/<uid>/<标签>。 */
  target?: string;
  files: ServiceFile[];
  /** 交给系统的那份定义：plist、systemd 单元或计划任务 XML。 */
  definition: string;
  /** 服务的标准输出与错误都追加到这里。 */
  log: string;
  /** 代理以服务身份起来时的命令行（程序 + 参数）。 */
  program: string[];
  /** 改动了哪些系统位置（回执与 PR 里写清楚）。 */
  locations: string[];
};

export type Step =
  | {
      kind: "run";
      command: string;
      args: string[];
      /** 失败也接着往下走（先卸再装、停一个可能没在跑的服务）。 */
      allowFail?: boolean;
      /** 失败时隔一秒再试几次（launchctl bootout 之后马上 bootstrap 可能还没卸完）。 */
      retries?: number;
    }
  /** 按数据目录里的 agent.pid 结束代理进程（只这一个进程，执行者照跑）；Windows 上结束计划任务不一定带走它。 */
  | { kind: "stop-agent" };

const pathOf = (platform: ServicePlatform) =>
  platform === "win32" ? win32 : posix;

const xml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** systemd 单元里双引号内的参数：反斜杠与引号转义，`%` 是说明符、`$` 会展开，都要写两遍。 */
const systemdQuote = (text: string) =>
  `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

/** systemd 里不加引号的路径值（WorkingDirectory、append:）：只转义说明符。 */
const systemdPath = (text: string) => text.replace(/%/g, "%%");

function plist(layout: {
  label: string;
  program: string[];
  data: string;
  log: string;
}) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<!-- Atrium 代理：atrium agent install 生成，卸载用 atrium agent install --uninstall -->",
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(layout.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...layout.program.map((arg) => `    <string>${xml(arg)}</string>`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${xml(layout.data)}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    // 非 0 退出才重起：令牌失效时代理以 0 退出，不白白重试。
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    `  <integer>${RESTART_SECONDS}</integer>`,
    "  <key>StandardOutPath</key>",
    `  <string>${xml(layout.log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(layout.log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function systemdUnit(layout: { program: string[]; data: string; log: string }) {
  return [
    "# Atrium 代理：atrium agent install 生成，卸载用 atrium agent install --uninstall",
    "[Unit]",
    "Description=Atrium agent",
    // 重起不设次数上限：服务那头长时间不在时代理自己在重连，这里只兜进程异常退出。
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${layout.program.map(systemdQuote).join(" ")}`,
    `WorkingDirectory=${systemdPath(layout.data)}`,
    "Restart=on-failure",
    `RestartSec=${RESTART_SECONDS}`,
    // 只停代理进程：执行者在独立进程组里照跑，代理再起来按运行记录接着看。
    "KillMode=process",
    `StandardOutput=append:${systemdPath(layout.log)}`,
    `StandardError=append:${systemdPath(layout.log)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** cmd.exe 双引号里的参数：% 会展开、" 无法转义，这两种字符不收（在 serviceLayout 里拒绝）。 */
const cmdQuote = (text: string) => `"${text}"`;

/** 隐藏窗口拉起代理的 JScript：wscript 本身没有窗口，Run 的第二个参数 0 让 cmd 与 node 也不开窗口。 */
function windowsLauncher(layout: { program: string[]; log: string }) {
  const line = `${layout.program.map(cmdQuote).join(" ")} >> ${cmdQuote(layout.log)} 2>&1`;
  const command = `cmd.exe /d /s /c "${line}"`;
  return [
    "// Atrium 代理：atrium agent install 生成，卸载用 atrium agent install --uninstall",
    "// 以隐藏窗口拉起代理；非 0 退出隔一会儿重来，令牌失效（以 0 退出）或本文件已删（卸载）就停。",
    'var shell = new ActiveXObject("WScript.Shell");',
    'var files = new ActiveXObject("Scripting.FileSystemObject");',
    `var command = ${JSON.stringify(command)};`,
    "while (true) {",
    "  var code = shell.Run(command, 0, true);",
    "  if (code === 0) break;",
    `  WScript.Sleep(${RESTART_SECONDS * 1000});`,
    "  if (!files.FileExists(WScript.ScriptFullName)) break;",
    "}",
    "",
  ].join("\r\n");
}

function windowsTask(layout: {
  user: string;
  wscript: string;
  launcher: string;
  data: string;
}) {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Atrium 代理：atrium agent install 生成，卸载用 atrium agent install --uninstall</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    // 只在本人登录时：不需要管理员，也不需要存密码。
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${xml(layout.user)}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${xml(layout.user)}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    // 缺省 72 小时后强行结束；代理要常驻。
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    // 缺省 7 是低于正常：执行者会继承，跑得比前台代理拉起的慢。
    "    <Priority>5</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xml(layout.wscript)}</Command>`,
    `      <Arguments>${xml(`//B //Nologo //E:JScript "${layout.launcher}"`)}</Arguments>`,
    `      <WorkingDirectory>${xml(layout.data)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** 这台要写的服务文件与命令行；参数装不进服务定义时给出原因。 */
export function serviceLayout(
  input: ServiceInput,
): ServiceLayout | { error: string } {
  const { platform } = input;
  const path = pathOf(platform);
  for (const [label, value] of [
    ["node 路径", input.node],
    ["Atrium 入口", input.script],
    ["代理数据目录", input.data],
  ] as const) {
    if (!path.isAbsolute(value))
      return { error: `${label}应为绝对路径（收到：${value}）` };
    if (/[\r\n\0]/.test(value)) return { error: `${label}里有换行或空字符` };
    if (platform === "win32" && /["%]/.test(value))
      return {
        error: `${label}里有 " 或 %，Windows 计划任务经 cmd.exe 拉起时装不进去：${value}`,
      };
  }
  const program = [
    input.node,
    input.script,
    "agent",
    "--service",
    "--data",
    input.data,
  ];
  const log = path.join(input.data, SERVICE_LOG_FILE);
  const envFile: ServiceFile = {
    path: path.join(input.data, SERVICE_ENV_FILE),
    content: `${JSON.stringify(carriedEnvironment(input.env, platform), null, 2)}\n`,
    encoding: "utf8",
    secret: true,
  };
  if (platform === "darwin") {
    if (input.uid === undefined)
      return { error: "取不到当前用户 id，装不了 launchd 用户代理" };
    const file = path.join(
      input.home,
      "Library",
      "LaunchAgents",
      `${LAUNCHD_LABEL}.plist`,
    );
    return {
      platform,
      name: LAUNCHD_LABEL,
      target: `gui/${input.uid}/${LAUNCHD_LABEL}`,
      definition: file,
      files: [
        envFile,
        {
          path: file,
          content: plist({
            label: LAUNCHD_LABEL,
            program,
            data: input.data,
            log,
          }),
          encoding: "utf8",
        },
      ],
      log,
      program,
      locations: [
        `${file}（launchd 用户代理，登录时启动）`,
        `launchctl 域 gui/${input.uid} 里的 ${LAUNCHD_LABEL}`,
      ],
    };
  }
  if (platform === "linux") {
    const configured = input.env.XDG_CONFIG_HOME?.trim();
    const config =
      configured && path.isAbsolute(configured)
        ? configured
        : path.join(input.home, ".config");
    const file = path.join(config, "systemd", "user", SYSTEMD_UNIT);
    return {
      platform,
      name: SYSTEMD_UNIT,
      definition: file,
      files: [
        envFile,
        {
          path: file,
          content: systemdUnit({ program, data: input.data, log }),
          encoding: "utf8",
        },
      ],
      log,
      program,
      locations: [
        `${file}（systemd 用户服务）`,
        `${path.join(config, "systemd", "user", "default.target.wants", SYSTEMD_UNIT)}（enable 建的软链接）`,
        `linger（/var/lib/systemd/linger/${input.user ?? "<用户名>"}，让用户服务开机就起、退出登录也不停）`,
      ],
    };
  }
  const user = input.env.USERNAME?.trim();
  if (!user)
    return { error: "取不到 USERNAME，装不了只在本人登录时启动的计划任务" };
  const domain = input.env.USERDOMAIN?.trim();
  const systemRoot = input.env.SystemRoot?.trim() || "C:\\Windows";
  const launcher = path.join(input.data, "agent-service.js");
  const taskFile = path.join(input.data, "agent-service.xml");
  return {
    platform,
    name: WINDOWS_TASK,
    definition: taskFile,
    files: [
      envFile,
      {
        path: launcher,
        content: windowsLauncher({ program, log }),
        encoding: "utf8",
      },
      {
        path: taskFile,
        content: windowsTask({
          user: domain ? `${domain}\\${user}` : user,
          wscript: path.join(systemRoot, "System32", "wscript.exe"),
          launcher,
          data: input.data,
        }),
        encoding: "utf16le",
      },
    ],
    log,
    program,
    locations: [
      `计划任务 \\${WINDOWS_TASK}（本人登录时启动，隐藏窗口）`,
      `${launcher} 与 ${taskFile}（任务定义与拉起脚本，放在代理数据目录）`,
    ],
  };
}

const run = (
  command: string,
  args: string[],
  extra: { allowFail?: boolean; retries?: number } = {},
): Step => ({ kind: "run", command, args, ...extra });

/** 查服务状态：launchctl print、systemctl show、schtasks /Query（只看退出码，输出随系统语言变）。 */
export function statusQuery(layout: ServiceLayout): Invocation {
  if (layout.platform === "darwin")
    return { command: "launchctl", args: ["print", layout.target ?? ""] };
  if (layout.platform === "linux")
    return {
      command: "systemctl",
      args: [
        "--user",
        "show",
        layout.name,
        "--property=LoadState,ActiveState,SubState,MainPID,UnitFileState",
      ],
    };
  return { command: "schtasks", args: ["/Query", "/TN", layout.name] };
}

export type ServiceState = {
  /** 系统里登记着（launchd 已加载、systemd 单元文件在、计划任务在）。 */
  installed: boolean;
  /** 在跑；Windows 上查询不给，由 IO 按 agent.pid 判断，这里为 null。 */
  running: boolean | null;
  pid: number | null;
  /** 开机或登录时自动起。 */
  enabled: boolean | null;
};

export function parseStatus(
  platform: ServicePlatform,
  result: { ok: boolean; stdout: string },
): ServiceState {
  if (platform === "darwin") {
    if (!result.ok)
      return { installed: false, running: false, pid: null, enabled: false };
    const pid = /^\s*pid = ([0-9]+)\s*$/m.exec(result.stdout)?.[1];
    const running = /^\s*state = running\s*$/m.test(result.stdout);
    return {
      installed: true,
      running,
      pid: running && pid ? Number(pid) : null,
      enabled: true,
    };
  }
  if (platform === "linux") {
    const fields = new Map(
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.split("="))
        .filter((parts) => parts.length >= 2)
        .map(([key, ...rest]) => [key!.trim(), rest.join("=").trim()]),
    );
    const installed =
      result.ok &&
      fields.get("LoadState") !== undefined &&
      fields.get("LoadState") !== "not-found";
    const running = installed && fields.get("ActiveState") === "active";
    const pid = Number(fields.get("MainPID") ?? 0);
    return {
      installed,
      running,
      pid: running && pid > 0 ? pid : null,
      enabled: installed ? fields.get("UnitFileState") === "enabled" : false,
    };
  }
  return {
    installed: result.ok,
    running: result.ok ? null : false,
    pid: null,
    enabled: result.ok,
  };
}

/** Linux：用户服务开机就起、退出登录也不停，要 linger。 */
export function lingerQuery(user: string): Invocation {
  return {
    command: "loginctl",
    args: ["show-user", user, "--property=Linger"],
  };
}

export const lingerOn = (result: { ok: boolean; stdout: string }) =>
  result.ok && /^Linger=yes\s*$/m.test(result.stdout);

/**
 * 装（或重装）服务：文件已写好之后要跑的命令。已经登记过的先停掉再按新定义起来。
 * 旧代理停下不带走执行者，新代理起来按运行记录接着看。
 */
export function installSteps(
  layout: ServiceLayout,
  current: { installed: boolean },
): Step[] {
  if (layout.platform === "darwin") {
    const target = layout.target ?? "";
    const domain = target.slice(0, target.lastIndexOf("/"));
    return [
      ...(current.installed
        ? [run("launchctl", ["bootout", target], { allowFail: true })]
        : []),
      // 以前被 launchctl disable 过的也要能起来。
      run("launchctl", ["enable", target], { allowFail: true }),
      run("launchctl", ["bootstrap", domain, layout.definition], {
        retries: 5,
      }),
    ];
  }
  if (layout.platform === "linux")
    return [
      run("systemctl", ["--user", "daemon-reload"]),
      run("systemctl", ["--user", "enable", layout.name]),
      run("systemctl", ["--user", "restart", layout.name]),
    ];
  return [
    ...(current.installed
      ? [
          run("schtasks", ["/End", "/TN", layout.name], { allowFail: true }),
          { kind: "stop-agent" } as const,
        ]
      : []),
    run("schtasks", [
      "/Create",
      "/TN",
      layout.name,
      "/XML",
      layout.definition,
      "/F",
    ]),
    run("schtasks", ["/Run", "/TN", layout.name]),
  ];
}

/** 卸载要跑的命令（之后删掉服务文件）；没装的步骤失败也不要紧。 */
export function uninstallSteps(layout: ServiceLayout): Step[] {
  if (layout.platform === "darwin")
    return [
      run("launchctl", ["bootout", layout.target ?? ""], { allowFail: true }),
    ];
  if (layout.platform === "linux")
    return [
      run("systemctl", ["--user", "disable", "--now", layout.name], {
        allowFail: true,
      }),
    ];
  return [
    run("schtasks", ["/End", "/TN", layout.name], { allowFail: true }),
    run("schtasks", ["/Delete", "/TN", layout.name, "/F"], { allowFail: true }),
    { kind: "stop-agent" },
  ];
}

/** 删完服务文件之后要跑的命令（Linux 让 systemd 忘掉已删的单元）。 */
export function afterUninstallSteps(layout: ServiceLayout): Step[] {
  return layout.platform === "linux"
    ? [run("systemctl", ["--user", "daemon-reload"], { allowFail: true })]
    : [];
}

/** 服务文件里哪些是系统位置（卸载时删）；service-env.json 留在数据目录，和令牌一起留给下次再装。 */
export const serviceDefinitionFiles = (layout: ServiceLayout) =>
  layout.files.filter((file) => !file.secret);
