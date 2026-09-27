# atrium top 的最近动作夹具（#262）

`atrium top` 每行显示的「最近一个动作」是从执行者日志尾部解析出来的，解析按各自适配器的
真实输出格式写。这些片段是 2026-09-27 在本机跑真执行者抓下来的原样日志，不是手编的。
文件后缀用 .txt：仓库 .gitignore 忽略 *.log。

## codex（`codex exec`，不带 `--json`，分段纯文本）

抓取：`echo "<提示词>" | codex exec -C . -s danger-full-access -m gpt-6-sol -c model_reasoning_effort="low" --skip-git-repo-check -`，
codex 0.157.1，临时目录里两个文件（hello.txt、edit.txt）。

| 夹具              | 原始日志行号 | 覆盖的形态                                        |
| ----------------- | ------------ | ------------------------------------------------- |
| `codex-tools.txt` | raw2 15～68  | 段名 `codex` / `exec`；最后一段是 exec 工具调用   |
| `codex-patch.txt` | raw2 33～53  | 段名 `apply patch`；目标取自提示后的路径行        |
| `codex-final.txt` | raw2 76～98  | 尾部 `codex` 收尾散文 + `tokens used`（要被跳过） |

## claude（`-p --output-format stream-json`）

抓取：真实 stream-json 日志，取第 1、2、9 行（Bash 工具调用、tool_result、助手文本）。

| 夹具                  | 覆盖的形态                                       |
| --------------------- | ------------------------------------------------ |
| `claude-stream.jsonl` | `assistant.content` 里的 tool_use 与 text 两种块 |

## opencode（`run --format json`）

抓取：真实 `--format json` 日志。`opencode-tools.jsonl` 里故意留了一行 opencode 自己打的
权限提示（带 ANSI、不是 JSON），用来保证解析时跳过非 JSON 行。

| 夹具                   | 覆盖的形态                                      |
| ---------------------- | ----------------------------------------------- |
| `opencode-tools.jsonl` | grep 工具调用、非 JSON 行、被拒的 bash 工具调用 |
| `opencode-text.jsonl`  | `text` 事件的助手文本（收尾汇报）               |

## 人话化的补充夹具（#322 全景网页的「最近动作」）

2026-09-27 从本机 Atrium 任务日志（`~/Atrium/runtime-data/tasks/<n>/log`）原样截取的行，覆盖
heredoc、长管道与中文说明；解析优先取助手自己说的话的首句，没有时才把工具调用概括成人话。

| 夹具                     | 来源                 | 覆盖的形态                                                                      |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------- |
| `claude-said.jsonl`      | t62 第 206～208 行   | 中文说明 → `python3 - <<'EOF'` 工具调用 → 工具结果                              |
| `claude-heredoc.jsonl`   | t62 第 207～208 行   | 只有 heredoc 工具调用与结果                                                     |
| `claude-pipeline.jsonl`  | t62 第 424～425 行   | `mkdir && for …; do … > …; done; ls …; cat > harness.ts <<'EOF'` 长管道         |
| `codex-said.txt`         | t65 第 1049～1075 行 | `codex` 段的中文长句，后面跟 exec                                               |
| `codex-heredoc.txt`      | t65 第 2412～2444 行 | 跨行的 `node - <<'NODE'` exec                                                   |
| `codex-pipeline.txt`     | t65 第 2117～2135 行 | `rg … \| cut … \| tail` 长管道                                                  |
| `opencode-said.jsonl`    | t29 第 12～16 行     | 中文 `text` 事件后跟两次 gh 调用                                                |
| `opencode-heredoc.jsonl` | t8、t6、t51 各一行   | `cat > … <<'EOF'`、`gh pr create --body "$(cat <<'EOF' …)"`、`python3 - <<'PY'` |
