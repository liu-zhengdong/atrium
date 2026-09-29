package gates

import (
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/platform"
)

// JudgeBuild 纯判定：根据构建输出与错误返回 CheckResult。
func JudgeBuild(output string, err error) CheckResult {
	if err != nil {
		msg := err.Error()
		if ce, ok := err.(*CmdError); ok && strings.TrimSpace(ce.Stderr) != "" {
			msg = strings.TrimSpace(ce.Stderr)
		}
		if len(msg) > 400 {
			msg = msg[:400] + "…"
		}
		return CheckResult{
			OK:       false,
			Evidence: fmt.Sprintf("pnpm 构建失败：%s", msg),
		}
	}
	return CheckResult{
		OK:       true,
		Evidence: "pnpm 构建通过",
	}
}

// FindPreviewDir 寻找构建产物目录（dist、out、build、.vitepress/dist、_site、public）或包含 html 的根目录。
func FindPreviewDir(workDir string) string {
	candidates := []string{
		"dist",
		"out",
		"build",
		filepath.Join(".vitepress", "dist"),
		"_site",
		"public",
	}
	for _, cand := range candidates {
		d := filepath.Join(workDir, cand)
		if fi, err := os.Stat(d); err == nil && fi.IsDir() {
			if hasHTML(d) {
				return d
			}
		}
	}
	if hasHTML(workDir) {
		return workDir
	}
	return ""
}

func hasHTML(dir string) bool {
	found := false
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == "node_modules" || d.Name() == ".git") {
			return filepath.SkipDir
		}
		if !d.IsDir() && strings.HasSuffix(strings.ToLower(d.Name()), ".html") {
			found = true
			return fs.SkipAll
		}
		return nil
	})
	return found
}

// FindArticlePage 在预览目录中寻找文章页面相对路径（如 /posts/hello.html 或 /）。
func FindArticlePage(previewDir string) string {
	var firstNonIndex string
	var hasIndex bool

	_ = filepath.WalkDir(previewDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == "node_modules" || d.Name() == ".git") {
			return filepath.SkipDir
		}
		if d.IsDir() {
			return nil
		}
		name := strings.ToLower(d.Name())
		if !strings.HasSuffix(name, ".html") {
			return nil
		}
		rel, err := filepath.Rel(previewDir, path)
		if err != nil {
			return nil
		}
		urlPath := "/" + filepath.ToSlash(rel)
		if name == "index.html" && (urlPath == "/index.html" || urlPath == "/") {
			hasIndex = true
			return nil
		}
		if name == "404.html" {
			return nil
		}
		if firstNonIndex == "" {
			firstNonIndex = urlPath
		}
		// 优先选择包含 post、article、blog 的页面
		lower := strings.ToLower(urlPath)
		if strings.Contains(lower, "post") || strings.Contains(lower, "article") || strings.Contains(lower, "blog") {
			firstNonIndex = urlPath
			return fs.SkipAll
		}
		return nil
	})

	if firstNonIndex != "" {
		return firstNonIndex
	}
	if hasIndex {
		return "/"
	}
	return "/"
}

// ServePreview 启动本地 HTTP 静态预览服务，支持无扩展名 Clean URLs。
func ServePreview(dir string) (baseURL string, shutdown func() error, err error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, fmt.Errorf("启动本地预览端口失败：%w", err)
	}

	port := listener.Addr().(*net.TCPAddr).Port
	fileServer := http.FileServer(http.Dir(dir))

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqPath := filepath.Clean(r.URL.Path)
		target := filepath.Join(dir, filepath.FromSlash(reqPath))
		fi, statErr := os.Stat(target)
		if statErr == nil && !fi.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		// 尝试补齐 .html
		if statErr != nil {
			htmlTarget := target + ".html"
			if hfi, herr := os.Stat(htmlTarget); herr == nil && !hfi.IsDir() {
				r.URL.Path = reqPath + ".html"
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		fileServer.ServeHTTP(w, r)
	})

	server := &http.Server{Handler: handler}
	go func() {
		_ = server.Serve(listener)
	}()

	return fmt.Sprintf("http://127.0.0.1:%d", port), server.Close, nil
}

