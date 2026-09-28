# Atrium · 中庭

**一支延伸你意志的 AI 军团。** 你定方向、做判断；军团按组织树层层展开：秘书对你，负责人各管一块，执行者（Claude Code、Codex、OpenCode……）干具体的活，运行时自己查事实、验收、合入、上线。递到你面前的，只有需要你拍板的事。

```
往下：你 → 秘书 → 任务 → 执行者 → PR → 关卡 · 合入 · 上线
往上：你 ← 秘书 ← 负责人 ← 卡住、越界、上线的事
```

## 开始

需要 Node.js 24+，和至少一个已登录的编码 CLI。从发布的标签安装（`x` 换成最新补丁号，之后用 `atrium update` 升级）：

```bash
git clone --depth 1 --branch v0.1.x https://github.com/liu-zhengdong/atrium.git /tmp/atrium-src
cd /tmp/atrium-src && npm pack && npm install -g ./atrium-0.1.x.tgz
```

```bash
atrium                                    # 启动后台服务（只监听本机 127.0.0.1:4310）
atrium task add "给登录页加记住我" --repo .  # 建任务 t1
atrium task run t1                        # 按额度挑执行者，派出去
atrium task wait t1                       # 等它交 PR、过关卡、合入
atrium map                                # 在浏览器里看全景：各部分在做什么、谁负责
```

日常不用自己敲这些：让一个 Claude Code 会话当秘书，你跟它说目标就行。

```bash
cd ~/秘书目录 && atrium secretary bridge --install-hook   # 装一次：事件自动送进这个会话
```

在 `~/.claude/settings.json` 配上状态栏，随时看见谁在干活、什么在等你：

```json
{ "statusLine": { "type": "command", "command": "atrium statusline" } }
```

## 概念

| 概念         | 是什么                                                                         | 从这里看        |
| ------------ | ------------------------------------------------------------------------------ | --------------- |
| 部分         | 组织树上的一块（项目、模块），有人话介绍、现状和负责人                         | `atrium map`    |
| 要点         | 一句规矩：是什么、为什么、谁定的；沿树往下继承，派活时附给执行者               | `org show`      |
| 秘书与负责人 | 固定身份：秘书对你，负责人（leader）管一块；按事唤醒，各有一份备忘             | `leader ls`     |
| 专员与技能   | 一类活怎么干：做法、优先的执行者、交付要查什么                                 | `specialist ls` |
| 任务         | 挂在一个部分下，可拆子任务、有依赖、有优先级（紧急／修复／普通／闲时）、可周期 | `top`           |
| 选项单       | 调研后提给你的几个方向，各写清收益和代价；你只做选择                           | `choice ls`     |
| 决定记录     | 你拍过板的事和原因，只追加                                                     | `decision ls`   |
| 执行者       | 编码 CLI + 模型 + 强度，如 `codex+gpt-6-sol:high`；档案记它能接什么活          | `workers`       |
| 执行机器     | 本机 `h1` 和接入的其他电脑 `h2`…，执行者可以跑在任何一台                       | `host ls`       |

短号全局唯一、不复用：任务 `t1`、部分 `o1`、要点 `k1`、负责人 `a1`、选项单 `c1`、决定 `d1`、主机 `h1`。

## 一件任务怎么走完

1. **派活**：进派活队列，按优先级取出；在独立的 git worktree 里拉起执行者，提示词附上详述、所在部分的要点和专员的做法。
2. **执行**：执行者只交 PR。卡住、供应商报错、额度用完时，运行时重试或换人。
3. **验收**：运行时自己查 PR、提交、改动规模，不信执行者的自述；高风险或新接入的执行者，另派一个不同模型审阅。
4. **合入**：合入队列串行 rebase、跑同一份快检查（`.agents/check`），通过才合入；冲突或没过交回原执行者。
5. **上线**：Atrium 自己的仓库合入后等发版，然后自动升级、平滑重启，告诉负责人「t1 已上线」。

出了问题先找负责人，负责人处理不了才上交秘书，秘书再递给你。

## 它替你守住的

- **一键停机**：`atrium pause` 停下一切自主动作（派活、唤醒、周期任务、合入、发版），`atrium resume` 恢复；可以只停一块（`--part`）或一台机器（`--host`）。
- **每件没结束的事都有人管、有时限**：执行者、检查、合入、负责人、秘书各有时限，到期先叫醒，再到期往上交。
- **main 常绿**：合入和发版用同一份检查；重启与升级不打断在跑的执行者，新版本起不来就自动装回旧版。
- **不碰你的真实环境**：执行者用白名单环境启动，不继承你的令牌和密钥；只在隔离的实例里做端到端验证。
- **每条规矩只存一份**：规矩只写在要点里，命令用法只在 `--help` 里。

## 更多

- **命令**：`atrium --help` 列出全部命令，`atrium <命令> --help` 看某一组；`atrium guide` 是写给 Agent 看的调用约定。
- **多台机器**：`atrium host add` 登记一台，在那台上跑 `atrium agent install` 接入；远程机器主动连服务，不用开端口。
- **额度**：`atrium quota` 看各账号还剩多少；Atrium 自己读 Claude Code、Codex、OpenCode 的用量，其余的由 [OpenQuota](https://github.com/liu-zhengdong/OpenQuota) 补上。派活时按富余挑执行者，并给你留一份（缺省 20%，`atrium org limits` 改）。
- **数据**：都在 `~/.atrium`（`ATRIUM_DATA` 可改），换机器带走这个目录即可。令牌、数据库不要提交或分享；令牌泄露了用 `atrium auth rotate` 换一个。
- **重启与升级**：`atrium restart` 随时可以做，`atrium update` 装最新版（`--to 版本` 可回退）。

## 开发

```bash
npm ci
npm run build                     # 类型检查
npm test -- tests/a.test.ts       # 只跑列出的测试；--changed 跑与 origin/main 相比改动相关的
npm run format:check
npm run e2e                       # 主路径端到端（装包、派活、重启接管、停止）
```

开发中用隔离的服务，别碰 4310 上的安装版：

```bash
ATRIUM_PORT=4391 ATRIUM_DATA=$PWD/.atrium node bin/atrium.mjs        # 启动
ATRIUM_PORT=4391 ATRIUM_DATA=$PWD/.atrium node bin/atrium.mjs stop   # 用完停掉
```

全量测试（`npm run check`）由运行时定时在 main 上跑，开发时只跑相关的。代码结构、实现约束和协作流程见 [AGENTS.md](AGENTS.md)；各目录的约定写在目录旁的 `AGENTS.md`。方向讨论见 [#260](https://github.com/liu-zhengdong/atrium/discussions/260)。
