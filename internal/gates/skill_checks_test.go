package gates_test

import (
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

type mockSkillRunner struct {
	t        *testing.T
	buildErr error
	firstImg image.Image // 第一帧图片
}

func (m *mockSkillRunner) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	cmdLine := name + " " + strings.Join(args, " ")
	switch {
	case name == "pnpm" && len(args) > 0 && args[0] == "build":
		if m.buildErr != nil {
			return "", m.buildErr
		}
		return "pnpm build success", nil

	case strings.Contains(cmdLine, "--screenshot="):
		// 模拟无头浏览器截图
		for _, arg := range args {
			if strings.HasPrefix(arg, "--screenshot=") {
				dest := strings.TrimPrefix(arg, "--screenshot=")
				if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
					return "", err
				}
				if err := os.WriteFile(dest, []byte("fake screenshot png data"), 0o600); err != nil {
					return "", err
				}
			}
		}
		return "", nil

	case name == "ffprobe" && slices.Contains(args, "a:0"):
		// 音频流探测
		return `{"streams":[{"index":1}]}`, nil

	case name == "ffprobe":
		// 视频流探测
		return `{
			"streams": [{"width": 1920, "height": 1080, "duration": "10.000000"}],
			"format": {"duration": "10.000000"}
		}`, nil

	case name == "ffmpeg" && slices.Contains(args, "ebur128"):
		return `
  Integrated loudness:
    I:         -18.5 LUFS
    Threshold: -28.5 LUFS
  Loudness range:
    LRA:         6.0 LU
`, nil

	case name == "ffmpeg" && slices.Contains(args, "-vframes"):
		// 导出第一帧
		dest := args[len(args)-1]
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return "", err
		}
		f, err := os.Create(dest)
		if err != nil {
			return "", err
		}
		defer f.Close()
		img := m.firstImg
		if img == nil {
			// 默认生成非空白图片
			mImg := image.NewRGBA(image.Rect(0, 0, 10, 10))
			for y := 0; y < 10; y++ {
				for x := 0; x < 10; x++ {
					if (x+y)%2 == 0 {
						mImg.Set(x, y, color.White)
					} else {
						mImg.Set(x, y, color.Black)
					}
				}
			}
			img = mImg
		}
		if err := png.Encode(f, img); err != nil {
			return "", err
		}
		return "", nil

	case name == "ffmpeg" && strings.Contains(cmdLine, "tile="):
		// 联系表生成
		dest := args[len(args)-1]
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return "", err
		}
		if err := os.WriteFile(dest, []byte("fake contact sheet"), 0o600); err != nil {
			return "", err
		}
		return "", nil
	}

	return "", nil
}

func TestSkillChecks_KnownList(t *testing.T) {
	known := gates.KnownSkillChecks()
	for _, expected := range []string{"article", "video", "site_build", "article_screenshot", "video_probe", "video_frames"} {
		if !slices.Contains(known, expected) {
			t.Errorf("KnownSkillChecks 应包含 %q，当前：%v", expected, known)
		}
	}
}

func TestSkillChecks_UnknownCheck(t *testing.T) {
	cctx := gates.CheckContext{
		Context: context.Background(),
		WorkDir: t.TempDir(),
		TaskDir: t.TempDir(),
	}
	_, allPassed, reasons, _, err := gates.RunSkillChecks(cctx, []string{"unknown_check_xyz"})
	if err != nil {
		t.Fatalf("RunSkillChecks error = %v", err)
	}
	if allPassed {
		t.Errorf("未知检查项应判定不过")
	}
	if len(reasons) == 0 || !strings.Contains(reasons[0], "未知技能检查项") {
		t.Errorf("未返回清晰的未知检查项错误：%v", reasons)
	}
}

