package dispatch

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/quota"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// grok 的 402 没写恢复时刻：本机按本机读数的重置时刻标，远程机器仍按 Hold。
func TestMarkUnavailableQuotaUntilReset(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	used, reset := float64(100), time.Now().Add(16*time.Hour).UTC().Truncate(time.Millisecond)
	resetText := reset.Format(time.RFC3339Nano)
	rows := []quota.Pace{{Account: "grok", RefreshedAt: time.Now().UTC().Format(time.RFC3339), SourceFacts: quota.SourceFacts{
		DataQuality: "cache", RefreshOutcome: "notRequested",
		Quotas: []quota.SourceWindow{{ID: "weekly", UsedPercent: &used, ResetsAt: &resetText, PeriodSeconds: 604800}}}}}
	body, err := json.Marshal(map[string]any{"rows": rows})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO quota_cache VALUES ('openquota','openquota',?,?)`, string(body), store.Now()); err != nil {
		t.Fatal(err)
	}
	sig := workers.Classify(1, "grok", workers.LogTail{Text: `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,` +
		`"errors":["Internal error: {\n  \"message\": \"API error (status 402 Payment Required): Grok Build usage balance exhausted\",\n  \"http_status\": 402\n}"]}`}, time.Now())
	if sig.Kind != workers.SignalQuota || sig.ResetAt != 0 {
		t.Fatalf("前提：402 判额度且报文没写恢复时刻：%+v", sig)
	}
	for _, c := range []struct {
		host string
		want func(int64) bool
	}{
		{LocalHost, func(u int64) bool { return u == reset.UnixMilli() }},
		{"h3", func(u int64) bool {
			d := time.Until(time.UnixMilli(u))
			return d > workers.Hold-time.Minute && d <= workers.Hold
		}},
	} {
		if _, err := markUnavailable(ctx, db, workers.Run{Worker: "grok", Host: c.host}, sig); err != nil {
			t.Fatal(err)
		}
		marks, err := workers.Marks(ctx, db, store.Now())
		if err != nil {
			t.Fatal(err)
		}
		m, ok := workers.Blocked(marks, "grok", "", c.host)
		if !ok || m.Kind != workers.SignalQuota || !c.want(m.Until) {
			t.Fatalf("%s 的标记：%+v（重置 %d）", c.host, m, reset.UnixMilli())
		}
	}
}
