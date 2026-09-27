# cli 约定

`atrium` 命令行。`bin/atrium.mjs` 只负责调用 `cli/main.ts`；总体规范见根目录 `AGENTS.md`。

- 新命令写成 `Command`（`args`、`about`、`options`、`positionals`、`run`）并接入 `cli/main.ts` 的命令表；分组在 `cli/guide.ts`。`atrium --help`、命令组帮助与 `atrium guide` 都从命令表生成，示例须能通过参数解析（`tests/cli-guide.test.ts` 校验）。改了命令同步 README「命令行」一节。
- 除帮助外，每条命令先过执行者防护（`worker-guard.ts`）：带 `ATRIUM_WORKER=1` 又没有隔离的 `ATRIUM_DATA`、`ATRIUM_PORT` 时拒绝，不拉起服务。
- 回执：成功时最后一行给下一步命令（`recordNext`），`--json` 只在 stdout 写一个对象；失败给错误码与退出码（`contract.ts`），修正命令只在明确可执行时给出，不拿通用帮助充数。
- 校验错误用命令行参数名和中文表达（`error-message.ts`），不暴露接口字段名与英文验证句。
- 需要等的动作提供等待与增量读取（`long-wait.ts`、`wait-options.ts`），不让调用方轮询。
