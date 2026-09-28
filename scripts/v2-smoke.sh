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

step "负责人、备忘、上交（org/leaders）"
out=$(json leader add 运行时负责人 --workers claude,codex); has '.result.id == "a1" and .result.workers == ["claude","codex"] and .next == "atrium org edit <oN> --leader a1"'
out=$(json leader add 没组合 || true); has '.error.code == "usage"'
out=$(json org edit o2 --leader a1); has '.result.leader == "a1"'
out=$(json leader ls); has '.result[0].depts == ["o2"]'
out=$(json leader edit a1 --workers codex); has '.result.workers == ["codex"]'
out=$(json memo edit "下次先看 t1" --as a1); has '.result.owner == "a1"'
out=$(json leader ls a1); has '.result.memo.body == "下次先看 t1"'
out=$(json memo edit "秘书备忘"); has '.result.owner == "secretary"'
out=$(json memo show); has '.result.body == "秘书备忘"'
out=$(json memo edit "$(python3 -c 'print("字"*2001)')" || true); has '.error.code == "limit"'
out=$(json leader escalate 卡住 --kind stuck || true); has '.error.code == "forbidden"'   # 只有负责人令牌能上交
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer lt_fake' "http://127.0.0.1:$ATRIUM_PORT/api/org")
[ "$code" = 401 ] || fail "没签发的负责人令牌应 401，得到 $code"

step "events wait / ack（任务受阻 → 要处理事件投秘书）"
out=$(json task add 受阻的活); t_blk=$(jq -r .result.id <<<"$out")
out=$(json task set "$t_blk" --status blocked); has '.result.status == "blocked"'
out=$(json events wait --timeout 5); has '(.result|length) >= 1 and (.result|map(select(.task == "'"$t_blk"'"))|.[0].level) == "act" and (.next|startswith("atrium events ack"))'
ev=$(jq -r '.result|map(select(.task == "'"$t_blk"'"))|.[0].id' <<<"$out")
out=$(json events wait --timeout 0); has '(.result|map(select(.id == '"$ev"'))|length) == 0'   # 租约内不重投
out=$(json events ack "$ev" 99999); has '.result.acked == ['"$ev"'] and .result.missing == [99999]'

step "top / statusline"
out=$(json top); has '.ok and (.result.tasks|map(select(.id == "'"$t_blk"'"))|.[0].holder.who) == "secretary" and .result.secretary.listening == null'
line=$("$bin" statusline); grep -q "$t_blk 秘书 卡住" <<<"$line" || fail "statusline 没有受阻任务：$line"
line=$(ATRIUM_DATA="$work/none" "$bin" statusline); [ "$line" = "Atrium 未运行" ] || fail "服务不在时应显示未运行：$line"
[ ! -d "$work/none" ] || fail "statusline 不该建数据目录"

step "secretary bridge（假会话收件 socket）"
sock="$work/cc.sock"
python3 - "$sock" "$work/inbox.txt" <<'PY' &
import os, socket, sys
path, out = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX); s.bind(path); s.listen(8)
while True:
    c, _ = s.accept()
    data = b""
    while True:
        chunk = c.recv(65536)
        if not chunk: break
        data += chunk
    c.close()
    if data:
        with open(out, "ab") as f: f.write(data)
PY
inbox=$!; pid="$pid $inbox"
for _ in $(seq 50); do [ -S "$sock" ] && break; sleep 0.1; done
out=$(CLAUDE_CODE_MESSAGING_SOCKET="$sock" CLAUDE_CODE_MESSAGING_TOKEN=tok json secretary bridge --detach --batch 1); has '.ok and .result.pid > 0'
bridge=$(jq -r .result.pid <<<"$out"); pid="$pid $bridge"
out=$(CLAUDE_CODE_MESSAGING_SOCKET="$sock" CLAUDE_CODE_MESSAGING_TOKEN=tok json secretary bridge --detach); has '.result.pid == '"$bridge"   # 同一会话不起第二个
out=$(json task add 又卡住); t_blk2=$(jq -r .result.id <<<"$out")
json task set "$t_blk2" --status blocked >/dev/null
for _ in $(seq 100); do grep -q "$t_blk2" "$work/inbox.txt" 2>/dev/null && break; sleep 0.1; done
head -1 "$work/inbox.txt" | grep -qx '{"type":"auth","token":"tok"}' || fail "没先认证：$(cat "$work/inbox.txt" 2>/dev/null)"
grep -q "【Atrium 事件】" "$work/inbox.txt" && grep -q "$t_blk2" "$work/inbox.txt" || fail "事件没注入会话：$(cat "$work/inbox.txt" 2>/dev/null)"
grep -q "atrium events ack" "$work/inbox.txt" || fail "注入消息末尾没有 ack 命令"
out=$(json secretary bridge --status); has '.result.listener != null and .result.bridge.pid == '"$bridge"
out=$(json top); has '.result.secretary.listening != null'
kill "$bridge"; kill "$inbox"; wait "$inbox" 2>/dev/null || true
for _ in $(seq 50); do kill -0 "$bridge" 2>/dev/null || break; sleep 0.1; done
[ ! -f "$ATRIUM_DATA/secretary/bridge.json" ] || fail "bridge 退出后登记还在"
dir="$work/sec"; mkdir -p "$dir/.claude"; echo '{"model":"x"}' >"$dir/.claude/settings.local.json"
out=$(json secretary bridge --install-hook --dir "$dir"); has '.result.added'
out=$(json secretary bridge --install-hook --dir "$dir"); has '.result.added == false'
jq -e '.model == "x" and (.hooks.SessionStart[0].hooks[0].command == "atrium secretary bridge --detach")' "$dir/.claude/settings.local.json" >/dev/null || fail "hook 写得不对"

