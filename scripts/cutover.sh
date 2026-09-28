#!/usr/bin/env bash
# 从旧版（TypeScript，npm 全局装、4310、~/.atrium）切换到 v2（Go 二进制、4320、~/.atrium-v2）。
# 由秘书在用户同意后执行一次；每步回显，出错即停。说明见 docs/cutover.md。
#
# 做什么：确认旧服务已停 → 取旧库只读副本 → 构建并装 v2 二进制（卸掉 npm 全局的旧 atrium）
#        → 导入到 v2 数据目录（导入后自动全局暂停）→ 启动 → 冒烟 → 提示 atrium resume。
# 不做什么：不改、不删 ~/.atrium（旧库原样留着，退回时旧版照常读它）；不 resume。
#
# 手动退回旧版（v2 出问题时）：
#   atrium stop                                   # 停 v2（4320）
#   rm "$HOME/.local/bin/atrium"                  # 去掉 v2 二进制
#   git clone -q --depth 1 --branch v0.1.162 https://github.com/liu-zhengdong/atrium /tmp/atrium-v1
#   (cd /tmp/atrium-v1 && npm pack -q && npm install -g ./atrium-0.1.162.tgz)   # 旧版 update 也是这样装的
#   mise reshim 2>/dev/null; hash -r; atrium      # 旧版读的 ~/.atrium 没动过
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
old_data="$HOME/.atrium"
v2_data="${ATRIUM_DATA:-$HOME/.atrium-v2}"
bin_dir="${ATRIUM_BIN_DIR:-$HOME/.local/bin}"
stamp=$(date +%Y%m%d-%H%M%S)
backup="$HOME/.atrium-v1-backup-$stamp"

step() { printf '\n== %s\n' "$*"; }
run() { printf '+ %s\n' "$*"; "$@"; }
die() { echo "停下：$*" >&2; exit 1; }

step "0. 前提"
command -v go >/dev/null || die "没有 go，装好 Go 再来"
command -v sqlite3 >/dev/null || die "没有 sqlite3（取旧库只读副本要用）"
[ -f "$old_data/atrium.sqlite" ] || die "找不到旧库 $old_data/atrium.sqlite"
[ ! -e "$v2_data/atrium.sqlite" ] || die "$v2_data 已有 v2 库；import 只往空库导。确认不要了再手动挪开"
echo "仓库：${repo}（当前分支 $(git -C "$repo" rev-parse --abbrev-ref HEAD)）"
echo "旧数据：$old_data   v2 数据：$v2_data   装到：$bin_dir"

step "1. 确认旧服务（4310）已停"
old_bin=$(command -v atrium || true)
if [ -n "$old_bin" ]; then
  echo "当前 atrium：$old_bin -> $(readlink "$old_bin" || echo "$old_bin")"
  run atrium status
  if curl -s -m 3 -o /dev/null http://127.0.0.1:4310/health; then
    run atrium stop
  fi
fi
if curl -s -m 3 -o /dev/null http://127.0.0.1:4310/health; then
  die "4310 上仍有服务在答，先手动停掉旧服务"
fi
echo "4310 没有服务在跑"

step "2. 取旧库只读副本 → $backup"
run mkdir -p "$backup"
# 旧服务已停，库文件不再变：连同 -wal、-shm 原样拷出，在副本上合并 WAL（原库一个字节都不碰）。
for f in atrium.sqlite atrium.sqlite-wal atrium.sqlite-shm; do
  if [ -f "$old_data/$f" ]; then run cp -p "$old_data/$f" "$backup/$f"; fi
done
run sqlite3 "$backup/atrium.sqlite" "PRAGMA wal_checkpoint(TRUNCATE);"
# 导入按「旧库所在目录/materials」找资料文件：副本旁放一个指向原目录的链接（只读用）。
if [ -d "$old_data/materials" ]; then
  run ln -s "$old_data/materials" "$backup/materials"
fi
run sqlite3 "$backup/atrium.sqlite" "PRAGMA integrity_check;"

step "3. 构建 v2 并装到 $bin_dir"
run mkdir -p "$bin_dir"
(cd "$repo" && run go build -trimpath -o "$bin_dir/atrium.new" ./cmd/atrium)
run "$bin_dir/atrium.new" --help >/dev/null
# PATH 里 mise 的 node bin 与 shims 排在 ~/.local/bin 前面：先卸掉 npm 全局的旧 atrium，再让 mise 重建 shim。
if npm ls -g --depth=0 atrium >/dev/null 2>&1; then
  run npm uninstall -g atrium
fi
if command -v mise >/dev/null 2>&1; then
  run mise reshim
fi
run mv "$bin_dir/atrium.new" "$bin_dir/atrium"
hash -r
now_bin=$(command -v atrium || true)
[ "$now_bin" = "$bin_dir/atrium" ] || die "PATH 上的 atrium 是 ${now_bin:-（没有）}，不是 $bin_dir/atrium；把 $bin_dir 放到 PATH 前面或删掉挡在前面的那个"
echo "atrium → $now_bin"

step "4. 导入旧库副本 → ${v2_data}（导入后自动全局暂停）"
export ATRIUM_DATA="$v2_data"   # 端口沿用 ATRIUM_PORT，没设就是缺省 4320
run atrium import --from "$backup/atrium.sqlite"

step "5. 启动（暂停状态下）"
run atrium start
atrium status --json | grep -q '"scope":"all"' || die "服务不在全局暂停状态，先 atrium pause 再看"

step "6. 冒烟"
run atrium status
run atrium org tree
run atrium task ls
run atrium leader ls
run atrium workers
run atrium host ls
atrium --help >/dev/null && echo "atrium --help 正常"
run atrium map   # 非交互终端里打印一次性链接

step "完成"
cat <<EOF
v2 已在 ${ATRIUM_PORT:-4320} 上运行，数据目录 ${v2_data}，仍处于全局暂停：派活、负责人唤醒、周期任务、合入、发版都不会动。
旧库副本：${backup}（原库 $old_data 没动过）。
还要手动做的（见 docs/cutover.md）：
  - 负责人没挂部门的，按秘书备忘恢复：atrium org edit oN --leader aN
  - 远程机器 ggb：atrium host edit h3 --join，照回执在那台上接入（隧道目标与私钥已导入）
  - Claude Code 秘书会话：atrium secretary bridge --install-hook
确认无误后：atrium resume
EOF
