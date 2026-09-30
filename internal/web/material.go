package web

import (
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// 资料原文：/ui/material/mN（?rev= 取某一版）回正文文件，页面按扩展名在抽屉里渲染。
// /ui/material/mN/<相对路径> 取这条资料里的某个文件：html 正文在 iframe 里按 /ui/material/mN/<正文路径> 打开，
// 里面的相对图片、链接就落在同一条资料里（不带 ?rev= 的取最新版）。
// 资料是谁都能写进来的内容，和网页同源：除 pdf（Chrome 不在沙箱里渲染 pdf）外一律带 CSP sandbox，
// 直接在新窗口打开也拿不到网页的权限；html 只多放行脚本与弹窗，仍是不透明来源。

// materialTypes 按扩展名定 Content-Type；不在表里的文本按纯文本，其余按二进制。
var materialTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".htm":  "text/html; charset=utf-8",
	".pdf":  "application/pdf",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp":  "image/bmp",
	".svg":  "image/svg+xml",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

// materialType 纯判定：Content-Type 与 CSP。
func materialType(name string, binary bool) (ctype, csp string) {
	ext := strings.ToLower(path.Ext(name))
	ctype, ok := materialTypes[ext]
	switch {
	case ok:
	case binary:
		ctype = "application/octet-stream"
	default:
		ctype = "text/plain; charset=utf-8"
	}
	switch ext {
	case ".pdf":
		csp = "frame-ancestors 'self'"
	case ".html", ".htm":
		csp = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'"
	default:
		csp = "sandbox; frame-ancestors 'self'"
	}
	return ctype, csp
}

func (w *web) material(rw http.ResponseWriter, req *http.Request) {
	info, p, err := w.findMaterial(req)
	if err != nil {
		api.WriteJSON(rw, err, nil, w.env.Log)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		api.WriteJSON(rw, err, nil, w.env.Log)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		api.WriteJSON(rw, err, nil, w.env.Log)
		return
	}
	name := path.Base(info.Path)
	ctype, csp := materialType(name, info.Binary)
	h := rw.Header()
	h.Set("Content-Type", ctype)
	h.Set("Content-Security-Policy", csp)
	h.Set("Content-Disposition", "inline; filename*=UTF-8''"+url.PathEscape(name))
	h.Set("Cache-Control", "no-cache")
	http.ServeContent(rw, req, name, st.ModTime(), f)
}

// findMaterial 取地址指的那个文件：mN 的正文（可带 ?rev=），或 mN 里的相对路径。
func (w *web) findMaterial(req *http.Request) (org.MaterialFileInfo, string, error) {
	id, err := ref(req, "m")
	if err != nil {
		return org.MaterialFileInfo{}, "", err
	}
	rev := 0
	if s := req.URL.Query().Get("rev"); s != "" {
		if rev, err = strconv.Atoi(s); err != nil || rev < 1 {
			return org.MaterialFileInfo{}, "", api.Usage("rev: 应为正整数")
		}
	}
	m, err := org.GetMaterial(req.Context(), w.env.DB, w.env.Paths.Data, id, rev)
	if err != nil {
		return org.MaterialFileInfo{}, "", err
	}
	return m.File(req.PathValue("rel"))
}
