# 模块：cli（命令行）

**负责**：`cli/`（命令实现）与 `bin/atrium.mjs`（只负责调用）。命令行与服务共用同一套数据；除启动、`status`、`stop`、`auth status` 外都经服务完成。

**干活前读**：根目录 `AGENTS.md` 与 `cli/AGENTS.md`（代码约定跟着代码走）。
