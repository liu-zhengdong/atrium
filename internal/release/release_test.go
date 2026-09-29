package release

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// fakeGH 答 release list、api compare、release download。contains[tag] 是该版本含的提交。
type fakeGH struct {
	tags     []string
	contains map[string][]string
	calls    []string
	badSum   bool // SHA256SUMS 写错：Install 应拒绝
}

func (f *fakeGH) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	f.calls = append(f.calls, strings.Join(args, " "))
	switch {
	case args[0] == "release" && args[1] == "list":
		var parts []string
		for _, t := range f.tags {
			parts = append(parts, `{"tagName":"`+t+`"}`)
		}
		return "[" + strings.Join(parts, ",") + "]", nil
	case args[0] == "api":
		// repos/o/r/compare/<tag>...<sha>
		spec := args[1][strings.LastIndex(args[1], "/")+1:]
		tag, sha, _ := strings.Cut(spec, "...")
		for _, s := range f.contains[tag] {
			if s == sha {
				return "behind\n", nil
			}
		}
		return "ahead\n", nil
	case args[0] == "release" && args[1] == "download":
		dir := args[len(args)-1]
		asset, bin := Asset(runtime.GOOS, runtime.GOARCH), []byte("new binary "+args[2])
		sum := sha256.Sum256(bin)
		if f.badSum {
			sum[0]++
		}
		if err := os.WriteFile(filepath.Join(dir, SumsFile), []byte(hex.EncodeToString(sum[:])+"  "+asset+"\n"), 0o644); err != nil {
			return "", err
		}
		return "", os.WriteFile(filepath.Join(dir, asset), bin, 0o644)
	}
	return "", fmt.Errorf("fakeGH 不支持 %v", args)
}

func TestInstall(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "atrium")
	os.WriteFile(exe, []byte("old"), 0o755)
	if err := Install(context.Background(), &fakeGH{}, "o/r", "v2.0.1", exe); err != nil {
		t.Fatal(err)
	}
	now, _ := os.ReadFile(exe)
	old, _ := os.ReadFile(exe + ".old")
	if string(now) != "new binary v2.0.1" || string(old) != "old" {
		t.Fatalf("新 %q 旧 %q", now, old)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatalf("临时目录没清掉：%v", entries)
	}
	// 校验和不符：不替换。
	if err := Install(context.Background(), &fakeGH{badSum: true}, "o/r", "v2.0.2", exe); err == nil || !strings.Contains(err.Error(), "校验和不符") {
		t.Fatalf("校验和不符应拒绝：%v", err)
	}
	if now, _ := os.ReadFile(exe); string(now) != "new binary v2.0.1" {
		t.Fatalf("校验失败不该替换：%q", now)
	}
}

func TestCheckSum(t *testing.T) {
	sums := "aa  atrium-linux-amd64\nBB *atrium-darwin-arm64\n"
	for _, c := range []struct {
		asset, got string
		ok         bool
	}{
		{"atrium-linux-amd64", "aa", true},
		{"atrium-darwin-arm64", "bb", true},
		{"atrium-linux-amd64", "ab", false},
		{"atrium-windows-amd64.exe", "aa", false},
	} {
		if err := CheckSum(sums, c.asset, c.got); (err == nil) != c.ok {
			t.Errorf("%s %s：%v", c.asset, c.got, err)
		}
	}
}

type env struct {
	t   *testing.T
	ctx context.Context
	db  *store.DB
	gh  *fakeGH
	r   *Releaser
}

func setup(t *testing.T, smokeOK bool) *env {
	if runtime.GOOS == "windows" {
		t.Skip("假可执行文件是 sh 脚本")
	}
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	exe := filepath.Join(t.TempDir(), "atrium")
	reply := `{"ok":true,"result":{}}`
	if !smokeOK {
		reply = `{"ok":false,"error":{"code":"internal","message":"坏了"}}`
	}
	os.WriteFile(exe, []byte("#!/bin/sh\necho '"+reply+"'\n"), 0o755)
	gh := &fakeGH{tags: []string{"v2.0.1", "v0.1.162"}, contains: map[string][]string{"v2.0.1": {"c1"}, "v2.0.2": {"c1", "c2"}}}
	r := &Releaser{DB: db, Pause: &pause.Store{DB: db}, R: gh, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Cfg: Config{Repo: "o/r", Enabled: true, Data: t.TempDir(), Port: 1}, Exe: exe, Current: "v2.0.1",
		Token: func() (string, error) { return "tok", nil }}
	return &env{t: t, ctx: context.Background(), db: db, gh: gh, r: r}
}

// merged 造一件合入了 commit、等发版的任务。
func (e *env) merged(commit string) string {
	e.t.Helper()
	task, _ := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "x", Repo: "o/r"}, "u1")
	for _, k := range []ledger.EventKind{ledger.Deliver} {
		if _, err := ledger.Apply(e.ctx, e.db, task.ID, ledger.Event{Kind: k}, "u1", ""); err != nil {
			e.t.Fatal(err)
		}
	}
	ledger.Record(e.ctx, e.db, task.ID, gates.KindMergeCommit, "merge", `{"pr":"u","commit":"`+commit+`"}`)
	if _, err := ledger.Apply(e.ctx, e.db, task.ID, ledger.Event{Kind: ledger.Merged, NeedRelease: true}, "merge", ""); err != nil {
		e.t.Fatal(err)
	}
	return task.ID
}

