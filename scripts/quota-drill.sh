#!/usr/bin/env bash
# 额度避让演练：一条命令起假 magpie（本机临时端口）、隔离实例（数据目录全在 $TMPDIR）与假执行者（bash），
# 跑三个场景并断言 magpie 窗口读数怎样影响派活：
#   一、窗口 40%：经 magpie 的候选照常可选，照常派它；
#   二、窗口 92%：该组合不可用，拒绝原因含「额度将满」，实际派活落在别的组合，task log 与经历可见；
#   三、假 magpie 不可达：读数按未知，照常派。
# 只服务演练：不读真实额度、不碰用户在跑的服务与 ~/.atrium-v2；隔离数据与临时进程用完即停。
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/atrium-quota-drill.XXXXXX")
bin="$work/atrium$(go env GOEXE)"
# 从用户身份起服务：不继承执行者那套连接变量，命令行按 ATRIUM_DATA 里的用户令牌连隔离实例。
unset ATRIUM_WORKER ATRIUM_WORKER_TOKEN ATRIUM_SERVER ATRIUM_LEADER_TOKEN

pids=""
cur="开始前"; where=""
trap 'where="第 $LINENO 行：$BASH_COMMAND"' ERR
cleanup() {
  local rc=$?
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  [ -s "$work/magpie.pids" ] && kill $(cat "$work/magpie.pids") 2>/dev/null || true
  [ -z "${ATRIUM_DATA:-}" ] || "$bin" stop >/dev/null 2>&1 || true
  if [ "$rc" = 0 ]; then rm -rf "$work"; return; fi
  echo; echo "演练失败：步骤「${cur}」${where:+，$where}" >&2
  echo "现场留在 $work" >&2
}
trap cleanup EXIT

step() { cur="$*"; printf '\n== %s\n' "$*"; }
fail() { where="第 ${BASH_LINENO[${#BASH_LINENO[@]}-2]} 行"; echo "失败：$*" >&2; exit 1; }
j() { "$bin" "$@" --json; }
has() { jq -e "$@" >/dev/null <<<"$out" || fail "断言不成立：$1；输出：$out"; }
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }

