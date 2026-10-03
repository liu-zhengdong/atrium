package quota

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestLocalDisabledAndReenabled(t *testing.T) {
	reads := 0
	d := Deps{GOOS: "linux", Home: "/fake", Env: map[string]string{}, Now: func() time.Time { return time.UnixMilli(1_800_000_000_000) },
		ReadFile: func(path string) ([]byte, error) {
			if strings.Contains(path, ".claude") {
				reads++
			}
			return nil, nil
		},
	}
	l := NewLocal(d)
	ctx := context.Background()
	// 故意在未到期时下架再启用，验证重新启用不受旧的读取期限阻挡。
	l.Due(ctx, nil)
	reads = 0
	for _, r := range l.Due(ctx, map[string]bool{"claude": true}) {
		if r.Account == "claude" {
			t.Fatal("下架账号仍在读取")
		}
	}
	if reads != 0 {
		t.Fatal("下架账号仍读取凭据")
	}
	got := l.Due(ctx, nil)
	if len(got) != 1 || got[0].Account != "claude" || reads == 0 {
		t.Fatalf("重新启用没有立即恢复读取：%+v reads=%d", got, reads)
	}
	if strings.Contains(got[0].Reason, "自动续期") {
		t.Fatal("仍许诺自动续期")
	}
}