step "技能、资料、决定、凭据、选项单、周期任务（第二波 D）"
mkdir -p "$work/skill/refs"; printf -- '---\ndescription: 修 bug 的做法\n---\n先复现再修\n' >"$work/skill/SKILL.md"; echo 附 >"$work/skill/refs/a.md"
out=$(json skill add fix-bug "$work/skill" --checks pr_exists); has '.result.rev == 1 and .result.summary == "修 bug 的做法" and .result.files == 2'
[ -f "$(jq -r .result.path <<<"$out")" ] || fail "技能文件不在数据目录"
out=$(json skill add fix-bug --workers claude); has '.result.rev == 2 and .result.workers == ["claude"] and .result.checks == ["pr_exists"]'
out=$(json skill ls fix-bug); has '.result.others == ["refs/a.md"] and (.result.body|test("先复现"))'
printf '部门是什么' >"$work/overview.md"; printf 'abc' >"$work/detail.md"
out=$(json material add o2 "$work/overview.md" --overview --note 总览); has '.result[0].id == "m1" and .result[0].kind == "overview"'
out=$(json material add o2 "$work/detail.md" --note 细节); has '.result[0].id == "m2"'
out=$(json material add o2 "$work/detail.md" --note 改了); has '.result[0].id == "m2" and .result[0].rev == 2'
out=$(json material get m1); has '(.result.content|@base64d) == "部门是什么"'
[ "$(ATRIUM_WORKER=1 "$bin" material get m2)" = abc ] || fail "执行者应能 material get"
out=$(json material archive m2); has '.result.archived_at != null'
out=$(json material ls --node o2); has '(.result|length) == 1'
out=$(json org show o2); has '(.result.limits|map(select(.key == "overview"))[0].used) == 5'
out=$(json decision add o2 "先做 A" --why 快); has '.result.id == "d1"'
out=$(json decision add o2 "改做 B" --replaces d1); has '.result.id == "d2"'
out=$(json decision ls --node o2); has '(.result|map(.id)) == ["d2"]'
printf 'sekrit\n' | "$bin" secret set o1 BOT_TOKEN --json >/dev/null || fail "secret set 失败"
out=$(json secret ls --node o2); has '.result[0].name == "BOT_TOKEN" and (tostring|test("sekrit")|not)'
[ "$(stat -f %Lp "$ATRIUM_DATA/secrets/o1/BOT_TOKEN" 2>/dev/null || stat -c %a "$ATRIUM_DATA/secrets/o1/BOT_TOKEN")" = 600 ] || fail "凭据文件权限不是 600"
grep -q sekrit "$ATRIUM_DATA/service.log" && fail "凭据值进了日志"
out=$(json secret rm o1 BOT_TOKEN); has '.ok'
opt='{"title":"T","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"e"}'
echo "{\"title\":\"下一步\",\"options\":[$opt,$opt,$opt],\"recommend\":[1],\"reason\":\"快\"}" >"$work/choice.json"
out=$(json choice add o2 "$work/choice.json"); has '.result.id == "c1" and .result.status == "open"'
out=$(json choice ls); has '(.result|length) == 1'
out=$(json choice pick c1 1,3 --note 先快); has '.result.status == "picked" and .result.options[0].task != null and .result.decision == "d3"'
out=$(json choice add o2 "$work/choice.json"); has '.result.id == "c2"'
out=$(json choice pass c2); has '.result.status == "passed"'
out=$(json schedule add o2 巡检 --every 1d --at 09:00 --kind patrol); has '.result.id == "s1" and .result.at == "09:00"'
out=$(json schedule run s1 || true); has '(.ok and .result.task.id != null) or (.error.code == "conflict" and (.error.message|test("已生成")))'
out=$(json schedule ls); has '.result[0].last_task != null'
out=$(json schedule rm s1); has '.ok'
out=$(json schedule add o2 x --every 30m || true); has '.error.code == "usage"'

