#!/usr/bin/env bash
# 端到端冒烟：临时数据目录 + 空闲端口起服务 → 建部门、要点、任务 → 等待 → 平滑重启 → 暂停 → 停。每步断言。
# 只动自己起的服务（记 pid），不碰用户在跑的服务与 ~/.atrium-v2。
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/atrium-smoke.XXXXXX")
bin="$work/atrium"
export ATRIUM_DATA="$work/data"
export ATRIUM_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')
unset ATRIUM_AS

pid=""
cur="开始前"; where=""
# 失败（断言不成立，或哪条命令非零退出被 set -e 带走）时说清哪一步、哪一行，附服务日志末尾，现场目录留着。
trap 'where="第 $LINENO 行：$BASH_COMMAND"' ERR
cleanup() {
  local rc=$?
  # 只结束自己起的服务进程（新旧 pid 都记着）。
  for p in $pid; do kill "$p" 2>/dev/null || true; done
  if [ "$rc" = 0 ]; then rm -rf "$work"; return; fi
  {
    echo; echo "冒烟失败：步骤「${cur}」${where:+，$where}"
    echo "最近一条输出：${out:-（无）}"
    if [ -f "$ATRIUM_DATA/service.log" ]; then echo "--- 服务日志末尾（$ATRIUM_DATA/service.log）"; tail -40 "$ATRIUM_DATA/service.log"; fi
    echo "现场留在 $work"
  } >&2
}
trap cleanup EXIT

step() { cur="$*"; printf '\n== %s\n' "$*"; }
fail() { where="第 ${BASH_LINENO[${#BASH_LINENO[@]}-2]} 行"; echo "失败：$*" >&2; exit 1; }
# json <命令…>：跑命令取 --json 输出；jq 断言用 has <jq 表达式>。
json() { "$bin" "$@" --json; }
has() { jq -e "$1" >/dev/null <<<"$out" || fail "断言不成立：$1；输出：$out"; }
# 技能检查那一段要用 pnpm、ffmpeg（造小样、跑检查）与无头浏览器（运行时自己找，找不到时任务转受阻并写明）。
for c in jq pnpm ffmpeg ffprobe; do command -v "$c" >/dev/null || fail "缺 $c：冒烟要用它"; done

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
out=$(json org show o2); has '.result.path == ["o1","o2"] and (.result.inherited|map(.text)) == ["事实为准","简洁优先"] and .result.room == 6 and .result.leader == "secretary" and .result.leader_from == null'
for i in 1 2 3 4 5; do json point add o1 "p$i" >/dev/null; done
out=$(json point add o1 "第八条" || true); has '.ok == false and .error.code == "limit" and (.error.next|length) > 0'

step "task add / ls / show / set / tree / note"
out=$(json task add 根任务 --org o2); has '.result.id == "t1" and .result.status == "todo" and .next == "atrium task run t1"'
out=$(json task add 子一 --parent t1); has '.result.org == "o2"'
out=$(json task add 子二 --parent t1 --after t2 --priority urgent); has '.result.priority == "urgent"'
out=$(json task ls); has '(.result|length) == 3'
out=$(json task tree t1); has '(.result[0].ready|not) and .result[0].children[0].ready and .result[0].children[1].waiting_on == ["t2"] and .next == "atrium task run t2"'
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
out=$(json org show o2); has '.result.leader == "a1" and .result.leader_from == "o2"'
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
out=$(json task set "$t_blk" --status blocked || true); has '.ok == false and .error.code == "usage"'   # 停下只有 task stop 一个说法
out=$(json task stop "$t_blk" 等证书); has '.result.status == "blocked" and .next == "atrium task run '"$t_blk"'"'
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
json task stop "$t_blk2" >/dev/null
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

