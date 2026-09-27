# 模块：runtime（服务与运行时）

**负责**：服务进程生命周期（`server/main.ts`、`service*.ts`、`supervisor.ts`：启动、平滑重启、排空、升级回滚）；任务账本与执行者运行时（`server/tasks/`：账本、状态机、适配器、档案、派活、关卡、看门狗、额度、事件）；组织树（`server/org/`）。

**干活前读**：根目录 `AGENTS.md` 与 `server/tasks/AGENTS.md`（代码约定跟着代码走）。
