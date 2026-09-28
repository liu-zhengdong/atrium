#!/usr/bin/env bash
# v2 端到端冒烟：临时数据目录 + 空闲端口起服务 → 建部门、要点、任务 → 等待 → 平滑重启 → 暂停 → 停。每步断言。
# 只动自己起的服务（记 pid），不碰 4310 与 ~/.atrium。
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/atrium-v2-smoke.XXXXXX")
bin="$work/atrium"
export ATRIUM_DATA="$work/data"
export ATRIUM_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
unset ATRIUM_WORKER

pid=""
cleanup() {
  # 只结束自己起的服务进程（新旧 pid 都记着）。
  for p in $pid; do kill "$p" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { echo "失败：$*" >&2; [ -f "$ATRIUM_DATA/service.log" ] && tail -20 "$ATRIUM_DATA/service.log" >&2; exit 1; }
# json <命令…>：跑命令取 --json 输出；jq 断言用 has <jq 表达式>。
json() { "$bin" "$@" --json; }
has() { jq -e "$1" >/dev/null <<<"$out" || fail "断言不成立：$1；输出：$out"; }

step "构建"
(cd "$root" && go build -o "$bin" ./cmd/atrium)

step "启动（端口 ${ATRIUM_PORT}）"
out=$(json start); has '.ok and .result.pid > 0 and .next == "atrium status"'
pid=$(jq -r .result.pid <<<"$out")
[ "$(stat -f %Lp "$ATRIUM_DATA/token" 2>/dev/null || stat -c %a "$ATRIUM_DATA/token")" = 600 ] || fail "令牌文件权限不是 600"
out=$(json start); has '.ok and (.result.pid|tostring) == "'"$pid"'"'   # 单实例：再 start 不起第二个

step "认证默认拒绝"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$ATRIUM_PORT/api/tasks")
[ "$code" = 401 ] || fail "无令牌应 401，得到 $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "http://127.0.0.1:$ATRIUM_PORT/api/status")
[ "$code" = 401 ] || fail "错令牌应 401，得到 $code"

step "status"
out=$(json status); has '.ok and .result.running and .result.service.pauses == []'

step "org add / point add / org show"
out=$(json org add 公司 --what "全部" --repo liu-zhengdong/atrium); has '.result.id == "o1" and .result.repos == ["liu-zhengdong/atrium"]'
out=$(json org add 运行时 --parent o1); has '.result.id == "o2" and .result.parent == "o1"'
out=$(json point add o1 "简洁优先" --why "整体更简单"); has '.result.id == "k1" and .result.pos == 1 and .result.by == "u1"'
out=$(json point add o2 "单实例"); has '.result.id == "k2"'
out=$(json point add o1 "事实为准" --pos 1); has '.result.pos == 1'
out=$(json org show o2); has '.result.path == ["o1","o2"] and (.result.inherited|map(.text)) == ["事实为准","简洁优先"] and .result.room == 6'
for i in 1 2 3 4 5; do json point add o1 "p$i" >/dev/null; done
out=$(json point add o1 "第八条" || true); has '.ok == false and .error.code == "limit" and (.error.next|length) > 0'

step "task add / ls / show / set / tree / plan / note"
out=$(json task add 根任务 --org o2); has '.result.id == "t1" and .result.status == "todo" and .next == "atrium task run t1"'
out=$(json task add 子一 --parent t1); has '.result.org == "o2"'
out=$(json task add 子二 --parent t1 --after t2 --priority urgent); has '.result.priority == "urgent"'
out=$(json task ls); has '(.result|length) == 3'
out=$(json task plan t1); has '.result[0].id == "t2" and .result[0].ready and .result[1].waiting_on == ["t2"]'
out=$(json task set t2 --after t3 || true); has '.ok == false and .error.code == "usage"'   # 成环
out=$(json task note t1 "记一笔"); has '.ok'
out=$(json task show t1); has '.result.children.total == 2 and (.result.history|map(.kind)) == ["created","note"]'
out=$(json task tree); has '.result[0].id == "t1" and (.result[0].children|length) == 2'

step "task wait（长轮询被另一条命令唤醒）"
("$bin" task wait t2 --until done --timeout 20 --json >"$work/wait.out") &
waiter=$!
sleep 0.5
out=$(json task set t2 --status done); has '.result.status == "done"'
wait "$waiter" || fail "wait 失败：$(cat "$work/wait.out")"
out=$(cat "$work/wait.out"); has '.result.reached and .result.task.status == "done"'
out=$(json task wait t3 --timeout 0 || true); has '.ok == false and .error.code == "timeout"'

step "pause / resume"
out=$(json pause --org o2); has '.result.pauses[0].scope == "o2"'
out=$(json pause); has '(.result.pauses|length) == 2'
out=$(json resume); has '.result.pauses[0].scope == "o2" and .next == "atrium resume --org o2"'
out=$(json resume --org o2); has '.result.pauses == []'
out=$(json pause --org t1 || true); has '.error.code == "usage"'

step "restart（平滑：在等的 wait 不断）"
("$bin" task wait t3 --until cancelled --timeout 30 --json >"$work/wait2.out") &
waiter=$!
sleep 0.3
out=$(json restart); has '.ok and .result.old_pid != .result.service.pid'
newpid=$(jq -r .result.service.pid <<<"$out"); pid="$pid $newpid"
out=$(json task set t3 --status cancelled); has '.result.status == "cancelled"'
wait "$waiter" || fail "重启后 wait 失败：$(cat "$work/wait2.out")"
out=$(cat "$work/wait2.out"); has '.result.reached and .result.task.status == "cancelled"'
out=$(json task ls --status done,cancelled); has '(.result|length) == 2'   # 数据跨重启还在

step "stop"
out=$(json stop); has '.result.stopped'
out=$(json status); has '.result.running == false'
[ ! -f "$ATRIUM_DATA/service.json" ] || fail "停下后登记文件还在"

echo
echo "冒烟通过"