step "技能、资料、凭据、选项单、周期任务（第二波 D）"
mkdir -p "$work/skill/refs"; printf -- '---\ndescription: 修 bug 的做法\n---\n先复现再修\n' >"$work/skill/SKILL.md"; echo 附 >"$work/skill/refs/a.md"
out=$(json skill add fix-bug "$work/skill" --checks pr_exists || true); has '.ok == false and (.error.message|test("--checks: 不认识的检查"))'
out=$(json skill add fix-bug "$work/skill" --checks video); has '.result.rev == 1 and .result.summary == "修 bug 的做法" and .result.files == 2'
[ -f "$(jq -r .result.path <<<"$out")" ] || fail "技能文件不在数据目录"
out=$(json skill add fix-bug --workers claude); has '.result.rev == 2 and .result.workers == ["claude"] and .result.checks == ["video"]'
out=$(json skill ls fix-bug); has '.result.others == ["refs/a.md"] and (.result.body|test("先复现"))'
printf '部门是什么' >"$work/overview.md"; printf 'abc' >"$work/detail.md"
out=$(json material add o2 "$work/overview.md" --overview --note 总览); has '.result[0].id == "m1" and .result[0].kind == "overview"'
out=$(json material add o2 "$work/detail.md" --note 细节); has '.result[0].id == "m2"'
out=$(json material add o2 "$work/detail.md"); has '.result[0].id == "m2" and .result[0].rev == 2 and .result[0].note == "细节"'
out=$(json material ls m1); has '(.result.content|@base64d) == "部门是什么"'
[ "$("$bin" material ls m2)" = abc ] || fail "material ls mN 应输出原文"
out=$(json material archive m2); has '.result.archived_at != null'
out=$(json material ls --node o2); has '(.result|length) == 1'
out=$(json org show o2); has '(.result.limits|map(select(.key == "overview"))[0].used) == 5'
printf 'sekrit\n' | "$bin" secret set o1 BOT_TOKEN --json >/dev/null || fail "secret set 失败"
out=$(json secret ls --node o2); has '.result[0].name == "BOT_TOKEN" and (tostring|test("sekrit")|not)'
[ "$(stat -f %Lp "$ATRIUM_DATA/secrets/o1/BOT_TOKEN" 2>/dev/null || stat -c %a "$ATRIUM_DATA/secrets/o1/BOT_TOKEN")" = 600 ] || fail "凭据文件权限不是 600"
grep -q sekrit "$ATRIUM_DATA/service.log" && fail "凭据值进了日志"
out=$(json secret set o1 BOT_TOKEN --rm); has '.ok'
opt='{"title":"T","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"e"}'
opt3='{"title":"T","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"e","org":"o1"}'
echo "{\"title\":\"下一步\",\"options\":[$opt,$opt,$opt3],\"recommend\":[1],\"reason\":\"快\"}" >"$work/choice.json"
out=$(json choice add o2 "$work/choice.json"); has '.result.id == "c1" and .result.status == "open" and .result.options[2].org == "o1"'
out=$(json choice ls); has '(.result|length) == 1'
out=$(json choice pick c1 1,3 --note 先快); has '.result.status == "picked" and .result.options[0].task != null and .result.options[1].task == null and .result.note == "先快"'
has '.next == "atrium task wait " + .result.options[0].task'   # 选中的项交给部门负责人 a1 去拆，拍板的人不派
picked3=$(jq -r '.result.options[2].task' <<<"$out")
out=$(json task show "$picked3"); has '.result.task.org == "o1" and .result.parties.owner == "secretary"'   # 选项写了归 o1：o1 没有负责人，交秘书
out=$(json choice add o2 "$work/choice.json"); has '.result.id == "c2"'
out=$(json choice pick c2 --none); has '.result.status == "passed"'
out=$(json schedule add o2 巡检 --every 1d --at 09:00 --kind patrol); has '.result.id == "s1" and .result.at == "09:00"'
out=$(json schedule run s1 || true); has '(.ok and .result.task.id != null) or (.error.code == "conflict" and (.error.message|test("已生成")))'
out=$(json schedule ls); has '.result[0].last_task != null'
out=$(json schedule rm s1); has '.ok'
out=$(json schedule add o2 x --every 30m || true); has '.error.code == "usage"'
step "map：打印本机网址，不登录直接读；外来 Host 403；import：新库有数据时拒绝"
out=$(json map); has '.ok and .result.url == "http://127.0.0.1:'"$ATRIUM_PORT"'/"'
out=$(curl -s "http://127.0.0.1:$ATRIUM_PORT/ui/api/dept/o2"); has '.ok and .result.dept.id == "o2" and (.result.inherited|length) == 7'
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: evil.example:$ATRIUM_PORT" "http://127.0.0.1:$ATRIUM_PORT/ui/api/today"); [ "$code" = 403 ] || fail "外来 Host 应 403，得到 $code"
touch "$work/old.sqlite"
out=$(json import --from "$work/old.sqlite" || true); has '.ok == false and .error.code == "conflict"'

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