step "task merge：登记 PR → 合入队列 rebase、快检查、squash 合入（另起隔离服务，假 gh + 本地 bare 远端）"
m="$work/merge"; mkdir -p "$m/bin"
g() { git -c user.name=t -c user.email=t@t "$@"; }
git init -q --bare -b main "$m/remote.git"
git clone -q "$m/remote.git" "$m/seed" 2>/dev/null
(
  cd "$m/seed" && git checkout -q -b main
  mkdir .agents && printf '#!/bin/sh\necho 快检查通过\n' >.agents/check && chmod +x .agents/check
  echo hi >README.md && git add -A && g commit -qm init && git push -q origin main
  git checkout -q -b feat && echo x >feat.txt && git add -A && g commit -qm feat && git push -q origin feat
  git checkout -q main && echo y >other.txt && git add -A && g commit -qm other && git push -q origin main
)
echo OPEN >"$m/state"
printf '#!/usr/bin/env bash\nremote=%q; state=%q\n' "$m/remote.git" "$m/state" >"$m/bin/gh"
cat >>"$m/bin/gh" <<'EOF'
set -euo pipefail
head() { git --git-dir "$remote" rev-parse refs/heads/feat; }
case "$1 $2" in
  "repo view") echo main ;;
  "repo clone") git clone -q "$remote" "$4" ;;
  "pr view")
    jq -n --arg s "$(cat "$state")" --arg h "$(head)" --arg mc "$(cat "$state.commit" 2>/dev/null || true)" \
      '{number:1,url:"https://github.com/o/r/pull/1",state:$s,headRefName:"feat",headRefOid:$h,baseRefName:"main",body:"",
        mergeCommit:(if $mc == "" then null else {oid:$mc} end)}' ;;
  "pr merge")
    want=""; args=("$@"); for i in "${!args[@]}"; do [ "${args[$i]}" = --match-head-commit ] && want=${args[$((i+1))]}; done
    [ "$want" = "$(head)" ] || { echo "头提交 $(head) 与 --match-head-commit $want 不一致" >&2; exit 1; }
    w=$(mktemp -d); git clone -q "$remote" "$w/c"; cd "$w/c"
    git merge -q --squash origin/feat; git -c user.name=t -c user.email=t@t commit -qm "squash #1"; git push -q origin main
    git rev-parse HEAD >"$state.commit"; echo MERGED >"$state"; rm -rf "$w" ;;
  *) echo "假 gh 不支持：$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$m/bin/gh"
saved=("$ATRIUM_DATA" "$ATRIUM_PORT" "$PATH")
export ATRIUM_DATA="$m/data" PATH="$m/bin:$PATH"
export ATRIUM_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
out=$(json start); has '.ok'
pid="$pid $(jq -r .result.pid <<<"$out")"
out=$(json task add 合入演练); has '.result.id == "t1"'
out=$(json task merge t1 --pr 1 || true); has '.ok == false and .error.code == "usage"'   # 任务没仓库、PR 号没带仓库
out=$(json task merge t1 --pr https://github.com/o/r/pull/1); has '.result.status == "running" and .result.stage == "merge_queue" and .result.repo == "o/r" and .next == "atrium task wait t1"'
out=$(json task wait t1 --until done,blocked,queued --timeout 60); has '.result.task.status == "done" and .result.task.stage == "merged"'
files=$(git --git-dir "$m/remote.git" ls-tree --name-only main)
grep -q feat.txt <<<"$files" && grep -q other.txt <<<"$files" || fail "main 上应有 feat.txt 与 other.txt：$files"
[ "$(git --git-dir "$m/remote.git" rev-parse refs/heads/feat~1)" = "$(git --git-dir "$m/remote.git" rev-parse 'refs/heads/main~1')" ] || fail "feat 应已 rebase 到 main 上再合入"
out=$(json task show t1); has '(.result.history|map(.kind)) | index("merge_commit") != null'
out=$(json stop); has '.result.stopped'
export ATRIUM_DATA="${saved[0]}" ATRIUM_PORT="${saved[1]}" PATH="${saved[2]}"

step "stop"
out=$(json stop); has '.result.stopped'
out=$(json status); has '.result.running == false'
[ ! -f "$ATRIUM_DATA/service.json" ] || fail "停下后登记文件还在"

echo
echo "冒烟通过"
