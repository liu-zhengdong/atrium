package gates

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestJudgeBuild(t *testing.T) {
	tests := []struct {
		name       string
		output     string
		err        error
		wantOK     bool
		wantSubstr string
	}{
		{
			name:       "构建成功",
			output:     "build complete",
			err:        nil,
			wantOK:     true,
			wantSubstr: "构建通过",
		},
		{
			name:       "构建命令失败",
			output:     "",
			err:        errors.New("exit status 1"),
			wantOK:     false,
			wantSubstr: "构建失败",
		},
		{
			name:       "构建命令带标准错误",
			output:     "",
			err:        &CmdError{Cmd: "pnpm build", Stderr: "SyntaxError: Unexpected token"},
			wantOK:     false,
			wantSubstr: "SyntaxError: Unexpected token",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := JudgeBuild(tt.output, tt.err)
			if res.OK != tt.wantOK {
				t.Errorf("JudgeBuild() OK = %v, want %v", res.OK, tt.wantOK)
			}
			if !strings.Contains(res.Evidence, tt.wantSubstr) {
				t.Errorf("JudgeBuild() Evidence = %q, want contains %q", res.Evidence, tt.wantSubstr)
			}
		})
	}
}

func TestFindPreviewDir(t *testing.T) {
	tmp := t.TempDir()

	// 1. 无产物目录且无 html
	if dir := FindPreviewDir(tmp); dir != "" {
		t.Errorf("空目录应返回空，得到 %q", dir)
	}

	// 2. 根目录有 index.html
	indexFile := filepath.Join(tmp, "index.html")
	if err := os.WriteFile(indexFile, []byte("<h1>Hi</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if dir := FindPreviewDir(tmp); dir != tmp {
		t.Errorf("根目录有 index.html 应返回根目录，得到 %q", dir)
	}

	// 3. 有 dist 目录且含 html
	distDir := filepath.Join(tmp, "dist")
	if err := os.MkdirAll(distDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(distDir, "index.html"), []byte("<h1>Dist</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if dir := FindPreviewDir(tmp); dir != distDir {
		t.Errorf("有 dist 应优先返回 dist，得到 %q", dir)
	}
}

func TestFindArticlePage(t *testing.T) {
	tmp := t.TempDir()

	// 只有 index.html
	if err := os.WriteFile(filepath.Join(tmp, "index.html"), []byte("<h1>Home</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if p := FindArticlePage(tmp); p != "/" {
		t.Errorf("只有 index.html 应返回 /，得到 %q", p)
	}

	// 有文章页面
	postsDir := filepath.Join(tmp, "posts")
	if err := os.MkdirAll(postsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(postsDir, "hello.html"), []byte("<h1>Hello</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}

	page := FindArticlePage(tmp)
	if page != "/posts/hello.html" && page != "/posts/hello" {
		t.Errorf("有文章应返回 /posts/hello.html，得到 %q", page)
	}
}

func TestServePreview(t *testing.T) {
	tmp := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmp, "index.html"), []byte("home page"), 0o600); err != nil {
		t.Fatal(err)
	}
	postsDir := filepath.Join(tmp, "posts")
	if err := os.MkdirAll(postsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(postsDir, "post.html"), []byte("post content"), 0o600); err != nil {
		t.Fatal(err)
	}

	baseURL, closeSrv, err := ServePreview(tmp)
	if err != nil {
		t.Fatalf("ServePreview 启动失败：%v", err)
	}
	defer closeSrv()

	// 访问首页
	resp, err := http.Get(baseURL + "/")
	if err != nil {
		t.Fatalf("GET / 失败：%v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "home page" {
		t.Errorf("首页内容不对：收到 %q", string(body))
	}

	// 访问无扩展名的 clean URL /posts/post
	respClean, err := http.Get(baseURL + "/posts/post")
	if err != nil {
		t.Fatalf("GET /posts/post 失败：%v", err)
	}
	bodyClean, _ := io.ReadAll(respClean.Body)
	respClean.Body.Close()
	if string(bodyClean) != "post content" {
		t.Errorf("Clean URL 内容不对：收到 %q", string(bodyClean))
	}
}

func TestJudgeArticleScreenshots(t *testing.T) {
	tmp := t.TempDir()
	light := filepath.Join(tmp, "light.png")
	dark := filepath.Join(tmp, "dark.png")

	// 文件不存在
	res := JudgeArticleScreenshots(light, dark)
	if res.OK {
		t.Errorf("文件不存在应判定不过")
	}

	// 文件大小为 0
	if err := os.WriteFile(light, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dark, []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	res = JudgeArticleScreenshots(light, dark)
	if res.OK {
		t.Errorf("文件大小为 0 应判定不过")
	}

	// 两张都有数据
	if err := os.WriteFile(light, []byte("light data"), 0o600); err != nil {
		t.Fatal(err)
	}
	res = JudgeArticleScreenshots(light, dark)
	if !res.OK {
		t.Errorf("两张都有数据应通过，得到 %q", res.Evidence)
	}
	if len(res.Artifacts) != 2 {
		t.Errorf("产物应有 2 个，得到 %d 个", len(res.Artifacts))
	}
}
