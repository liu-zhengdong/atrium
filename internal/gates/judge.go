package gates

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/org"
)

// 本文件全是纯判定：吃运行时查到的事实，不碰进程、库与时间。

// 档案 checks 里能写的交付检查。
const (
	CheckFinished = "finished"        // 已提交、已推送、比默认分支有新提交
	CheckPR       = "pr_exists"       // 分支上有开着的 PR，头提交与本地一致
	CheckGrowth   = "file_growth"     // 单个文件新增行数不超上限
	CheckClaims   = "claims_verified" // PR 正文「端到端验证」一节不为空
	// CheckRelease 是发布授权任务（ReleaseAuthorized）替换 pr_exists 的检查：PR 已合入，
	// 有已发布（非草稿）的 release 其 tag 包含合入提交，且附件至少一个。版本号对不对上详述由审阅、验收看。
	CheckRelease = "release_published"
)

// CheckCommitted 是本机交付（local）的交付检查：工作树都提交了、任务分支比本机主分支有新提交；不看推送与 PR，
// 不由档案 checks 选。
const CheckCommitted = "committed"

// Known 是全部交付检查名；档案写了别的名字判不过（写错了要看见，不静默跳过）。
var Known = []string{CheckFinished, CheckPR, CheckGrowth, CheckClaims, CheckRelease}

// DefaultChecks：档案没写 checks 时查这些。
var DefaultChecks = []string{CheckFinished, CheckPR}

// releaseLine：任务详述里任一行以「授权（k52）」开头（行首空白不计，括号全半角都认）。
var releaseLine = regexp.MustCompile(`(?m)^[ \t]*授权[（(]k52[）)]`)

// ReleaseAuthorized：任务详述按 k52 写明了发布授权。授权内容只存详述这一行，不另设任务字段。
func ReleaseAuthorized(detail string) bool { return releaseLine.MatchString(detail) }

// ReleaseChecks 是发布授权任务的交付检查：去掉 pr_exists（交付时 PR 已按授权合入），必查 release_published，其余保留。
func ReleaseChecks(checks []string) []string {
	out := make([]string, 0, len(checks)+1)
	for _, c := range checks {
		if c != CheckPR && c != CheckRelease {
			out = append(out, c)
		}
	}
	return append(out, CheckRelease)
}

// MaxFileAdded 是 file_growth 的上限：一个文件一次新增的行数。
const MaxFileAdded = 800

// FileStat 是 git diff --numstat 的一行。
type FileStat struct {
	File    string `json:"file"`
	Added   int    `json:"added"`
	Removed int    `json:"removed"`
}

// PR 是 gh 查到的 PR。
type PR struct {
	Number int    `json:"number"`
	URL    string `json:"url"`
	State  string `json:"state"`
	Draft  bool   `json:"draft,omitempty"` // GitHub 草稿（gh 的 isDraft）；开着的草稿 state 仍是 OPEN
	Head   string `json:"head"`            // 分支名
	HeadID string `json:"head_oid"`        // 头提交
	// MergeCommit 是合入提交（gh 的 mergeCommit）；没合入为空。
	MergeCommit string `json:"merge_commit,omitempty"`
	Body        string `json:"-"`
}

// Release 是 GitHub 上的一个 release，及其 tag 是否包含任务 PR 的合入提交（git 在工作树里判）。
type Release struct {
	Tag      string `json:"tag"`
	Draft    bool   `json:"draft,omitempty"`
	Assets   int    `json:"assets"`
	Contains bool   `json:"contains"`
}

// Facts 是运行时查到的事实（不来自执行者自述）。
type Facts struct {
	Dir     string     `json:"dir"`
	Branch  string     `json:"branch"`
	Base    string     `json:"base"` // 默认分支
	Head    string     `json:"head"` // 本地 HEAD
	Dirty   []string   `json:"dirty,omitempty"`
	Ahead   int        `json:"ahead"`
	Pushed  bool       `json:"pushed"` // 远端同名分支与本地 HEAD 一致
	PR      *PR        `json:"pr,omitempty"`
	Numstat []FileStat `json:"-"`
	Diff    string     `json:"diff"` // 改动规模一行人话
	E2E     string     `json:"-"`    // PR 正文「端到端验证」一节
	// Releases 只对发布授权任务查（CollectReleases）：最近 ReleaseScan 个 release。
	Releases []Release `json:"releases,omitempty"`
}

// Result 是一道交付检查的结论。
type Result struct {
	Check    string `json:"check"`
	OK       bool   `json:"ok"`
	Evidence string `json:"evidence"`
}

