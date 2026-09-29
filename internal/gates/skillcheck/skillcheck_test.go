package skillcheck

import (
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPage(t *testing.T) {
	old, now := time.Unix(100, 0), time.Unix(200, 0)
	cases := []struct {
		name    string
		sources []Source
		pages   []string
		want    string
		why     string
	}{
		{"按文件名", []Source{{"posts/old.md", old}, {"posts/hello.md", now}}, []string{"index.html", "posts/old.html", "posts/hello.html"}, "posts/hello.html", ""},
		{"按目录名（topics/<slug>/post.md）", []Source{{"topics/talk/post.md", now}}, []string{"index.html", "talk/index.html"}, "talk/index.html", ""},
		{"index.md 按目录名", []Source{{"content/hello/index.md", now}}, []string{"index.html", "hello/index.html"}, "hello/index.html", ""},
		{"根目录页面", []Source{{"hello.md", now}}, []string{"index.html", "hello.html"}, "hello.html", ""},
		{"README 不算", []Source{{"posts/hello.md", old}, {"README.md", now}}, []string{"posts/hello.html"}, "posts/hello.html", ""},
		{"不按子串匹配", []Source{{"posts/log.md", now}}, []string{"blog.html"}, "", "找不到"},
		{"没有源文件", nil, []string{"index.html"}, "", "没有 Markdown"},
		{"最新的源文件没对应页面", []Source{{"posts/hello.md", old}, {"posts/new.md", now}}, []string{"posts/hello.html"}, "", "posts/new.md"},
	}
	for _, c := range cases {
		got, why := Page(c.sources, c.pages)
		if got != c.want || (c.why == "") != (why == "") || !strings.Contains(why, c.why) {
			t.Errorf("%s：得到 %q %q，要 %q 含 %q", c.name, got, why, c.want, c.why)
		}
	}
}

type file struct {
	name string
	mod  int64
	dir  bool
}

func (f file) Name() string       { return f.name }
func (f file) Size() int64        { return 1 }
func (f file) Mode() fs.FileMode  { return 0 }
func (f file) ModTime() time.Time { return time.Unix(f.mod, 0) }
func (f file) IsDir() bool        { return f.dir }
func (f file) Sys() any           { return nil }

func TestNewest(t *testing.T) {
	cases := []struct {
		files []fs.FileInfo
		want  string
	}{
		{[]fs.FileInfo{file{"a.mp4", 1, false}, file{"b.MOV", 3, false}, file{"c.webm", 2, false}}, "b.MOV"},
		{[]fs.FileInfo{file{"a.mp4", 1, false}, file{"poster.png", 9, false}, file{"x.mp4", 9, true}}, "a.mp4"},
		{[]fs.FileInfo{file{"notes.txt", 1, false}}, ""},
		{nil, ""},
	}
	for _, c := range cases {
		if got := Newest(c.files); got != c.want {
			t.Errorf("Newest(%v) = %q，要 %q", c.files, got, c.want)
		}
	}
}

func TestParseProbe(t *testing.T) {
	cases := []struct {
		out  string
		want Meta
		err  string
	}{
		{`{"streams":[{"codec_type":"video","width":1920,"height":1080},{"codec_type":"audio"}],"format":{"duration":"12.5"}}`, Meta{1920, 1080, 12.5, true}, ""},
		{`{"streams":[{"codec_type":"video","width":320,"height":240}],"format":{"duration":"2.000000"}}`, Meta{320, 240, 2, false}, ""},
		{`{"streams":[{"codec_type":"audio"}],"format":{"duration":"2"}}`, Meta{}, "没有视频流"},
		{`{"streams":[{"codec_type":"video","width":320,"height":240}],"format":{"duration":"N/A"}}`, Meta{}, "读不出时长"},
		{`not json`, Meta{}, "不是 JSON"},
	}
	for _, c := range cases {
		got, err := ParseProbe(c.out)
		if c.err != "" {
			if err == nil || !strings.Contains(err.Error(), c.err) {
				t.Errorf("ParseProbe(%s) 错误 %v，要含 %q", c.out, err, c.err)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("ParseProbe(%s) = %+v %v，要 %+v", c.out, got, err, c.want)
		}
	}
}

func TestParseLoudness(t *testing.T) {
	frames := "frame:0 pts:0\nlavfi.r128.M=-70\nlavfi.r128.I=-70.0\nlavfi.r128.LRA=0.000\nframe:1 pts:1024\nlavfi.r128.I=-21.082\nlavfi.r128.LRA=1.500\nlavfi.r128.LRA.low=0.000\n"
	i, lra, err := ParseLoudness(frames)
	if err != nil || i != -21.082 || lra != 1.5 {
		t.Errorf("取最后一帧：得到 %v %v %v", i, lra, err)
	}
	for _, bad := range []string{"", "lavfi.r128.I=-20\n", "lavfi.r128.I=x\nlavfi.r128.LRA=1\n"} {
		if _, _, err := ParseLoudness(bad); err == nil {
			t.Errorf("ParseLoudness(%q) 应报错", bad)
		}
	}
}

func solid(c color.Color) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, 40, 30))
	for y := 0; y < 30; y++ {
		for x := 0; x < 40; x++ {
			img.Set(x, y, c)
		}
	}
	return img
}