step "host add / ls / 代理接入 / show / edit（hosts）"
out=$(json host add 远程一号 --repo liu-zhengdong/atrium --max 2); has '.result.host.id == "h2" and (.result.code|test("^h2-[0-9a-f]{64}$")) and .next == "atrium host ls h2"'
code=$(jq -r .result.code <<<"$out")
out=$(json host ls); has '.result[0].id == "h1" and .result[0].kind == "local" and .result[1].conn == "pending"'
out=$(json host add 坏 --repo bad || true); has '.ok == false and .error.code == "usage"'
HOME="$work/agenthome" "$bin" agent --data "$work/agent" --server "http://127.0.0.1:$ATRIUM_PORT" --token "$code" >"$work/agent.out" 2>&1 &
agentpid=$!; pid="$pid $agentpid"
for _ in $(seq 50); do out=$(json host ls h2); jq -e '.result.conn == "online"' >/dev/null <<<"$out" && break; sleep 0.2; done
has '.result.conn == "online" and .result.info.cpus > 0 and .result.max == 2'
[ "$(stat -f %Lp "$work/agent/agent.json" 2>/dev/null || stat -c %a "$work/agent/agent.json")" = 600 ] || fail "agent.json 权限不是 600"
code2=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(jq -r .token "$work/agent/agent.json")" "http://127.0.0.1:$ATRIUM_PORT/api/tasks")
[ "$code2" = 401 ] || fail "机器令牌调用户接口应 401，得到 $code2"
out=$(json host edit h2 --max 3); has '.result.host.max == 3 and (.result.code // "") == ""'
out=$(json host edit h2 --key "$work/nokey" || true); has '.error.code == "usage"'
out=$(json host edit h1 --rm || true); has '.error.code == "conflict"'
out=$(json host edit h2 --rm); has '.ok'
wait "$agentpid" || fail "移除后代理应以 0 退出：$(cat "$work/agent.out")"
grep -q "令牌已失效" "$work/agent.out" || fail "代理没报令牌失效：$(cat "$work/agent.out")"

step "workers / task run / log（通用命令行执行者：sh 当假执行者）"
cat >"$work/fakesh.md" <<'MD'
---
protocol: cli
command: sh
args: ["-c", "echo worker=$ATRIUM_WORKER task=$ATRIUM_TASK; echo DONE", "{prompt}"]
done_match: "^DONE$"
---
只回 DONE。
MD
out=$(json workers edit harness/fakesh --file "$work/fakesh.md"); has '.ok and .next == "atrium workers harness/fakesh"'
out=$(json workers edit harness/fakesh --set trust=super || true); has '.ok == false and .error.code == "usage"'
out=$(json workers edit harness/fakesh || true); has '.ok == false and .error.code == "usage"'
out=$(json workers fakesh); has '.result.resolved.id == "fakesh" and .result.resolved.layers == ["harness/fakesh"]'
out=$(json workers); has '(.result|map(.id)|index("fakesh")) != null'
out=$(json task add 冒烟派活); run_id=$(jq -r .result.id <<<"$out")
out=$(json task run "$run_id" --dry-run); has '(.result.pick.candidates|map(.id)|index("fakesh")) != null and .result.task.status == "todo"'
out=$(json task run "$run_id" --worker fakesh --risk high || true); has '.ok == false and .error.code == "conflict"'
out=$(json task run "$run_id" --worker fakesh); has '.result.queued and .result.position == 1 and .next == "atrium task log '"$run_id"' --follow"'
out=$(json task wait "$run_id" --timeout 30); has '.result.task.status == "done"'   # 没有仓库：关卡过了直接完成
out=$(json task log "$run_id"); has '(.result.text|contains("worker=1 task='"$run_id"'")) and (.result.text|contains("DONE")) and .result.running == false'
out=$(json task show "$run_id"); has '.result.task.worker == "fakesh" and .result.task.host == "h1" and ((.result.history|map(.kind)) as $k | ["launch","worktree","result","exit_ok"] - $k == [])'
out=$(json task tell "$run_id" "补一句" || true); has '.ok == false and .error.code == "conflict"'   # 已完成：捎话没人收