// Verdict 是交付检查结论；Reasons 是没过的证据，原样交回执行者。
type Verdict struct {
	Pass    bool     `json:"pass"`
	Results []Result `json:"results"`
	Reasons []string `json:"reasons,omitempty"`
}

// Judge 按 checks 逐条判定。
func Judge(checks []string, f Facts) Verdict {
	v := Verdict{Pass: true, Results: []Result{}}
	for _, c := range checks {
		r := judgeOne(c, f)
		v.Results = append(v.Results, r)
		if !r.OK {
			v.Pass = false
			v.Reasons = append(v.Reasons, r.Check+"："+r.Evidence)
		}
	}
	return v
}

func judgeOne(check string, f Facts) Result {
	r := Result{Check: check}
	switch check {
	case CheckFinished:
		missing := uncommitted(f, "origin/"+f.Base)
		if !f.Pushed {
			missing = append(missing, "本地 HEAD 没推送到 origin/"+f.Branch)
		}
		r.OK = len(missing) == 0
		r.Evidence = fmt.Sprintf("已提交 %d 个提交并推送", f.Ahead)
		if !r.OK {
			r.Evidence = "没收尾：" + strings.Join(missing, "；")
		}
	case CheckCommitted:
		missing := uncommitted(f, f.Base)
		r.OK = len(missing) == 0
		r.Evidence = fmt.Sprintf("分支 %s 比 %s 多 %d 个提交，工作树干净", f.Branch, f.Base, f.Ahead)
		if !r.OK {
			r.Evidence = "没收尾：" + strings.Join(missing, "；")
		}
	case CheckPR:
		switch {
		case f.PR == nil:
			r.Evidence = "分支 " + f.Branch + " 没有开着的 PR"
		case f.PR.State != "OPEN":
			r.Evidence = fmt.Sprintf("PR #%d 状态是 %s，不是开着的", f.PR.Number, f.PR.State)
		case f.PR.Head != f.Branch:
			r.Evidence = fmt.Sprintf("PR #%d 的分支是 %s，不是任务分支 %s", f.PR.Number, f.PR.Head, f.Branch)
		case f.PR.HeadID != f.Head:
			r.Evidence = fmt.Sprintf("PR #%d 的头提交 %s 与本地 HEAD %s 不一致（没推送最新提交）", f.PR.Number, short(f.PR.HeadID), short(f.Head))
		default:
			r.OK, r.Evidence = true, fmt.Sprintf("PR #%d：%s", f.PR.Number, f.PR.URL)
		}
	case CheckGrowth:
		var over []string
		for _, s := range f.Numstat {
			if s.Added > MaxFileAdded {
				over = append(over, fmt.Sprintf("%s 新增 %d 行", s.File, s.Added))
			}
		}
		r.OK = len(over) == 0
		r.Evidence = f.Diff + fmt.Sprintf("；单文件新增上限 %d 行", MaxFileAdded)
		if !r.OK {
			r.Evidence = fmt.Sprintf("超过单文件新增上限 %d 行：%s；拆成更小的文件或更小的 PR", MaxFileAdded, strings.Join(firstN(over, 10), "；"))
		}
	case CheckClaims:
		r.OK = strings.TrimSpace(f.E2E) != ""
		r.Evidence = "PR 正文有「端到端验证」一节"
		if !r.OK {
			r.Evidence = "PR 正文没有「端到端验证」一节或该节为空：写在隔离实例里实测的命令与输出"
		}
	case CheckRelease:
		r.OK, r.Evidence = releasePublished(f)
	default:
		r.Evidence = fmt.Sprintf("未知交付检查 %q（可用 %s）；改档案 checks", check, strings.Join(Known, "、"))
	}
	return r
}

// releasePublished 判 release_published：PR 已合入；最近的 release 里有已发布、tag 包含合入提交的，且附件至少一个。
func releasePublished(f Facts) (bool, string) {
	pr := f.PR
	switch {
	case pr == nil:
		return false, "分支 " + f.Branch + " 没有 PR：开 PR 并按详述授权合入后再发版"
	case pr.State != "MERGED" || pr.MergeCommit == "":
		return false, fmt.Sprintf("PR #%d 状态是 %s，未合入：按详述「授权（k52）」合入 PR，再打 tag 发版", pr.Number, pr.State)
	}
	var empty *Release
	for i, rel := range f.Releases {
		if rel.Draft || !rel.Contains {
			continue
		}
		if rel.Assets > 0 {
			return true, fmt.Sprintf("release %s 已发布，附件 %d 个，tag 包含 PR #%d 的合入提交 %s", rel.Tag, rel.Assets, pr.Number, short(pr.MergeCommit))
		}
		if empty == nil {
			empty = &f.Releases[i]
		}
	}
	if empty != nil {
		return false, fmt.Sprintf("release %s 已发布、tag 包含合入提交 %s，但附件为空：等 Actions 构建完或上传附件", empty.Tag, short(pr.MergeCommit))
	}
	return false, fmt.Sprintf("最近 %d 个 release 里没有包含 PR #%d 合入提交 %s 的已发布 release：在含它的提交上打 tag、等 Actions 发出 release（草稿要发布）",
		ReleaseScan, pr.Number, short(pr.MergeCommit))
}

