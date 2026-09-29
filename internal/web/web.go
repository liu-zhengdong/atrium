// Package web 是只读网页：静态文件 embed 进二进制，托管在 /；数据走只读接口 /ui/api/…，
// 实时靠一条 SSE（/ui/stream，数据变了推 changed，页面只重取）。
// 不登录：服务只听 127.0.0.1，网页与只读接口再核对 Host 头（挡 DNS 重绑定），不发 CORS 头。设计稿 ~/Atrium/design/atrium-ui.html。
// 契约见 internal/README.md。
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
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
	w := &web{hub: newHub()}
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
	hub *hub
	env *app.Env
}

func (w *web) routes(r *api.Router, env *app.Env) {
	w.env = env
	static, _ := fs.Sub(staticFS, "static")
	files := http.FileServer(http.FS(static))
	r.Raw("GET /{$}", w.local(func(rw http.ResponseWriter, req *http.Request) {
		http.ServeFileFS(rw, req, static, "index.html")
	}))
	r.Raw("GET /ui/assets/", w.local(http.StripPrefix("/ui/assets/", files).ServeHTTP))
	w.data(r, "GET /ui/api/nav", func(req *http.Request) (any, error) { return loadNav(req.Context(), env.DB) })
	w.data(r, "GET /ui/api/today", func(req *http.Request) (any, error) { return loadToday(req.Context(), env.DB, time.Now()) })
	w.data(r, "GET /ui/api/legion", func(req *http.Request) (any, error) {
		return loadLegion(req.Context(), env.DB, store.Now())
	})
	w.data(r, "GET /ui/api/quota", func(req *http.Request) (any, error) { return loadQuota(req.Context(), env.DB) })
	w.data(r, "GET /ui/api/dept/{id}", func(req *http.Request) (any, error) {
		id, err := ref(req, "o")
		if err != nil {
			return nil, err
		}
		return loadDept(req.Context(), env.DB, env.Paths.Data, id)
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
	w.data(r, "GET /ui/api/schedule/{id}", func(req *http.Request) (any, error) {
		id, err := ref(req, "s")
		if err != nil {
			return nil, err
		}
		return loadSchedule(req.Context(), env.DB, id)
	})
	r.Raw("GET /ui/stream", w.local(w.hub.serve))
}

func ref(req *http.Request, prefix string) (string, error) {
	return (&api.Req{Request: req}).Ref("id", prefix)
}

// localHost 纯判定：Host 头是本服务的本机地址（127.0.0.1:端口 或 localhost:端口），挡 DNS 重绑定。
func localHost(host string, port int) bool {
	h := strings.ToLower(host)
	return h == "127.0.0.1:"+strconv.Itoa(port) || h == "localhost:"+strconv.Itoa(port)
}

// local 只放行 Host 头是本机地址的请求；其余一律 403。
func (w *web) local(h http.HandlerFunc) http.HandlerFunc {
	return func(rw http.ResponseWriter, req *http.Request) {
		if !localHost(req.Host, w.env.Port) {
			http.Error(rw, "只接受本机地址", http.StatusForbidden)
			return
		}
		// 脚本只许本站文件；样式许行内 style（额度条宽度、树缩进是算出来的），页面里的文字一律转义后才拼进 HTML。
		rw.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'")
		rw.Header().Set("X-Content-Type-Options", "nosniff")
		rw.Header().Set("Referrer-Policy", "no-referrer")
		h(rw, req)
	}
}

// data 注册一个只读 JSON 接口：只核对 Host。
func (w *web) data(r *api.Router, pattern string, load func(*http.Request) (any, error)) {
	r.Raw(pattern, w.local(func(rw http.ResponseWriter, req *http.Request) {
		rw.Header().Set("Cache-Control", "no-store")
		result, err := load(req)
		api.WriteJSON(rw, err, result, w.env.Log)
	}))
}
