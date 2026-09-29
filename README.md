<img src="docs/brand/atrium-logo.svg" width="88" alt="Atrium logo">

# Atrium · 中庭

**一支像你一样判断、自己找事、越做越好的 AI 军团。** 你定方向、做判断；军团按组织树层层展开：秘书对你，负责人各管一块，执行者（Claude Code、Codex、OpenCode……）干具体的活，运行时自己查事实、验收、合入、上线。递到你面前的，只有需要你拍板的事。

https://github.com/user-attachments/assets/dfeb8215-da6d-4cc3-aacf-34857e1f2a1f

```
往下：你 → 秘书 → 任务 → 执行者 → PR → 关卡 · 合入 · 上线
往上：你 ← 秘书 ← 负责人 ← 卡住、越界、上线的事
```

## 目标

要让一群 AI 替你干活、你又不用盯着，它得做到三件事：

| 目标 | 是什么 | 怎么检验 |
| --- | --- | --- |
| 像你一样判断 | 你不在场时，替你做出你本来会做的决定；你的原则、口味、取舍方式是它的一部分 | 同样多的活，你要纠正的次数越来越少 |
| 自己找事 | 你给方向和底线，不给任务清单；它围绕方向自己发现问题、提出要做的事让你选 | 它自己提出、又被你认可的活越来越多 |
| 越做越好 | 执行者用完即走，但组织从每件事里学到的东西留下来：有效的做法、踩过的坑、你纠正过什么 | 同一类问题不再重复出现 |

这三件事是连着的：判断像你，你才敢让它自己找事；它自己做的事多了，才有东西可学；学到的又让它的判断更像你。

## 开始

需要至少一个已登录的编码 CLI。Atrium 是一个二进制，服务、命令行、远程代理都是它。

