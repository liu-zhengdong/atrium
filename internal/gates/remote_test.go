package gates_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/platform"
)

// remoteAgent 在进程内起服务的机器接口与一个真代理（接入、长轮询），返回那台的短号与代理数据目录。
func (e *env) remoteAgent() (host, dir string) {
	t := e.t
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	aenv := &app.Env{DB: e.db, Paths: config.Paths{Data: t.TempDir()}, Port: 4999, Log: log, Pause: &pause.Store{DB: e.db}}
	r := api.NewRouter(log)
	hosts.Routes(r, aenv)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	_, code, err := hosts.Add(e.ctx, e.db, hosts.AddInput{Name: "远程", Repos: []string{"*"}}, aenv.Port)
	if err != nil {
		t.Fatal(err)
	}
	dir = t.TempDir()
	cfg, err := hosts.JoinServer(e.ctx, dir, srv.URL, code, platform.EnvMap(os.Environ()))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- hosts.NewAgent(dir, cfg, log).Run(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	return cfg.Host, dir
}

// localGit 记下经本机 Runner 跑的 git 用的目录：远程工作树的 git 不该出现在这里。
type localGit struct {
	gates.Runner
	dirs []string
}

func (l *localGit) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	if name == "git" {
		l.dirs = append(l.dirs, dir)
	}
	return l.Runner.Run(ctx, dir, name, args...)
}

// 关卡按工作树登记的机器取事实：本机直接 git，远程经代理（只读 git、读 choice.json）；PR 仍由服务查（假 gh）。
// 没有仓库的任务不要求工作树。
func TestGateWhere(t *testing.T) {
	choice := `{"title":"下一步","options":[` + strings.Repeat(`{"title":"A","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"e"},`, 2) +
		`{"title":"B","gain":"g","why_now":"w","cost":"c","if_not":"i","evidence":"e"}],"recommend":[2],"reason":"r"}`
	cases := []struct {
		name         string
		remote, repo bool
		worktree     bool
		dirty        bool // 有仓库：工作树里留一个没提交的文件
		status       ledger.Status
		stage        ledger.Stage
		choices      int
		note         string
	}{
		{"本机有仓库", false, true, true, false, ledger.Running, ledger.StageMerge, 0, "关卡通过"},
		{"远程有仓库", true, true, true, false, ledger.Running, ledger.StageMerge, 0, "关卡通过"},
		{"远程有仓库没收尾", true, true, true, true, ledger.Queued, "", 0, "未提交"},
		{"本机无仓库", false, false, true, false, ledger.Done, ledger.StageGate, 1, "登记了选项单"},
		{"远程无仓库", true, false, true, false, ledger.Done, ledger.StageGate, 1, "登记了选项单"},
		{"无仓库没有工作树登记", false, false, false, false, ledger.Done, ledger.StageGate, 0, "没有仓库"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := setup(t)
			host, base := hosts.Local, t.TempDir()
			if c.remote {
				host, base = e.remoteAgent()
			}
			d, err := org.Add(e.ctx, e.db, org.NewDept{Name: "部门"})
			if err != nil {
				t.Fatal(err)
			}
			nt := ledger.NewTask{Title: "活", Org: d.ID}
			if c.repo {
				nt.Repo = "o/r"
			}
			task, _ := ledger.Add(e.ctx, e.db, nt, "u1")
			e.start(task.ID, "claude+opus")
			dir := filepath.Join(base, "tasks", task.ID, "work")
			if c.repo {
				dir = filepath.Join(base, "repos", "o-r-"+task.ID)
				os.MkdirAll(filepath.Dir(dir), 0o700)
				e.gh.Branch(dir, "task-"+task.ID, map[string]string{"a.go": "package a\n"})
				e.gh.Open("task-"+task.ID, goodBody)
				if c.dirty {
					e.gh.Write(dir, "b.go", "package a\n")
				}
			} else {
				os.MkdirAll(dir, 0o700)
				os.WriteFile(filepath.Join(dir, "choice.json"), []byte(choice), 0o600)
			}
			if c.worktree {
				raw, _ := json.Marshal(gates.Worktree{Host: host, Dir: dir})
				ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", string(raw))
			}
			e.exit(task.ID)
			rec := &localGit{Runner: e.gh}
			e.g.R = rec
			e.sweep()
			if ranLocal := strings.Contains(strings.Join(rec.dirs, "\n"), dir); ranLocal != (c.repo && !c.remote) {
				t.Fatalf("工作树的 git 在本机跑了 %v（远程=%v）：%v", ranLocal, c.remote, rec.dirs)
			}
			got := e.get(task.ID)
			if got.Status != c.status || got.Stage != c.stage {
				t.Fatalf("%s/%s，期望 %s/%s：%s", got.Status, got.Stage, c.status, c.stage, e.lastNote(task.ID))
			}
			if note := e.lastNote(task.ID); !strings.Contains(note, c.note) {
				t.Fatalf("经历应含 %q：%s", c.note, note)
			}
			var n int
			e.db.QueryRowContext(e.ctx, `SELECT count(*) FROM choices WHERE task = ?`, task.ID).Scan(&n)
			if n != c.choices {
				t.Fatalf("选项单 %d 份，期望 %d", n, c.choices)
			}
		})
	}
}

// 登记不是 {"host","dir"}（旧写法）：报错受阻，不猜。
func TestGateBadWorktree(t *testing.T) {
	e := setup(t)
	task, _ := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "活"}, "u1")
	e.start(task.ID, "claude+opus")
	ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", `{"dir":"/x"}`)
	e.exit(task.ID)
	e.sweep()
	if got := e.get(task.ID); got.Status != ledger.Blocked || !strings.Contains(e.lastNote(task.ID), "工作树登记不是") {
		t.Fatalf("%+v %s", got, e.lastNote(task.ID))
	}
}
