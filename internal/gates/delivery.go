package gates

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org/agenda"
	"github.com/liu-zhengdong/atrium/internal/store"
	"github.com/liu-zhengdong/atrium/internal/workers"
)

// Delivery 是一种交付方式：执行者交什么（Rules，附进提示词）、交付检查查什么事实（check）、验收后怎么应用（land）。
// 不存库，按任务已有的事实选（pick）：有仓库但工作树没改动 → message（按执行者的交付结论判）；本机仓库没有 GitHub 远程 → local；其余有仓库 → pr；
// 只有工作地点（本机文件夹）→ dir；都没有 → message，工作目录根有 choice.json → choice。
// 核心（ledger）只认交付检查、审阅、验收过没过与应用的步骤名；要新的交付方式在这里加一项。
type Delivery struct {
	Name string
	// Rules 是提示词「通用约束」里怎么交；%s 换成执行者的分支。
	Rules []string
	// check 查事实判定交付检查结果。
	check func(g *Gate, ctx context.Context, t ledger.Task) (checked, error)
	// land 是应用的第一步（交付检查、审阅、验收都过了之后）；nil 是没有要应用的（东西已在原地，或只是结论），
	// 验收拦不住什么，过了交付检查、审阅就完成，不等验收人。
	land func(g *Gate, ctx context.Context, t ledger.Task) (landed, error)
}

// checked 是交付检查查完的结论。
type checked struct {
	reasons []string // 不过的原因，交回执行者照着改；空为过
	block   string   // 非空：不交回执行者，停下等人定（结论受阻、自称没做成/未完成、没写结论），转受阻交处理人
	note    string   // 过了记进经历的话
	review  string   // 非空：应用前要另一个模型审阅，写明为什么
}

// landed 是应用第一步的结果。
type landed struct {
	stage  ledger.Stage // 应用步骤，由别的循环接着推进（如 pr 的合入队列）；空表示当场应用完成，任务完成
	note   string       // 记进经历
	bounce string       // 非空：无法应用，交回原执行者照它改（如 local 合进主分支有冲突）
	block  string       // 非空：结论是受阻，停下等人定（转受阻），不交回
}

var noRepoRules = []string{"这件活没有仓库：在当前目录干，交付物是最后一条消息里的结论（写清调查结果与依据）。"}

// endRule 没有改动可查的交付（message、dir），交付检查只凭最后一行判（ParseEnding）。分派任务时分不出会不会有改动，所以除审阅轮外一律附。
// 审阅轮不附：它的最后一行是审阅结论（ReviewBrief 与 ParseReview），附了这条执行者会把交付结论写在审阅结论之后，读结论严格末行读不到（t877 第 3 轮）。
// noLandRule 是 pr 交付不让执行者做的应用动作；发布授权任务（ReleaseAuthorized）换成 releaseRule，授权内容以详述那一行为准。
const (
	noLandRule  = "不要合入、不要改默认分支、不要发版。"
	releaseRule = "详述「授权（k52）」行内授权的发布动作（合入自己的 PR、打 tag、触发与等待 Actions、上传附件与更新清单）可以做；其余代码改动仍只交 PR。"
)

const endRule = "最后一行单独写 `交付结论：完成`；没做成、或停在动手前等人定，写 `交付结论：没做成`，原因写在它上面。等外部依赖、要停下等人继续时写 `交付结论：受阻`，受阻原因写在它上面（或紧跟其后，`受阻：<原因>`）：交付当前成果、停下等依赖，关卡会停车并通知负责人，不算失败，依赖解除后继续（任务详述另定了最后一行的照详述）。"

