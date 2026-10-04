package platform

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSecretEnvValues(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want []string
	}{
		{"任务令牌", map[string]string{"ATRIUM_WORKER_TOKEN": "awt-0123456789"}, []string{"awt-0123456789"}},
		{"负责人令牌", map[string]string{"ATRIUM_LEADER_TOKEN": "alt-0123456789"}, []string{"alt-0123456789"}},
		{"启动要拦的凭据名单", map[string]string{"ANTHROPIC_AUTH_TOKEN": "sk-ant-0123456789", "GITHUB_TOKEN": "gh-0123456789"}, []string{"gh-0123456789", "sk-ant-0123456789"}},
		{"档案与凭据的任意名字", map[string]string{"ZHIPU_KEY": "zp-0123456789", "BOT_SECRET": "bs-0123456789", "DB_PASSWORD": "pw-0123456789"}, []string{"bs-0123456789", "pw-0123456789", "zp-0123456789"}},
		{"普通变量不动", map[string]string{"ATRIUM_TASK": "t1005", "ATRIUM_SERVER": "http://127.0.0.1:4320", "ATRIUM_WORKER": "1", "PATH": "/usr/bin:/bin"}, nil},
		{"短值不构成泄漏不换", map[string]string{"ATRIUM_DEBUG_KEY": "on", "GH_TOKEN": "x"}, nil},
		{"空值不动", map[string]string{"ATRIUM_X_TOKEN": ""}, nil},
	}
	for _, c := range cases {
		got := SecretEnvValues(c.env)
		if len(got) != len(c.want) {
			t.Fatalf("%s：得到 %v，要 %v", c.name, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("%s：得到 %v，要 %v", c.name, got, c.want)
			}
		}
	}
}

func TestRedactLog(t *testing.T) {
	tok := "awt-0123456789abcdef"
	var buf bytes.Buffer
	w := RedactLog(&buf, map[string]string{
		"ATRIUM_WORKER_TOKEN": tok,
		"ATRIUM_TASK":         "t1005",
	})
	// 令牌被两次 Write 从中间切开，也要换掉。
	n, err := w.Write([]byte("printenv\nATRIUM_WORKER_TOKEN=" + tok[:8]))
	if err != nil || n != len("printenv\nATRIUM_WORKER_TOKEN="+tok[:8]) {
		t.Fatalf("Write 应报告完整写入量：%d %v", n, err)
	}
	w.Write([]byte(tok[8:] + "\n任务收到。\n" + tok + " 出现在正文里\n无换行的尾巴 " + tok))
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, keep := range []string{"printenv\n", "ATRIUM_WORKER_TOKEN=" + Redacted, "任务收到。\n", "无换行的尾巴 " + Redacted} {
		if !strings.Contains(out, keep) {
			t.Fatalf("落盘内容缺 %q：%q", keep, out)
		}
	}
	if strings.Contains(out, tok) {
		t.Fatalf("落盘内容含令牌原文：%q", out)
	}
	if strings.Count(out, Redacted) != 3 {
		t.Fatalf("三处令牌都该换成占位：%q", out)
	}
	// Close 后再写照常（拉起失败等路径下不炸）。
	buf.Reset()
	w.Write([]byte("tail\n"))
	w.Close()
	if buf.String() != "tail\n" {
		t.Fatalf("Close 后再写应照常落盘：%q", buf.String())
	}
}

// 范围外的变量、没命中的值原样保留，不误伤。
func TestRedactLogLeavesOthers(t *testing.T) {
	var buf bytes.Buffer
	w := RedactLog(&buf, map[string]string{
		"ANTHROPIC_AUTH_TOKEN": "sk-ant-0123456789", // 命中，要换
		"ATRIUM_SERVER":        "http://127.0.0.1:4320",
	})
	w.Write([]byte("server=" + "http://127.0.0.1:4320" + "\ntoken=" + "sk-ant-0123456789" + "\n"))
	w.Close()
	out := buf.String()
	if !strings.Contains(out, "server=http://127.0.0.1:4320\n") || strings.Contains(out, "sk-ant-0123456789") {
		t.Fatalf("范围外原样、范围内替换：%q", out)
	}
}

// 没有凭据值时原样透传（同一 writer 语义，无缓冲）。
func TestRedactLogPassthrough(t *testing.T) {
	var buf bytes.Buffer
	w := RedactLog(&buf, map[string]string{"ATRIUM_TASK": "t1005"})
	if _, ok := w.(*redactWriter); ok {
		t.Fatal("没凭据不该包缓冲")
	}
	io.WriteString(w, "head")
	w.Close()
	if buf.String() != "head" {
		t.Fatalf("透传应直接落盘：%q", buf.String())
	}
}

// 真子进程端到端：执行者把令牌打进 stdout（含无换行尾巴），落盘内容不含原值。
func TestRedactLogTakesShOutput(t *testing.T) {
	dir := t.TempDir()
	tok := "awt-fedcba9876543210"
	script, log := filepath.Join(dir, "leak"), filepath.Join(dir, "run-1.log")
	body := "#!/bin/sh\necho \"ATRIUM_WORKER_TOKEN=$ATRIUM_WORKER_TOKEN\"\nprintf 'tail-no-newline'\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	env := WorkerEnv(runtime.GOOS, EnvMap(os.Environ()))
	env["ATRIUM_WORKER_TOKEN"] = tok
	spec, err := Script(script, env)
	if err != nil {
		t.Fatal(err)
	}
	f, err := OpenLog(log)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	redact := RedactLog(f, env)
	spec.Stdout, spec.Stderr = redact, redact
	cmd, err := Start(spec)
	if err != nil {
		t.Fatal(err)
	}
	if err := WaitSession(cmd, dir); err != nil {
		t.Fatalf("子进程应正常退出：%v", err)
	}
	redact.Close()
	out, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Contains(s, tok) || !strings.Contains(s, "ATRIUM_WORKER_TOKEN="+Redacted) || !strings.Contains(s, "tail-no-newline") {
		t.Fatalf("落盘内容不对：%q", s)
	}
}