# 假 magpie：GET /v1/magpie/quotas 回读数文件里的构造读数，并记一次命中；打印网关地址。
magpie() {  # magpie <读数文件> <命中记录>
  local py="$2.py"
  cat >"$py" <<'PY'
import http.server, sys
reading, hits = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/v1/magpie/quotas":
            self.send_error(404); return
        open(hits, "a").write("hit\n")
        body = open(reading, "rb").read()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
open(hits + ".port", "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
  rm -f "$2" "$2.port"
  python3 "$py" "$1" "$2" >/dev/null 2>&1 & echo "$!" >>"$work/magpie.pids"
  for _ in $(seq 100); do [ -f "$2.port" ] && break; sleep 0.1; done
  [ -f "$2.port" ] || fail "假 magpie 没起来"
  echo "http://127.0.0.1:$(cat "$2.port")"
}

start_instance() {  # start_instance <数据目录> <magpie 地址>
  export ATRIUM_DATA="$1" ATRIUM_MAGPIE_URL="$2"
  unset ATRIUM_PORT
  out=$(j start); has '.ok and .result.pid > 0'
  pids="$pids $(jq -r .result.pid <<<"$out")"
}
stop_instance() { "$bin" stop >/dev/null 2>&1 || true; }
profile() { out=$(j workers edit "$1" --file "$2"); has '.ok'; }
wait_tool() {  # wait_tool <工具>：等主机自检认出这个通用命令行执行者
  for _ in $(seq 150); do
    out=$(j host ls h1)
    jq -e --arg t "$1" '.result.info.clis[$t].installed == true' >/dev/null <<<"$out" && return 0
    sleep 0.2
  done
  fail "h1 未识别 $1；输出：$out"
}
wait_hit() { for _ in $(seq 100); do [ -s "$1" ] && return 0; sleep 0.1; done; fail "实例没去读假 magpie：$1"; }
wait_dry() {  # wait_dry <任务> <jq 断言>：等读数落到实例（dry-run 是只读预览，可反复调用）
  for _ in $(seq 100); do
    out=$(j task run "$1" --dry-run)
    jq -e "$2" >/dev/null <<<"$out" && return 0
    sleep 0.1
  done
  fail "dry-run 未达预期：$2；输出：$out"
}
# evidence <任务>：打印这次实际拉起落在哪个组合，以及 task log 的关键行。
evidence() {
  local w t
  out=$(j task show "$1")
  w=$(jq -r '.result.history|map(select(.kind=="launch"))|last|.body|fromjson|.worker' <<<"$out")
  out=$(j task log "$1")
  t=$(jq -r .result.text <<<"$out" | tr '\n' ' ' | sed 's/  */ /g')
  printf '  实际执行者=%s；task log：%s\n' "$w" "$t"
}
write_profiles() {  # write_profiles <目录> <magpie 地址>：mag 走 magpie 网关的 cursor 组合，plain 直连
  cat >"$1/mag.md" <<MD
---
protocol: cli
command: bash
args: ["-c", "echo 组合=mag 模型={model} 端点={base_url}; echo DONE; echo 交付结论：完成", "{prompt}"]
endpoint: $2/v1
endpoint_api: openai
model: cursor/auto
prefer: true
---
额度避让演练用的假执行者：模型走 magpie 网关的 cursor 组合。
MD
  cat >"$1/plain.md" <<'MD'
---
protocol: cli
command: bash
args: ["-c", "echo 组合=plain; echo DONE; echo 交付结论：完成", "{prompt}"]
---
额度避让演练用的假执行者：不走 magpie 的组合。
MD
  profile harness/mag "$1/mag.md"; profile harness/plain "$1/plain.md"
  wait_tool mag; wait_tool plain
}

step "构建"
(cd "$root" && go build -o "$bin" ./cmd/atrium)

step "场景一：窗口 40%，经 magpie 的候选照常可选并派它"
d1="$work/s1"; mkdir -p "$d1/data"
echo '{"object":"list","data":[{"provider":"cursor","plan":"Pro","kind":"subscription","windows":[{"name":"7d","used":40,"resetsAt":"2099-01-01T00:00:00Z"}]}]}' >"$d1/reading.json"
mp=$(magpie "$d1/reading.json" "$d1/hits")
start_instance "$d1/data" "$mp"
write_profiles "$d1" "$mp"
wait_hit "$d1/hits"
out=$(j task add 额度演练一); t1=$(jq -r .result.id <<<"$out")
wait_dry "$t1" '.result.pick.recommended == "mag+cursor/auto"'
rec=$(jq -r '.result.pick.recommended' <<<"$out")
has '[.result.pick.candidates[]|select(.id=="mag+cursor/auto")][0].eligible == true'
out=$(j task run "$t1"); has '.result.queued'
out=$(j task wait "$t1" --timeout 30); has '.result.task.status == "done"'
out=$(j task log "$t1"); has '.result.text|contains("组合=mag")'
out=$(j task show "$t1"); has '.result.history|map(select(.kind=="launch"))|last|.body|fromjson|.worker == "mag+cursor/auto"'
printf '  读数 40%%：dry-run 推荐 %s\n' "$rec"
evidence "$t1"
stop_instance

step "场景二：窗口 92%，该组合不可用、换别的组合"
d2="$work/s2"; mkdir -p "$d2/data"
echo '{"object":"list","data":[{"provider":"cursor","plan":"Pro","kind":"subscription","windows":[{"name":"7d","used":92,"resetsAt":"2099-01-01T00:00:00Z"}]}]}' >"$d2/reading.json"
mp=$(magpie "$d2/reading.json" "$d2/hits")
start_instance "$d2/data" "$mp"
write_profiles "$d2" "$mp"
wait_hit "$d2/hits"
out=$(j task add 额度演练二); t2=$(jq -r .result.id <<<"$out")
wait_dry "$t2" '[.result.pick.candidates[]|select(.id=="mag+cursor/auto")][0].eligible == false'
refusal=$(jq -r '[.result.pick.candidates[]|select(.id=="mag+cursor/auto")][0].refusals|join("；")' <<<"$out")
recommend=$(jq -r '.result.pick.recommended' <<<"$out")
has '.result.pick.recommended == "plain"'
has '([.result.pick.candidates[]|select(.id=="mag+cursor/auto")][0].refusals|join("；")) as $r | ($r|test("额度将满")) and ($r|test("cursor Pro：7d 已用 92.0%")) and ($r|test("须给用户留 20%"))'
out=$(j task run "$t2"); has '.result.queued'
out=$(j task wait "$t2" --timeout 30); has '.result.task.status == "done"'
out=$(j task log "$t2"); has '(.result.text|contains("组合=plain")) and (.result.text|contains("组合=mag")|not)'
out=$(j task show "$t2"); has '.result.history|map(select(.kind=="launch"))|last|.body|fromjson|.worker == "plain"'
printf '  读数 92%%：拒绝 mag+cursor/auto：%s；dry-run 推荐 %s\n' "$refusal" "$recommend"
evidence "$t2"
stop_instance

step "场景三：假 magpie 不可达，读数按未知、照常派"
d3="$work/s3"; mkdir -p "$d3/data"
closed=$(free_port)
start_instance "$d3/data" "http://127.0.0.1:$closed"
write_profiles "$d3" "http://127.0.0.1:$closed"
out=$(j task add 额度演练三); t3=$(jq -r .result.id <<<"$out")
wait_dry "$t3" '.result.pick.recommended == "mag+cursor/auto"'
rec=$(jq -r '.result.pick.recommended' <<<"$out")
has '[.result.pick.candidates[]|select(.id=="mag+cursor/auto")][0].eligible == true'
out=$(j task run "$t3"); has '.result.queued'
out=$(j task wait "$t3" --timeout 30); has '.result.task.status == "done"'
out=$(j task log "$t3"); has '.result.text|contains("组合=mag")'
printf '  magpie 不可达：dry-run 推荐 %s\n' "$rec"
evidence "$t3"
stop_instance

echo
echo "额度避让演练通过：三个场景断言全部成立"
