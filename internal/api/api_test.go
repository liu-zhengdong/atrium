package api

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRouterAuthAndEnvelope(t *testing.T) {
	r := NewRouter(nil)
	r.AddAuth(func(tok string) (Actor, bool) { return Actor{ID: "u1", Kind: "user"}, tok == "good" })
	r.Public("GET /health", func(q *Req) (any, error) { return "ok", nil })
	r.Handle("GET /api/me", func(q *Req) (any, error) { return q.Actor, nil })
	r.Handle("POST /api/small", func(q *Req) (any, error) {
		var v map[string]string
		return v, q.DecodeMax(&v, 32)
	})
	r.Handle("GET /api/t/{id}", func(q *Req) (any, error) {
		id, err := q.Ref("id", "t")
		if err != nil {
			return nil, err
		}
		return nil, NotFound("任务 %s 不存在", id).WithNext("atrium task ls")
	})
	srv := httptest.NewServer(r)
	defer srv.Close()
	ctx := context.Background()
	anon := &Client{Base: srv.URL}
	good := &Client{Base: srv.URL, Token: "good"}
	bad := &Client{Base: srv.URL, Token: "bad"}

	var s string
	if err := anon.Do(ctx, "GET", "/health", nil, &s); err != nil || s != "ok" {
		t.Fatalf("公开路由：%q %v", s, err)
	}
	codeOf := func(err error) string {
		var ae *Error
		if errors.As(err, &ae) {
			return ae.Code
		}
		return "?"
	}
	for _, c := range []*Client{anon, bad} {
		if err := c.Do(ctx, "GET", "/api/me", nil, nil); codeOf(err) != "unauthorized" {
			t.Fatalf("应 401：%v", err)
		}
	}
	var me Actor
	if err := good.Do(ctx, "GET", "/api/me", nil, &me); err != nil || me.ID != "u1" {
		t.Fatalf("%+v %v", me, err)
	}
	if err := (&Client{Base: srv.URL, Token: "good", As: "secretary"}).Do(ctx, "GET", "/api/me", nil, &me); err != nil ||
		me != (Actor{ID: "secretary", Kind: "user"}) {
		t.Fatalf("带署名 secretary：%+v %v", me, err)
	}
	if err := (&Client{Base: srv.URL, Token: "good", As: "u2"}).Do(ctx, "GET", "/api/me", nil, nil); codeOf(err) != "usage" {
		t.Fatalf("认不出的署名应拒绝：%v", err)
	}
	err := good.Do(ctx, "GET", "/api/t/t3", nil, nil)
	var ae *Error
	if !errors.As(err, &ae) || ae.Status != 404 || ae.Next != "atrium task ls" {
		t.Fatalf("错误信封：%+v", err)
	}
	for _, bad := range []string{"/api/t/o3", "/api/t/t0", "/api/t/..", "/api/t/t1x"} {
		if err := good.Do(ctx, "GET", bad, nil, nil); codeOf(err) != "usage" && codeOf(err) != "not_found" {
			t.Errorf("%s 应拒绝：%v", bad, err)
		}
	}
	if err := good.Do(ctx, "GET", "/api/nothing", nil, nil); codeOf(err) != "not_found" {
		t.Fatalf("未知路由应 404：%v", err)
	}
	if err := anon.Do(ctx, "GET", "/api/nothing", nil, nil); codeOf(err) != "not_found" {
		t.Fatalf("未知路由：%v", err)
	}
	if err := good.Do(ctx, "POST", "/api/small", map[string]string{"a": "b"}, nil); err != nil {
		t.Fatalf("上限内：%v", err)
	}
	err = good.Do(ctx, "POST", "/api/small", map[string]string{"a": strings.Repeat("x", 64)}, nil)
	if codeOf(err) != "usage" || !strings.Contains(err.Error(), "请求体超过") {
		t.Fatalf("超了上限应说清，不报 JSON 不合法：%v", err)
	}
}

func TestSign(t *testing.T) {
	user, leader := Actor{ID: "u1", Kind: "user"}, Actor{ID: "a2", Kind: "leader"}
	for _, c := range []struct {
		actor Actor
		as    string
		want  Actor
		err   bool
	}{
		{user, "", user, false},
		{user, "secretary", Actor{ID: "secretary", Kind: "user"}, false},
		{user, "u1", user, true},
		{user, "a2", user, true},
		{leader, "secretary", leader, false}, // 负责人会话读到秘书目录的设置：忽略，不借用秘书名义
		{leader, "", leader, false},
	} {
		got, err := Sign(c.actor, c.as)
		if got != c.want || (err != nil) != c.err {
			t.Errorf("Sign(%+v, %q) = %+v, %v", c.actor, c.as, got, err)
		}
	}
}

func TestClientNotRunning(t *testing.T) {
	c := &Client{Base: "http://127.0.0.1:1"}
	err := c.Do(context.Background(), "GET", "/health", nil, nil)
	var ae *Error
	if !errors.As(err, &ae) || ae.Code != "not_running" || ae.Next != "atrium start" {
		t.Fatalf("got %v", err)
	}
}