// FindBrowser 查找 Chrome / Chromium 可执行文件路径。
func FindBrowser(env map[string]string) (string, error) {
	for _, key := range []string{"BROWSER", "CHROME_BIN", "CHROME_PATH"} {
		if val := env[key]; val != "" {
			if fi, err := os.Stat(val); err == nil && !fi.IsDir() {
				return val, nil
			}
		}
	}

	names := []string{"google-chrome", "chromium", "chrome", "chromium-browser", "google-chrome-stable"}
	for _, name := range names {
		if path, err := platform.LookPath(name, env); err == nil {
			return path, nil
		}
	}

	var candidates []string
	switch runtime.GOOS {
	case "darwin":
		candidates = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates, filepath.Join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
		}
	case "windows":
		candidates = []string{
			`C:\Program Files\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
			`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
			`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
		}
	case "linux":
		candidates = []string{
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
		}
	}

	for _, cand := range candidates {
		if fi, err := os.Stat(cand); err == nil && !fi.IsDir() {
			return cand, nil
		}
	}

	return "", fmt.Errorf("在 PATH 和常见路径未找到 Chrome/Chromium 无头浏览器")
}

// JudgeArticleScreenshots 纯判定：检查明暗两张截图是否存在且非空。
func JudgeArticleScreenshots(lightPath, darkPath string) CheckResult {
	for _, p := range []struct {
		name string
		path string
	}{{"明色", lightPath}, {"暗色", darkPath}} {
		fi, err := os.Stat(p.path)
		if err != nil {
			return CheckResult{
				OK:       false,
				Evidence: fmt.Sprintf("缺少%s截图 %s：%v", p.name, p.path, err),
			}
		}
		if fi.Size() == 0 {
			return CheckResult{
				OK:       false,
				Evidence: fmt.Sprintf("%s截图 %s 文件大小为 0", p.name, p.path),
			}
		}
	}
	return CheckResult{
		OK:        true,
		Evidence:  fmt.Sprintf("文章页截图已生成：%s（明）、%s（暗）", lightPath, darkPath),
		Artifacts: []string{lightPath, darkPath},
	}
}

// checkSiteBuild 检查站点仓库 pnpm build 是否能通过。
func checkSiteBuild(c CheckContext) (CheckResult, error) {
	pkgPath := filepath.Join(c.WorkDir, "package.json")
	if _, err := os.Stat(pkgPath); os.IsNotExist(err) {
		return CheckResult{Check: "site_build", OK: false, Evidence: "工作目录缺少 package.json"}, nil
	}

	out, err := c.Runner.Run(c.Context, c.WorkDir, "pnpm", "build")
	res := JudgeBuild(out, err)
	res.Check = "site_build"
	return res, nil
}

// checkArticleScreenshot 运行时自己起本地预览，用无头浏览器截出文章页（明暗各一张）。
func checkArticleScreenshot(c CheckContext) (CheckResult, error) {
	previewDir := FindPreviewDir(c.WorkDir)
	if previewDir == "" {
		return CheckResult{Check: "article_screenshot", OK: false, Evidence: "找不到站点构建产物目录（dist/、out/、build/）"}, nil
	}

	env := platform.EnvMap(os.Environ())
	browser, err := FindBrowser(env)
	if err != nil {
		return CheckResult{Check: "article_screenshot", OK: false, Evidence: err.Error()}, nil
	}

	baseURL, shutdown, err := ServePreview(previewDir)
	if err != nil {
		return CheckResult{Check: "article_screenshot", OK: false, Evidence: err.Error()}, nil
	}
	defer shutdown()

	articlePath := FindArticlePage(previewDir)
	targetURL := baseURL + articlePath

	lightPath := filepath.Join(c.TaskDir, "article-light.png")
	darkPath := filepath.Join(c.TaskDir, "article-dark.png")

	// 截取明色模式
	if _, err := c.Runner.Run(c.Context, c.WorkDir, browser,
		"--headless=new",
		"--screenshot="+lightPath,
		"--window-size=1280,800",
		"--hide-scrollbars",
		targetURL,
	); err != nil {
		return CheckResult{Check: "article_screenshot", OK: false, Evidence: fmt.Sprintf("截图明色模式失败：%v", err)}, nil
	}

	// 截取暗色模式
	if _, err := c.Runner.Run(c.Context, c.WorkDir, browser,
		"--headless=new",
		"--screenshot="+darkPath,
		"--window-size=1280,800",
		"--hide-scrollbars",
		"--force-dark-mode",
		"--enable-features=WebContentsForceDark",
		targetURL,
	); err != nil {
		return CheckResult{Check: "article_screenshot", OK: false, Evidence: fmt.Sprintf("截图暗色模式失败：%v", err)}, nil
	}

	res := JudgeArticleScreenshots(lightPath, darkPath)
	res.Check = "article_screenshot"
	return res, nil
}

// checkArticle 复合检查：构建通过并生成明暗截图。
func checkArticle(c CheckContext) (CheckResult, error) {
	buildRes, err := checkSiteBuild(c)
	if err != nil {
		return CheckResult{Check: "article"}, err
	}
	if !buildRes.OK {
		return CheckResult{Check: "article", OK: false, Evidence: buildRes.Evidence}, nil
	}

	shotRes, err := checkArticleScreenshot(c)
	if err != nil {
		return CheckResult{Check: "article"}, err
	}
	if !shotRes.OK {
		return CheckResult{Check: "article", OK: false, Evidence: shotRes.Evidence}, nil
	}

	return CheckResult{
		Check:     "article",
		OK:        true,
		Evidence:  fmt.Sprintf("构建通过；%s", shotRes.Evidence),
		Artifacts: shotRes.Artifacts,
	}, nil
}