step "第三波接缝：负责人组合按执行者解析；帮助末尾点名不列出的命令"
out=$(json leader add 坏组合 --workers nosuch+x || true); has '.ok == false and .error.code == "usage"'
"$bin" --help | grep -q "不列出的.*statusline" || fail "帮助末尾没点名隐藏命令"

step "验收人是用户：只交结论的活没有要落地的，过了关卡直接完成，不等验收（gates，假执行者 fakesh）"
out=$(json org add 验收演练 --parent o1); acc_org=$(jq -r .result.id <<<"$out")
out=$(json org edit o1 --accept user); has '.ok'
out=$(json org show "$acc_org"); has '.result.accept == "user" and .result.accept_from == "o1"'
out=$(json org edit "$acc_org" --accept boss || true); has '.ok == false and .error.code == "usage"'
out=$(json task add 只交结论 --org "$acc_org"); msg=$(jq -r .result.id <<<"$out")
json task run "$msg" --worker fakesh >/dev/null
out=$(json task wait "$msg" --timeout 30); has '.result.task.status == "done"'
grep -q "开 PR" "$ATRIUM_DATA/tasks/$msg/prompt-1.md" && fail "没有仓库的活提示词里不该要求开 PR"
out=$(json org edit o1 --accept -); has '.ok'

step "本机交付：本机仓库没有远程 → 假执行者提交 → 关卡 → 等你验收 → 打回交回原执行者、第 3 次转受阻 → 再派 → 验收通过合进本机 main → 删任务工作树与分支"
site="$work/site"; git init -q -b main "$site"; echo hi >"$site/README.md"
git -C "$site" add -A; git -C "$site" -c user.name=t -c user.email=t@t commit -qm init
cat >"$work/fakecommit.md" <<'MD'
---
protocol: cli
command: sh
args: ["-c", "export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; echo 正文 >>post.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm 写完 && echo DONE", "{prompt}"]
done_match: "^DONE$"
---
只回 DONE。
MD
out=$(json workers edit harness/fakecommit --file "$work/fakecommit.md"); has '.ok'
out=$(json org edit "$acc_org" --accept user); has '.ok'
out=$(json task add 写文章 --org "$acc_org" --repo "$site"); loc=$(jq -r .result.id <<<"$out")
until_accept() {
  for _ in $(seq 150); do
    out=$(json task show "$loc"); jq -e '.result.task.stage == "accept" and .result.task.status == "running"' >/dev/null <<<"$out" && return 0; sleep 0.2
  done
  fail "$loc 没停在等验收：$out"
}
json task run "$loc" --worker fakecommit >/dev/null
out=$(json task wait "$loc" --timeout 30); has '.result.reached and .result.task.stage == "accept" and .next == "atrium task accept '"$loc"'"'   # 缺省等法停在等验收
out=$(json task show "$loc"); has '.result.holder == "等你验收" and .next == "atrium task accept '"$loc"'"'
grep -q "本机交付：在分支 task-$loc 上提交" "$ATRIUM_DATA/tasks/$loc/prompt-1.md" || fail "本机仓库的提示词应写本机交付"
grep -q "开 PR" "$ATRIUM_DATA/tasks/$loc/prompt-1.md" && fail "本机仓库的活提示词里不该要求开 PR"
out=$(json events wait --timeout 5); has '(.result|map(select(.task == "'"$loc"'" and .level == "act"))|length) == 1'
out=$(curl -s "http://127.0.0.1:$ATRIUM_PORT/ui/api/today"); has '(.result.asks|map(select(.kind == "accept" and .id == "'"$loc"'"))|length) == 1'
out=$(json task reject "$loc" || true); has '.ok == false and .error.code == "usage"'   # 打回要写原因
for i in 1 2; do
  out=$(json task reject "$loc" --reason "第 $i 次：本地跑不起来"); has '.result.status == "queued"'
  until_accept   # 交回原执行者重做，再停在等验收
