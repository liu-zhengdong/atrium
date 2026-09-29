package skillcheck

import (
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/png"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// siteDirs 是构建产物目录，按顺序取第一个存在的。
var siteDirs = []string{"dist", "out", "build", "_site"}

// Source 是工作目录里的一篇 Markdown 源文件。
type Source struct {
	Path string // 相对工作目录，斜杠分隔
	Mod  time.Time
}

// Page 从构建产物的页面里认出这次写的文章页（纯函数）：取最近改过的源文件（README 除外），按它的文件名（index 除外）
// 或所在目录名找 <名>.html 或 <名>/index.html。pages 是相对产物目录的斜杠路径。找不到时返回没过的原因。
func Page(sources []Source, pages []string) (page, why string) {
	var src Source
	for _, s := range sources {
		if !strings.EqualFold(path.Base(s.Path), "README.md") && (src.Path == "" || s.Mod.After(src.Mod)) {
			src = s
		}
	}
	if src.Path == "" {
		return "", "工作目录里没有 Markdown 源文件（.md、.mdx），认不出文章页"
	}
	var names []string
	if n := strings.TrimSuffix(path.Base(src.Path), path.Ext(src.Path)); n != "index" {
		names = append(names, n)
	}
	if d := path.Base(path.Dir(src.Path)); d != "." {
		names = append(names, d)
	}
	for _, n := range names {
		for _, p := range pages {
			if q := "/" + p; strings.HasSuffix(q, "/"+n+".html") || strings.HasSuffix(q, "/"+n+"/index.html") {
				return p, ""
			}
		}
	}
	return "", fmt.Sprintf("构建产物里找不到最近改过的 %s 对应的页面（找的是 %s 的 .html 或 /index.html）", src.Path, strings.Join(names, "、"))
}

// article：站点仓库 pnpm run build 能过；在构建产物里认出文章页，运行时自己起本地预览，用无头浏览器截明暗各一张。
func article(ctx context.Context, e Env) (Result, error) {
	if _, err := e.R.Run(ctx, e.Dir, "pnpm", "run", "build"); err != nil {
		why, err := failed(ctx, "构建", err)
		return Result{Evidence: why}, err
	}
	var site string
	for _, d := range siteDirs {
		if fi, err := os.Stat(filepath.Join(e.Dir, d)); err == nil && fi.IsDir() {
			site = filepath.Join(e.Dir, d)
			break
		}
	}
	if site == "" {
		return Result{Evidence: fmt.Sprintf("构建后没有产物目录（找的是 %s）", strings.Join(siteDirs, "、"))}, nil
	}
	sources, pages, err := scanSite(e.Dir, site)
	if err != nil {
		return Result{}, err
	}
	page, why := Page(sources, pages)
	if why != "" {
		return Result{Evidence: why}, nil
	}
	find := e.Browser
	if find == nil {
		find = FindBrowser
	}
	browser, err := find()
	if err != nil {
		return Result{}, err
	}
	base, stop, err := preview(site)
	if err != nil {
		return Result{}, err
	}
	defer stop()
	var shots []string
	for _, m := range []struct{ name, scheme string }{{"light", "1"}, {"dark", "0"}} {
		shot, why, err := screenshot(ctx, e, browser, base+"/"+page, m.name, m.scheme)
		if why != "" || err != nil {
			return Result{Evidence: why, Artifacts: shots}, err
		}
		shots = append(shots, shot)
	}
	return Result{OK: true, Evidence: "pnpm run build 通过；文章页 " + page + " 已截明暗两张", Artifacts: shots}, nil
}

// scanSite 列工作目录里的 Markdown 源文件（跳过依赖、git 与产物目录）和产物目录里的页面。
func scanSite(dir, site string) (sources []Source, pages []string, err error) {
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if n := d.Name(); p != dir && (n == "node_modules" || strings.HasPrefix(n, ".") || p == site) {
				return filepath.SkipDir
			}
			return nil
		}
		if ext := strings.ToLower(filepath.Ext(p)); ext == ".md" || ext == ".mdx" {
			fi, err := d.Info()
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(dir, p)
			sources = append(sources, Source{Path: filepath.ToSlash(rel), Mod: fi.ModTime()})
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	err = filepath.WalkDir(site, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".html") {
			rel, _ := filepath.Rel(site, p)
			pages = append(pages, filepath.ToSlash(rel))
		}
		return err
	})
	return sources, pages, err
}

// shotPoll 是看截图写完没有的间隔。
const shotPoll = 100 * time.Millisecond

// preview 在本机随机端口起静态预览（只听 127.0.0.1）。
func preview(dir string) (base string, stop func() error, err error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}
	srv := &http.Server{Handler: http.FileServer(http.Dir(dir))}
	go srv.Serve(ln)
	return "http://" + ln.Addr().String(), srv.Close, nil
}

// screenshot 用无头浏览器截一张（scheme 1 亮、0 暗，走页面自己的 prefers-color-scheme），
// 用一次性的浏览器资料目录，不碰本机浏览器的资料。
func screenshot(ctx context.Context, e Env, browser, url, name, scheme string) (shot, why string, err error) {
	profile, err := os.MkdirTemp("", "atrium-browser-")
	if err != nil {
		return "", "", err
	}
	defer os.RemoveAll(profile)
	shot = filepath.Join(e.Out, "article-"+name+".png")
	if err := os.Remove(shot); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", "", err
	}
	// 完整版 Chrome 的无头模式写完截图不一定退出（macOS 上 Chrome 154 实测一直挂着），所以不等它退出：
	// 截图能完整解码就结束浏览器。
	bctx, written := context.WithCancel(ctx)
	defer written()
	go func() {
		for bctx.Err() == nil {
			if _, err := blankFile(shot); err == nil {
				written()
				return
			}
			select {
			case <-bctx.Done():
			case <-time.After(shotPoll):
			}
		}
	}()
	_, err = e.R.Run(bctx, e.Out, browser, "--headless", "--no-first-run", "--hide-scrollbars",
		"--user-data-dir="+profile, "--window-size=1280,1600", "--blink-settings=preferredColorScheme="+scheme,
		"--screenshot="+shot, url)
	if bctx.Err() != nil && ctx.Err() == nil {
		err = nil // 截图已写完，是这里结束的浏览器
	}
	if err != nil {
		why, err := failed(ctx, "截图（"+name+"）", err)
		return "", why, err
	}
	blank, err := blankFile(shot)
	if errors.Is(err, fs.ErrNotExist) {
		return "", fmt.Sprintf("浏览器没有写出截图（%s）", name), nil
	}
	if err != nil {
		return "", "", err
	}
	if blank {
		return "", fmt.Sprintf("文章页截图（%s）是空白：页面没渲染出来", name), nil
	}
	return shot, "", nil
}

// blankFile 解码一张图并判是不是空白。
func blankFile(p string) (bool, error) {
	f, err := os.Open(p)
	if err != nil {
		return false, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return false, fmt.Errorf("解码 %s：%w", p, err)
	}
	return Blank(img), nil
}
