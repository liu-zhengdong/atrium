package dispatch

import (
	"context"
	"strings"
	"testing"
	"time"
)

// 生产 run 原样返回标准输出（不 TrimSpace）：-z 里首个名字的前导空格不能被吃掉，
// 否则补检出的冲突预检会漏判（t927 审阅）。
func TestRunReturnsVerbatimOutput(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	out, err := run(ctx, "", "git", "--version")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(out, "\n") {
		t.Fatalf("run 应原样返回标准输出，实际 %q", out)
	}
}
