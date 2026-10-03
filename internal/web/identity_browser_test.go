package web

import (
	"context"

	"encoding/json"
	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/store"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestIdentityBrowser 只在显式指定临时交接目录时启动网页模块，不启动服务后台、模型或额度读取。
func TestIdentityBrowser(t *testing.T) {
	out := os.Getenv("ATRIUM_WEB_BROWSER_TEST")
	if out == "" {
		t.Skip("未指定隔离浏览器验证目录")
	}
	ctx := context.Background()
	data := t.TempDir()
	db, err := store.Open(filepath.Join(data, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	root, err := org.Add(ctx, db, org.NewDept{Name: "隔离组织"})
	must(err)
	dept, err := org.Add(ctx, db, org.NewDept{Name: "网页身份验收", Parent: root.ID})
	must(err)
	var a1, a10 org.Identity
	for i := 1; i <= 10; i++ {
		a, err := org.AddLeader(ctx, db, org.NewLeader{Name: "负责人" + strconv.Itoa(i), Workers: []string{"fake"}})
		must(err)
		if i == 1 {
			a1 = a
		}
		if i == 10 {
			a10 = a
		}
	}
	_, err = org.Edit(ctx, db, root.ID, org.DeptPatch{Leader: &a1.ID})
	must(err)
	_, err = org.Edit(ctx, db, dept.ID, org.DeptPatch{Leader: &a10.ID})
	must(err)
	_, err = org.AddPoint(ctx, db, dept.ID, org.NewPoint{Text: "结构身份查名", By: a1.ID}, a1.ID)
	must(err)
	_, err = org.AddPoint(ctx, db, dept.ID, org.NewPoint{Text: "历史原文保持", By: "a1 历史原文"}, a1.ID)
	must(err)
	task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "等待负责人处理", Org: dept.ID, Owner: a10.ID, Detail: "a1 历史原文不能被改名"}, a1.ID)
	must(err)
	must(ledger.Record(ctx, db, task.ID, "escalated", a1.ID, "a1 历史正文<&保持"))
	running, err := ledger.Add(ctx, db, ledger.NewTask{Title: "今天的处理人", Org: dept.ID, Owner: a10.ID}, a1.ID)
	must(err)
	_, err = ledger.Apply(ctx, db, running.ID, ledger.Event{Kind: ledger.Enqueue}, "runtime", "")
	must(err)
	_, err = ledger.Apply(ctx, db, running.ID, ledger.Event{Kind: ledger.Start}, "worker", "")
	must(err)
	draft, err := ledger.Add(ctx, db, ledger.NewTask{Title: "来源记录人", Org: dept.ID, Draft: true, Source: ledger.SourceOrg}, a1.ID)
	must(err)
	unknown, err := ledger.Add(ctx, db, ledger.NewTask{Title: "未登记来源", Org: dept.ID, Draft: true, Source: ledger.SourceOrg}, "a99")
	must(err)
	oldDept, err := org.Add(ctx, db, org.NewDept{Name: "原负责人部门", Parent: root.ID, Leader: "a2"})
	must(err)
	deleted, err := ledger.Add(ctx, db, ledger.NewTask{Title: "已删除处理人", Org: oldDept.ID, Owner: "a2"}, "a1")
	must(err)
	retiring, err := events.Wait(ctx, db, events.WaitOpts{Target: "a2"})
	must(err)
	for _, e := range retiring {
		_, err = events.Ack(ctx, db, []int64{e.ID}, "a2", "a2")
		must(err)
	}
	_, err = org.Edit(ctx, db, oldDept.ID, org.DeptPatch{Leader: &a10.ID}, "a1")
	must(err)
	mat, err := org.AddMaterial(ctx, db, data, org.MaterialInput{Org: dept.ID, Note: "资料记录人", Files: []org.MaterialFile{{Name: "样本.md", Content: []byte("a1 历史原文保持")}}}, a1.ID)
	must(err)
	c, err := agenda.AddChoice(ctx, db, data, agenda.ChoiceInput{Org: dept.ID, Title: "选项作者", Recommend: []int{1}, Reason: "固定隔离样本", Options: []agenda.OptionInput{
		{Title: "方案一", Gain: "识别", WhyNow: "需要", Cost: "小", IfNot: "难辨认", Evidence: mat.ID + "/样本.md"},
		{Title: "方案二", Gain: "识别", WhyNow: "需要", Cost: "小", IfNot: "难辨认", Evidence: mat.ID + "/样本.md"},
		{Title: "方案三", Gain: "识别", WhyNow: "需要", Cost: "小", IfNot: "难辨认", Evidence: mat.ID + "/样本.md"},
	}}, "", a1.ID)
	must(err)
	sched, err := agenda.AddSchedule(ctx, db, agenda.NewSchedule{Org: dept.ID, Title: "定时建立人", Kind: "task", Every: "7d"}, a10.ID, store.Now(), time.Local)
	must(err)
	must(events.Emit(ctx, db, events.Event{Kind: events.LeaderEscalate, Task: task.ID, Dept: dept.ID, Target: org.Secretary, Body: map[string]any{"from": a1.ID, "kind": "stuck", "label": "无法解决", "note": "上报卡身份"}}))
	// 一条降为知会的协作回执：今天页折起的次级入口要有东西可展开。
	must(events.Emit(ctx, db, events.Event{Kind: events.LeaderEscalate, Target: org.Secretary, Body: map[string]any{"from": a1.ID, "kind": "cross", "label": "需要别的部门配合", "note": "t866确认工作已闭合，回交t862 https://github.com/liu-zhengdong/atrium/pull/801#discussion_r1234567890abcdef"}}))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := api.NewRouter(logger)
	router.AddAuth(func(token string) (api.Actor, bool) {
		return api.Actor{ID: "u1", Kind: "user"}, token == "isolated-test"
	})
	srv := httptest.NewServer(router)
	defer srv.Close()
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	env := &app.Env{DB: db, Paths: config.Paths{Data: data}, Port: port, Log: logger}
	m := Module()
	m.Routes(router, env)
	ledger.Module().Routes(router, env)
	// 起 SSE 推送循环：浏览器里的实时刷新走真的一条（数据变了推 changed）。
	runCtx, stop := context.WithCancel(ctx)
	defer stop()
	go m.Run(runCtx, env)
	ready, _ := json.Marshal(map[string]string{"base": srv.URL, "root": root.ID, "dept": dept.ID, "running": running.ID, "task": task.ID, "draft": draft.ID, "deleted": deleted.ID, "unknown": unknown.ID, "choice": c.ID, "schedule": sched.ID, "material": mat.ID})
	must(os.WriteFile(filepath.Join(out, "ready.json"), ready, 0600))
	deadline := time.After(4 * time.Minute)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-deadline:
			t.Fatal("隔离浏览器验证超时")
		case <-ticker.C:
			if _, err := os.Stat(filepath.Join(out, "done")); err == nil {
				return
			}
			if b, err := os.ReadFile(filepath.Join(out, "rename.json")); err == nil {
				var names map[string]string
				must(json.Unmarshal(b, &names))
				for id, name := range names {
					_, err = org.EditLeader(ctx, db, id, org.LeaderPatch{Name: &name})
					must(err)
				}
				must(os.Remove(filepath.Join(out, "rename.json")))
				must(os.WriteFile(filepath.Join(out, "renamed"), []byte("ok"), 0600))
			}
		}
	}
}
