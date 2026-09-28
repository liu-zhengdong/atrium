import {
  Agent,
  normalizeServer
} from "./chunk-OMKMBJZQ.js";
import {
  AgentState
} from "./chunk-OYU4IKQ6.js";
import {
  currentVersion
} from "./chunk-NWLFCMFK.js";
import {
  Problem,
  processAlive,
  runFile
} from "./chunk-XWXBA3CJ.js";
import {
  commandLineInvocation,
  envKey
} from "./chunk-AOP4HR6R.js";

// server/agent/run.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// server/agent/service-plan.ts
import { posix, win32 } from "node:path";
var LAUNCHD_LABEL = "dev.atrium.agent";
var SYSTEMD_UNIT = "atrium-agent.service";
var WINDOWS_TASK = "AtriumAgent";
var RESTART_SECONDS = 10;
var SERVICE_ENV_FILE = "service-env.json";
var SERVICE_LOG_FILE = "agent-service.log";
function servicePlatform(platform) {
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : null;
}
var CARRIED = /* @__PURE__ */ new Set([
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
  "ATRIUM_TEST_CONCURRENCY"
]);
function carriedEnvironment(env, platform) {
  const carried = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === void 0 || value === "") continue;
    const name = platform === "win32" ? envKey(platform, key) : key;
    if (CARRIED.has(name) || /^LC_[A-Z_]+$/.test(name)) carried[name] = value;
  }
  return Object.fromEntries(
    Object.entries(carried).sort(([a], [b]) => a.localeCompare(b))
  );
}
var pathOf = (platform) => platform === "win32" ? win32 : posix;
var xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var systemdQuote = (text) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
var systemdPath = (text) => text.replace(/%/g, "%%");
function plist(layout) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    "<!-- Atrium \u4EE3\u7406\uFF1Aatrium agent install \u751F\u6210\uFF0C\u5378\u8F7D\u7528 atrium agent install --uninstall -->",
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
    ""
  ].join("\n");
}
function systemdUnit(layout) {
  return [
    "# Atrium \u4EE3\u7406\uFF1Aatrium agent install \u751F\u6210\uFF0C\u5378\u8F7D\u7528 atrium agent install --uninstall",
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
    ""
  ].join("\n");
}
var cmdQuote = (text) => `"${text}"`;
function windowsLauncher(layout) {
  const line = `${layout.program.map(cmdQuote).join(" ")} >> ${cmdQuote(layout.log)} 2>&1`;
  const command = `cmd.exe /d /s /c "${line}"`;
  return [
    "// Atrium \u4EE3\u7406\uFF1Aatrium agent install \u751F\u6210\uFF0C\u5378\u8F7D\u7528 atrium agent install --uninstall",
    "// \u4EE5\u9690\u85CF\u7A97\u53E3\u62C9\u8D77\u4EE3\u7406\uFF1B\u975E 0 \u9000\u51FA\u9694\u4E00\u4F1A\u513F\u91CD\u6765\uFF0C\u4EE4\u724C\u5931\u6548\uFF08\u4EE5 0 \u9000\u51FA\uFF09\u6216\u672C\u6587\u4EF6\u5DF2\u5220\uFF08\u5378\u8F7D\uFF09\u5C31\u505C\u3002",
    'var shell = new ActiveXObject("WScript.Shell");',
    'var files = new ActiveXObject("Scripting.FileSystemObject");',
    `var command = ${JSON.stringify(command)};`,
    "while (true) {",
    "  var code = shell.Run(command, 0, true);",
    "  if (code === 0) break;",
    `  WScript.Sleep(${RESTART_SECONDS * 1e3});`,
    "  if (!files.FileExists(WScript.ScriptFullName)) break;",
    "}",
    ""
  ].join("\r\n");
}
function windowsTask(layout) {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Atrium \u4EE3\u7406\uFF1Aatrium agent install \u751F\u6210\uFF0C\u5378\u8F7D\u7528 atrium agent install --uninstall</Description>",
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
    ""
  ].join("\r\n");
}
function serviceLayout(input) {
  const { platform } = input;
  const path = pathOf(platform);
  for (const [label, value] of [
    ["node \u8DEF\u5F84", input.node],
    ["Atrium \u5165\u53E3", input.script],
    ["\u4EE3\u7406\u6570\u636E\u76EE\u5F55", input.data]
  ]) {
    if (!path.isAbsolute(value))
      return { error: `${label}\u5E94\u4E3A\u7EDD\u5BF9\u8DEF\u5F84\uFF08\u6536\u5230\uFF1A${value}\uFF09` };
    if (/[\r\n\0]/.test(value)) return { error: `${label}\u91CC\u6709\u6362\u884C\u6216\u7A7A\u5B57\u7B26` };
    if (platform === "win32" && /["%]/.test(value))
      return {
        error: `${label}\u91CC\u6709 " \u6216 %\uFF0CWindows \u8BA1\u5212\u4EFB\u52A1\u7ECF cmd.exe \u62C9\u8D77\u65F6\u88C5\u4E0D\u8FDB\u53BB\uFF1A${value}`
      };
  }
  const program = [
    input.node,
    input.script,
    "agent",
    "--service",
    "--data",
    input.data
  ];
  const log = path.join(input.data, SERVICE_LOG_FILE);
  const envFile = {
    path: path.join(input.data, SERVICE_ENV_FILE),
    content: `${JSON.stringify(carriedEnvironment(input.env, platform), null, 2)}
`,
    encoding: "utf8",
    secret: true
  };
  if (platform === "darwin") {
    if (input.uid === void 0)
      return { error: "\u53D6\u4E0D\u5230\u5F53\u524D\u7528\u6237 id\uFF0C\u88C5\u4E0D\u4E86 launchd \u7528\u6237\u4EE3\u7406" };
    const file = path.join(
      input.home,
      "Library",
      "LaunchAgents",
      `${LAUNCHD_LABEL}.plist`
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
            log
          }),
          encoding: "utf8"
        }
      ],
      log,
      program,
      locations: [
        `${file}\uFF08launchd \u7528\u6237\u4EE3\u7406\uFF0C\u767B\u5F55\u65F6\u542F\u52A8\uFF09`,
        `launchctl \u57DF gui/${input.uid} \u91CC\u7684 ${LAUNCHD_LABEL}`
      ]
    };
  }
  if (platform === "linux") {
    const configured = input.env.XDG_CONFIG_HOME?.trim();
    const config = configured && path.isAbsolute(configured) ? configured : path.join(input.home, ".config");
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
          encoding: "utf8"
        }
      ],
      log,
      program,
      locations: [
        `${file}\uFF08systemd \u7528\u6237\u670D\u52A1\uFF09`,
        `${path.join(config, "systemd", "user", "default.target.wants", SYSTEMD_UNIT)}\uFF08enable \u5EFA\u7684\u8F6F\u94FE\u63A5\uFF09`,
        `linger\uFF08/var/lib/systemd/linger/${input.user ?? "<\u7528\u6237\u540D>"}\uFF0C\u8BA9\u7528\u6237\u670D\u52A1\u5F00\u673A\u5C31\u8D77\u3001\u9000\u51FA\u767B\u5F55\u4E5F\u4E0D\u505C\uFF09`
      ]
    };
  }
  const user = input.env.USERNAME?.trim();
  if (!user)
    return { error: "\u53D6\u4E0D\u5230 USERNAME\uFF0C\u88C5\u4E0D\u4E86\u53EA\u5728\u672C\u4EBA\u767B\u5F55\u65F6\u542F\u52A8\u7684\u8BA1\u5212\u4EFB\u52A1" };
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
        encoding: "utf8"
      },
      {
        path: taskFile,
        content: windowsTask({
          user: domain ? `${domain}\\${user}` : user,
          wscript: path.join(systemRoot, "System32", "wscript.exe"),
          launcher,
          data: input.data
        }),
        encoding: "utf16le"
      }
    ],
    log,
    program,
    locations: [
      `\u8BA1\u5212\u4EFB\u52A1 \\${WINDOWS_TASK}\uFF08\u672C\u4EBA\u767B\u5F55\u65F6\u542F\u52A8\uFF0C\u9690\u85CF\u7A97\u53E3\uFF09`,
      `${launcher} \u4E0E ${taskFile}\uFF08\u4EFB\u52A1\u5B9A\u4E49\u4E0E\u62C9\u8D77\u811A\u672C\uFF0C\u653E\u5728\u4EE3\u7406\u6570\u636E\u76EE\u5F55\uFF09`
    ]
  };
}
var run = (command, args, extra = {}) => ({ kind: "run", command, args, ...extra });
function statusQuery(layout) {
  if (layout.platform === "darwin")
    return { command: "launchctl", args: ["print", layout.target ?? ""] };
  if (layout.platform === "linux")
    return {
      command: "systemctl",
      args: [
        "--user",
        "show",
        layout.name,
        "--property=LoadState,ActiveState,SubState,MainPID,UnitFileState"
      ]
    };
  return { command: "schtasks", args: ["/Query", "/TN", layout.name] };
}
function parseStatus(platform, result) {
  if (platform === "darwin") {
    if (!result.ok)
      return { installed: false, running: false, pid: null, enabled: false };
    const pid = /^\s*pid = ([0-9]+)\s*$/m.exec(result.stdout)?.[1];
    const running = /^\s*state = running\s*$/m.test(result.stdout);
    return {
      installed: true,
      running,
      pid: running && pid ? Number(pid) : null,
      enabled: true
    };
  }
  if (platform === "linux") {
    const fields = new Map(
      result.stdout.split(/\r?\n/).map((line) => line.split("=")).filter((parts) => parts.length >= 2).map(([key, ...rest]) => [key.trim(), rest.join("=").trim()])
    );
    const installed = result.ok && fields.get("LoadState") !== void 0 && fields.get("LoadState") !== "not-found";
    const running = installed && fields.get("ActiveState") === "active";
    const pid = Number(fields.get("MainPID") ?? 0);
    return {
      installed,
      running,
      pid: running && pid > 0 ? pid : null,
      enabled: installed ? fields.get("UnitFileState") === "enabled" : false
    };
  }
  return {
    installed: result.ok,
    running: result.ok ? null : false,
    pid: null,
    enabled: result.ok
  };
}
function lingerQuery(user) {
  return {
    command: "loginctl",
    args: ["show-user", user, "--property=Linger"]
  };
}
var lingerOn = (result) => result.ok && /^Linger=yes\s*$/m.test(result.stdout);
function installSteps(layout, current) {
  if (layout.platform === "darwin") {
    const target = layout.target ?? "";
    const domain = target.slice(0, target.lastIndexOf("/"));
    return [
      ...current.installed ? [run("launchctl", ["bootout", target], { allowFail: true })] : [],
      // 以前被 launchctl disable 过的也要能起来。
      run("launchctl", ["enable", target], { allowFail: true }),
      run("launchctl", ["bootstrap", domain, layout.definition], {
        retries: 5
      })
    ];
  }
  if (layout.platform === "linux")
    return [
      run("systemctl", ["--user", "daemon-reload"]),
      run("systemctl", ["--user", "enable", layout.name]),
      run("systemctl", ["--user", "restart", layout.name])
    ];
  return [
    ...current.installed ? [
      run("schtasks", ["/End", "/TN", layout.name], { allowFail: true }),
      { kind: "stop-agent" }
    ] : [],
    run("schtasks", [
      "/Create",
      "/TN",
      layout.name,
      "/XML",
      layout.definition,
      "/F"
    ]),
    run("schtasks", ["/Run", "/TN", layout.name])
  ];
}
function uninstallSteps(layout) {
  if (layout.platform === "darwin")
    return [
      run("launchctl", ["bootout", layout.target ?? ""], { allowFail: true })
    ];
  if (layout.platform === "linux")
    return [
      run("systemctl", ["--user", "disable", "--now", layout.name], {
        allowFail: true
      })
    ];
  return [
    run("schtasks", ["/End", "/TN", layout.name], { allowFail: true }),
    run("schtasks", ["/Delete", "/TN", layout.name, "/F"], { allowFail: true }),
    { kind: "stop-agent" }
  ];
}
function afterUninstallSteps(layout) {
  return layout.platform === "linux" ? [run("systemctl", ["--user", "daemon-reload"], { allowFail: true })] : [];
}
var serviceDefinitionFiles = (layout) => layout.files.filter((file) => !file.secret);

