# server/secrets 约定

凭据（t194 第 3 步）：挂在组织节点上的令牌、密码，按「节点 + 名称」找，名称就是注入执行者时的环境变量名。总体规范见根目录 `AGENTS.md`。

- 判定是纯函数、穷举测试（`model.ts`）：名称（大写环境变量名；系统变量、运行时标记与改变加载方式的前缀拒绝）、值（去结尾换行、空、空字符、上限）、`--secret` 列表、按节点链找（`resolveSecrets`，同名取最近一层）、合进环境（`withSecrets`，代理那一侧收到的也走它）、清理线索（`staleSecret`，90 天没用）、提示词段落（`secretSection`，只有名称）。报错一律不带值。
- 账与值在 `store.ts`：`node_secrets` 一个凭据一行（没有值），`task_secrets` 记任务声明的名称；值在 `<ATRIUM_DATA>/secrets/<id>`（目录 0700、文件 0600，先写临时文件再改名）。旧运行时的 `runner_credentials`、`credential_modes` 表不读不写。
- 没有读值的接口：值只在派活那一刻由 `taskSecretValues` 读出，本机拉起（`Executors.taskEnv`）与远程指令（`Assignment.secrets`，服务与代理都只放内存）按名称注入；拉起成功后 `markSecretsUsed` 记最后使用、事件 `secrets_injected` 只记名称。缺了或已归档就报错不拉起。
- 清理线索由 `hints.ts` 发：周期任务建出一轮后调用，范围与资料线索同一个（`materials/hints.ts hintScope`）；出错只记日志，不挡周期任务。归档的不注入、不进线索，可恢复；留下（keep）写原因后不再提；真删只有用户（leader 规则表不登记 DELETE）。
