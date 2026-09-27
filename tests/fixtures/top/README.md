# atrium top 的最近动作夹具（#262）

`atrium top` 每行显示的「最近一个动作」是从执行者日志尾部解析出来的，解析按各自适配器的
真实输出格式写。这些片段是 2026-09-27 在本机跑真执行者抓下来的原样日志，不是手编的。

## codex（`codex exec`，不带 `--json`，分段纯文本）

抓取：`echo "<提示词>" | codex exec -C . -s danger-full-access -m gpt-6-sol -c model_reasoning_effort="low" --skip-git-repo-check -`，
codex 0.157.1，临时目录里两个文件（hello.txt、edit.txt）。

| 夹具              | 原始日志行号 | 覆盖的形态                                        |
| ----------------- | ------------ | ------------------------------------------------- |
| `codex-tools.log` | raw2 15～68  | 段名 `codex` / `exec`；最后一段是 exec 工具调用   |
| `codex-patch.log` | raw2 33～53  | 段名 `apply patch`；目标取自提示后的路径行        |
| `codex-final.log` | raw2 76～98  | 尾部 `codex` 收尾散文 + `tokens used`（要被跳过） |

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
