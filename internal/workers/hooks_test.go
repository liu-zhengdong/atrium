package workers

import (
	"os"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/watch"
)

func TestWatchSignal(t *testing.T) {
	// t685 第 2 次拉起（trae@h1）日志的最后 16KB（资料 m111）：最后一行是 trae 读 signals.go 的工具结果，内容里有 "rate limit exceeded"。
	b, err := os.ReadFile("testdata/trae-t685-run2-tail.txt")
	if err != nil {
		t.Fatal(err)
	}
	sample := string(b)
	watchTail := sample[len(sample)-8<<10:] // 巡检读末尾 8KB，整段落在最后一行里

	trae := cliAdapter("trae", CLISpec{Command: "trae-cli", DoneMatch: `^\{"type":"result","subtype":"success".*"is_error":false`,
		ErrorMatch: `^\{"type":"result".*"is_error":true`})
	claude, _ := Builtin("claude")
	codex, _ := Builtin("codex")
	cases := []struct {
		name string
		a    *Driver
		tail string
		want watch.Signal
	}{
		// 通用命令行没见到结束行只算 error：巡检只在进程退出后采用；在跑时只有额度、临时错误、思考耗尽会让巡检动手。
		{"t685 在跑：截断的工具结果不判额度", trae, watchTail, watch.SigError},
		{"t685 整段尾巴也不判额度", trae, sample, watch.SigError},
		{"通用命令行在跑：读到的报错文字不判额度", trae, "Error: rate limit exceeded\n", watch.SigError},
		{"通用命令行报错收尾且是额度", trae, `{"type":"result","is_error":true,"result":"usage limit reached"}`, watch.SigQuota},
		{"通用命令行报错收尾：额度字样在工具输出里不算", trae,
			"Error: rate limit exceeded\n" + `{"type":"result","is_error":true}`, watch.SigError},
		{"通用命令行正常收尾", trae, `{"type":"result","subtype":"success","is_error":false}`, watch.SigDone},
		{"claude 在跑：截断的工具结果不判", claude, watchTail, watch.SigNone},
		{"claude 报错收尾且是额度", claude, `{"type":"result","is_error":true,"result":"Claude AI usage limit reached|resets 3pm (UTC)"}`, watch.SigQuota},
		{"claude 报错收尾：之前的额度字样不算", claude,
			"x rate limit exceeded: " + "\n" + `{"type":"result","is_error":true}`, watch.SigError},
		{"codex 临时错误收尾只算 error，重试由拉起者判", codex, `{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}`, watch.SigError},
		{"command-code 权限被拒收尾：subtype 假装 success 也算 error", claude, `{"type":"result","subtype":"success","stopReason":"permission_denied","finalText":"I'll read the task file first."}`, watch.SigError},
	}
	for _, c := range cases {
		if got := WatchSignal(c.a, c.tail); got != c.want {
			t.Errorf("%s：%q，要 %q", c.name, got, c.want)
		}
	}
}
