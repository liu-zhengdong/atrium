package web

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
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
// /ui/material/mN/<相对路径> 取这条资料里的某个文件（不带 ?rev= 的取最新版）。
// 资料是谁都能写进来的内容，和网页同源：除 pdf（Chrome 不在沙箱里渲染 pdf）外一律带 CSP sandbox，
// 直接在新窗口打开也拿不到网页的权限；html 只多放行脚本与弹窗，仍是不透明来源。
//
// 不透明来源按跨域模式取的文件（模块脚本、fetch、字体）要跨域头才读得到，而浏览器发来的只有 Origin: null，
// 分不出是这条资料自己的页面还是别的网站。所以 html 正文在 iframe 里按 /ui/frame/mN-<键>/<正文路径> 打开，里面的相对路径落在同一条资料里；
// 键是服务内存里的随机密钥对资料号的 HMAC，只经同源的部门页接口给出；只有这个地址回 Access-Control-Allow-Origin: null。
// 资料页面因此能读自己这条资料里的文件；别的网站、别的资料猜不到键，网页接口照旧不发跨域头。重启后键会变，重开抽屉即可。

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

// frameTypes 只在沙箱页面地址上按真实类型回（模块脚本、样式表不是对的类型浏览器不执行）；
// 原地址照旧按纯文本，别的网站用 <script src> 拉不走资料里的脚本。
var frameTypes = map[string]string{
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".woff":  "font/woff",
	".woff2": "font/woff2",
}

// materialType 纯判定：Content-Type 与 CSP；frame 表示沙箱页面地址。
func materialType(name string, binary, frame bool) (ctype, csp string) {
	ext := strings.ToLower(path.Ext(name))
	ctype, ok := materialTypes[ext]
	if t, is := frameTypes[ext]; frame && is {
		ctype, ok = t, true
	}
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

// frameKey 纯函数：资料 id 的沙箱页面地址段 mN-<键>。
func frameKey(secret []byte, id string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(id))
	return id + "-" + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))[:22]
}

// frameID 纯判定：地址段 mN-<键> 的键对得上就返回 mN。
func frameID(secret []byte, seg string) (string, bool) {
	id, _, ok := strings.Cut(seg, "-")
	return id, ok && hmac.Equal([]byte(frameKey(secret, id)), []byte(seg))
}

func (w *web) material(rw http.ResponseWriter, req *http.Request) {
	id, err := ref(req, "m")
	if err != nil {
		api.WriteJSON(rw, err, nil, w.env.Log)
		return
	}
	w.serveMaterial(rw, req, id, false)
}

// frame 是 html 正文的沙箱页面：键对得上才给文件，并对不透明来源放行跨域读。
func (w *web) frame(rw http.ResponseWriter, req *http.Request) {
	id, ok := frameID(w.secret, req.PathValue("key"))
	if !ok {
		http.NotFound(rw, req)
		return
	}
	rw.Header().Set("Access-Control-Allow-Origin", "null")
	w.serveMaterial(rw, req, id, true)
}

func (w *web) serveMaterial(rw http.ResponseWriter, req *http.Request, id string, frame bool) {
	info, p, err := w.findMaterial(req, id)
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
	ctype, csp := materialType(name, info.Binary, frame)
	h := rw.Header()
	h.Set("Content-Type", ctype)
	h.Set("Content-Security-Policy", csp)
	h.Set("Content-Disposition", "inline; filename*=UTF-8''"+url.PathEscape(name))
	h.Set("Cache-Control", "no-cache")
	http.ServeContent(rw, req, name, st.ModTime(), f)
}

// findMaterial 取地址指的那个文件：id 的正文（可带 ?rev=），或 id 里的相对路径。
func (w *web) findMaterial(req *http.Request, id string) (org.MaterialFileInfo, string, error) {
	var err error
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
