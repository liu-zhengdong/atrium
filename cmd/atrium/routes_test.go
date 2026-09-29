package main

import (
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/org/leaders"
	"github.com/liu-zhengdong/atrium/internal/pause"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 负责人令牌的权限表（leaders.RuleFor）按路由模式判。这里装上全部模块的真实路由，逐条核对写接口的规则：
// 新加的写接口不在表里就失败，逼着决定负责人能不能调它；路由改了形状（RuleFor 认不出）也会失败。
func TestLeaderRulesCoverRealRoutes(t *testing.T) {
	dir := t.TempDir()
	db, err := store.Open(filepath.Join(dir, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	env := &app.Env{DB: db, Paths: config.Paths{Data: dir}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Pause: &pause.Store{DB: db}}
	r := api.NewRouter(env.Log)
	for _, m := range modules() {
		if m.Routes != nil {
			m.Routes(r, env)
		}
	}
	want := map[string]leaders.Rule{
		"POST /api/tasks":                     leaders.RuleTaskCreate,
		"PATCH /api/tasks/{id}":               leaders.RuleTaskRef,
		"POST /api/tasks/{id}/notes":          leaders.RuleTaskRef,
		"POST /api/tasks/{id}/run":            leaders.RuleTaskRef,
		"POST /api/tasks/{id}/tell":           leaders.RuleTaskRef,
		"POST /api/tasks/{id}/merge":          leaders.RuleTaskRef,
		"POST /api/tasks/{id}/accept":         leaders.RuleTaskRef, // 验收人是用户时由 gates 另拒
		"POST /api/tasks/{id}/reject":         leaders.RuleTaskRef,
		"POST /api/org/{id}/points":           leaders.RuleDeptRef,
		"PATCH /api/points/{id}":              leaders.RulePointRef,
		"POST /api/materials":                 leaders.RuleBodyDept,
		"POST /api/materials/{id}/archive":    leaders.RuleMaterialRef,
		"POST /api/schedules":                 leaders.RuleBodyDept,
		"POST /api/schedules/{id}/run":        leaders.RuleScheduleRef,
		"DELETE /api/schedules/{id}":          leaders.RuleScheduleRef,
		"POST /api/choices":                   leaders.RuleBodyDept,
		"PUT /api/memo":                       leaders.RuleMemo,
		"POST /api/events/ack":                leaders.RuleEventsAck,
		"POST /api/escalations":               leaders.RuleEscalate,
		"POST /api/choices/{id}/decide":       leaders.RuleDeny, // 拍板只有用户
		"POST /api/org":                       leaders.RuleDeny,
		"PATCH /api/org/{id}":                 leaders.RuleDeptIntro, // 只许介绍四项
		"PUT /api/org/{id}/secrets/{name}":    leaders.RuleDeny,
		"DELETE /api/org/{id}/secrets/{name}": leaders.RuleDeny,
		"POST /api/leaders":                   leaders.RuleDeny,
		"PATCH /api/leaders/{id}":             leaders.RuleDeny,
		"POST /api/skills":                    leaders.RuleDeny,
		"POST /api/workers/edit":              leaders.RuleDeny,
		"POST /api/workers/clear":             leaders.RuleDeny, // 解除不可用标记：人处理好之后由用户或秘书做
		"POST /api/hosts":                     leaders.RuleDeny,
		"PATCH /api/hosts/{id}":               leaders.RuleDeny,
		"DELETE /api/hosts/{id}":              leaders.RuleDeny,
		"POST /api/quota":                     leaders.RuleDeny,
		"POST /api/events/listen":             leaders.RuleDeny, // 「在听」只给秘书会话
	}
	seen := map[string]bool{}
	for _, p := range r.Patterns() {
		method, _, _ := strings.Cut(p, " ")
		if method == "GET" || method == "HEAD" {
			if got := leaders.RuleFor(p); got != leaders.RuleRead && !strings.Contains(p, "/api/service") && !strings.Contains(p, "/api/auth") {
				t.Errorf("%s：读接口应放行，规则 %d", p, got)
			}
			continue
		}
		seen[p] = true
		w, ok := want[p]
		if !ok {
			t.Errorf("写接口 %s 不在负责人权限表里：决定负责人能不能调它，补进这张表（必要时改 leaders.RuleFor）", p)
			continue
		}
		if got := leaders.RuleFor(p); got != w {
			t.Errorf("%s：规则 %d，期望 %d", p, got, w)
		}
	}
	for p := range want {
		if !seen[p] {
			t.Errorf("表里的 %s 没有注册（路由改了形状？）", p)
		}
	}
}
