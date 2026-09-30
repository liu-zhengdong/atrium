package web

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
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
		{"logo.svg", true, "image/svg+xml", "sandbox;", false}, // svg 能带脚本：新窗口打开也在沙箱里
		{"a.PNG", true, "image/png", "sandbox;", false},
		{"报告.pdf", true, "application/pdf", "frame-ancestors 'self'", false}, // Chrome 不在沙箱里渲染 pdf
		{"表.xlsx", true, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sandbox;", false},
		{"logs.zip", true, "application/octet-stream", "sandbox;", false},
		{"app.js", false, "text/plain; charset=utf-8", "sandbox;", false}, // 原地址不给脚本类型
		{"style.css", false, "text/plain; charset=utf-8", "sandbox;", false},
	} {
		ctype, csp := materialType(c.name, c.binary, false)
		if ctype != c.ctype || !strings.HasPrefix(csp, c.csp) || strings.Contains(csp, "allow-scripts") != c.scriptsOpen ||
			strings.Contains(csp, "allow-same-origin") || !strings.Contains(csp, "frame-ancestors 'self'") {
			t.Errorf("%s：%q %q", c.name, ctype, csp)
		}
	}
	// 沙箱页面地址：脚本、样式按真实类型，其余同原地址
	for name, want := range map[string]string{"app.JS": "text/javascript; charset=utf-8", "m.mjs": "text/javascript; charset=utf-8",
		"style.css": "text/css; charset=utf-8", "d.json": "application/json", "f.woff2": "font/woff2", "page.html": "text/html; charset=utf-8", "a.md": "text/plain; charset=utf-8"} {
		if ctype, csp := materialType(name, false, true); ctype != want || !strings.HasPrefix(csp, "sandbox") {
			t.Errorf("沙箱页面 %s：%q %q", name, ctype, csp)
		}
	}
}

// 沙箱页面的键：只认同一个密钥给同一条资料算出的。
func TestFrameKey(t *testing.T) {
	secret, other := []byte("secret-a"), []byte("secret-b")
	key := frameKey(secret, "m2")
	if id, ok := frameID(secret, key); !ok || id != "m2" {
		t.Fatalf("自己的键：%q %v", id, ok)
	}
	_, mac, _ := strings.Cut(key, "-")
	for _, seg := range []string{
		"m2", "m2-", "m3-" + mac, // 拿 m2 的键去开 m3
		key[:len(key)-1], key + "A", frameKey(other, "m2"), "-" + mac,
	} {
		if _, ok := frameID(secret, seg); ok {
			t.Errorf("%q 不该认", seg)
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
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><text>图</text></svg>`)
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00")
	site, err := org.AddMaterial(ctx, db, data, org.MaterialInput{Org: dept.ID, Title: "magpie", Note: "样本", Files: []org.MaterialFile{
		{Name: "index.html", Content: []byte(`<img src="images/a.png">`)},
		{Name: "images/a.png", Content: png},
		{Name: "images/a.svg", Content: svg},
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
	r.AddAuth(func(token string) (api.Actor, bool) { return api.Actor{ID: "u1", Kind: "user"}, token == "test-token" })
	org.Module().Routes(r, &app.Env{DB: db, Paths: config.Paths{Data: data}, Log: slog.New(slog.NewTextHandler(io.Discard, nil))})
	table := cli.NewTable("atrium", "")
	org.Module().Commands(table)
	var output bytes.Buffer
	env := cli.Env{Stdout: &output, Stderr: &output, Getenv: func(key string) string {
		switch key {
		case "ATRIUM_WORKER_TOKEN":
			return "test-token"
		case "ATRIUM_SERVER":
			return srv.URL
		}
		return ""
	}}
	exported := filepath.Join(data, "export.svg")
	if exit := table.Main(ctx, []string{"material", "ls", site.ID + "/images/a.svg", "--out", exported}, env); exit != 0 {
		t.Fatalf("CLI 导出：%d %s", exit, output.String())
	}
	raw, err := os.ReadFile(exported)
	if err != nil || !bytes.Equal(raw, svg) {
		t.Fatalf("CLI 导出的 SVG：%q %v", raw, err)
	}
	output.Reset()
	if exit := table.Main(ctx, []string{"material", "ls", site.ID + "/images/a.svg"}, env); exit != 2 || !strings.Contains(output.String(), "--out") {
		t.Fatalf("二进制读取应提示 --out：%d %s", exit, output.String())
	}

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
		{"/ui/material/" + site.ID + "/images/a.svg", string(svg), "image/svg+xml"},
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
	// html 正文的沙箱地址从部门页接口取；只有它放行跨域读，且只开这一条资料
	res, body := get("/ui/api/dept/"+dept.ID, "")
	var page struct {
		Result struct {
			Materials []struct{ ID, Frame string } `json:"materials"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(body), &page); err != nil || res.StatusCode != 200 {
		t.Fatalf("部门页：%d %s", res.StatusCode, body)
	}
	frames := map[string]string{}
	for _, m := range page.Result.Materials {
		frames[m.ID] = m.Frame
	}
	if !strings.HasPrefix(frames[site.ID], "/ui/frame/"+site.ID+"-") || frames[md.ID] == frames[site.ID] {
		t.Fatalf("沙箱地址：%v", frames)
	}
	res, body = get(frames[site.ID]+"images/a.png", "")
	if res.StatusCode != 200 || body != string(png) || res.Header.Get("Access-Control-Allow-Origin") != "null" ||
		!strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("沙箱地址取文件：%d %v", res.StatusCode, res.Header)
	}
	for _, c := range []struct {
		path  string
		code  int
		allow string
	}{
		{frames[md.ID] + "images/a.png", 404, "null"},                                        // 这把键只开 md 那条
		{strings.Replace(frames[site.ID], site.ID+"-", md.ID+"-", 1) + "report.md", 404, ""}, // 换了资料号，键对不上
		{"/ui/frame/" + site.ID + "/index.html", 404, ""},
		{"/ui/material/" + site.ID + "/index.html", 200, ""}, // 原地址不放行
	} {
		if res, _ := get(c.path, ""); res.StatusCode != c.code || res.Header.Get("Access-Control-Allow-Origin") != c.allow {
			t.Errorf("%s：%d %v", c.path, res.StatusCode, res.Header)
		}
	}
	if res, _ := get(frames[site.ID]+"index.html", "evil.example:"+strconv.Itoa(port)); res.StatusCode != 403 {
		t.Errorf("沙箱地址外来 Host 应 403，得到 %d", res.StatusCode)
	}
	if res, _ := get("/ui/material/"+md.ID, "evil.example:"+strconv.Itoa(port)); res.StatusCode != 403 {
		t.Errorf("外来 Host 应 403，得到 %d", res.StatusCode)
	}
	// 网页本身的 CSP 放行 data: 内嵌图与 blob: 本地 logo 动画，脚本仍只许本站
	if res, _ := get("/", ""); !strings.Contains(res.Header.Get("Content-Security-Policy"), "img-src 'self' data: blob:;") {
		t.Errorf("首页 CSP：%q", res.Header.Get("Content-Security-Policy"))
	}
}