var (
	// pr：在分支上开 PR；交付检查查提交、推送、改动规模与 PR 正文；应用是合入队列（merge）加可选的发版（release）。
	deliverPR = Delivery{Name: "pr",
		Rules: []string{
			"只交 PR：在当前任务工作树的分支 %s 上提交、推送；该分支已有 PR 就更新它，否则开 PR。不要进入其他任务的工作树，" + noLandRule + "不用改代码的活不开 PR，结论写在最后的回复里。",
			"PR 正文写「端到端验证」一节：在隔离实例里跑了什么、输出摘要；会停服务、改机器状态的步骤标注「只在隔离环境」。",
		},
		check: (*Gate).checkPR,
		land:  (*Gate).landPR}
	// local：本机仓库、不经 GitHub；交付检查在本机查提交与改动；应用交付结果是合进本机主分支（landLocal）。
	deliverLocal = Delivery{Name: "local",
		Rules: []string{
			"本机交付：在分支 %s 上提交；不要推送、不要合入主分支，验收过后由运行时合进本机主分支。不用改代码的活不提交，结论写在最后的回复里。",
		},
		check: (*Gate).checkLocal, land: (*Gate).landLocal}
	// dir：在工作地点（本机文件夹）原地干，东西已经在原地；交付检查看执行者的交付结论；没有应用。
	// 同一文件夹的几件活会不会互相踩由负责人分派任务时安排，运行时不隔离、不留回退。
	deliverDir = Delivery{Name: "dir",
		Rules: []string{"这件活在工作地点原地干：当前目录就是用户的文件夹，直接在这里改，不复制、不另建目录或 git 仓库；" +
			"交付说明写在最后的回复里（改了哪些文件、结果与依据）。"},
		check: (*Gate).checkEnding}
	// message：结论写在最后的回复里（没有仓库，或有仓库但没改动）；交付检查看执行者的交付结论；没有应用。
	deliverMessage = Delivery{Name: "message", Rules: noRepoRules, check: (*Gate).checkEnding}
	// choice：调研任务在工作目录根写 choice.json；交付检查核对格式；应用是登记成选项单（agenda.Settle）。
	deliverChoice = Delivery{Name: "choice", Rules: noRepoRules, check: (*Gate).checkChoice, land: (*Gate).landChoice}
)

// pick 按事实选交付方式（纯函数）：repo 是任务的仓库，dir 是工作地点；origin 是本机仓库 origin 的地址（没有为空，repo 不是本机路径时不看）；
// changed 是有仓库的任务工作树相对基线有没有改动（Facts.Changed），没有就按没有仓库交；
// choice 是没有仓库也没有工作地点的任务工作目录根有没有 choice.json。
func pick(repo, dir, origin string, changed, choice bool) Delivery {
	switch {
	case repo == "" && dir != "":
		return deliverDir
	case repo == "" && choice:
		return deliverChoice
	case repo == "" || !changed:
		return deliverMessage
	case localRepo(repo, origin):
		return deliverLocal
	}
	return deliverPR
}

// localRepo：本机仓库的 origin 换算不出 GitHub 的 owner/name（与 Slug 同一判定），交付走 local。
func localRepo(repo, origin string) bool {
	_, github := ParseSlug(origin)
	return filepath.IsAbs(repo) && !github
}

// PromptRules 是分派任务时提示词里怎么交（dispatch 附进「通用约束」）；origin 见 Origin。分派任务时还没有改动，有仓库按要改代码写
// （规则里说了不用改代码时怎么交）；choice 与 message 分派任务时分不出来，提示词相同，要不要写 choice.json 由任务详述（调研定时任务）说。
// detail 是任务详述：发布授权任务把不让合入、发版那句换成 releaseRule。review 是审阅轮：不附交付结论那条（见 endRule）。
func PromptRules(repo, dir, origin, branch, detail string, review bool) []string {
	d := pick(repo, dir, origin, true, false)
	release := ReleaseAuthorized(detail)
	out := make([]string, len(d.Rules), len(d.Rules)+1)
	for i, r := range d.Rules {
		if release {
			r = strings.Replace(r, noLandRule, releaseRule, 1)
		}
		out[i] = strings.ReplaceAll(r, "%s", branch)
	}
	if review {
		return out
	}
	return append(out, endRule)
}