- **下载对应平台的二进制**：从 [Releases](https://github.com/liu-zhengdong/atrium/releases) 取 `atrium-<系统>-<架构>`（如 `atrium-darwin-arm64`、`atrium-windows-amd64.exe`），对照 `SHA256SUMS`，改名为 `atrium` 放进 PATH。之后用 `atrium update` 升级。
- **从源码**：装好 Go，`go build ./cmd/atrium`。

```bash
atrium                                        # 启动后台服务（只监听本机 127.0.0.1:4320）
atrium task add "给登录页加记住我" --repo o/r   # 建任务 t1
atrium task run t1                            # 按额度挑执行者，派出去
atrium task wait t1                           # 等它交 PR、过关卡、合入
atrium map                                    # 在浏览器里看全景：各部门在做什么、什么在等你
```

日常不用自己敲这些：让一个 Claude Code 会话当秘书，你跟它说目标就行。

```bash
cd ~/秘书目录 && atrium secretary bridge --install-hook   # 装一次：事件自动送进这个会话，会话里的命令署名秘书
```

在 `~/.claude/settings.json` 配上状态栏，随时看见谁在干活、什么在等你：

```json
{ "statusLine": { "type": "command", "command": "atrium statusline" } }
```

## 概念

| 概念         | 是什么                                                                         | 从这里看      |
| ------------ | ------------------------------------------------------------------------------ | ------------- |
| 部门         | 组织树上的一块（项目、模块），有人话介绍、现状和负责人                         | `atrium map`  |
| 要点         | 一句规矩：是什么、为什么、谁定的；沿树往下继承，派活时附给执行者               | `org show`    |
| 秘书与负责人 | 固定身份：秘书对你，负责人管一块；按事唤醒，各有一份备忘                       | `leader ls`   |
| 技能         | 一类活怎么干：做法（SKILL.md）、优先的执行者、交付要查什么、要的凭据           | `skill ls`    |
| 资料         | 部门的知识：一份总览每次附给负责人，细节按需取                                 | `material ls` |
| 任务         | 挂在一个部门下，可拆子任务、有依赖、有优先级（紧急／修复／普通／闲时）         | `top`         |
| 周期任务     | 到点在部门下生成一件任务并派出去（巡检、调研）                                 | `schedule ls` |
| 选项单       | 调研后提给你的几个方向，各写清收益和代价；你只做选择，没选的下轮调研不再原样提 | `choice ls`   |
| 执行者       | 编码 CLI + 模型 + 强度，如 `codex+gpt-6-sol:high`；档案记它能接什么活          | `workers`     |
| 执行机器     | 本机 `h1` 和接入的其他电脑 `h2`…，执行者可以跑在任何一台                       | `host ls`     |

短号全局唯一、不复用：任务 `t1`、部门 `o1`、要点 `k1`、负责人 `a1`、选项单 `c1`、资料 `m1`、周期任务 `s1`、机器 `h1`。

会增长的东西都有上限（每部门要点 7 条、周期任务 10 条……），满了先合并、删掉最不值的。旧数据超了上限也照样全读出来，在 `org show`、派活提示词和网页里标「超限 8/7」；刚到或超了会给该整理的人发一条要处理的事件（同一件事只提醒一次）。

## 一件任务怎么走完

1. **派活**：进派活队列，按优先级取出；在独立的 git worktree 里拉起执行者，提示词附上详述、所在部门链上的要点和挂载的技能。
2. **执行**：有仓库的活交 PR，没有仓库的活把结论写在最后的回复里（调研另交 `choice.json`）。要改方向用 `task tell` 捎话，要停下用 `task stop`；卡住、供应商报错、额度用完时，运行时重试或换人。
3. **验收**：运行时自己查 PR、提交、改动规模，不信执行者的自述；高风险或信任不够的执行者，另派一个不同工具、不同模型的审阅。部门的验收人（`org edit --accept`，沿树继承）是负责人或你时，任务停在「等验收」，`task accept` 才落地，`task reject` 交回原执行者。
4. **落地**：交付方式决定怎么落地。PR 进合入队列，串行 rebase、跑同一份快检查（`.agents/check`），通过才合入，冲突或没过交回原执行者；Atrium 自己的仓库合入后等发版，然后自动升级、平滑重启，告诉负责人「t1 已上线」。调研的 `choice.json` 登记成选项单；只交结论的直接完成。

出了问题先找负责人，负责人处理不了才上交秘书，秘书再递给你（网页「等你」里也看得到）。

## 它替你守住的

- **一键停机**：`atrium pause` 停下一切自主动作（派活、唤醒、周期任务、合入、发版），`atrium resume` 恢复；可以只停一个部门（`--org`）或一台机器（`--host`）。
- **每件没结束的事都有人管、有时限**：执行者、检查、合入、负责人、秘书各有时限，到期先叫醒，再到期往上交。
- **负责人只管自己那块**：负责人的令牌由服务端按部门判权限，动不了别的部门；拍板、凭据只有你。
- **main 常绿**：合入和发版用同一份检查；重启与升级不打断在跑的执行者。
- **不碰你的真实环境**：执行者用白名单环境启动，不继承你的令牌和密钥；任务要的凭据按名称在派活那一刻注入。
- **每条规矩只存一份**：规矩只写在要点里，命令用法只在 `--help` 里。

## 更多

- **命令**：`atrium --help` 列出全部命令，`atrium <命令> --help` 看某一组或某一条；每条命令都支持 `--json`，回执最后一行给下一步。
- **日志**：`atrium task log t1 --follow` 跟着看执行者在干什么；网页任务抽屉里是同一份日志的尾巴。
- **多台机器**：`atrium host add` 登记一台，照回执在那台上运行 `atrium agent …` 接入，再 `atrium agent install` 装成开机自启；远程机器主动连服务，不用开端口。
- **额度**：`atrium quota` 看各账号还剩多少；Atrium 自己读 Claude Code、Codex、OpenCode 的用量，其余的由 [OpenQuota](https://github.com/liu-zhengdong/OpenQuota) 补上。派活时按富余挑执行者，并给你留一份（缺省 20%，`atrium quota --reserve` 改）。
- **数据**：都在 `~/.atrium-v2`（`ATRIUM_DATA` 可改），换机器带走这个目录即可。令牌、数据库不要提交或分享；令牌泄露了用 `atrium auth rotate` 换一个。旧版的数据用 `atrium import` 一次性导入。
- **重启与升级**：`atrium restart` 随时可以做，`atrium update` 装最新版（`--to 版本` 装指定版本）。

## 开发

```bash
go build ./...
go test ./internal/<包>/          # 只跑改动相关的包
.agents/check                     # 快检查：gofmt、vet 与交叉编译（Windows、Linux）、构建、全部测试、--help
scripts/smoke.sh                  # 主路径端到端（隔离服务、假执行者、假 gh）
```

开发中用隔离的服务，别碰 4320 上的安装版：

```bash
ATRIUM_PORT=4391 ATRIUM_DATA=$PWD/.atrium go run ./cmd/atrium start   # 启动
ATRIUM_PORT=4391 ATRIUM_DATA=$PWD/.atrium go run ./cmd/atrium stop    # 用完停掉
```

包怎么分、谁调谁、共享文件怎么改见 [internal/README.md](internal/README.md)；实现约束和协作流程见 [AGENTS.md](AGENTS.md)。方向讨论见 [#260](https://github.com/liu-zhengdong/atrium/discussions/260)，v2 规格见 [#496](https://github.com/liu-zhengdong/atrium/discussions/496)。