func textish() image.Image {
	img := solid(color.White).(*image.RGBA)
	for x := 5; x < 35; x++ {
		img.Set(x, 10, color.Black)
		img.Set(x, 11, color.Black)
	}
	return img
}

func TestBlank(t *testing.T) {
	noisy := solid(color.Black).(*image.RGBA)
	noisy.Set(3, 3, color.Gray{Y: 3}) // 编码噪声
	cases := []struct {
		name string
		img  image.Image
		want bool
	}{
		{"全黑", solid(color.Black), true},
		{"全白", solid(color.White), true},
		{"纯色", solid(color.RGBA{30, 120, 200, 255}), true},
		{"带噪声的黑", noisy, true},
		{"空图", image.NewRGBA(image.Rect(0, 0, 0, 0)), true},
		{"白底黑字", textish(), false},
	}
	for _, c := range cases {
		if got := Blank(c.img); got != c.want {
			t.Errorf("%s：Blank = %v，要 %v", c.name, got, c.want)
		}
	}
}

func TestValidateAndResult(t *testing.T) {
	for _, n := range []string{"article", "video"} {
		if err := Validate(n); err != nil {
			t.Errorf("Validate(%q) = %v", n, err)
		}
	}
	if err := Validate("pr_exists"); err == nil || !strings.Contains(err.Error(), "article、video") {
		t.Errorf("Validate(pr_exists) 应报不认识并列出可用：%v", err)
	}
	r := Result{Check: "video", OK: true, Evidence: "out/a.mp4：时长 2.0 秒", Artifacts: []string{"/d/a.png", "/d/b.png"}}
	if got := r.String(); got != "video 通过：out/a.mp4：时长 2.0 秒" {
		t.Errorf("String = %q", got)
	}
}

// fake 是假的 Runner：按命令名造产物或返回预设的输出与错误，不拉起任何进程。
type fake struct {
	build    error       // pnpm run build 的错误
	frame    image.Image // ffmpeg 导出的第一帧
	loudness error       // ebur128 的错误
	hang     bool        // pnpm 一直不返回，直到超时
	linger   bool        // 浏览器写完截图不退出（完整版 Chrome 的无头模式）
	noShot   bool        // 浏览器不写截图也不退出
	calls    []string
}

func writePNG(p string, img image.Image) error {
	f, err := os.Create(p)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

func (f *fake) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	last := args[len(args)-1]
	switch {
	case name == "pnpm" && f.hang:
		<-ctx.Done()
		return "", ctx.Err()
	case name == "pnpm":
		if f.build != nil {
			return "", f.build
		}
		if err := os.MkdirAll(filepath.Join(dir, "dist", "posts"), 0o700); err != nil {
			return "", err
		}
		return "", os.WriteFile(filepath.Join(dir, "dist", "posts", "hello.html"), []byte("<h1>你好</h1>"), 0o600)
	case name == "chrome":
		for _, a := range args {
			if p, ok := strings.CutPrefix(a, "--screenshot="); ok && !f.noShot {
				if err := writePNG(p, textish()); err != nil || !f.linger {
					return "", err
				}
			}
		}
		if f.linger || f.noShot {
			<-ctx.Done()
			return "", ctx.Err()
		}
	case name == "ffprobe":
		return `{"streams":[{"codec_type":"video","width":1920,"height":1080},{"codec_type":"audio"}],"format":{"duration":"10"}}`, nil
	case name == "ffmpeg" && strings.Contains(strings.Join(args, " "), "ebur128"):
		if f.loudness != nil {
			return "", f.loudness
		}
		return "", os.WriteFile(filepath.Join(dir, "loudness.txt"), []byte("lavfi.r128.I=-18.5\nlavfi.r128.LRA=6.0\n"), 0o600)
	case name == "ffmpeg":
		img := f.frame
		if strings.Contains(strings.Join(args, " "), "tile=") || img == nil {
			img = textish()
		}
		return "", writePNG(last, img)
	}
	return "", nil
}

func browser() (string, error) { return "chrome", nil }