done
out=$(json task reject "$loc" --reason "第 3 次"); has '.result.status == "blocked" and .result.stage == "accept"'
out=$(json task accept "$loc" || true); has '.ok == false and .error.code == "conflict"'
json task run "$loc" --worker fakecommit >/dev/null
until_accept
[ ! -f "$site/post.md" ] || fail "验收前不该合进 main"
out=$(json task accept "$loc"); has '.result.status == "done"'
grep -q 正文 "$site/post.md" || fail "验收后 main 上应有执行者的提交"
[ ! -d "$ATRIUM_DATA/tasks/$loc/repo" ] || fail "任务工作树应已删除"
[ -z "$(git -C "$site" branch --list "task-$loc")" ] || fail "任务分支应已删除"
out=$(json org edit "$acc_org" --accept -); has '.ok'

step "有仓库但没改代码（装工具、调研）：工作树相对基线没有改动 → 按只交结论判，过了关卡直接完成，不按缺提交交回"
out=$(json task add 装工具 --repo "$site"); nochg=$(jq -r .result.id <<<"$out")
json task run "$nochg" --worker fakesh >/dev/null
out=$(json task wait "$nochg" --timeout 30); has '.result.task.status == "done"'
out=$(json task show "$nochg"); has '(.result.history|map(select(.kind == "gate_pass"))[0].body|contains("没有改动")) and (.result.history|map(.kind)|index("bounce")) == null'

step "工作地点：普通文件夹（不是 git 仓库）→ 假执行者原地写文件 → 关卡 → 完成；不建工作树"
mkdir -p "$work/notes"; place=$(cd "$work/notes" && pwd)   # 规范路径：TMPDIR 可能带尾部斜杠
cat >"$work/fakewrite.md" <<'MD'
---
protocol: cli
command: sh
args: ["-c", "echo 正文 >post.md && echo DONE", "{prompt}"]
done_match: "^DONE$"
---
只回 DONE。
MD
out=$(json workers edit harness/fakewrite --file "$work/fakewrite.md"); has '.ok'
out=$(json task add 原地写 --repo o/r --dir "$place" || true); has '.ok == false and .error.code == "usage"'   # 仓库与工作地点只给一个
out=$(json task add 原地写 --dir "$place"); dirt=$(jq -r .result.id <<<"$out"); has '.result.dir == "'"$place"'"'
json task run "$dirt" --worker fakewrite >/dev/null
out=$(json task wait "$dirt" --timeout 30); has '.result.task.status == "done"'
[ "$(cat "$place/post.md")" = 正文 ] || fail "文件应落在原文件夹"
grep -q "原地干" "$ATRIUM_DATA/tasks/$dirt/prompt-1.md" || fail "提示词应让执行者原地干"
[ ! -e "$ATRIUM_DATA/tasks/$dirt/repo" ] && [ ! -e "$ATRIUM_DATA/tasks/$dirt/work" ] || fail "不该建工作树或 work/"
[ ! -e "$place/.git" ] || fail "不该在工作地点建 git 仓库"

