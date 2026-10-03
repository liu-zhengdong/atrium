package gates

import (
	"reflect"
	"strings"
	"testing"
)

func TestReleaseAuthorized(t *testing.T) {
	cases := []struct {
		detail string
		want   bool
	}{
		{"目标：发 0.8.7\n\n授权（k52）：本任务已授权发布动作——打 tag、触发与等待 Actions\n\n护栏：…", true}, // t963 的写法
		{"授权（k52）：首行就是", true},
		{"  授权(k52)：半角括号、行首缩进", true},
		{"目标：x\n未授权发布（k52 没批）", false},
		{"未授权（k52）：不能发", false},
		{"说明里提到 授权（k52） 但不在行首", false},
		{"授权：没写 k52", false},
		{"", false},
	}
	for _, c := range cases {
		if got := ReleaseAuthorized(c.detail); got != c.want {
			t.Errorf("ReleaseAuthorized(%q) = %v，应为 %v", c.detail, got, c.want)
		}
	}
}

func TestReleaseChecks(t *testing.T) {
	cases := []struct{ in, want []string }{
		{DefaultChecks, []string{CheckFinished, CheckRelease}},
		{[]string{CheckFinished, CheckPR, CheckGrowth, CheckClaims}, []string{CheckFinished, CheckGrowth, CheckClaims, CheckRelease}},
		{[]string{CheckFinished}, []string{CheckFinished, CheckRelease}}, // 档案没写 pr_exists 也必查发布
		{[]string{CheckRelease, CheckFinished}, []string{CheckFinished, CheckRelease}},
	}
	for _, c := range cases {
		if got := ReleaseChecks(c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("ReleaseChecks(%v) = %v，应为 %v", c.in, got, c.want)
		}
	}
	if !reflect.DeepEqual(DefaultChecks, []string{CheckFinished, CheckPR}) {
		t.Fatalf("ReleaseChecks 改了 DefaultChecks：%v", DefaultChecks)
	}
}

// t963 的形状：PR #27 已合入，v0.8.7 含它的合入提交、有附件。
func releaseFacts() Facts {
	f := goodFacts()
	f.PR.State, f.PR.MergeCommit = "MERGED", "f0d5f25aaaaaaaa"
	f.Releases = []Release{{Tag: "v0.8.7", Assets: 9, Contains: true}, {Tag: "v0.8.6", Assets: 9}}
	return f
}

func TestReleasePublished(t *testing.T) {
	cases := []struct {
		name string
		edit func(*Facts)
		ok   bool
		want string // 证据里要有的字样
	}{
		{"合入且有含合入提交的已发布 release", func(*Facts) {}, true, "release v0.8.7 已发布，附件 9 个，tag 包含 PR #7 的合入提交 f0d5f25a"},
		{"没有 PR", func(f *Facts) { f.PR = nil }, false, "没有 PR"},
		{"PR 还开着", func(f *Facts) { f.PR.State, f.PR.MergeCommit = "OPEN", "" }, false, "未合入"},
		{"PR 关了没合", func(f *Facts) { f.PR.State, f.PR.MergeCommit = "CLOSED", "" }, false, "未合入"},
		{"合入但没有 release", func(f *Facts) { f.Releases = nil }, false, "没有包含 PR #7 合入提交 f0d5f25a 的已发布 release"},
		{"release 都不含合入提交", func(f *Facts) { f.Releases = f.Releases[1:] }, false, "没有包含"},
		{"含合入提交的只有草稿", func(f *Facts) { f.Releases[0].Draft = true }, false, "没有包含"},
		{"附件为空", func(f *Facts) { f.Releases[0].Assets = 0 }, false, "release v0.8.7 已发布、tag 包含合入提交 f0d5f25a，但附件为空"},
		{"空附件的较新版本之外有带附件的", func(f *Facts) {
			f.Releases = append([]Release{{Tag: "v0.8.8", Contains: true}}, f.Releases...)
		}, true, "release v0.8.7"},
	}
	for _, c := range cases {
		f := releaseFacts()
		c.edit(&f)
		v := Judge(ReleaseChecks(DefaultChecks), f)
		r := v.Results[len(v.Results)-1]
		if r.Check != CheckRelease || r.OK != c.ok || v.Pass != c.ok || !strings.Contains(r.Evidence, c.want) {
			t.Errorf("%s：%+v，pass=%v，期望 ok=%v 且含 %q", c.name, r, v.Pass, c.ok, c.want)
		}
	}
	// 常规检查对同一份事实仍拦：合入了的 PR 不算开着的 PR。
	if v := Judge(DefaultChecks, releaseFacts()); v.Pass {
		t.Fatal("常规任务对合入的 PR 应仍判 pr_exists 不过")
	}
}
