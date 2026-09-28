# server/platform 约定

平台差异（macOS、Linux、Windows）的唯一落点。总体规范见根目录 `AGENTS.md`。

- 判定写在 `plan.ts`：纯函数、平台作参数（`"darwin" | "linux" | "win32"`），在 `tests/platform.test.ts` 按平台穷举；IO 在 `index.ts`，只把 `process.platform` 与环境变量喂给判定。
- 进程树 CPU 采样（t113）同样分两层：判定 `cpu-plan.ts`、采样 `cpu.ts`，类型沿用 `plan.ts`。
- 结束进程树用 `killTree`：Unix 给进程组发信号（拉起时须 `detached`）；Windows 一律 `taskkill /T /F`，没有温和关闭。
- 子进程一律从这里拉起（t167），其余代码不直接用 `node:child_process`（只引类型可以），`tests/child-process-imports.test.ts` 扫描把关：收输出跑一次用 `runFile` / `runCommand`，长跑的用 `spawnInvocation` / `spawnCommand` / `spawnShell`，Atrium 自己的 node 进程（服务、supervisor）用 `spawnNode`。全部带 `windowsHide`，Windows 上不弹控制台窗口。
- Windows 上要求 `detached` 的拉起经隐藏控制台中转（`hiddenLaunch` / `HIDDEN_LAUNCHER`）：libuv 的 detached 是 DETACHED_PROCESS，程序没有控制台，它再起的 git、shell 各自新开可见窗口；中转自己 detached（活过服务重启），再不 detached、全管道拉起程序，程序得到没有窗口的控制台，子孙共用它。中转把输出写进继承来的日志或管道、转发标准输入、按程序退出码退出；返回的 pid 是中转的，`killTree` 按进程树连程序一起结束。
- 按名字拉起程序用 `spawnCommand` / `commandInvocation`：Windows 按 PATHEXT 找文件；npm 的 `.cmd` 包装直接用 node 跑目标脚本（参数可带换行），认不出的批处理经 `cmd.exe` 并逐个转义参数、拒绝换行。
- 跑 shell 命令用 `spawnShell`：Unix `/bin/sh -c`，Windows `cmd.exe /d /s /c`；仓库里的 `.agents/check` 与验收命令按所在平台的 shell 写。
- 已知限制：执行者日志在 Windows 上以「只追加」句柄交给子进程，MSYS 程序（Git 自带的 sh 等）直接写会失败；真实执行者是 node 或原生程序，不受影响。
- Claude Code 会话收件地址（t243）：地址认不认、哪些连接错误算会话没了在 `plan.ts`（`messagingEndpoint`、`endpointGone`），连接与写入在 `endpoint.ts`（`net.connect` 同时支持 Unix socket 与 Windows 命名管道；单独成文件，只有 `secretary bridge` 按需加载）。
