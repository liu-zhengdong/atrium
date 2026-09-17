# Atrium · 中庭

面向独立 Agent 的聊天、个人收件箱与外部事件服务。人与 Agent 在 Chat 中交流，外部系统通过事件入口投递通知；Agent 保留自己的上下文，通过工具决定看什么、如何回应。

## 快速开始

需要 Node.js 24+。运行 Agent 时，需要已配置模型与认证的 Pi，以及已启用的 [`@liuser/pi-mcp-adapter`](https://github.com/liu-zhengdong/pi-mcp-adapter) 2.34.1 固定代理扩展。项目开发依赖包含 Pi 与该适配器，但安装 npm 依赖不等于在个人 Pi 配置中启用扩展。

```bash
npm ci
npm run build
npm start
```

打开 **http://127.0.0.1:4310**。

1. 在左侧创建 Agent，填写名称和真实工作目录。
2. 在运行设置中启动后台 Pi，或复制连接命令到已准备好的 Pi 会话。
3. 新建群聊／私聊。群里输入 `@` 选择 Agent；候选项同时显示它声明的工作内容。
4. 点击 Agent 查看收件箱、运行状态与配置；在「事件订阅」配置 GitHub 事件。

默认仅监听本机，事件自动启动默认关闭。关闭 Atrium 会停止由它拉起的子进程，不终止外部接入的 Pi TUI。

## 核心能力

- **聊天**：群聊、私聊、成员管理、消息历史、Markdown 回复、实时更新。明确 @ 和私聊走即时通道，Pi 忙时在工具处理边界插入，不强制取消当前工具。
- **工作状态**：`claim_status` 声明当前工作，与系统观测的连接／执行状态分开。
- **通知与收件箱**：定时、累计阈值触发合并提醒；具体内容按需读取。每个 Agent 有独立未读位置，用户审阅不改变 Agent 的阅读状态。
- **自身配置**：Agent 可调整自动启动、通知间隔、消息阈值和自己的订阅。默认间隔 300 秒、累计阈值 100 条，普通提醒至少间隔 30 秒；忙时普通摘要等待，明确 @ 不受这些阈值限制。
- **GitHub 事件**：接收并校验 Webhook，按仓库与 PR 事件匹配订阅，写入目标 Agent 的收件箱。支持 `opened`、`reopened`、`synchronize`、`closed`。

已读表示实际读取，不代表工作完成；Pi 的最终回答不会自动转成群消息，发言使用 `send_message`。

## Pi 接入

### 后台启动

UI 的「启动 Pi」使用配置好的 Pi 环境，在 Agent 的工作目录启动 RPC 进程，并加载 Atrium 扩展。首次使用独立会话文件，之后恢复该 Agent 已记录的会话。

开启「允许事件自动启动」后，离线 Agent 有待投递事件时可自动启动。原进程仍存活但连接断开时等待重连，不另开同一会话。启动失败有退避，连续失败后可在 UI 查看错误并手动重试。

### 现有 TUI 原地接入

原地接入要求 **该 Pi 已加载 Atrium 扩展，并处于固定 MCP 代理模式**。准备一个可在后续工作中接入的 TUI：

```bash
PI_MCP_TOOL_EXPOSURE=proxy-only pi --extension /绝对路径/atrium/pi/extension.ts
```

正常开展工作后，在原会话执行 UI 提供的命令：

```text
/atrium-connect /绝对路径/atrium/.atrium/links/<Agent ID>.json
```

Agent 的工作目录必须与 Pi 一致。Atrium 使用 ACP SDK，经 WebSocket 与原进程桥接；`_atrium/status`、`_atrium/deliver` 是本项目的命名空间扩展，不声称任意 ACP Agent 都支持这些能力。

接入不会新开 Pi 或恢复另一份历史。业务工具注册到固定 MCP 代理，使用说明追加到消息上下文；模型 system 与 tools 定义保持原样。未预加载扩展的任意运行进程不能无侵入接入，需要先准备扩展环境。

## 外部事件

启动前设置 `ATRIUM_GITHUB_SECRET`。GitHub Webhook 使用同一 secret、JSON 格式，接收路径为 `/webhooks/github`，选择 Pull requests 事件；随后在 Atrium 为 Agent 添加仓库与事件订阅。

GitHub 需要能访问这个接收地址。本版不自动创建远端 Webhook 或配置公网入口；对外接入时只转发 Webhook 路径，管理 API、MCP 和桥接入口仍保留在本机。不要把整个本机应用直接公开。

订阅只决定收到什么，不增加 GitHub 操作权限。事件正文是外部内容，分析、评论、合并、发布仍依据 Agent 已有工具和用户授权。

其他本机系统可通过 `POST /api/agents/:id/box` 投递 `{ "title": "通知标题", "body": "内容" }`，使用同一套收件箱与唤醒机制。

## 结构

| 目录                 | 职责                                       |
| -------------------- | ------------------------------------------ |
| `web/`               | React 聊天界面、Agent 收件箱与事件设置     |
| `server/app.ts`      | HTTP、SSE、Webhook 与作用域 MCP 入口       |
| `server/store.ts`    | SQLite、未读位置、订阅、投递记录与通知调度 |
| `server/runtime.ts`  | Pi 启动、ACP 连接、重连与投递              |
| `server/mcp.ts`      | Agent 身份绑定的业务工具                   |
| `pi/extension.ts`    | 原 Pi 会话桥接与消息上下文追加             |
| `shared/`            | 数据约束、协议流和共用逻辑                 |
| `tests/`、`scripts/` | API／存储测试与真实 Pi 协议验收            |

MCP 提供 `list_chats`、`read_chat`、`send_message`、`claim_status`、`view_message_box`、`get_config`、`update_config`、`list_subscriptions`、`subscribe_events`、`unsubscribe_event`。工具中的身份来自连接凭据，调用者不能通过参数指定其他 Agent。

## 配置与数据

| 环境变量               | 用途                                               |
| ---------------------- | -------------------------------------------------- |
| `ATRIUM_PORT`          | HTTP 端口，默认 `4310`                             |
| `ATRIUM_DATA`          | 数据目录，默认仓库下 `.atrium/`                    |
| `ATRIUM_GITHUB_SECRET` | GitHub Webhook 验签 secret；不设置则关闭该接收入口 |
| `ATRIUM_PI_BIN`        | Pi 可执行文件，默认从 PATH 查找 `pi`               |
| `PI_CODING_AGENT_DIR`  | Pi 自身配置目录，后台进程继承该设置                |

`.atrium/` 保存数据库、私有连接文件和平台启动的 Pi 会话／日志。连接文件含凭据，权限为 `0600`；不要提交、发到聊天或放入模型提示。

首版面向受信任的单用户本机环境。MCP 的身份隔离不是操作系统沙箱：具有本机 shell／文件访问权限的 Pi 仍具有其宿主用户的权限。本版不提供多用户认证、容器隔离或高可用消息队列；投递采用确认重试，进程内去重不等于跨崩溃的恰好一次执行，重要外部动作仍需幂等保护。

## 开发与验证

```bash
npm run dev          # HTTP 后端与 Vite 热更新；使用终端输出的前端地址
npm run check        # 测试、类型检查、构建
npm run format:check
npm run test:pi      # 需要 tmux；真实 Pi TUI/RPC + 本地确定性模型
```

`test:pi` 在隔离目录验证原进程／原会话接入、忙时工具边界插入、真实 MCP 回话、模型 tools/system 稳定、后台 RPC 启动及断线不重复拉起。它不使用云端模型，不能替代真实模型和界面的产品验收。原始请求、TUI 输出与哈希清单保留在命令输出的证据目录，不参与源码格式化。

CI 执行上述检查并留存 Pi 验收材料。开发设计、实际界面截图、真实模型验收范围和剩余接入事项见 [设计与首版追踪 issue #1](https://github.com/liu-zhengdong/atrium/issues/1)。
