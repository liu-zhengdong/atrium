# server/materials 约定

资料（t192 第 1 步）：挂在组织节点上的文件或目录，短号 mN。总体规范见根目录 `AGENTS.md`。

- 判定是纯函数、穷举测试（`model.ts`）：短号、路径与名称（拒绝 `..`、绝对路径、盘符、反斜杠、隐藏段、控制字符）、上传校验（数量与大小上限，超了提示压缩或外链）、关联、清理线索（`staleVerdict`）、再提间隔（`hintDue`）、真删候选（`purgeVerdict`）、派活清单（`contextMaterialLines`）。
- 账与文件在 `store.ts`：`materials` 一份一行（AUTOINCREMENT，mN 不复用），`material_versions` 每版一行、清单存 JSON，`material_reads` 每份只留最近 `READS_KEPT` 条，`material_links` 存 `--for` 关联。文件在 `<ATRIUM_DATA>/materials/mN/vK/`，先写临时目录再改名；读文件只认版本清单里的路径并确认落在版本目录里。旧运行时的 `attachments` 表不读不写。
- 同一节点同名、没归档的再加是新版本（摘要相同不加）；`--supersedes` 只标旧的被取代，旧的照旧可取。归档的不进清单、提示词与清理线索，可恢复；留下（keep）写原因后线索不再提。真删只有用户（leader 规则表不登记 DELETE）。
- 关联是否结束、真删要的总大小都按类别或 JOIN 批量查，不在循环里查库；列表有界分页。
- 清理线索由 `hints.ts` 发：周期任务（`server/schedules/runtime.ts`）建出一轮后调用，只看这一块及事件同样投给这位 leader 的下层；出错只记日志，不挡周期任务。
- 执行者取资料：命令行 `material get` 在执行者环境里是唯一放行的命令（`cli/worker-guard.ts` 的 `workerReadable`），只读、不拉起服务；运行时拉起本机执行者时注入 `ATRIUM_TASK`，读取记在该任务上。