step "技能声明的交付检查：文章与视频由运行时自己跑（构建、截图、ffprobe、第一帧、联系表），没过交回，产物路径记进经历"
data=$(cd "$ATRIUM_DATA" && pwd)   # 规范路径：TMPDIR 可能带尾部斜杠，服务记的是规范路径
out=$(json skill add article "$work/skill" --checks article); has '.result.checks == ["article"]'
out=$(json skill add video "$work/skill" --checks video); has '.result.checks == ["video"]'
# 文章小样：假执行者写 post.md，pnpm run build 把它变成 dist/post.html；运行时截明暗两张
mkdir -p "$work/art"; art=$(cd "$work/art" && pwd)
echo '{"scripts":{"build":"mkdir -p dist && (echo \"<meta charset=utf-8><h1>\"; cat post.md) >dist/post.html"}}' >"$art/package.json"
out=$(json task add 文章 --dir "$art" --skill article); a=$(jq -r .result.id <<<"$out")
json task run "$a" --worker fakewrite >/dev/null
out=$(json task wait "$a" --timeout 120); has '.result.task.status == "done"'
out=$(json task show "$a"); has '(.result.history|map(select(.kind == "skill_check"))[0].body|test("article 通过：.*post.html")) and (.result.history|map(select(.kind == "artifact").body)) == ["'"$data/tasks/$a/article-light.png"'","'"$data/tasks/$a/article-dark.png"'"]'
[ -s "$ATRIUM_DATA/tasks/$a/article-light.png" ] && [ -s "$ATRIUM_DATA/tasks/$a/article-dark.png" ] || fail "明暗截图应在任务目录"
# 故意破坏：构建失败 → 交回执行者，第 3 次转受阻
mkdir -p "$work/art-bad"; artb=$(cd "$work/art-bad" && pwd)
echo '{"scripts":{"build":"echo 构建编译出错 >&2; exit 1"}}' >"$artb/package.json"
out=$(json task add 文章构建坏了 --dir "$artb" --skill article); ab=$(jq -r .result.id <<<"$out")
json task run "$ab" --worker fakewrite >/dev/null
out=$(json task wait "$ab" --timeout 120); has '.result.task.status == "blocked"'
out=$(json task show "$ab"); has '.result.history as $h | ($h|map(select(.kind == "launch"))|last|.body|fromjson|.n) == 3 and ($h|map(select(.kind == "bounce"))|last|.body|fromjson|.to.status == "blocked" and (.note|test("关卡没过：article：构建失败：pnpm run build：exit status 1：构建编译出错")))'   # 经历只取最近 20 条：看第 3 次拉起后的那次打回
# 视频小样：out/ 里一段 2 秒带音轨的成片；故意破坏：第一帧纯黑
mkdir -p "$work/vid/out" "$work/vid-bad/out"; vid=$(cd "$work/vid" && pwd); vidb=$(cd "$work/vid-bad" && pwd)
ffmpeg -v error -y -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -f lavfi -i sine=duration=2 -c:v libx264 -pix_fmt yuv420p -c:a aac "$vid/out/demo.mp4"
ffmpeg -v error -y -f lavfi -i color=c=black:duration=2:size=320x240:rate=10 -c:v libx264 -pix_fmt yuv420p "$vidb/out/demo.mp4"
out=$(json task add 视频 --dir "$vid" --skill video); v=$(jq -r .result.id <<<"$out")
json task run "$v" --worker fakewrite >/dev/null
out=$(json task wait "$v" --timeout 120); has '.result.task.status == "done"'
out=$(json task show "$v"); has '(.result.history|map(select(.kind == "skill_check"))[0].body|test("video 通过：out/demo.mp4：时长 2.0 秒，320x240，响度 -[0-9.]+ LUFS")) and (.result.history|map(select(.kind == "artifact").body)) == ["'"$data/tasks/$v/video-first-frame.png"'","'"$data/tasks/$v/video-contact-sheet.png"'"]'
[ -s "$ATRIUM_DATA/tasks/$v/video-first-frame.png" ] && [ -s "$ATRIUM_DATA/tasks/$v/video-contact-sheet.png" ] || fail "第一帧与联系表应在任务目录"
out=$(json task add 视频第一帧黑 --dir "$vidb" --skill video); vb=$(jq -r .result.id <<<"$out")
json task run "$vb" --worker fakewrite >/dev/null
out=$(json task wait "$vb" --timeout 120); has '.result.task.status == "blocked"'
out=$(json task show "$vb"); has '.result.history|map(select(.kind == "bounce"))[0].body|test("video：out/demo.mp4 的第一帧是空白")'

