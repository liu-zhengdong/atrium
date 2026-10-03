package gates

import (
	"reflect"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/org"
)

func goodFacts() Facts {
	return Facts{Branch: "t1-x", Base: "main", Head: "abc123", Ahead: 2, Pushed: true,
		PR:      &PR{Number: 7, URL: "https://github.com/o/r/pull/7", State: "OPEN", Head: "t1-x", HeadID: "abc123"},
		Numstat: []FileStat{{"a.go", 10, 2}}, Diff: "改动 1 个文件", E2E: "跑了 x，输出 y"}
}

func TestJudge(t *testing.T) {
	all := []string{CheckFinished, CheckPR, CheckGrowth, CheckClaims}
	cases := []struct {
		name   string
		checks []string
		edit   func(*Facts)
		fail   []string // 没过的交付检查
	}{
		{"全过", all, func(*Facts) {}, nil},
		{"没写 checks 什么都不查", nil, func(f *Facts) { f.PR = nil }, nil},
		{"有未提交文件", all, func(f *Facts) { f.Dirty = []string{"x.go"} }, []string{CheckFinished}},
		{"没有新提交", all, func(f *Facts) { f.Ahead = 0 }, []string{CheckFinished}},
		{"没推送", all, func(f *Facts) { f.Pushed = false }, []string{CheckFinished}},
		{"没有 PR", all, func(f *Facts) { f.PR = nil }, []string{CheckPR}},
		{"PR 已关", all, func(f *Facts) { f.PR.State = "CLOSED" }, []string{CheckPR}},
		{"PR 属于别的分支", all, func(f *Facts) { f.PR.Head = "other" }, []string{CheckPR}},
		{"PR 头提交落后本地", all, func(f *Facts) { f.PR.HeadID = "old" }, []string{CheckPR}},
		{"单文件新增超限", all, func(f *Facts) { f.Numstat = append(f.Numstat, FileStat{"big.go", MaxFileAdded + 1, 0}) }, []string{CheckGrowth}},
		{"刚好到上限不算超", all, func(f *Facts) { f.Numstat = []FileStat{{"big.go", MaxFileAdded, 0}} }, nil},
		{"没有端到端验证", all, func(f *Facts) { f.E2E = "  " }, []string{CheckClaims}},
		{"未知交付检查判不过", []string{"screenshot"}, func(*Facts) {}, []string{"screenshot"}},
	}
	for _, c := range cases {
		f := goodFacts()
		c.edit(&f)
		v := Judge(c.checks, f)
		var failed []string
		for _, r := range v.Results {
			if !r.OK {
				failed = append(failed, r.Check)
			}
		}
		if !reflect.DeepEqual(failed, c.fail) || v.Pass != (len(c.fail) == 0) || len(v.Reasons) != len(c.fail) {
			t.Errorf("%s：没过 %v（pass=%v，reasons=%v），期望 %v", c.name, failed, v.Pass, v.Reasons, c.fail)
		}
	}
}

func TestSection(t *testing.T) {
	body := "## 做了什么\n改了 x\n\n## 端到端验证\n\n```\n$ atrium task ls\nok\n```\n### 细节\n还在节里\n## 碰到哪些已有能力\n无\n"
	got := Section(body, "端到端验证")
	if !strings.Contains(got, "atrium task ls") || !strings.Contains(got, "还在节里") || strings.Contains(got, "已有能力") {
		t.Fatalf("取节不对：%q", got)
	}
	if Section("## 端到端验证\n## 下一节\n内容", "端到端验证") != "" {
		t.Fatal("空节应为空")
	}
	if Section("没有标题", "端到端验证") != "" {
		t.Fatal("没有这一节应为空")
	}
}

func TestNumstat(t *testing.T) {
	got := ParseNumstat("3\t1\ta.go\n-\t-\tlogo.png\n\nbad line\n")
	want := []FileStat{{"a.go", 3, 1}, {"logo.png", 0, 0}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%v", got)
	}
	if s := DiffText(got); !strings.HasPrefix(s, "改动 2 个文件，+3 −1：a.go") {
		t.Fatal(s)
	}
}

func TestNeedReview(t *testing.T) {
	cases := []struct {
		risk, trust string
		need        bool
	}{
		{"low", "medium", false},
		{"low", "high", false},
		{"high", "high", true},
		{"low", "low", true},
		{"low", "", true},
		{"medium", "unknown", true},
	}
	for _, c := range cases {
		if got, why := NeedReview(c.risk, c.trust); got != c.need || (got && why == "") {
			t.Errorf("risk=%s trust=%s：%v %q", c.risk, c.trust, got, why)
		}
	}
}