// Origin 读本机仓库（绝对路径）origin 的地址；没有 origin 或 repo 不是本机路径为空。
func Origin(ctx context.Context, r Runner, repo string) (string, error) {
	if !filepath.IsAbs(repo) {
		return "", nil
	}
	names, err := r.Run(ctx, repo, "git", "remote")
	if err != nil || !slices.Contains(strings.Fields(names), "origin") {
		return "", err
	}
	url, err := r.Run(ctx, repo, "git", "remote", "get-url", "origin")
	return strings.TrimSpace(url), err
}

// deliveryOf 查齐事实（本机仓库的 origin、工作目录根的 choice.json，交付检查时再查工作树有没有改动）后按 pick 选交付方式。
// 任务级验收也覆盖零 diff：没有登记 PR 时按工作树事实选 message。
// 审阅轮不走这里：它的回复由 review 直接读（roundResult + ParseReview），不查工作树或 choice.json。
func (g *Gate) deliveryOf(ctx context.Context, t ledger.Task, atGate bool) (Delivery, error) {
	switch {
	case t.Repo != "":
		if t.PR != "" {
			repo, e := Slug(ctx, g.R, t.Repo)
			if e != nil {
				return Delivery{}, e
			}
			pr, e := ViewPR(ctx, g.R, repo, t.PR)
			if e != nil {
				return Delivery{}, e
			}
			if pr.State == "MERGED" {
				return deliverPR, nil
			}
		}
		origin, err := Origin(ctx, g.R, t.Repo)
		changed := true
		if err == nil && (atGate || t.Stage == ledger.StageAccept && t.PR == "") {
			changed, err = g.changed(ctx, t, origin)
		}
		return pick(t.Repo, "", origin, changed, false), err
	case t.Dir != "":
		return pick("", t.Dir, "", true, false), nil
	}
	raw, err := g.choiceFile(ctx, t)
	return pick("", "", "", true, raw != nil), err
}

// changed 查有仓库的任务工作树相对基线有没有改动：本机交付比本机主分支，其余比 GitHub 默认分支。
func (g *Gate) changed(ctx context.Context, t ledger.Task, origin string) (bool, error) {
	w, err := mustWorkspace(ctx, g.DB, t.ID)
	if err != nil {
		return false, err
	}
	var f Facts
	if localRepo(t.Repo, origin) {
		f, err = CollectLocal(ctx, g.R, w.Dir, t.Repo)
	} else {
		var repo string
		if repo, err = Slug(ctx, g.R, t.Repo); err == nil {
			f, _, err = collectBase(ctx, On(g.R, w), w.Dir, repo)
		}
	}
	return f.Changed(), err
}

// choiceFile 读没有仓库的任务工作目录根的 choice.json（远程经代理）；没登记工作目录或没有文件为 nil。
func (g *Gate) choiceFile(ctx context.Context, t ledger.Task) ([]byte, error) {
	w, found, err := Workspace(ctx, g.DB, t.ID)
	if err != nil || !found {
		return nil, err
	}
	return ReadFile(ctx, w, agenda.ChoiceFile)
}

// checkEnding 是没有改动可查的交付（message、dir）的交付检查：按执行者这一轮最后的回复里的交付结论判（ParseEnding）。
// 没做成、受阻、没写都转受阻交处理人读回复定（受阻是等外部依赖，不算失败；其余补说明重派或收尾），不交回执行者重跑同一份提示词。
// 受阻说明以执行者的结论开头：没有改动是这种交付的常态，不是受阻的原因（t923、t1000 曾被读成「没 diff 被拦」）。
func (g *Gate) checkEnding(ctx context.Context, t ledger.Task) (checked, error) {
	reply, err := roundResult(ctx, g.DB, t.ID)
	if err != nil {
		return checked{}, err
	}
	where := "没有仓库"
	switch {
	case t.Repo != "":
		where = "没有代码改动"
	case t.Dir != "":
		where = "在工作地点原地干"
	}
	if reply == "" {
		return checked{block: fmt.Sprintf("这一轮没记到执行者的回复（atrium task log %s 看原始输出）", t.ID)}, nil
	}
	next := fmt.Sprintf("（%s，按交付结论判）；读执行者的回复（atrium task log %s）后补说明重派，或收尾 atrium task set %s --status done", where, t.ID, t.ID)
	word, why, ok := Ending(reply)
	switch {
	case !ok:
		return checked{block: "执行者最后一行没写「交付结论：完成/没做成」，读不出做没做成" + next}, nil
	case word == "受阻":
		return checked{block: blockedReason(why) + "（" + where + "）"}, nil
	case word != "完成":
		if why = strings.Join(strings.Fields(why), " "); why == "" {
			why = "没写原因"
		}
		return checked{block: "执行者交付结论：" + word + "（" + why + "）" + next}, nil
	}
	return checked{note: where + "，交付结论：完成，结论在最后的回复里"}, nil
}

