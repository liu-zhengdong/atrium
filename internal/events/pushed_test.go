package events

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/cli"
)

func TestPushed(t *testing.T) {
	cases := []struct {
		name      string
		a         api.Actor
		listening bool
		want      bool
	}{
		{"负责人由唤醒送达", api.Actor{ID: "a1", Kind: "leader"}, false, true},
		{"秘书在听", api.Actor{ID: Secretary, Kind: "user"}, true, true},
		{"秘书不在听", api.Actor{ID: Secretary, Kind: "user"}, false, false},
		{"用户自己在终端里", api.Actor{ID: "u1", Kind: "user"}, true, false},
	}
	for _, c := range cases {
		if got := Pushed(c.a, c.listening); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestAsyncNext(t *testing.T) {
	for _, tc := range []struct {
		name           string
		worker, pushed bool
	}{
		{"执行者不查推送", true, true},
		{"普通用户保留等待", false, false},
		{"推送调用者不等", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/api/events/pushed" {
					t.Errorf("意外请求：%s", r.URL.Path)
				}
				fmt.Fprintf(w, `{"ok":true,"result":{"pushed":%v}}`, tc.pushed)
			}))
			defer srv.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			c := &cli.Ctx{Context: ctx, Env: cli.Env{Getenv: func(k string) string {
				switch k {
				case "ATRIUM_WORKER":
					if tc.worker {
						return "1"
					}
				case "ATRIUM_WORKER_TOKEN":
					return "test-token"
				case "ATRIUM_SERVER":
					return srv.URL
				}
				return ""
			}}}
			text, next, err := AsyncNext(c, "任务", "atrium task wait t1")
			wantText, wantNext, wantCalls := "任务", "atrium task wait t1", 1
			if tc.worker {
				wantCalls = 0
			} else if tc.pushed {
				wantText, wantNext = "任务\n"+PushedNote, ""
			}
			if err != nil || text != wantText || next != wantNext || calls != wantCalls {
				t.Fatalf("text=%q next=%q calls=%d err=%v", text, next, calls, err)
			}
		})
	}
}
