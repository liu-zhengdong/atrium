# agy（Antigravity CLI）日志夹具（t137）

2026-09-28 在本机跑真 agy 1.2.12 抓下来的 stream-json 日志，不是手编的；只把 init 事件里 57 个工具名缩成 3 个、
临时目录路径换成 `/w/repo`。

抓取：`agy -p "" --input-format stream-json --output-format stream-json --model gemini-3.8-flash-medium --dangerously-skip-permissions`，
标准输入一行 `{"event":"user","message":{"role":"user","content":"先用一两句话说明你打算怎么做，再把 e.txt 第二行改成 LINE2……"}}`。

| 夹具           | 覆盖的形态                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `stream.jsonl` | init（conversation_id）、user_input 步骤、view_file / replace_file_content / run_command 工具步骤、text_delta 片段、result |
