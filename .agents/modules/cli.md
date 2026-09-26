# 模块：cli（命令行）

**负责**：`cli/`（命令实现）与 `bin/atrium.mjs`（只负责调用）。除 `run` 外都经服务完成。

**要点**
- 命令行的主要调用者是 Agent：成功回执给下一步命令；只有修正明确可执行时才提示修正；字段校验用参数名、中文表述；读命令支持 `--json`。
- 异步状态提供等待与增量读取（`wait`、`log --follow`），不让调用方轮询。
- 新命令接入 `cli/main.ts` 的命令表，并同步 `atrium --help`、`atrium guide`、README 命令行一节。
