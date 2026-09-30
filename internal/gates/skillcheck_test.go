package gates_test

import (
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
)

// frames 是假的 ffprobe/ffmpeg：第一帧按 blank 造纯黑或有内容的图，不拉起进程。
type frames struct{ blank bool }

func (f frames) Run(ctx context.Context, dir, name string, args ...string) (string, error) {
	if name == "ffprobe" {
		return `{"streams":[{"codec_type":"video","width":320,"height":240}],"format":{"duration":"2"}}`, nil
	}
	img := image.NewGray(image.Rect(0, 0, 8, 8))
	if !f.blank {
		for i := 0; i < 8; i++ {
			img.Set(i, i, color.White)
		}
	}
	w, err := os.Create(args[len(args)-1])
	if err != nil {
		return "", err
	}
	defer w.Close()
	return "", png.Encode(w, img)
}

// 挂了声明 checks 的技能：交付检查跑检查，过了把结论与产物路径记进经历；没过交回执行者；
// 执行者改不了的（工作目录在远程、技能里写了不认识的名字）转受阻。
func TestGateSkillChecks(t *testing.T) {
	e := setup(t)
	e.g.Data = t.TempDir()
	checks := []string{"video"}
	if _, err := org.SaveSkill(e.ctx, e.db, e.g.Data, org.SkillInput{Name: "video", Checks: &checks,
		Files: map[string][]byte{"SKILL.md": []byte("做视频")}}, "u1"); err != nil {
		t.Fatal(err)
	}
	if _, err := org.SaveSkill(e.ctx, e.db, e.g.Data, org.SkillInput{Name: "old", Checks: &[]string{"pr_exists"},
		Files: map[string][]byte{"SKILL.md": []byte("x")}}, "u1"); err == nil || !strings.Contains(err.Error(), "--checks") {
		t.Fatalf("技能保存时就该拒绝不认识的检查名：%v", err)
	}
	// 旧数据里的名字（保存校验之前写进去的）照样要看得见
	if _, err := e.db.ExecContext(e.ctx, `INSERT INTO skills (name, rev, summary, files, workers, checks, secrets, created_by, created_at)
		SELECT 'old', 1, summary, files, '', 'pr_exists', '', 'u1', 0 FROM skills WHERE name = 'video'`); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(e.g.Data, "skills", "old", "r1"), 0o700); err != nil {
		t.Fatal(err)
	}
	dept := e.dept(org.AcceptAuto)
	add := func(skill, host string) ledger.Task {
		place := t.TempDir()
		os.MkdirAll(filepath.Join(place, "out"), 0o700)
		os.WriteFile(filepath.Join(place, "out", "demo.mp4"), []byte("mp4"), 0o600)
		task, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "做视频", Org: dept, Dir: place, Skill: skill}, "u1")
		if err != nil {
			t.Fatal(err)
		}
		e.start(task.ID, "claude+opus")
		ledger.Record(e.ctx, e.db, task.ID, gates.KindWorktree, "dispatch", `{"host":"`+host+`","dir":"`+filepath.ToSlash(place)+`"}`)
		return e.exit(task.ID)
	}

	e.g.R = frames{}
	ok := add("video", "h1")
	e.sweep()
	out := filepath.Join(e.g.Data, "tasks", ok.ID)
	if got := e.state(ok.ID); got != "done/gate" || !strings.Contains(e.lastNote(ok.ID), "技能检查通过：video") {
		t.Fatalf("检查过了应应用：%s %s", got, e.lastNote(ok.ID))
	}
	h, _ := ledger.History(e.ctx, e.db, ok.ID, 50)
	var got []string
	for _, ev := range h {
		if ev.Kind == gates.KindSkillCheck || ev.Kind == gates.KindArtifact {
			got = append(got, ev.Kind+" "+ev.Body)
		}
	}
	want := []string{"skill_check video 通过：out/demo.mp4：时长 2.0 秒，320x240，没有音轨",
		"artifact " + filepath.Join(out, "video-first-frame.png"), "artifact " + filepath.Join(out, "video-contact-sheet.png")}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("经历里要有结论与逐条产物路径：%q", got)
	}

	e.g.R = frames{blank: true}
	bad := add("video", "h1")
	e.sweep()
	if e.state(bad.ID) != "queued/" || !strings.Contains(e.lastNote(bad.ID), "video：out/demo.mp4 的第一帧是空白") {
		t.Fatalf("第一帧空白应交回执行者：%s %s", e.state(bad.ID), e.lastNote(bad.ID))
	}

	for _, c := range []struct{ skill, host, why string }{
		{"video", "h2", "暂只支持本机"},
		{"old", "h1", "不认识的检查"},
	} {
		task := add(c.skill, c.host)
		e.sweep()
		if got := e.get(task.ID); got.Status != ledger.Blocked || !strings.Contains(e.lastNote(task.ID), c.why) {
			t.Fatalf("%s 应转受阻：%s %s", c.why, got.Status, e.lastNote(task.ID))
		}
	}
}

// 超时要连子进程一起结束：子进程占着输出管道时只结束父进程，Run 会一直等下去，检查的时限就形同虚设。
func TestExecTimeoutKillsTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("用 sh 造子进程")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := gates.NewExec().Run(ctx, t.TempDir(), "sh", "-c", "sleep 30 & sleep 30")
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 5*time.Second {
		t.Fatalf("应在时限后连子进程结束并返回超时：%v，用了 %s", err, time.Since(start))
	}
}