// server/agent/run.ts
async function agentAlive(record) {
  if (!record || record.pid === process.pid || !processAlive(record.pid))
    return false;
  const call = commandLineInvocation(process.platform, record.pid);
  const found = await runFile(call.command, call.args, { timeout: 1e4 });
  if (found.error) return true;
  return /\bagent\b/.test(found.stdout);
}
function loadServiceEnv(data) {
  const file = join(data, SERVICE_ENV_FILE);
  if (!existsSync(file)) return;
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(saved))
      if (typeof value === "string") process.env[key] = value;
  } catch {
    console.error(
      `${file} \u5199\u574F\u4E86\uFF0C\u7167\u7CFB\u7EDF\u7ED9\u7684\u73AF\u5883\u542F\u52A8\uFF1B\u91CD\u8DD1 atrium agent install \u53EF\u91CD\u5199`
    );
  }
}
async function runAgent(input) {
  const { data } = input;
  if (input.service) loadServiceEnv(data);
  const state = new AgentState(data);
  const configured = input.server ?? state.config()?.server;
  if (!configured)
    throw new Problem(
      400,
      "--server \u5FC5\u586B\uFF1A\u9996\u6B21\u63A5\u5165\u65F6\u4F7F\u7528 host add \u56DE\u6267\u91CC\u7684\u5730\u5740\uFF1B\u63A5\u5165\u540E\u53EF\u7701\u7565",
      "usage"
    );
  const server = normalizeServer(configured);
  const other = state.pid();
  if (await agentAlive(other)) {
    const what = other.service ? "\u7CFB\u7EDF\u670D\u52A1" : "\u524D\u53F0";
    if (input.service) {
      console.error(
        `\u8FD9\u53F0\u5DF2\u6709\u4EE3\u7406\u5728\u8DD1\uFF08${what}\uFF0CPID ${other.pid}\uFF09\uFF1B\u7B49\u5B83\u505C\u4E0B\u540E\u63A5\u624B`
      );
      return 1;
    }
    throw new Problem(
      409,
      `\u8FD9\u53F0\u5DF2\u6709\u4EE3\u7406\u5728\u8DD1\uFF08${what}\uFF0CPID ${other.pid}\uFF09\uFF1B\u540C\u4E00\u6570\u636E\u76EE\u5F55\u53EA\u8DD1\u4E00\u4E2A`,
      "conflict",
      void 0,
      other.service ? "atrium agent install --status" : void 0
    );
  }
  const url = new URL(server);
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]", "host.orb.internal"].includes(
    url.hostname
  ))
    console.error(
      "\u63D0\u793A\uFF1A\u4EE4\u724C\u8D70\u660E\u6587 HTTP\uFF1B\u8DE8\u516C\u7F51\u8BF7\u7528 HTTPS \u6216 SSH \u8F6C\u53D1\uFF08ssh -R\uFF09\u628A\u670D\u52A1\u7AEF\u53E3\u5E26\u5230\u8FD9\u53F0\u673A\u5668\u7684 127.0.0.1"
    );
  const agent = new Agent({
    server,
    data,
    env: process.env,
    code: input.code?.trim() || void 0,
    version: currentVersion()
  });
  const stop = () => agent.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(
    `Atrium \u4EE3\u7406${input.service ? "\uFF08\u7CFB\u7EDF\u670D\u52A1\uFF09" : ""} \xB7 \u670D\u52A1 ${server} \xB7 \u6570\u636E ${data}`
  );
  state.savePid({
    pid: process.pid,
    service: input.service === true,
    startedAt: Date.now()
  });
  try {
    await agent.start();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    state.clearPid(process.pid);
  }
  if (agent.failure) {
    console.error(
      `\u4EE3\u7406\u5DF2\u505C\u6B62\uFF1A${agent.failure}\u3002\u5728\u670D\u52A1\u90A3\u53F0\u673A\u5668\u4E0A\u91CD\u65B0 atrium host add \u62FF\u63A5\u5165\u7801\uFF0C\u518D atrium agent ${input.service ? "install " : ""}--server ${server} --token \u63A5\u5165\u7801`
    );
    return input.service ? 0 : 1;
  }
  console.log(
    input.service ? "\u4EE3\u7406\u5DF2\u505C\u6B62\uFF08\u7CFB\u7EDF\u670D\u52A1\uFF09\uFF1B\u5728\u8DD1\u7684\u6267\u884C\u8005\u7167\u8DD1" : "\u4EE3\u7406\u5DF2\u505C\u6B62\uFF1B\u5728\u8DD1\u7684\u6267\u884C\u8005\u7167\u8DD1\uFF0C\u518D\u8FD0\u884C atrium agent \u63A5\u7740\u770B"
  );
  return 0;
}

export {
  servicePlatform,
  serviceLayout,
  statusQuery,
  parseStatus,
  lingerQuery,
  lingerOn,
  installSteps,
  uninstallSteps,
  afterUninstallSteps,
  serviceDefinitionFiles,
  agentAlive,
  runAgent
};
