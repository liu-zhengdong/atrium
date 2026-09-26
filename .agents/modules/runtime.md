# 模块：runtime（服务与运行时）

**负责**：服务进程生命周期（`server/main.ts`、`service.ts`、`supervisor.ts`：启动、平滑重启、排空）；任务账本与执行者运行时（`server/tasks/`：账本、状态机、适配器、档案、派活与等待）；旧的身份运行时与投递（`runtime.ts`、`delivery.ts`、`turns.ts`、`runner-*`）。

**要点**

- 新功能放进职责单一的新模块（参照 `server/tasks/`），不要往 `server/store.ts`（2300 行）或 `runtime.ts` 里继续堆。
- 状态判定写成纯函数，穷举测试；IO 与判定分开。
- 持久化加载与启动路径按产品自愈：单条坏记录挪开并记日志，其余照常启动。
- SQLite 一律参数化查询、事务、有界分页。
- 子进程用白名单环境启动，不继承凭据类、身份类和 `HERDR_*` 变量。
