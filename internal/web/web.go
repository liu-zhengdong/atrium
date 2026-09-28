// Package web 是只读网页：静态文件 embed 进二进制，托管在 /；数据走只读接口 /ui/api/…，
// 实时靠一条 SSE（/ui/stream，数据变了推 changed，页面只重取）。
// 登录：atrium map 用用户令牌换一次性链接（2 分钟、只能用一次），浏览器打开后换成本机会话 cookie；会话只能读。
// 只接受本机连接（回环地址 + Host 头核对）。设计稿 ~/Atrium/design/atrium-ui.html。
// 契约见 internal/README.md。
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"time"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/importer"
	"github.com/liu-zhengdong/atrium/internal/store"
)

//go:embed static
var staticFS embed.FS

// Module 是本包接入点：命令 map（与一次性的 import，见 importer 包）、网页路由、变化推送循环。
func Module() app.Module {
	w := &web{auth: newSessions(), hub: newHub()}
	return app.Module{
		Name: "web",
		Commands: func(t *cli.Table) {
			t.Add(mapCommand())
			t.Add(importer.Command())
		},
		Routes: w.routes,
		Run:    w.hub.run,
	}
}

type web struct {
	auth *sessions
	hub  *hub
	env  *app.Env
}

// Link 是 POST /api/web/link 的结果。
type Link struct {
	URL       string `json:"url"`
	ExpiresAt int64  `json:"expires_at"`
}

func (w *web) routes(r *api.Router, env *app.Env) {
	w.env = env
	r.Handle("POST /api/web/link", func(q *api.Req) (any, error) {
		if q.Actor.Kind != "user" {
			return nil, api.Forbidden("只有用户能取网页链接")
		}
		code, exp := w.auth.newLink()
		return Link{URL: "http://127.0.0.1:" + itoa(env.Port) + "/login?code=" + code, ExpiresAt: exp.UnixMilli()}, nil
	})
	static, _ := fs.Sub(staticFS, "static")
	files := http.FileServer(http.FS(static))
	r.Raw("GET /{$}", w.local(func(rw http.ResponseWriter, req *http.Request) {
		http.ServeFileFS(rw, req, static, "index.html")
	}))
	r.Raw("GET /ui/assets/", w.local(http.StripPrefix("/ui/assets/", files).ServeHTTP))
	r.Raw("GET /login", w.local(func(rw http.ResponseWriter, req *http.Request) {
		sid, ok := w.auth.redeem(req.URL.Query().Get("code"))
		if !ok {
			http.Redirect(rw, req, "/#expired", http.StatusSeeOther)
			return
		}
		http.SetCookie(rw, &http.Cookie{Name: cookieName, Value: sid, Path: "/", HttpOnly: true,
			SameSite: http.SameSiteStrictMode, MaxAge: int(sessionTTL / time.Second)})
		http.Redirect(rw, req, "/", http.StatusSeeOther)
	}))
	w.data(r, "GET /ui/api/nav", func(req *http.Request) (any, error) { return loadNav(req.Context(), env.DB) })
	w.data(r, "GET /ui/api/today", func(req *http.Request) (any, error) { return loadToday(req.Context(), env.DB, time.Now()) })
	w.data(r, "GET /ui/api/decisions", func(req *http.Request) (any, error) { return loadDecisions(req.Context(), env.DB) })
	w.data(r, "GET /ui/api/legion", func(req *http.Request) (any, error) {
		return loadLegion(req.Context(), env.DB, store.Now())
	})
	w.data(r, "GET /ui/api/dept/{id}", func(req *http.Request) (any, error) {
		id, err := ref(req, "o")
		if err != nil {
			return nil, err
		}
		return loadDept(req.Context(), env.DB, id)
	})
	w.data(r, "GET /ui/api/task/{id}", func(req *http.Request) (any, error) {
		id, err := ref(req, "t")
		if err != nil {
			return nil, err
		}
		return loadTask(req.Context(), env.DB, id)
	})
	w.data(r, "GET /ui/api/choice/{id}", func(req *http.Request) (any, error) {
		id, err := ref(req, "c")
		if err != nil {
			return nil, err
		}
		return loadChoice(req.Context(), env.DB, id)
	})
	r.Raw("GET /ui/stream", w.local(w.session(w.hub.serve)))
}

func ref(req *http.Request, prefix string) (string, error) {
	return (&api.Req{Request: req}).Ref("id", prefix)
}

// local 只放行本机连接；其余一律 403。
func (w *web) local(h http.HandlerFunc) http.HandlerFunc {
	return func(rw http.ResponseWriter, req *http.Request) {
		if !localRequest(req.RemoteAddr, req.Host, w.env.Port) {
			http.Error(rw, "只接受本机连接", http.StatusForbidden)
			return
		}
		// 脚本只许本站文件；样式许行内 style（额度条宽度、树缩进是算出来的），页面里的文字一律转义后才拼进 HTML。
		rw.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'")
		rw.Header().Set("X-Content-Type-Options", "nosniff")
		rw.Header().Set("Referrer-Policy", "no-referrer")
		h(rw, req)
	}
}

// session 要求有效的网页会话 cookie；没有回 401（页面据此提示重新 atrium map）。
func (w *web) session(h http.HandlerFunc) http.HandlerFunc {
	return func(rw http.ResponseWriter, req *http.Request) {
		c, err := req.Cookie(cookieName)
		if err != nil || !w.auth.check(c.Value) {
			api.WriteJSON(rw, (&api.Error{Status: 401, Code: "unauthorized", Message: "网页会话无效或已过期"}).WithNext("atrium map"), nil, nil)
			return
		}
		h(rw, req)
	}
}

// data 注册一个只读 JSON 接口：本机 + 会话。
func (w *web) data(r *api.Router, pattern string, load func(*http.Request) (any, error)) {
	r.Raw(pattern, w.local(w.session(func(rw http.ResponseWriter, req *http.Request) {
		rw.Header().Set("Cache-Control", "no-store")
		result, err := load(req)
		api.WriteJSON(rw, err, result, w.env.Log)
	})))
}