func TestSkillChecks_Article(t *testing.T) {
	workDir := t.TempDir()
	taskDir := t.TempDir()

	// 准备站点工作目录
	if err := os.WriteFile(filepath.Join(workDir, "package.json"), []byte(`{"name":"test-site"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	distDir := filepath.Join(workDir, "dist")
	if err := os.MkdirAll(distDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(distDir, "index.html"), []byte("<h1>Article</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 1. 正常通过
	runner := &mockSkillRunner{t: t}
	cctx := gates.CheckContext{
		Context: context.Background(),
		WorkDir: workDir,
		TaskDir: taskDir,
		Runner:  runner,
	}

	res, err := gates.SkillCheckRegistry["article"](cctx)
	if err != nil {
		t.Fatalf("checkArticle error = %v", err)
	}
	if !res.OK {
		t.Fatalf("checkArticle 应通过，得到证据：%s", res.Evidence)
	}
	if len(res.Artifacts) != 2 {
		t.Errorf("产物应有 2 张截图，得到 %d 个", len(res.Artifacts))
	}

	// 2. 构建故意失败
	runnerFail := &mockSkillRunner{t: t, buildErr: fmt.Errorf("TypeScript compile error")}
	cctxFail := gates.CheckContext{
		Context: context.Background(),
		WorkDir: workDir,
		TaskDir: t.TempDir(),
		Runner:  runnerFail,
	}

	resFail, err := gates.SkillCheckRegistry["article"](cctxFail)
	if err != nil {
		t.Fatalf("checkArticle error = %v", err)
	}
	if resFail.OK {
		t.Errorf("构建失败时 checkArticle 应判定不过")
	}
	if !strings.Contains(resFail.Evidence, "构建失败") {
		t.Errorf("证据应包含构建失败信息：%s", resFail.Evidence)
	}
}

func TestSkillChecks_Video(t *testing.T) {
	workDir := t.TempDir()
	taskDir := t.TempDir()

	// 准备视频文件
	outDir := filepath.Join(workDir, "out")
	if err := os.MkdirAll(outDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outDir, "video.mp4"), []byte("video data"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 1. 正常通过
	runner := &mockSkillRunner{t: t}
	cctx := gates.CheckContext{
		Context: context.Background(),
		WorkDir: workDir,
		TaskDir: taskDir,
		Runner:  runner,
	}

	res, err := gates.SkillCheckRegistry["video"](cctx)
	if err != nil {
		t.Fatalf("checkVideo error = %v", err)
	}
	if !res.OK {
		t.Fatalf("checkVideo 应通过，得到证据：%s", res.Evidence)
	}
	if len(res.Artifacts) != 2 {
		t.Errorf("产物应有 2 个（第一帧和联系表），得到 %d 个", len(res.Artifacts))
	}

	// 2. 第一帧故意为空白（全黑）
	blankImg := image.NewRGBA(image.Rect(0, 0, 10, 10))
	for y := 0; y < 10; y++ {
		for x := 0; x < 10; x++ {
			blankImg.Set(x, y, color.Black)
		}
	}
	runnerBlank := &mockSkillRunner{t: t, firstImg: blankImg}
	cctxBlank := gates.CheckContext{
		Context: context.Background(),
		WorkDir: workDir,
		TaskDir: t.TempDir(),
		Runner:  runnerBlank,
	}

	resBlank, err := gates.SkillCheckRegistry["video"](cctxBlank)
	if err != nil {
		t.Fatalf("checkVideo error = %v", err)
	}
	if resBlank.OK {
		t.Errorf("第一帧为空白时 checkVideo 应判定不过")
	}
	if !strings.Contains(resBlank.Evidence, "第一帧为空白图片") {
		t.Errorf("证据应包含空白图片警告：%s", resBlank.Evidence)
	}
	if len(resBlank.Artifacts) == 0 {
		t.Errorf("即使判定不过也应记录第一帧产物路径供查验")
	}
}

func TestGate_SkillChecksIntegration(t *testing.T) {
	e := setup(t)
	dataDir := t.TempDir()
	e.g.Data = dataDir

	// 注册文章技能与视频技能
	checksArt := []string{"article"}
	_, err := org.SaveSkill(e.ctx, e.db, dataDir, org.SkillInput{
		Name:   "article-writer",
		Checks: &checksArt,
		Files:  map[string][]byte{"SKILL.md": []byte("# Article skill")},
	}, "u1")
	if err != nil {
		t.Fatal(err)
	}

	checksVid := []string{"video"}
	_, err = org.SaveSkill(e.ctx, e.db, dataDir, org.SkillInput{
		Name:   "video-maker",
		Checks: &checksVid,
		Files:  map[string][]byte{"SKILL.md": []byte("# Video skill")},
	}, "u1")
	if err != nil {
		t.Fatal(err)
	}

	// 1. 文章任务测试（通过）
	artPlace := t.TempDir()
	if err := os.WriteFile(filepath.Join(artPlace, "package.json"), []byte(`{"name":"test"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	dist := filepath.Join(artPlace, "dist")
	os.MkdirAll(dist, 0o700)
	os.WriteFile(filepath.Join(dist, "index.html"), []byte("<h1>OK</h1>"), 0o600)

	artTask, err := ledger.Add(e.ctx, e.db, ledger.NewTask{
		Title: "写一篇文章",
		Dir:   artPlace,
		Skill: "article-writer",
	}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	// 推进到 gate 阶段
	ledger.Apply(e.ctx, e.db, artTask.ID, ledger.Event{Kind: ledger.Enqueue}, "dispatch", "")
	ledger.Apply(e.ctx, e.db, artTask.ID, ledger.Event{Kind: ledger.Start}, "dispatch", "")
	ledger.Record(e.ctx, e.db, artTask.ID, gates.KindWorktree, "dispatch", fmt.Sprintf(`{"host":"h1","dir":%q}`, artPlace))
	ledger.Apply(e.ctx, e.db, artTask.ID, ledger.Event{Kind: ledger.ExitOK}, "dispatch", "")

	// 注入 mock 运行器
	e.g.R = &mockSkillRunner{t: t}

	if err := e.g.Sweep(e.ctx); err != nil {
		t.Fatalf("Sweep error = %v", err)
	}

	afterArt, err := ledger.Get(e.ctx, e.db, artTask.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterArt.Status != ledger.Done {
		t.Errorf("文章任务关卡通过后状态应为 done，得到 %s（stage=%s）", afterArt.Status, afterArt.Stage)
	}

	// 查验产物经历记录
	history, err := ledger.History(e.ctx, e.db, artTask.ID, 20)
	if err != nil {
		t.Fatal(err)
	}
	var artifactBodies []string
	for _, ev := range history {
		if ev.Kind == gates.KindArtifacts {
			artifactBodies = append(artifactBodies, ev.Body)
		}
	}
	if len(artifactBodies) < 2 {
		t.Errorf("经历中应有至少 2 条 artifacts 记录（明暗截图），得到 %d 条：%v", len(artifactBodies), artifactBodies)
	}

	// 2. 视频任务测试（第一帧故意空白 -> 关卡不过并交回）
	vidPlace := t.TempDir()
	os.MkdirAll(filepath.Join(vidPlace, "out"), 0o700)
	os.WriteFile(filepath.Join(vidPlace, "out", "demo.mp4"), []byte("mp4"), 0o600)

	vidTask, err := ledger.Add(e.ctx, e.db, ledger.NewTask{
		Title: "做一个视频",
		Dir:   vidPlace,
		Skill: "video-maker",
	}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	ledger.Apply(e.ctx, e.db, vidTask.ID, ledger.Event{Kind: ledger.Enqueue}, "dispatch", "")
	ledger.Apply(e.ctx, e.db, vidTask.ID, ledger.Event{Kind: ledger.Start}, "dispatch", "")
	ledger.Record(e.ctx, e.db, vidTask.ID, gates.KindWorktree, "dispatch", fmt.Sprintf(`{"host":"h1","dir":%q}`, vidPlace))
	ledger.Apply(e.ctx, e.db, vidTask.ID, ledger.Event{Kind: ledger.ExitOK}, "dispatch", "")

	// 模拟空白第一帧
	blackImg := image.NewRGBA(image.Rect(0, 0, 10, 10))
	for y := 0; y < 10; y++ {
		for x := 0; x < 10; x++ {
			blackImg.Set(x, y, color.Black)
		}
	}
	e.g.R = &mockSkillRunner{t: t, firstImg: blackImg}

	if err := e.g.Sweep(e.ctx); err != nil {
		t.Fatalf("Sweep error = %v", err)
	}

	afterVid, err := ledger.Get(e.ctx, e.db, vidTask.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 没过应被交回（queued）
	if afterVid.Status != ledger.Queued {
		t.Errorf("第一帧空白时视频任务应交回为 queued，得到 %s", afterVid.Status)
	}

	// 经历中应有 bounce 并且原因说明了第一帧空白
	historyVid, _ := ledger.History(e.ctx, e.db, vidTask.ID, 20)
	var foundBounce bool
	for _, ev := range historyVid {
		if ev.Kind == "bounce" && strings.Contains(ev.Body, "第一帧为空白图片") {
			foundBounce = true
			break
		}
	}
	if !foundBounce {
		t.Errorf("经历中缺少第一帧为空白图片的 bounce 记录")
	}
}