func (e *env) get(id string) ledger.Task {
	t, _ := ledger.Get(e.ctx, e.db, id)
	return t
}

func TestOnline(t *testing.T) {
	e := setup(t, true)
	id := e.merged("c1")
	if err := e.r.Sweep(e.ctx); err != nil {
		t.Fatal(err)
	}
	if got := e.get(id); got.Status != ledger.Done || got.Stage != ledger.StageReleased {
		t.Fatalf("当前版本已含合入，冒烟过应已上线：%+v", got)
	}
	var body string
	e.db.QueryRow(`SELECT body FROM events WHERE kind = 'task.status' AND task = ? ORDER BY id DESC LIMIT 1`, id).Scan(&body)
	if !strings.Contains(body, "已上线") {
		t.Fatalf("上线的状态事件应带版本：%q", body)
	}
}

func TestSmokeFailBlocks(t *testing.T) {
	e := setup(t, false)
	id := e.merged("c1")
	e.r.Sweep(e.ctx)
	h, _ := ledger.History(e.ctx, e.db, id, 50)
	if got := e.get(id); got.Status != ledger.Blocked || !strings.Contains(h[len(h)-1].Body, "上线失败") {
		t.Fatalf("冒烟没过应受阻：%+v", got)
	}
}

func TestWaitsForVersion(t *testing.T) {
	e := setup(t, true)
	id := e.merged("c9")
	e.r.Sweep(e.ctx)
	if got := e.get(id); got.Status != ledger.Running || got.Stage != ledger.StageMerged {
		t.Fatalf("还没有含它的版本应等：%+v", got)
	}
}

func TestUpgradesAndRestarts(t *testing.T) {
	e := setup(t, true)
	e.gh.tags = append(e.gh.tags, "v2.0.2")
	restarted := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		restarted <- r.Method + " " + r.URL.Path + " " + r.Header.Get("Authorization")
		fmt.Fprint(w, `{"ok":true,"result":{}}`)
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	e.r.Cfg.Port, _ = strconv.Atoi(u.Port())
	id := e.merged("c2")
	if err := e.r.Sweep(e.ctx); err != nil {
		t.Fatal(err)
	}
	if got := <-restarted; got != "POST /api/service/restart Bearer tok" {
		t.Fatal(got)
	}
	if raw, _ := os.ReadFile(e.r.Exe); string(raw) != "new binary v2.0.2" {
		t.Fatalf("没换成新版本：%q", raw)
	}
	if got := e.get(id); got.Stage != ledger.StageMerged {
		t.Fatalf("升级后等新进程冒烟，任务不动：%+v", got)
	}
}

func TestPausedNoUpgrade(t *testing.T) {
	e := setup(t, true)
	e.gh.tags = append(e.gh.tags, "v2.0.2")
	e.merged("c2")
	(&pause.Store{DB: e.db}).Set(e.ctx, pause.All, "u1")
	e.r.Sweep(e.ctx)
	if e.downloads() != 0 {
		t.Fatal("暂停时不该升级")
	}
}

func (e *env) downloads() int {
	n := 0
	for _, c := range e.gh.calls {
		if strings.HasPrefix(c, "release download") {
			n++
		}
	}
	return n
}

// 没有任务等上线也升级：发版巡检自己看最新发布。
func TestUpgradesWithoutWaitingTask(t *testing.T) {
	e := setup(t, true)
	e.gh.tags = append(e.gh.tags, "v2.0.2")
	restarted := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		restarted <- r.URL.Path
		fmt.Fprint(w, `{"ok":true,"result":{}}`)
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	e.r.Cfg.Port, _ = strconv.Atoi(u.Port())
	if err := e.r.Sweep(e.ctx); err != nil {
		t.Fatal(err)
	}
	if got := <-restarted; got != "/api/service/restart" {
		t.Fatal(got)
	}
	if raw, _ := os.ReadFile(e.r.Exe); string(raw) != "new binary v2.0.2" {
		t.Fatalf("没换成新版本：%q", raw)
	}
}

// 同一版本升失败：发一次 online.failed 给秘书，之后不再重试。
func TestUpgradeFailsOnce(t *testing.T) {
	e := setup(t, true)
	e.gh.tags = append(e.gh.tags, "v2.0.2")
	e.gh.badSum = true
	for range 3 {
		if err := e.r.Sweep(e.ctx); err != nil {
			t.Fatal(err)
		}
	}
	if n := e.downloads(); n != 1 {
		t.Fatalf("同一版本升失败不该重试，下载了 %d 次", n)
	}
	var n int
	var target, level, body string
	e.db.QueryRow(`SELECT COUNT(*), MAX(target), MAX(level), MAX(body) FROM events WHERE kind = ?`, events.OnlineFailed).
		Scan(&n, &target, &level, &body)
	if n != 1 || target != events.Secretary || level != events.Act || !strings.Contains(body, "校验和不符") {
		t.Fatalf("应给秘书发一条要处理的 online.failed：%d %s %s %s", n, target, level, body)
	}
	// 失败后当前版本已含的任务照常上线。
	id := e.merged("c1")
	e.r.Sweep(e.ctx)
	if got := e.get(id); got.Stage != ledger.StageReleased {
		t.Fatalf("升失败不挡当前版本的上线：%+v", got)
	}
}
