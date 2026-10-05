---
protocol: cli
command: command-code
args: ["--print", "--output-format", "json", "--yolo", "--no-auto-update", "--skip-onboarding", "{session_args}", "{model_args}", "{effort_args}", "{prompt}"]
model_args: ["--model", "{model}"]
effort_args: ["--effort", "{effort}"]
efforts: [low, medium, high]
session_args: ["--resume", "{session}"]
session_match: '"type"\s*:\s*"run_start"[^\n]*?"sessionId"\s*:\s*"([0-9a-f-]{36})"'
done_match: '^\{"type":"result","subtype":"success"'
error_match: '^\{"type":"result","subtype":"error"'
json: true
usage:
  event: result
  input: usage.inputTokens
  output: usage.outputTokens
  cache_read: usage.cacheReadTokens
  cache_write: usage.cacheWriteTokens
auto: false
trust: unknown
max_risk: low
---
command-code v1.74.1 的通用 CLI 档案，登记名 harness/commandcode。
用 workers edit harness/commandcode --file <本文件> 登记；档案保存在数据库。
commandcode 使用 PATH 上的 command-code，与已有内置 command-code 标识分开。

本档案仍待真实登录通道的成功两轮验收，暂不参与自动挑人。
--resume 接首行 run_start 的 sessionId；首次启动省去整组续接参数。
usage 只读取收尾 result 的四类 token，未获得花费字段，不把缺价当免费。
通用 CLI 的过程日志按原文保留。强度是否可用取决于所选模型。
