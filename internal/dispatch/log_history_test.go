package dispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

type failedLogWriter struct{ err error }

func (w failedLogWriter) Write(p []byte) (int, error) { return 0, w.err }

func TestCompleteLogWriteFailure(t *testing.T) {
	want := errors.New("output disk full")
	c := &cli.Ctx{Env: cli.Env{Stdout: failedLogWriter{want}}}
	if err := completeLog(c, "t1", "", LogChunk{Text: "原始错误"}); !errors.Is(err, want) {
		t.Fatalf("输出失败未返回：%v", err)
	}
}

func TestHistoricalLogCLI(t *testing.T) {
	env, _ := setup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	task, err := ledger.Add(ctx, env.DB, ledger.NewTask{Title: "多轮拨号错误"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	first := "dial tcp 127.0.0.1:14310: connect: connection refused\n" + strings.Repeat("历史中文原文\n", 30000) + "末尾错误无换行"
	for n, text := range []string{first, "POST: connection reset by peer\n", "最后一轮\n"} {
		path := filepath.Join(t.TempDir(), fmt.Sprintf("run-%d.log", n+1))
		if err := os.WriteFile(path, []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
		run := workers.Run{N: n + 1, Worker: "plain", Log: path, Host: "h3"}
		body, err := json.Marshal(run)
		if err != nil {
			t.Fatal(err)
		}
		if err := ledger.Record(ctx, env.DB, task.ID, workers.RunKind, "runtime", string(body)); err != nil {
			t.Fatal(err)
		}
	}
	r := api.NewRouter(env.Log)
	r.AddAuth(func(token string) (api.Actor, bool) {
		return api.Actor{ID: "u1", Kind: "user"}, token == "fake-credential"
	})
	Routes(r, env)
	server := httptest.NewServer(r)
	defer server.Close()
	table := cli.NewTable("atrium", "")
	ledger.Commands(table)
	Commands(table)
	callTo := func(dst io.Writer, args ...string) (string, int) {
		t.Helper()
		var out, stderr bytes.Buffer
		if dst == nil {
			dst = &out
		}
		code := table.Main(ctx, append([]string{"task", "log", task.ID}, args...), cli.Env{Stdout: dst, Stderr: &stderr, Getenv: func(k string) string {
			switch k {
			case "ATRIUM_WORKER":
				return "1"
			case "ATRIUM_WORKER_TOKEN":
				return "fake-credential"
			case "ATRIUM_SERVER":
				return server.URL
			}
			return ""
		}})
		return out.String() + stderr.String(), code
	}
	call := func(args ...string) (string, int) { return callTo(nil, args...) }
	out, code := callTo(failedLogWriter{errors.New("output disk full")}, "--run", "1", "--raw", "--all")
	if code == 0 || !strings.Contains(out, "output disk full") {
		t.Fatalf("写入失败被当成完整导出：code=%d %s", code, out)
	}
	t.Logf("隔离CLI失败Writer：退出码%d，错误明确显示", code)
	out, code = call("--raw")
	if code != 0 || !strings.Contains(out, "最后一轮") || !strings.Contains(out, "--run 3 --raw --all") {
		t.Fatalf("%d %s", code, out)
	}
	out, code = call("--run", "1", "--raw", "--all")
	if code != 0 || out != first {
		t.Fatalf("完整原文不一致 code=%d bytes=%d want=%d", code, len(out), len(first))
	}
	for _, args := range [][]string{{"--run", "0"}, {"--run", "-1"}, {"--run", "bad"}, {"--run", "4"}, {"--all"}, {"--raw", "--all", "--json"}} {
		out, code := call(args...)
		if code == 0 {
			t.Fatalf("非法输入被接受 %v", args)
		}
		if strings.Contains(out, "fake-credential") {
			t.Fatal("泄漏凭据")
		}
	}
	client := api.Client{Base: server.URL, Token: "fake-credential"}
	for _, query := range []string{"run=0", "run=-1", "run=bad", "offset=-1", "offset=bad"} {
		var ch LogChunk
		if err := client.Do(ctx, "GET", "/api/tasks/"+task.ID+"/log?"+query, nil, &ch); err == nil {
			t.Fatalf("HTTP入口接受非法参数 %s", query)
		}
	}
	run, _ := workers.RunAt(ctx, env.DB, task.ID, 1)
	if err := os.Remove(run.Log); err != nil {
		t.Fatal(err)
	}
	out, code = call("--run", "1", "--raw", "--all")
	if code == 0 || !strings.Contains(out, "日志文件缺失") {
		t.Fatalf("缺日志被吞掉：%s", out)
	}
	t.Logf("隔离HTTP+CLI：3轮中取回第1轮完整%d字节（跨256 KiB块，UTF-8与末尾无换行保留）；默认最后轮次；非法轮次和缺日志拒绝；假凭据未进入输出", len(first))
}
