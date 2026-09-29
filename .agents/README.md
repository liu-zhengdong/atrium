# 在 Atrium 仓库干活

派活时运行时把本文件原样附进提示词。通用约束（只交 PR、「端到端验证」、隔离实例、凭据不打印、只跑快检查）由运行时另附，这里只写本仓库自己的约定。仓库规范见根目录 `AGENTS.md`；包职责、接口与共享文件规则见 `internal/README.md`，改哪个包先读它那一节。

- 在任务给的工作树里改；不要 `git stash`（所有工作树共用）。
- 用户的服务在 4320（数据 `~/.atrium-v2`），不要启停，也不要读写这个数据目录。隔离实例：`ATRIUM_DATA=<临时目录> ATRIUM_PORT=<空闲端口> go run ./cmd/atrium start`，用完同样变量 `stop`。
- 开发中只跑改动相关的包（`go test ./internal/<包>/`）；交付前跑快检查 `.agents/check`，合入队列 rebase 后也跑这一份。端到端冒烟：`scripts/smoke.sh`。单包测试超过 30 秒在 PR 里说明。
- 测试用临时目录、假执行者、假 gh 与本地 bare 仓库；不调真实模型，不读用户主目录里的数据。
- 进程、shell、路径的平台差异只经 `internal/platform`，不直接写 `/bin/sh`、`kill(-pid)`。
- 网页里的图形符号（箭头、展开、排序、开关等）一律用 SVG：`app.js` 里用 `icon` 对象，`index.html` 骨架里直接内联；不用文字字符（›、▾、◐、↵ 之类）。
- PR 正文除「端到端验证」外再写「碰到哪些已有能力」一节：和哪些已有能力交叉、各验了什么；没有写「无」。
- PR 截图只有一种放法：在任务分支上提交截图（放 `.shots/`），紧接着下一个提交删掉，PR 里按那次提交的 SHA 引用 `https://raw.githubusercontent.com/<owner>/<repo>/<SHA>/.shots/<文件>`。squash 后 main 没有图片，PR 保留那次提交，图片仍能看。不另建分支、不放别处（另建的分支删掉后图就失效了）。
- 文档、提交、PR 用中文。
