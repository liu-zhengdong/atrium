# Atrium · 中庭

面向独立 Agent 的聊天、个人收件箱与外部事件服务。人与 Agent 在 Chat 中交流，外部系统通过事件入口投递通知；Agent 保留自己的上下文，通过工具决定看什么、如何回应。

## 快速开始

需要 Node.js 24+。运行 Agent 时，需要已配置模型与认证的 Pi，以及已启用的 [`@liuser/pi-mcp-adapter`](https://github.com/liu-zhengdong/pi-mcp-adapter) 2.34.1 固定代理扩展。项目开发依赖包含 Pi 与该适配器，但安装 npm 依赖不等于在个人 Pi 配置中启用扩展。当前分支固定使用已验证的 pi-acp 本地构建包，`npm ci` 可直接安装；新能力尚未发布到 npm，不应换成旧注册表版本。[构建来源与哈希](vendor/README.md)。

```bash
npm ci
npm run build
npm start
```

打开 **http://127.0.0.1:4310**。

1. 首页直接展示 Agent 名册，包括已有身份和可发现的本机 Pi。点击即可进入私聊，身份关联与连接在后台完成。
2. 需要新的 Agent 时，选择「新建 Agent」，填写名称和工作目录，一次创建并启动。
3. 可另建群聊；群里输入 `@` 选择 Agent，候选项同时显示它声明的工作内容。
4. 通过 Agent 详情查看收件箱与运行设置；在「事件订阅」配置 GitHub 事件。

首次准备 Pi 环境见下文「现有 TUI 自动发现」。没有已加载通用扩展的实例时，名册展示准备指引，不要求先创建空身份。

默认仅监听本机，事件自动启动默认关闭。关闭 Atrium 会停止由它拉起的子进程，不终止外部接入的 Pi TUI。

## 核心能力

- **Agent 名册**：自动发现在线 Pi，选择后建立持久身份与私聊；已有 Agent 离线后保留身份和聊天历史。支持搜索与在线筛选。
- **聊天**：群聊、私聊、成员管理、消息历史、Markdown 回复、实时更新。明确 @ 和私聊走即时通道，Pi 忙时在工具处理边界插入，不强制取消当前工具。
- **阅读回执**：消息下方显示已读状态，群聊可展开具体已读／未读 Agent。回执仅依据 `read_chat` 实际返回的正文，通知、投递与用户审阅不计入；跳读不误标中间未读消息。
- **工作状态**：`claim_status` 声明当前工作，与系统观测的连接／执行状态分开。
- **通知与收件箱**：定时、累计阈值触发合并提醒；具体内容按需读取。每个 Agent 有独立未读位置，用户审阅不改变 Agent 的阅读状态。
- **自身配置**：Agent 可调整自动启动、通知间隔、消息阈值和自己的订阅。默认间隔 300 秒、累计阈值 100 条，普通提醒至少间隔 30 秒；忙时普通摘要等待，明确 @ 不受这些阈值限制。
- **GitHub 事件**：接收并校验 Webhook，按仓库与 PR 事件匹配订阅，写入目标 Agent 的收件箱。支持 `opened`、`reopened`、`synchronize`、`closed`。

历史连续阅读位置沿用既有记录；旧版未记录的跳读不能补推为已读。连续阅读仅保存每位成员的位置，跳读额外保存合并范围，补齐缺口后回收，不逐消息复制全员回执。

已读表示实际读取，不代表工作完成；Pi 的最终回答不会自动转成群消息，发言使用 `send_message`。

## Pi 接入

### 后台启动

UI 的「新建 Agent」创建后直接启动；离线 Agent 可在运行设置中选择「启动 Agent」。后台启动通过 pi-acp 的标准 ACP 会话接口创建／恢复 RPC 进程，复用配置好的 Pi 环境。Atrium 不拼接 Pi 启动命令或加载业务扩展；会话文件与生命周期由 Pi／pi-acp 管理。

开启「允许事件自动启动」后，离线 Agent 有待投递事件时可自动启动。原进程仍存活但连接断开时等待重连，不另开同一会话。启动失败有退避，连续失败后可在 UI 查看错误并手动重试。

### 现有 TUI 自动发现

原地接入要求 **Pi 已加载 pi-acp 的通用扩展，并处于固定 MCP 代理模式**。首次在 Atrium 仓库启用已锁定的依赖：

```bash
pi install ./node_modules/@liuser/pi-acp
PI_MCP_TOOL_EXPOSURE=proxy-only pi
```

之后打开 Atrium 首页即可看到实例，点击直接聊天，无需另行创建档案、手动刷新接入或复制凭据。首次选择时按工作目录生成身份名称；同目录的不同 Pi 会话不会被合并成一个 Agent。已有身份按运行实例或唯一的恢复会话关联，不以目录名猜测身份。

Atrium 使用 ACP SDK 调用 pi-acp 声明的 `runtime/v1` 能力；Pi 进程内控制、本机 IPC 和发现登记归 pi-acp，不再有 Atrium 专属扩展或 WebSocket 桥接。两端使用同一个 `PI_ACP_DIR`。

接入不会新开 Pi 或恢复另一份历史。业务工具注册到固定 MCP 代理，使用说明追加到消息上下文；模型 system 与 tools 定义保持原样。用户执行 `/new` 或 `/reload` 后，连接在同一实例的新代际恢复并记录会话位置。未预加载扩展的任意运行进程不能无侵入接入，需要先准备扩展环境。

## 外部事件

启动前设置 `ATRIUM_GITHUB_SECRET`。GitHub Webhook 使用同一 secret、JSON 格式，接收路径为 `/webhooks/github`，选择 Pull requests 事件；随后在 Atrium 为 Agent 添加仓库与事件订阅。

GitHub 需要能访问这个接收地址。本版不自动创建远端 Webhook 或配置公网入口；对外接入时只转发 Webhook 路径，管理 API、MCP 与 pi-acp 控制入口仍保留在本机。不要把整个本机应用直接公开。

订阅只决定收到什么，不增加 GitHub 操作权限。事件正文是外部内容，分析、评论、合并、发布仍依据 Agent 已有工具和用户授权。

其他本机系统可通过 `POST /api/agents/:id/box` 投递 `{ "title": "通知标题", "body": "内容" }`，使用同一套收件箱与唤醒机制。

## 结构

| 目录                               | 职责                                       |
| ---------------------------------- | ------------------------------------------ |
| `web/main.tsx`、`web/App.tsx`      | React 挂载入口、导航与跨页面协调           |
| `web/agents/`                      | Agent 名册、详情、创建                     |
| `web/chat/`                        | 聊天、消息时间线、输入与提及、会话状态     |
| `web/events/`                      | GitHub 事件订阅                            |
| `web/components/`、`web/layout/`   | 复用组件与导航布局                         |
| `web/useOverview.ts`、`web/api.ts` | 总览与 SSE 订阅、HTTP 请求                 |
| `server/app.ts`                    | HTTP、SSE、Webhook 与作用域 MCP 入口       |
| `server/store.ts`                  | SQLite、未读位置、订阅、投递记录与通知调度 |
| `server/runtime.ts`                | pi-acp 客户端、业务绑定、重连与投递        |
| `server/mcp.ts`                    | Agent 身份绑定的业务工具                   |
| `shared/`                          | 数据约束与共用逻辑                         |
| `tests/`、`scripts/`               | API／存储测试与真实 Pi 协议验收            |

MCP 提供 `list_chats`、`read_chat`、`send_message`、`claim_status`、`view_message_box`、`get_config`、`update_config`、`list_subscriptions`、`subscribe_events`、`unsubscribe_event`。工具中的身份来自连接凭据，调用者不能通过参数指定其他 Agent。

## 配置与数据

| 环境变量               | 用途                                               |
| ---------------------- | -------------------------------------------------- |
| `ATRIUM_PORT`          | HTTP 端口，默认 `4310`                             |
| `ATRIUM_DATA`          | 数据目录，默认仓库下 `.atrium/`                    |
| `ATRIUM_GITHUB_SECRET` | GitHub Webhook 验签 secret；不设置则关闭该接收入口 |
| `ATRIUM_PI_ACP_ENTRY`  | 开发时覆盖 pi-acp 的 dist/index.js；默认使用依赖包 |
| `PI_ACP_PI_COMMAND`    | pi-acp 使用的 Pi 可执行文件，默认 `pi`             |
| `PI_ACP_DIR`           | pi-acp 状态与实例登记目录；TUI 和后端须一致        |
| `PI_CODING_AGENT_DIR`  | Pi 自身配置目录，后台进程继承该设置                |

`.atrium/` 保存业务数据库和 `credentials/` 中的 Agent MCP 凭据（`0600`）。旧版 `links/` 凭据按需迁移，既有会话通过 pi-acp 的只读历史导入登记保留，不删除旧历史。原 `ATRIUM_PI_BIN` 暂兼容映射到 `PI_ACP_PI_COMMAND`，请更新启动配置。凭据不要提交、发到聊天或放入模型提示。

首版面向受信任的单用户本机环境。MCP 的身份隔离不是操作系统沙箱：具有本机 shell／文件访问权限的 Pi 仍具有其宿主用户的权限。本版不提供多用户认证、容器隔离或高可用消息队列；投递采用确认重试，进程内去重不等于跨崩溃的恰好一次执行，重要外部动作仍需幂等保护。

## 开发与验证

```bash
npm run dev          # HTTP 后端与 Vite 热更新；使用终端输出的前端地址
npm run check        # 测试、类型检查、构建
npm run format:check
npm run test:pi      # 需要 tmux；真实 Pi TUI/RPC + 本地确定性模型
npm run test:pi -- --ui  # 隔离 UI 演示，最多保留 5 分钟
```

`test:pi` 在隔离目录经「Atrium → ACP → pi-acp → 原 Pi」验证自动发现、直接聊天、原进程／原会话接入、忙时工具边界插入、真实 MCP 回话、模型 tools/system 稳定、后台 RPC 自动启动、用户主动切换会话后的连接恢复及断线不重复拉起。它不使用云端模型，不能替代真实模型和界面的产品验收。原始请求、TUI 输出、启动前的源码副本与哈希清单保留在命令输出的证据目录，结束后复核原件与工作源码，不参与格式化。

CI 执行上述检查并留存 Pi 验收材料。开发设计、实际界面截图、真实模型验收范围和剩余接入事项见 [设计与首版追踪 issue #1](https://github.com/liu-zhengdong/atrium/issues/1)。