func site(t *testing.T) string {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "posts"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "posts", "hello.md"), []byte("# 你好"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func exitErr() error {
	return fmt.Errorf("pnpm run build：%w：构建编译出错", &exec.ExitError{})
}

func TestArticle(t *testing.T) {
	cases := []struct {
		name string
		f    *fake
		ok   bool
		why  string
		err  string
	}{
		{"通过", &fake{}, true, "posts/hello.html", ""},
		{"构建失败交回", &fake{build: exitErr()}, false, "构建编译出错", ""},
		{"缺 pnpm 是跑不起来", &fake{build: errors.New("在 PATH 里找不到 pnpm")}, false, "", "找不到 pnpm"},
		{"超时交回", &fake{hang: true}, false, "超时", ""},
		{"浏览器写完截图不退出也算通过", &fake{linger: true}, true, "posts/hello.html", ""},
		{"浏览器不写截图就超时交回", &fake{noShot: true}, false, "截图（light）超时", ""},
	}
	defer func(d time.Duration) { Timeout = d }(Timeout)
	Timeout = time.Second
	for _, c := range cases {
		out := t.TempDir()
		rs, err := Run(context.Background(), Env{Dir: site(t), Out: out, R: c.f, Browser: browser}, []string{"article"})
		if c.err != "" {
			if err == nil || !strings.Contains(err.Error(), c.err) {
				t.Errorf("%s：错误 %v，要含 %q", c.name, err, c.err)
			}
			continue
		}
		if err != nil || len(rs) != 1 {
			t.Fatalf("%s：%v %v", c.name, rs, err)
		}
		r := rs[0]
		if r.OK != c.ok || !strings.Contains(r.Evidence, c.why) {
			t.Errorf("%s：得到 %+v，要 ok=%v 含 %q", c.name, r, c.ok, c.why)
		}
		if c.ok {
			want := []string{filepath.Join(out, "article-light.png"), filepath.Join(out, "article-dark.png")}
			if strings.Join(r.Artifacts, ",") != strings.Join(want, ",") {
				t.Errorf("产物 %v，要 %v", r.Artifacts, want)
			}
			calls := strings.Join(c.f.calls, "\n")
			for _, s := range []string{"preferredColorScheme=1", "preferredColorScheme=0", "/posts/hello.html", "--user-data-dir="} {
				if !strings.Contains(calls, s) {
					t.Errorf("浏览器调用缺 %q：%s", s, calls)
				}
			}
		}
	}
}

func TestVideo(t *testing.T) {
	cases := []struct {
		name  string
		f     *fake
		files []string
		ok    bool
		why   string
		arts  []string
	}{
		{"通过", &fake{}, []string{"out/demo.mp4"}, true, "1920x1080，响度 -18.5 LUFS（LRA 6.0 LU）", []string{"video-first-frame.png", "video-contact-sheet.png"}},
		{"第一帧空白交回", &fake{frame: solid(color.Black)}, []string{"out/demo.mp4"}, false, "out/demo.mp4 的第一帧是空白", []string{"video-first-frame.png"}},
		{"响度读不出如实写、不挡", &fake{loudness: exitErr()}, []string{"out/demo.mp4"}, true, "响度读取失败：", []string{"video-first-frame.png", "video-contact-sheet.png"}},
		{"只有素材没有成片", &fake{}, []string{"public/clip.mp4"}, false, "out/ 里没有渲染出的成片", nil},
	}
	for _, c := range cases {
		dir, out := t.TempDir(), t.TempDir()
		for _, f := range c.files {
			p := filepath.Join(dir, filepath.FromSlash(f))
			if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(p, []byte("mp4"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		rs, err := Run(context.Background(), Env{Dir: dir, Out: out, R: c.f}, []string{"video"})
		if err != nil || len(rs) != 1 {
			t.Fatalf("%s：%v %v", c.name, rs, err)
		}
		r := rs[0]
		var arts []string
		for _, a := range r.Artifacts {
			arts = append(arts, strings.TrimPrefix(a, out+string(filepath.Separator)))
		}
		if r.OK != c.ok || !strings.Contains(r.Evidence, c.why) || strings.Join(arts, ",") != strings.Join(c.arts, ",") {
			t.Errorf("%s：得到 %+v，要 ok=%v 含 %q 产物 %v", c.name, r, c.ok, c.why, c.arts)
		}
	}
}

func TestRunUnknown(t *testing.T) {
	f := &fake{}
	_, err := Run(context.Background(), Env{Dir: t.TempDir(), Out: t.TempDir(), R: f}, []string{"video", "pr_exists"})
	if err == nil || !strings.Contains(err.Error(), "pr_exists") || len(f.calls) != 0 {
		t.Errorf("名字不认识应在跑任何一项之前报错：%v %v", err, f.calls)
	}
}