// Changed：工作树相对基线有改动（新提交或未提交的文件）。没有改动的有仓库任务按没有仓库交（按交付结论判）。
func (f Facts) Changed() bool { return len(f.Dirty) > 0 || f.Ahead > 0 }

// uncommitted 是没提交完的证据：未提交的文件、分支比 base 没有新提交。
func uncommitted(f Facts, base string) []string {
	var missing []string
	if len(f.Dirty) > 0 {
		missing = append(missing, fmt.Sprintf("有 %d 个文件未提交（%s）", len(f.Dirty), strings.Join(firstN(f.Dirty, 5), "、")))
	}
	if f.Ahead <= 0 {
		missing = append(missing, "分支比 "+base+" 没有新提交")
	}
	return missing
}

func short(sha string) string {
	if len(sha) > 8 {
		return sha[:8]
	}
	return sha
}

// ParseNumstat 解析 `git diff --numstat`；二进制文件（- -）按 0 行计。
func ParseNumstat(out string) []FileStat {
	var stats []FileStat
	for _, line := range strings.Split(out, "\n") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 {
			continue
		}
		a, _ := strconv.Atoi(parts[0])
		d, _ := strconv.Atoi(parts[1])
		stats = append(stats, FileStat{File: parts[2], Added: a, Removed: d})
	}
	return stats
}

// DiffText 是改动规模的一行人话：文件数、增删行数、改动最多的前 5 个文件。
func DiffText(stats []FileStat) string {
	added, removed := 0, 0
	for _, s := range stats {
		added += s.Added
		removed += s.Removed
	}
	top := append([]FileStat(nil), stats...)
	sort.SliceStable(top, func(i, j int) bool {
		return top[i].Added+top[i].Removed > top[j].Added+top[j].Removed
	})
	head := fmt.Sprintf("改动 %d 个文件，+%d −%d", len(stats), added, removed)
	if len(top) == 0 {
		return head
	}
	var names []string
	for _, s := range firstN(top, 5) {
		names = append(names, fmt.Sprintf("%s（+%d −%d）", s.File, s.Added, s.Removed))
	}
	return head + "：" + strings.Join(names, "、")
}

var heading = regexp.MustCompile(`^(#{1,6})\s+(.*?)\s*#*\s*$`)

