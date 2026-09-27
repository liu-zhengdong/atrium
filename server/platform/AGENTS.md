# server/platform 约定

平台差异（macOS、Linux、Windows）的唯一落点。总体规范见根目录 `AGENTS.md`。

- 判定写在 `plan.ts`：纯函数、平台作参数（`"darwin" | "linux" | "win32"`），在 `tests/platform.test.ts` 按平台穷举；IO 在 `index.ts`，只把 `process.platform` 与环境变量喂给判定。
- 进程树 CPU 采样（t113）同样分两层：判定 `cpu-plan.ts`、采样 `cpu.ts`，类型沿用 `plan.ts`。
- 结束进程树用 `killTree`：Unix 给进程组发信号（拉起时须 `detached`）；Windows 一律 `taskkill /T /F`，没有温和关闭。
- 按名字拉起程序用 `spawnCommand` / `commandInvocation`：Windows 按 PATHEXT 找文件；npm 的 `.cmd` 包装直接用 node 跑目标脚本（参数可带换行），认不出的批处理经 `cmd.exe` 并逐个转义参数、拒绝换行。经 `cmd.exe` 的调用在 Windows 上不 `detached`（否则子程序的输出丢失），这类进程随服务退出。
- 跑 shell 命令用 `spawnShell`：Unix `/bin/sh -c`，Windows `cmd.exe /d /s /c`；仓库里的 `.agents/check` 与验收命令按所在平台的 shell 写。
- 已知限制：执行者日志在 Windows 上以「只追加」句柄交给子进程，MSYS 程序（Git 自带的 sh 等）直接写会失败；真实执行者是 node 或原生程序，不受影响。
