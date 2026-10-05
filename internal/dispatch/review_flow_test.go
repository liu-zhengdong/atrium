package dispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/gates/fakegh"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/merge"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// 只把本地 bare 远端标成 GitHub；git、进程、账本、交付检查和合入均走实际调用链。
type reviewGitHub struct{ *fakegh.GH }

func (r reviewGitHub) Run(ctx context.Context, dir, exe string, args ...string) (string, error) {
	if exe == "git" && strings.Join(args, " ") == "remote get-url origin" {
		return "https://github.com/o/r.git\n", nil
	}
	return r.GH.Run(ctx, dir, exe, args...)
}

func TestReviewOriginalTaskFlow(t *testing.T) {
	for _, scenario := range []string{"通过并合入", "打回作者再审阅", "三次无结论", "作者预算耗尽仍能审阅"} {
		t.Run(scenario, func(t *testing.T) {
			env, d := setup(t)
			ctx := context.Background()
			previousPick := pickHost
			pickHost = func(ctx context.Context, env *app.Env, need HostNeed, pinned string) (HostChoice, error) {
				return HostChoice{Kind: "run", Host: LocalHost}, nil
			}
			t.Cleanup(func() { pickHost = previousPick })
			gh := fakegh.New(t, nil)
			r := reviewGitHub{gh}
			old := originRunner
			originRunner = func() gates.Runner { return r }
			oldReview := gates.Review
			gates.Review = func(ctx context.Context, id, who string) error { return Review(ctx, env, id, who) }
			t.Cleanup(func() { originRunner, gates.Review = old, oldReview })
			replyFile := filepath.Join(t.TempDir(), "reply")
			writeReply := func(reply string) {
				t.Helper()
				if err := os.WriteFile(replyFile, []byte(reply), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			writeReply("审阅结论：通过\n")
			// 假 dsh 按模型分饰两角：作者交「交付结论：完成」，审阅者照 reply 文件里的结论收尾。
			fake, err := exec.LookPath("dsh")
			if err != nil {
				t.Fatal(err)
			}
			script := `#!/bin/sh
patch=
while [ $# -gt 0 ]; do
	case "$1" in
	--patch) patch=$2; shift ;;
	esac
	shift
done
mode=${patch:+$(sed -n 's/^ *model: //p' "$patch" 2>/dev/null)}
mode=${mode##*/}
cat >/dev/null
echo '{"type":"session","sessionId":"session-0123abcd-0123-0123-0123-0123456789ab"}'
case "$mode" in
*author*) echo '{"type":"final","text":"交付结论：完成"}' ;;
*review*) printf '{"type":"final","text":"%s"}\n' "$(tr '\n' ' ' < ` + replyFile + `)" ;;
*) echo '{"type":"final","text":"ok"}' ;;
esac
`
			if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
			for name, body := range map[string]string{
				"combos/dsh+author": "---\nmodel: fake/author1\ntrust: low\nchecks: [finished, pr_exists]\n---\n",
				"combos/dsh+review": "---\nmodel: fake/review1\ntrust: medium\nauto: true\n---\n",
			} {
				if _, err := env.DB.ExecContext(ctx, `INSERT INTO worker_profiles(name,spec,updated_by,updated_at) VALUES(?,?,'u1',0)`, name, body); err != nil {
					t.Fatal(err)
				}
			}
			tk, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: scenario, Repo: gh.Work}, "u1")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Enqueue(ctx, env, tk.ID, Options{Worker: "dsh+author"}, "u1"); err != nil {
				t.Fatal(err)
			}
			if err := d.pump(ctx); err != nil {
				t.Fatal(err)
			}
			waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
			author, err := lastAuthorRun(ctx, env.DB, tk.ID)
			if err != nil {
				t.Fatal(err)
			}
			gh.Write(author.Dir, "change", "实现\n")
			gh.Must(author.Dir, "add", "change")
			gh.Must(author.Dir, "commit", "--quiet", "-m", "实现")
			gh.Must(author.Dir, "push", "--quiet", "origin", author.Branch)
			gh.Open(author.Branch, "## 端到端验证\n隔离验证通过\n")
			if scenario == "作者预算耗尽仍能审阅" {
				for _, why := range []string{workers.WhySame, workers.WhySwitch, workers.WhySwitch} {
					author.N++
					author.Why = why
					body, _ := json.Marshal(author)
					if err := ledger.Record(ctx, env.DB, tk.ID, workers.RunKind, actor, string(body)); err != nil {
						t.Fatal(err)
					}
				}
			}
			before, _ := workers.Runs(ctx, env.DB, tk.ID, 100)
			same, switches, _ := tries(before)
			g := &gates.Gate{DB: env.DB, Data: env.Paths.Data, Pause: env.Pause, R: r, Log: env.Log}
			if scenario == "三次无结论" {
				writeReply("看过了\n")
			}
			if scenario == "打回作者再审阅" {
				writeReply("缺测试\n审阅结论：打回\n")
			}
			if err := g.Sweep(ctx); err != nil {
				t.Fatal(err)
			}
			waitReviewExit := func() {
				t.Helper()
				waitFor(t, env, tk.ID, func(x ledger.Task) bool {
					last, _ := workers.LastRun(ctx, env.DB, tk.ID)
					if last == nil || last.Why != workers.WhyReview {
						return false
					}
					var done bool
					env.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM task_events WHERE task=? AND kind='exit' AND json_extract(body,'$.n')=?)`, tk.ID, last.N).Scan(&done)
					return done
				})
			}
			waitReviewExit()
			last, _ := workers.LastRun(ctx, env.DB, tk.ID)
			if last.Worker != "dsh+review" || last.Dir != author.Dir {
				t.Fatalf("审阅轮：%+v", last)
			}
			prompt, err := os.ReadFile(filepath.Join(TaskDir(env.Paths.Data, tk.ID), fmt.Sprintf("prompt-%d.md", last.N)))
			if err != nil || !strings.Contains(string(prompt), "本轮只读审阅") || strings.Contains(string(prompt), "只交 PR：") {
				t.Fatalf("提示词：%s %v", prompt, err)
			}
			if scenario == "三次无结论" {
				for i := 0; i < 3; i++ {
					if err := g.Sweep(ctx); err != nil {
						t.Fatal(err)
					}
					if i < 2 {
						waitReviewExit()
					}
				}
				got, _ := ledger.Get(ctx, env.DB, tk.ID)
				if got.Status != ledger.Blocked || got.Stage != ledger.StageReview {
					t.Fatalf("三次无结论：%+v", got)
				}
			} else {
				if err := g.Sweep(ctx); err != nil {
					t.Fatal(err)
				}
				if scenario == "打回作者再审阅" {
					got, _ := ledger.Get(ctx, env.DB, tk.ID)
					if got.Status != ledger.Queued || got.Stage != ledger.StageNone {
						t.Fatalf("打回：%+v", got)
					}
					if err := d.pump(ctx); err != nil {
						t.Fatal(err)
					}
					waitFor(t, env, tk.ID, func(x ledger.Task) bool { return x.Stage == ledger.StageGate })
					redo, _ := workers.LastRun(ctx, env.DB, tk.ID)
					if redo.Worker != "dsh+author" || redo.Why != workers.WhyBounce {
						t.Fatalf("重做没有回作者：%+v", redo)
					}
					writeReply("审阅结论：通过\n")
					if err := g.Sweep(ctx); err != nil {
						t.Fatal(err)
					}
					waitReviewExit()
					if err := g.Sweep(ctx); err != nil {
						t.Fatal(err)
					}
				}
				got, _ := ledger.Get(ctx, env.DB, tk.ID)
				if got.Stage != ledger.StageMerge {
					t.Fatalf("通过未进合入：%+v", got)
				}
				q := &merge.Queue{DB: env.DB, Pause: env.Pause, R: r, Log: env.Log, Dir: filepath.Join(env.Paths.Data, "merge"), CIReport: time.Millisecond}
				if err := q.Drain(ctx); err != nil {
					t.Fatal(err)
				}
				got, _ = ledger.Get(ctx, env.DB, tk.ID)
				if got.Status != ledger.Done {
					t.Fatalf("未合入：%+v", got)
				}
			}
			after, _ := workers.Runs(ctx, env.DB, tk.ID, 100)
			a, b, _ := tries(after)
			if a != same || b != switches {
				t.Fatalf("作者预算改变：%d/%d → %d/%d", same, switches, a, b)
			}
			var count int
			env.DB.QueryRowContext(ctx, `SELECT count(*) FROM tasks`).Scan(&count)
			if count != 1 {
				t.Fatalf("产生平行任务：%d", count)
			}
			t.Logf("原任务 %s：%s；任务数=%d，作者预算=%d/%d→%d/%d", tk.ID, scenario, count, same, switches, a, b)
		})
	}
}