step "交给负责人去拆 → 拆成有依赖的两件 → 前一件完成后自动派下一件；依赖失败转受阻（假执行者 fakesh）"
out=$(json task add 性能治理 --owner a1); goal=$(jq -r .result.id <<<"$out")
has '.result.org == "o2" and .next == "atrium task wait '"$goal"'"'   # 不写仓库 = 交给 a1 去拆：落到它负责的部门，建的人不派它
out=$(json events wait --as a1 --timeout 5); has '(.result|map(select(.task == "'"$goal"'" and .kind == "task.assigned" and .level == "act"))|length) == 1'
json events ack $(jq -r '.result|map(.id|tostring)|join(" ")' <<<"$out") >/dev/null
out=$(json task add 采集瓶颈 --parent "$goal"); sub1=$(jq -r .result.id <<<"$out")
out=$(json task add 修热点 --parent "$goal" --after "$sub1"); sub2=$(jq -r .result.id <<<"$out")
out=$(json task run "$sub2" --worker fakesh); has '.result.task.status == "queued" and .result.waiting == ["'"$sub1"'"] and .next == "atrium task wait '"$sub1"'"'
out=$(json task show "$goal"); has '.result.holder == "子任务在做（0/2 结束）" and .next == "atrium task tree '"$goal"'"'   # 子任务没结束：父任务不计时、不派它自己
json task run "$sub1" --worker fakesh >/dev/null
out=$(json task wait "$sub2" --timeout 30); has '.result.task.status == "done"'
out=$(json task show "$goal"); has '.next == "atrium task set '"$goal"' --status done"'   # 子任务都完成：等负责人收尾父任务
out=$(json task set "$goal" --status done); has '.result.status == "done"'
out=$(json task add 前序); pre=$(jq -r .result.id <<<"$out")
out=$(json task add 后续 --after "$pre"); post=$(jq -r .result.id <<<"$out")
json task run "$post" --worker fakesh >/dev/null
json task set "$pre" --status failed >/dev/null
out=$(json task wait "$post" --timeout 10); has '.result.task.status == "blocked"'
out=$(json task run "$post" || true); has '.error.code == "conflict"'   # 依赖失败了：当场拒绝

step "执行者可用性：假执行者报模型名无效 → 标记「工具@机器」、重新排队 → workers 看得到、挑执行者跳过 → workers edit --clear 解除"
cat >"$work/fakemodel.md" <<'MD'
---
protocol: cli
command: sh
args: ["-c", "sleep 2; echo 'invalid model selection (--model \"x\" --effort \"\")'; exit 1", "{prompt}"]
---
MD
out=$(json workers edit harness/fakemodel --file "$work/fakemodel.md"); has '.ok'
out=$(json org add 可用性演练 --parent o1); av_org=$(jq -r .result.id <<<"$out")
out=$(json task add 模型名无效 --org "$av_org"); av=$(jq -r .result.id <<<"$out")
json task run "$av" --worker fakemodel >/dev/null
out=$(json pause --org "$av_org"); has '.ok'   # 重新排队后不再拉起，好断言停在 queued
for _ in $(seq 50); do out=$(json workers fakemodel); jq -e '(.result.marks // [])|length == 1' >/dev/null <<<"$out" && break; sleep 0.2; done
has '.result.marks[0].host == "h1" and .result.marks[0].kind == "model" and .result.marks[0].until == 0'
out=$(json task show "$av"); has '.result.task.status == "queued" and (.result.history|map(.body // "")|join(" ")|contains("已标记 fakemodel@h1 不可用"))'
out=$(json workers); has '(.result|map(select(.id == "fakemodel"))|.[0].marks|length) == 1'
out=$(json task run "$av" --dry-run); has '.result.pick.candidates|map(select(.id == "fakemodel"))|.[0]|(.eligible|not) and (.refusals|join("")|contains("本机不可用：模型名无效"))'
out=$(json workers edit --clear fakemodel@h1); has '.result.cleared == 1'
out=$(json workers edit --clear fakemodel@h1 || true); has '.error.code == "not_found"'
out=$(json workers edit --clear "bad tool" || true); has '.error.code == "usage" and (.error.message|startswith("--clear:"))'

step "按拉起统计：每次拉起记一个结果，workers 列近期、给执行者看明细"
out=$(json workers fakesh); has '.result.stat.ok >= 1 and (.result.attempts|map(select(.task == "'"$run_id"'" and .outcome == "ok"))|length) == 1'
out=$(json workers fakemodel); has '.result.stat == {"launches":1,"ok":0,"bounce":0,"quota":0,"setup":0,"fail":1} and .result.attempts[0].task == "'"$av"'"'
out=$(json workers); has '(.result|map(select(.id == "fakemodel"))|.[0].stat.fail) == 1'

step "stop"
out=$(json stop); has '.result.stopped'
out=$(json status); has '.result.running == false'
[ ! -f "$ATRIUM_DATA/service.json" ] || fail "停下后登记文件还在"

echo
echo "冒烟通过"
