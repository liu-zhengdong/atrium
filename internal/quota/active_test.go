package quota

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLocalDisabledAndReenabled(t *testing.T) {
	reads := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reads++
		w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()
	now := time.Now()
	d := Deps{Now: func() time.Time { return now }, HTTP: srv.Client(), URLs: map[string]string{MagpieAccount: srv.URL}}
	l := NewLocal(d)
	ctx := context.Background()
	// 故意在未到期时下架再启用，验证重新启用不受旧的读取期限阻挡。
	l.Due(ctx, nil)
	reads = 0
	for _, r := range l.Due(ctx, map[string]bool{MagpieAccount: true}) {
		if r.Account == MagpieAccount {
			t.Fatal("下架账号仍在读取")
		}
	}
	if reads != 0 {
		t.Fatal("下架账号仍读取")
	}
	got := l.Due(ctx, nil)
	if len(got) != 1 || got[0].Account != MagpieAccount || reads == 0 {
		t.Fatalf("重新启用没有立即恢复读取：%+v reads=%d", got, reads)
	}
}
