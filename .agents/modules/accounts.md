# 模块：accounts（模型账号与供应商）

**负责**：`server/account*.ts`、`provider-directory.ts`、`custom-providers.ts`、`assignment.ts`、`cli/accounts.ts`、`cli/connect.ts`。

**要点**

- 供应商列表由 Atrium 维护（openai-codex、xai、kimi-coding、opencode-go、自定义兼容），不读个人 Pi 模板里的插件（#242）。不接 Claude 模型；Claude 走 Claude Code 后端（#193）。
- 令牌不打印、不写日志、不进模型上下文。
