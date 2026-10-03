package api

import (
	"context"
	"errors"
	"net"
	"net/http"
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
	for _, tc := range []struct {
		name, op, message string
		notRunning        bool
	}{
		{"refused", "dial", "connect: connection refused", true},
		{"timeout", "dial", "i/o timeout", true},
		{"reset", "dial", "connect: connection reset by peer", true},
		{"read_reset", "read", "connection reset by peer", false},
		{"write_broken_pipe", "write", "broken pipe", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cause := &net.OpError{Op: tc.op, Net: "tcp", Addr: &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 14310}, Err: errors.New(tc.message)}
			calls := 0
			c := &Client{Base: "http://127.0.0.1:14310", HTTP: &http.Client{Transport: clientErrorTransport(func(*http.Request) (*http.Response, error) {
				calls++
				return nil, cause
			})}}
			err := c.Do(context.Background(), "POST", "/api/materials", map[string]string{"org": "o4"}, nil)
			if calls != 1 {
				t.Fatalf("请求次数 = %d，失败后不应自动重试", calls)
			}
			var ae *Error
			if !tc.notRunning {
				if !errors.Is(err, cause) || errors.As(err, &ae) {
					t.Fatalf("读写错误应原样返回，不应归为 not_running：%v", err)
				}
				return
			}
			if !errors.As(err, &ae) || ae.Code != "not_running" {
				t.Fatalf("拨号错误应归为 not_running：%v", err)
			}
			if want := "连不上服务（" + c.Base + "）：" + cause.Error(); ae.Message != want {
				t.Errorf("Message = %q，want %q", ae.Message, want)
			}
			if !strings.HasPrefix(ae.Next, "atrium start") || !strings.Contains(ae.Next, "远程机器的代理端口") ||
				!strings.Contains(ae.Next, "反向隧道断开") || !strings.Contains(ae.Next, "稍候重试") {
				t.Errorf("Next 应同时给出本机启动与远程隧道指引：%q", ae.Next)
			}
		})
	}
}

type clientErrorTransport func(*http.Request) (*http.Response, error)

func (f clientErrorTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