func TestRefusal(t *testing.T) {
	req := Requirement{NotTool: "claude", NotModel: "opus", MinTrust: "medium", NotWorkers: []string{"claude+opus", "agy"}}
	cases := []struct {
		p  Profile
		ok bool
	}{
		{Profile{Name: "codex", Tool: "codex", Model: "gpt", Trust: "medium"}, true},
		{Profile{Name: "agy", Tool: "agy", Model: "gemini", Trust: "high"}, false}, // 拉起过被审任务：回避
		{Profile{Name: "codex", Tool: "codex", Model: "gpt", Trust: "high"}, true},
		{Profile{Name: "c2", Tool: "claude", Model: "sonnet", Trust: "high"}, false},
		{Profile{Name: "oc", Tool: "opencode", Model: "opus", Trust: "high"}, false},
		{Profile{Name: "kimi", Tool: "kimi", Model: "k2", Trust: "low"}, false},
		{Profile{Name: "kimi", Tool: "kimi", Model: "k2"}, false},
	}
	for _, c := range cases {
		if why := req.Refusal(c.p); (why == "") != c.ok {
			t.Errorf("%+v：%q", c.p, why)
		}
	}
}

func TestParseReview(t *testing.T) {
	cases := []struct {
		text  string
		pass  bool
		notes string
		ok    bool
	}{
		{"看过了\n审阅结论：通过\n", true, "看过了", true},
		{"1. a.go:3 空指针\n\n审阅结论: **打回**", false, "1. a.go:3 空指针", true},
		{"审阅结论：通过\n后来又说了别的", false, "", false},
		{"", false, "", false},
		{"审阅结论：再看看", false, "", false},
	}
	for _, c := range cases {
		pass, notes, ok := ParseReview(c.text)
		if pass != c.pass || notes != c.notes || ok != c.ok {
			t.Errorf("%q：%v %q %v", c.text, pass, notes, ok)
		}
	}
}

func TestParseEnding(t *testing.T) {
	cases := []struct {
		text string
		done bool
		why  string
		ok   bool
	}{
		{"调研结论……\n交付结论：完成\n", true, "调研结论……", true},
		{"h3 上读不到设计稿，没改代码\n\n**交付结论：没做成**", false, "h3 上读不到设计稿，没改代码", true},
		{"方案 A、B 等负责人定\n交付结论: 没做成", false, "方案 A、B 等负责人定", true},
		{"差一步\n交付结论：未完成", false, "差一步", true},
		{"等设计稿\n交付结论：受阻", false, "等设计稿", true},
		{"交付结论：完成\n补一句", false, "", false},   // 结论不在最后一行
		{"没做成，没改代码也没开 PR", false, "", false}, // 自然语言不猜
		{"", false, "", false},
		{"审阅结论：通过", false, "", false},
	}
	for _, c := range cases {
		done, why, ok := ParseEnding(c.text)
		if done != c.done || why != c.why || ok != c.ok {
			t.Errorf("%q：%v %q %v", c.text, done, why, ok)
		}
	}
}

func TestParseSlug(t *testing.T) {
	for _, c := range []struct {
		in, want string
		ok       bool
	}{
		{"o/r", "o/r", true},
		{"https://github.com/o/r.git", "o/r", true},
		{"https://github.com/o/r", "o/r", true},
		{"git@github.com:o/r.git", "o/r", true},
		{"ssh://git@github.com/o/r", "o/r", true},
		{"https://github.com/o/r/", "o/r", true},
		{"o", "", false},
		{"o/r/x", "", false},
		{"../r", "", false},
		{"-o/r", "", false},
		{"https://github.com/o", "", false},
	} {
		got, ok := ParseSlug(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("ParseSlug(%q) = %q,%v，要 %q,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestReviewBrief(t *testing.T) {
	for _, dir := range []string{"", "worktree"} {
		brief := ReviewBrief("t1", "文档站", "o/r", PR{Number: 7, URL: "https://github.com/o/r/pull/7", Head: "task-t1"}, dir, "main", "低 trust", "3 个文件", "普通读者能找到开始入口")
		if strings.Count(brief, org.ReviewChecklist) != 1 {
			t.Fatal("审阅须完整引用唯一清单一次")
		}
		if strings.Index(brief, org.ReviewChecklist) > strings.Index(brief, "gh pr diff") {
			t.Fatal("先定标准，再查看 PR")
		}
		for _, want := range []string{"普通读者能找到开始入口", "只读：不修改", "审阅结论：通过", "审阅结论：打回", "gh pr diff 7 -R o/r"} {
			if !strings.Contains(brief, want) {
				t.Errorf("提示词缺 %q", want)
			}
		}
		if (dir != "") != strings.Contains(brief, "git -C worktree diff origin/main...HEAD") {
			t.Fatal("本地与远程查看方式不符")
		}
	}
}