// Section 取 Markdown 正文里标题含 name 的一节（到同级或更高级标题为止）。
func Section(body, name string) string {
	var out []string
	level := 0
	for _, line := range strings.Split(strings.ReplaceAll(body, "\r\n", "\n"), "\n") {
		if m := heading.FindStringSubmatch(line); m != nil {
			if level > 0 && len(m[1]) <= level {
				break
			}
			if level == 0 && strings.Contains(m[2], name) {
				level = len(m[1])
				continue
			}
		}
		if level > 0 {
			out = append(out, line)
		}
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// 信任档：审阅者至少 medium；低于 medium 的执行者交付要审阅。
var trusts = []string{"unknown", "low", "medium", "high"}

func trustRank(t string) int {
	for i, v := range trusts {
		if v == t {
			return i
		}
	}
	return 0
}

// NeedReview：任务风险 high，或执行者 trust 低于 medium（没写按 unknown）要先审阅。
func NeedReview(risk, trust string) (bool, string) {
	var why []string
	if risk == "high" {
		why = append(why, "任务风险 high")
	}
	if trustRank(trust) < trustRank("medium") {
		if trust == "" {
			trust = "unknown"
		}
		why = append(why, "执行者 trust="+trust)
	}
	return len(why) > 0, strings.Join(why, "，")
}

// Requirement 是审阅者的要求：不同工具、不同模型、trust 至少 medium。
// 记在审阅任务经历里（kind "worker_require"，JSON），dispatch 挑执行者时按它排除。
type Requirement struct {
	NotTool  string `json:"not_tool"`
	NotModel string `json:"not_model,omitempty"`
	MinTrust string `json:"min_trust"`
}

// Refusal 判一个执行者当不当得了审阅者；当得了返回空串。
func (r Requirement) Refusal(p Profile) string {
	switch {
	case p.Tool == r.NotTool:
		return p.Name + " 与原执行者同一工具 " + p.Tool
	case r.NotModel != "" && p.Model == r.NotModel:
		return p.Name + " 与原执行者同一模型 " + p.Model
	case trustRank(p.Trust) < trustRank(r.MinTrust):
		t := p.Trust
		if t == "" {
			t = "unknown"
		}
		return fmt.Sprintf("%s 的 trust=%s，审阅者至少 %s", p.Name, t, r.MinTrust)
	}
	return ""
}

var (
	verdictLine = regexp.MustCompile(`审阅结论\s*[:：]\s*\**\s*(通过|打回)`)
	// 未完成放在完成前面，避免更长的词被截短。读不出不猜。
	endingLine = regexp.MustCompile(`交付结论\s*[:：]\s*\**\s*(未完成|没做成|受阻|完成)`)
)

// lastLine 按最后一行非空文字读结论：last 匹配 re 时返回第一个分组，之前的文字留末尾 n 个字作说明；匹配不上 ok=false，不猜。
func lastLine(text string, re *regexp.Regexp, n int) (got, before string, ok bool) {
	lines := strings.Split(strings.TrimRight(strings.ReplaceAll(text, "\r\n", "\n"), " \n\t"), "\n")
	m := re.FindStringSubmatch(strings.TrimSpace(lines[len(lines)-1]))
	if m == nil {
		return "", "", false
	}
	before = strings.TrimSpace(strings.Join(lines[:len(lines)-1], "\n"))
	if r := []rune(before); len(r) > n {
		before = "…" + string(r[len(r)-n:])
	}
	return m[1], before, true
}

// ParseReview 从审阅者的收尾文字读结论：最后一行必须是「审阅结论：通过/打回」，之前的文字作意见。
func ParseReview(text string) (pass bool, notes string, ok bool) {
	got, notes, ok := lastLine(text, verdictLine, 1500)
	return got == "通过", notes, ok
}

// Ending 从执行者最后的回复读交付结论那一个词：最后一行必须是「交付结论：完成 / 没做成 / 未完成 / 受阻」。
// 读不出 ok=false，不猜。之前的文字留末尾作原因。
func Ending(text string) (word, why string, ok bool) {
	return lastLine(text, endingLine, 300)
}

// ParseEnding 从执行者最后的回复读交付结论。完成才算做成。
// 没有改动可查的交付（message、dir）只凭这一行判：执行者自称没做成是安全的一侧，照信；读不出不猜。
func ParseEnding(text string) (done bool, why string, ok bool) {
	word, why, ok := Ending(text)
	return word == "完成", why, ok
}

// ReviewBrief 是派给审阅者的任务详述：只读、按清单审、最后一行给结论。dir 是本机工作树；原工作树在远程机器上时为空，只看 PR。
func ReviewBrief(task, title, repo string, pr PR, dir, base, why, diff, detail string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# 审阅 %s 的 PR\n\n原任务：%s %s\nPR：%s（gh 一律带 -R %s）\n", task, task, title, pr.URL, repo)
	code, local := dir, ""
	if dir == "" {
		code = "原工作树在远程机器上，看 PR"
	} else {
		local = fmt.Sprintf(" 或 `git -C %s diff origin/%s...HEAD`；需要时读工作树里的文件", dir, base)
	}
	fmt.Fprintf(&b, "代码：%s（分支 %s 已推送；基线 origin/%s）\n为什么要审阅：%s\n改动规模：%s\n", code, pr.Head, base, why, diff)
	if strings.TrimSpace(detail) != "" {
		fmt.Fprintf(&b, "\n## 原任务详述\n\n%s\n", strings.TrimSpace(detail))
	}
	fmt.Fprintf(&b, `
## 清单

%s

## 怎么看

- 先写上述标准，再读 `+"`gh pr diff %d -R %s`"+`%s。
- 只读：不修改、提交、推送，不在 PR 上评论、批准或合入。

## 结论格式

打回时先逐条写问题（文件:行、现象、怎么改），只写必须改的。
最后一行单独写 `+"`审阅结论：通过`"+` 或 `+"`审阅结论：打回`"+`。
`, org.ReviewChecklist, pr.Number, repo, local)
	return b.String()
}