// CurrentReply 是执行者这一轮（最近一次拉起之后）最后的回复；这一轮没回复为空，不拿上一轮的充数。
// 合入入口重查用它，不读交付检查记录。
func CurrentReply(ctx context.Context, q store.Querier, id string) (string, error) {
	return roundResult(ctx, q, id)
}

// roundResult 取执行者这一轮（最近一次拉起之后）最后的回复；这一轮没回复为空，不拿上一轮的充数。
func roundResult(ctx context.Context, q store.Querier, id string) (string, error) {
	launched, err := lastID(ctx, q, id, workers.RunKind)
	if err != nil {
		return "", err
	}
	var body string
	err = q.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = ? AND id > ? ORDER BY id DESC LIMIT 1`,
		id, KindResult, launched).Scan(&body)
	if store.IsNotFound(err) {
		return "", nil
	}
	return body, err
}

func (g *Gate) checkChoice(ctx context.Context, t ledger.Task) (checked, error) {
	raw, err := g.choiceFile(ctx, t)
	if err != nil {
		return checked{}, err
	}
	_, err = agenda.ParseChoice(raw)
	if err == nil && t.Org == "" {
		err = api.Usage("%s 没挂部门，%s 无处登记", t.ID, agenda.ChoiceFile)
	}
	var ae *api.Error
	if errors.As(err, &ae) && ae.Code == "usage" {
		return checked{reasons: []string{ae.Message}}, nil
	}
	return checked{note: "没有仓库，交了选项单"}, err
}

func (g *Gate) landChoice(ctx context.Context, t ledger.Task) (landed, error) {
	raw, err := g.choiceFile(ctx, t)
	if err != nil {
		return landed{}, err
	}
	c, err := agenda.Settle(ctx, g.DB, g.Data, t.ID, raw)
	if err != nil || c == nil {
		return landed{}, err
	}
	return landed{note: "登记了选项单 " + c.ID}, nil
}

// checkPR 查事实、判定交付检查结果：git 在工作树所在机器上查（On），PR 由服务查 GitHub；过了记下 PR，按风险与信任定要不要审阅。
// 发布授权任务（ReleaseAuthorized）的 PR 按授权已合入：pr_exists 换成 release_published（ReleaseChecks），不要求 PR 开着。
func (g *Gate) checkPR(ctx context.Context, t ledger.Task) (checked, error) {
	return g.checkPRWithRecovery(ctx, t, nil)
}

func (g *Gate) checkPRWithRecovery(ctx context.Context, t ledger.Task, recovery *MergedRecovery) (checked, error) {
	w, err := mustWorkspace(ctx, g.DB, t.ID)
	if err != nil {
		return checked{}, err
	}
	prof, err := LoadProfile(ctx, g.DB, t.Worker)
	if err != nil {
		return checked{}, err
	}
	repo, err := Slug(ctx, g.R, t.Repo)
	if err != nil {
		return checked{}, err
	}
	r := On(g.R, w)
	facts, err := Collect(ctx, r, w.Dir, repo)
	if err != nil {
		return checked{}, err
	}
	checks := prof.Checks
	if checks == nil {
		checks = DefaultChecks
	}
	release := ReleaseAuthorized(t.Detail)
	if release {
		checks = ReleaseChecks(checks)
		if facts.Releases, err = CollectReleases(ctx, r, w.Dir, repo, facts.PR); err != nil {
			return checked{}, err
		}
	}
	recheck := !release && mergedRecheck(facts, t.PR)
	if recovery != nil && !recheck {
		return checked{block: "当前 head 不是原任务同一已合入 head"}, nil
	}
	v := Judge(checks, facts)
	if recheck {
		v = recheckVerdict(checks, facts)
	}
	if !release && !recheck && v.Pass && (facts.PR == nil || facts.PR.State != "OPEN") {
		v.Pass = false
		v.Reasons = append(v.Reasons, "pr_exists：分支 "+facts.Branch+" 没有开着的 PR，无从合入")
	}
	resultID, reply, err := deliveryResult(ctx, g.DB, t.ID)
	if err != nil {
		return checked{}, err
	}
	reasons, blocked := Admit(facts.PR, reply)
	if recheck {
		done, _, ok := ParseEnding(reply)
		if !ok || !done {
			blocked = "已合入复核的原回复未完成"
		}
		if recovery != nil {
			reasons = nil
			blocked = ""
		}
	}
	if blocked != "" {
		v.Pass = false
		v.Reasons = append(v.Reasons, blocked)
	} else if len(reasons) > 0 {
		v.Pass = false
		v.Reasons = append(v.Reasons, reasons...)
	}
	if recovery == nil || (v.Pass && blocked == "") {
		if err := record(ctx, g.DB, t.ID, KindGate, gateRecord{Verdict: v, Facts: facts, ResultID: resultID, Recovery: recovery}); err != nil {
			return checked{}, err
		}
	}
	if blocked != "" {
		return checked{block: blocked}, nil
	}
	if !v.Pass {
		return checked{reasons: v.Reasons}, nil
	}
	url := facts.PR.URL
	if err := ledger.SetFacts(ctx, g.DB, t.ID, ledger.Facts{PR: &url}, Actor); err != nil {
		return checked{}, err
	}
	risk, err := Risk(ctx, g.DB, t.ID)
	if err != nil {
		return checked{}, err
	}
	c := checked{note: fmt.Sprintf("交付检查通过（%s）：%s", strings.Join(checks, "、"), facts.Diff)}
	if need, why := NeedReview(risk, prof.Trust); need {
		c.review = why
	}
	return c, nil
}

// landPR 进合入队列前再查一次：现问 GitHub 这个 PR 是不是草稿，并读这一轮回复。不读交付检查记录。
// 执行者在审阅或等验收期间把 PR 转 ready，也要过这一道，不能沿用之前的通过。
// 发布授权任务的 PR 已合入：发布动作执行者已做完，没有要应用的。
func (g *Gate) landPR(ctx context.Context, t ledger.Task) (landed, error) {
	cur, err := ledger.Get(ctx, g.DB, t.ID)
	if err != nil {
		return landed{}, err
	}
	if cur.PR == "" {
		return landed{}, fmt.Errorf("%s 要进合入队列，但还没有登记 PR", t.ID)
	}
	repo, err := Slug(ctx, g.R, cur.Repo)
	if err != nil {
		return landed{}, err
	}
	info, err := ViewPR(ctx, g.R, repo, cur.PR)
	if err != nil {
		return landed{}, err
	}
	if !ReleaseAuthorized(cur.Detail) && info.State == "MERGED" {
		return g.landRecheck(ctx, cur, repo)
	}
	if ReleaseAuthorized(cur.Detail) && info.State == "MERGED" {
		return landed{note: "PR 已按授权合入并发布，没有要应用的"}, nil
	}
	reasons, blocked, err := QueueBlock(ctx, g.DB, &info.PR, t.ID)
	if err != nil {
		return landed{}, err
	}
	if blocked != "" {
		return landed{block: blocked}, nil
	}
	if len(reasons) > 0 {
		return landed{bounce: strings.Join(reasons, "；")}, nil
	}
	return landed{stage: ledger.StageMerge, note: "进合入队列"}, nil
}
