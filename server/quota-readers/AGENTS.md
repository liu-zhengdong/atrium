# server/quota-readers 约定

自带额度读取（#352）：服务进程内读各工具本机已登录的凭据、调供应商用量接口，折成与 `openquota pace --json` 同结构的行。总体规范见根目录 `AGENTS.md`。

- 每家一个读取器（`claude.ts`、`codex.ts`、`opencode.ts`），导出 `Reader`，登记到 `index.ts` 的 `READERS`；`provider` 与执行者适配器的 `quotaProvider` 同一套键。
- 凭据位置写在 `paths.ts`，按平台（darwin / linux / win32）分别算，纯函数，三个平台都要测；读取器只经 `ReaderDeps` 读文件、钥匙串、发请求，测试全部注入假的。
- 只读：不改、不刷新对方凭据；令牌过期就报「登录已过期」。钥匙串只读不弹授权框的项（经 `/usr/bin/security`）。
- 报错原因是固定中文句子，不带响应正文、令牌或底层报错原文；测试断言令牌不出现在任何结果里。
- 响应映射（`map*Usage`）与 pace 计算（`pace.ts`）是纯函数；口径照 OpenQuota（`src-tauri/src/providers/*`、`cli.rs`、`pacing.rs`），改口径要同时说明与 OpenQuota 的差别。
- 读到时带账号指纹 `account`（`credentials.ts accountKey`：`<provider>:<账号 id>` 的 sha256 前 16 位；claude 取 `.claude.json` 的 oauthAccount，codex 取 id_token 的用户加 account_id，opencode 取 key 本身）。指纹只用来在多台主机间去重，账号 id 与令牌都不出这台机器。
- 来源合并在 `merge.ts`（纯函数），多台主机的读数按账号合并是 `mergeHostReadings`；读两边并合并的入口是 `server/tasks/quota-source.ts`；`atrium quota`、挑执行者、组织树都从那里取。
