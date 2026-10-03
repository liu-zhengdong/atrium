package secretary

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/watch"
)

// 隔离固定响应覆盖真正的读取入口与三个文本消费者，不读用户数据。
func TestHumanViewDisplay(t *testing.T) {
	v := watch.View{Tasks: []watch.TaskRow{
		{ID: "t1", Holder: watch.Holder{Kind: "leader", Who: "a1", Text: "待分派"}},
		{ID: "t2", Holder: watch.Holder{Kind: "leader", Who: "a10", Text: "待分派"}},
		{ID: "t3", Holder: watch.Holder{Kind: "leader", Who: "a99", Text: "待分派"}},
	}}
	roster := []org.Identity{{ID: "a1", Name: "张三"}, {ID: "a10", Name: "李四"}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var result any
		switch r.URL.Path {
		case "/api/top":
			result = v
		case "/api/leaders":
			result = roster
		default:
			t.Errorf("意外请求 %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": result})
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c := &cli.Ctx{Context: ctx, Env: cli.Env{Getenv: func(key string) string {
		switch key {
		case "ATRIUM_SERVER":
			return srv.URL
		case "ATRIUM_WORKER_TOKEN":
			return "test-token"
		}
		return ""
	}}}
	read := func() watch.View {
		t.Helper()
		got, err := watch.ReadHumanView(c)
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	got := read()
	for label, output := range map[string]string{"top": watch.Render(got), "statusline": ansi.ReplaceAllString(StatusLine(got), ""), "Brief": Brief("", "", nil, got, "")} {
		for _, want := range []string{"张三（a1）", "李四（a10）", "未登记负责人（a99）"} {
			if !strings.Contains(output, want) {
				t.Fatalf("%s 缺少 %s：%s", label, want, output)
			}
		}
		t.Logf("%s: %s", label, output)
	}
	raw, err := json.Marshal(got)
	if err != nil || strings.Contains(string(raw), "张三") || !strings.Contains(string(raw), `"who":"a1"`) {
		t.Fatalf("机器输出改变：%s %v", raw, err)
	}
	roster[0].Name = "新名字"
	if who := read().HolderWho(v.Tasks[0].Holder); who != "新名字（a1）" {
		t.Fatalf("改名后未更新：%s", who)
	}
	for id, kind := range map[string]string{"u1": "user", "secretary": "secretary", "worker": "worker", "gates": "check", "a1旧名": "leader"} {
		h := watch.Holder{Kind: kind, Who: id, Text: "原语义"}
		if got.HolderWho(h) != id {
			t.Fatalf("非负责人语义改变：%s", id)
		}
		base := watch.View{Tasks: []watch.TaskRow{{ID: "t9", Holder: h}}}
		withNames := base
		withNames.Names = got.Names
		if Brief("", "", nil, base, "") != Brief("", "", nil, withNames, "") || StatusLine(base) != StatusLine(withNames) {
			t.Fatalf("非负责人消费者语义改变：%s", id)
		}
	}
	got.Names["a1"] = strings.Repeat("长名字", 20) + "\n换行"
	who := got.HolderWho(v.Tasks[0].Holder)
	if who != strings.Repeat("长名字", 4)+"…（a1）" || strings.ContainsAny(who, "\r\n") {
		t.Fatalf("长名截断损坏短号：%q", who)
	}
	t.Logf("40 列窄终端负责人标签（最多 32 列）：%s", who)
}
