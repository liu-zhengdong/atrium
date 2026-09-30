package web

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/config"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestMaterialType(t *testing.T) {
	for _, c := range []struct {
		name        string
		binary      bool
		ctype, csp  string
		scriptsOpen bool
	}{
		{"report.md", false, "text/plain; charset=utf-8", "sandbox;", false},
		{"data.CSV", false, "text/plain; charset=utf-8", "sandbox;", false},
		{"page.html", false, "text/html; charset=utf-8", "sandbox allow-scripts", true},
		{"logo.svg", false, "image/svg+xml", "sandbox;", false}, // svg 能带脚本：新窗口打开也在沙箱里
		{"a.PNG", true, "image/png", "sandbox;", false},
		{"报告.pdf", true, "application/pdf", "frame-ancestors 'self'", false}, // Chrome 不在沙箱里渲染 pdf
		{"表.xlsx", true, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sandbox;", false},
		{"logs.zip", true, "application/octet-stream", "sandbox;", false},
	} {
		ctype, csp := materialType(c.name, c.binary)
		if ctype != c.ctype || !strings.HasPrefix(csp, c.csp) || strings.Contains(csp, "allow-scripts") != c.scriptsOpen ||
			strings.Contains(csp, "allow-same-origin") || !strings.Contains(csp, "frame-ancestors 'self'") {
			t.Errorf("%s：%q %q", c.name, ctype, csp)
		}
	}
}

// 资料原文：按 mN（可带版本）取正文；mN/<相对路径> 只在这条资料里找；外来 Host 403。
func TestMaterialRoute(t *testing.T) {
	ctx := context.Background()
	data := t.TempDir()
	db, err := store.Open(filepath.Join(data, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	dept, _ := org.Add(ctx, db, org.NewDept{Name: "调研"})
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00")
	site, err := org.AddMaterial(ctx, db, data, org.MaterialInput{Org: dept.ID, Title: "magpie", Note: "样本", Files: []org.MaterialFile{
		{Name: "index.html", Content: []byte(`<img src="images/a.png">`)},
		{Name: "images/a.png", Content: png},
	}}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	md, err := org.AddMaterial(ctx, db, data, org.MaterialInput{Org: dept.ID, Note: "报告", Files: []org.MaterialFile{{Name: "report.md", Content: []byte("# 第一版")}}}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := org.AddMaterial(ctx, db, data, org.MaterialInput{ID: md.ID, Note: "改", Files: []org.MaterialFile{{Name: "report.md", Content: []byte("# 第二版")}}}, "u1"); err != nil {
		t.Fatal(err)
	}
	set, err := org.AddMaterial(ctx, db, data, org.MaterialInput{Org: dept.ID, Title: "shots", Note: "截图", Files: []org.MaterialFile{
		{Name: "a.png", Content: png}, {Name: "b.png", Content: png}}}, "u1")
	if err != nil {
		t.Fatal(err)
	}

	r := api.NewRouter(slog.New(slog.NewTextHandler(io.Discard, nil)))
	srv := httptest.NewServer(r)
	defer srv.Close()
	port, _ := strconv.Atoi(srv.URL[strings.LastIndex(srv.URL, ":")+1:])
	Module().Routes(r, &app.Env{DB: db, Paths: config.Paths{Data: data}, Port: port, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	get := func(path, host string) (*http.Response, string) {
		req, _ := http.NewRequest("GET", srv.URL+path, nil)
		if host != "" {
			req.Host = host
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res, string(body)
	}

	for _, c := range []struct{ path, body, ctype string }{
		{"/ui/material/" + md.ID, "# 第二版", "text/plain; charset=utf-8"},
		{"/ui/material/" + md.ID + "?rev=1", "# 第一版", "text/plain; charset=utf-8"},
		{"/ui/material/" + site.ID, `<img src="images/a.png">`, "text/html; charset=utf-8"},
		{"/ui/material/" + site.ID + "/index.html", `<img src="images/a.png">`, "text/html; charset=utf-8"},
		{"/ui/material/" + site.ID + "/images/a.png", string(png), "image/png"},
		{"/ui/material/" + set.ID + "/b.png", string(png), "image/png"},
	} {
		res, body := get(c.path, "")
		if res.StatusCode != 200 || body != c.body || res.Header.Get("Content-Type") != c.ctype ||
			!strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") || res.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s：%d %q %v", c.path, res.StatusCode, body, res.Header)
		}
	}
	for _, c := range []struct {
		path string
		code int
	}{
		{"/ui/material/" + md.ID + "/images/a.png", 404}, // 在别的资料里：不按标题跨资料找
		{"/ui/material/" + site.ID + "/nope.md", 404},
		{"/ui/material/" + set.ID, 404}, // 图片集没有正文
		{"/ui/material/m999", 404},
		{"/ui/material/" + md.ID + "?rev=9", 404},
		{"/ui/material/" + md.ID + "?rev=x", 400},
		{"/ui/material/t1", 400},
	} {
		if res, _ := get(c.path, ""); res.StatusCode != c.code {
			t.Errorf("%s 应 %d，得到 %d", c.path, c.code, res.StatusCode)
		}
	}
	if res, _ := get("/ui/material/"+md.ID, "evil.example:"+strconv.Itoa(port)); res.StatusCode != 403 {
		t.Errorf("外来 Host 应 403，得到 %d", res.StatusCode)
	}
	// 网页本身的 CSP 放行 data: 图片（docx 预览的内嵌图），脚本仍只许本站
	if res, _ := get("/", ""); !strings.Contains(res.Header.Get("Content-Security-Policy"), "img-src 'self' data:;") {
		t.Errorf("首页 CSP：%q", res.Header.Get("Content-Security-Policy"))
	}
}
