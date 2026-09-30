# 切换到 v2

从旧版（TypeScript，npm 全局装，4310，`~/.atrium`）换到 v2（Go 二进制，4320，`~/.atrium-v2`）。一次性操作，由秘书在你同意后执行 `scripts/cutover.sh`。

## 前提

- 在仓库工作树里执行（脚本用它 `go build`）；装好 Go 与 sqlite3。
- 旧服务可以在跑，脚本会先停；`~/.atrium-v2` 里还没有 v2 库。
- 旧库 `~/.atrium` 全程不改；退回旧版时它照常可用。

## 步骤（脚本自动做，每步回显，出错即停）

1. 确认 4310 上的旧服务已停（在跑就 `atrium stop`）。
2. 把旧库连同 `-wal`、`-shm` 拷到 `~/.atrium-v1-backup-<时间>/`，在副本上合并 WAL；资料目录用链接指回原处。
3. `go build` 出 v2，卸掉 npm 全局的旧 `atrium`（`npm uninstall -g atrium`），`mise reshim`，把二进制放到 `~/.local/bin/atrium`，并核对 PATH 上的 `atrium` 就是它。PATH 里 mise 的 node bin 与 shims 排在 `~/.local/bin` 前面，所以一定要先卸旧版。
4. `atrium import --from <副本>`：搬部门、要点、负责人、备忘、技能、资料、执行者档案、机器；**导入后自动全局暂停**。
5. `atrium start`，并确认是全局暂停状态。
6. 冒烟：`status`、`org tree`、`task ls`、`leader ls`、`workers`、`host ls`、`--help`、`map`（打印网址）。

脚本结束时服务在跑、仍然暂停。看过网页和 `org show` 没问题后，由你决定 `atrium resume`。

## 导入后要手动做的

- **负责人挂回部门**：旧库里负责人都没挂部门（09-28 审视时临时撤下，见秘书备忘）。恢复用 `atrium org edit oN --leader aN`。
- **超限的旧数据**：导入回执会列出来（例如 o2 要点 8/7、visual-design 技能超过 6KB、o4 资料总量超限）。照样可用，分派任务与网页会标「超限」，有空再整理。
- **执行者档案**：旧键 `invoke`、`cost`、`progress`、`single_instance` 与交付检查 `local_check` 在导入时去掉了（v2 内置适配器负责调用；合入队列总跑 `.agents/check`）。回执逐份列出。

## 远程机器 ggb（Windows）

旧的 h3 导入后没有令牌，要重新接入：

1. Mac 上交叉编译：`GOOS=windows GOARCH=amd64 go build -trimpath -o atrium.exe ./cmd/atrium`，拷到 ggb（例如 `scp atrium.exe <ssh 目标>:`，ssh 目标从旧库查：`sqlite3 ~/.atrium/atrium.sqlite "select ssh_target from hosts where id=3"`）。
2. ggb 上停掉旧代理的系统服务（旧版装的开机自启），免得两个代理同时领活。
3. Mac 上：`atrium host edit h3 --join`，记下回执里的接入码（30 分钟有效）。隧道目标、私钥路径与远端端口（旧版的 14310）已随导入带过来，隧道本机这头按 v2 服务端口；要换就 `atrium host edit h3 --tunnel 4320:14320 --key <私钥路径>`。
4. ggb 上：照回执里那一行（`atrium.exe agent --server http://127.0.0.1:<远端端口> --token <接入码>`）前台接入一次，看到连上后 `atrium.exe agent install` 装成开机自启。
5. Mac 上 `atrium host ls` 看到 ggb 已连接；它仍在全局暂停里，resume 后才领活。

注意：v2 的服务不继承 `SSH_AUTH_SOCK`，隧道只能用磁盘上的私钥（`host add/edit --key`，即 `ssh -i`）。旧版登记的私钥路径已导入，`atrium host ls h3` 能看到。

## 打 v2 首个发版标签

旧版的 `atrium update` 会拉仓库最新的标签。**等切换完成、本机与 ggb 上的旧版都卸掉之后**再在 main 上打 `v2.0.0`，否则还在跑的旧版可能把自己升级成它装不了的 Go 版本。发版工作流 `.github/workflows/release.yml` 会交叉编译六个平台并生成 `SHA256SUMS`；v2 的 `atrium update` 下载后对照它校验，对不上不装。

## 退回旧版

脚本开头的注释里有完整命令：停 v2、删 `~/.local/bin/atrium`、从 `v0.1.162` 标签 `npm pack` 后 `npm install -g`、`atrium` 启动。旧库没动过，旧版照常读。
