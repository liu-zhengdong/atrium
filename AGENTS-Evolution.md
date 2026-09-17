# AGENTS Evolution

## 2026-09-17 · Pi 会话替换的连接生命周期

- 发生：真实 Pi 0.85.1 执行 `/new` 时，旧 WebSocket 的关闭回调读取失效 `ctx`，触发 `This extension ctx is stale after session replacement or reload.` 并导致 Pi 退出。
- 分析：首次接入成功不能代表连接能跨会话替换存活；异步回调需要本代生命周期检查，连接绑定需要进程内保留，但不应通过环境变量继承给子进程。
- 改变：项目开发规范补充生命周期验证边界；扩展隔离旧代回调并恢复当前进程绑定，`scripts/probe-pi.mjs` 增加真实 `/new`、重连与恢复位置验证，已实跑通过。失败现场捕获改为尽力保留，不再覆盖原始错误。
