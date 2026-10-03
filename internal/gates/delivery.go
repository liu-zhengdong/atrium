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
	"github.com/liu-zhengdong/atrium/internal/org"
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
	block   string   // 非空：交回执行者也没用（它自称没做成、停下等人定，或没写交付结论），转受阻交处理人
	note    string   // 过了记进经历的话
	review  string   // 非空：应用前要另一个模型审阅，写明为什么
}

// landed 是应用第一步的结果。
type landed struct {
	stage  ledger.Stage // 应用步骤，由别的循环接着推进（如 pr 的合入队列）；空表示当场应用完成，任务完成
	note   string       // 记进经历
	bounce string       // 非空：无法应用，交回原执行者照它改（如 local 合进主分支有冲突）
}

var noRepoRules = []string{"这件活没有仓库：在当前目录干，交付物是最后一条消息里的结论（写清调查结果与依据）。"}

// endRule 没有改动可查的交付（message、dir），交付检查只凭最后一行判（ParseEnding）。分派任务时分不出会不会有改动，所以除审阅任务外一律附。
// 审阅任务不附：它的最后一行是审阅结论（ReviewBrief 与 ParseReview），附了这条执行者会把交付结论写在审阅结论之后，原任务的 ParseReview 严格末行读不到（t877 第 3 轮）。
// noLandRule 是 pr 交付不让执行者做的应用动作；发布授权任务（ReleaseAuthorized）换成 releaseRule，授权内容以详述那一行为准。
const (
	noLandRule  = "不要合入、不要改默认分支、不要发版。"
	releaseRule = "详述「授权（k52）」行内授权的发布动作（合入自己的 PR、打 tag、触发与等待 Actions、上传附件与更新清单）可以做；其余代码改动仍只交 PR。"
)

const endRule = "最后一行单独写 `交付结论：完成`；没做成、或停在动手前等人定，写 `交付结论：没做成`，原因写在它上面（任务详述另定了最后一行的照详述）。"

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
// detail 是任务详述：发布授权任务把不让合入、发版那句换成 releaseRule。review 是审阅任务：不附交付结论那条（见 endRule）。
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
// 过了交付检查还在走的（审阅、验收）都有改动：没改动的按 message 交，没有这两步。
func (g *Gate) deliveryOf(ctx context.Context, t ledger.Task, atGate bool) (Delivery, error) {
	// 审阅只交服务已记下的回复，不查执行者机器上的工作树或 choice.json。
	if _, review, err := Last(ctx, g.DB, t.ID, KindReviewOf); err != nil || review {
		return deliverMessage, err
	}
	switch {
	case t.Repo != "":
		origin, err := Origin(ctx, g.R, t.Repo)
		changed := true
		if err == nil && atGate {
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
// 没做成、没写都转受阻交处理人读回复定（补说明重派或收尾），不交回执行者重跑同一份提示词。
// 审阅任务看的是审阅结论（reviewEnding），读不出就交回审阅者，原任务不卡在审阅阶段。
func (g *Gate) checkEnding(ctx context.Context, t ledger.Task) (checked, error) {
	_, review, err := Last(ctx, g.DB, t.ID, KindReviewOf)
	if err != nil {
		return checked{}, err
	}
	reply, err := roundResult(ctx, g.DB, t.ID)
	if err != nil || review {
		return reviewEnding(reply), err
	}
	where := "没有仓库"
	switch {
	case t.Repo != "":
		where = "工作树相对基线没有改动，不要 PR"
	case t.Dir != "":
		where = "在工作地点原地干"
	}
	if reply == "" {
		return checked{block: fmt.Sprintf("这一轮没记到执行者的回复（atrium task log %s 看原始输出）", t.ID)}, nil
	}
	next := fmt.Sprintf("；读执行者的回复（atrium task log %s）后补说明重派，或收尾 atrium task set %s --status done", t.ID, t.ID)
	word, why, ok := Ending(reply)
	switch {
	case !ok:
		return checked{block: where + "，执行者最后一行没写「交付结论：完成/没做成」" + next}, nil
	case word != "完成":
		if why = strings.Join(strings.Fields(why), " "); why == "" {
			why = "没写原因"
		}
		return checked{block: where + "，执行者交付结论：" + word + "（" + why + "）" + next}, nil
	}
	return checked{note: where + "，交付结论：完成，结论在最后的回复里"}, nil
}

// reviewEnding 判审阅任务这一轮的回复读不读得出审阅结论（纯函数，与原任务读结论同一个 ParseReview）。
// 读不出交回审阅者重审（交回计次，第 3 次转受阻）：回复为空多是取回复或登录出错，重派即可，不该让原任务等人重开审阅任务。
func reviewEnding(reply string) checked {
	const want = "最后一行单独写 `审阅结论：通过` 或 `审阅结论：打回`，问题写在它上面，它之后不再写别的"
	if strings.TrimSpace(reply) == "" {
		return checked{reasons: []string{"这一轮没记到审阅者的最后回复；审阅完在最后的回复里" + want}}
	}
	if _, _, ok := ParseReview(reply); !ok {
		return checked{reasons: []string{"最后的回复读不出审阅结论：" + want}}
	}
	return checked{note: "审阅结论在最后的回复里"}
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
	v := Judge(checks, facts)
	if !release && v.Pass && (facts.PR == nil || facts.PR.State != "OPEN") {
		v.Pass = false
		v.Reasons = append(v.Reasons, "pr_exists：分支 "+facts.Branch+" 没有开着的 PR，无从合入")
	}
	block, err := QueueBlock(ctx, g.DB, facts.PR, t.ID)
	if err != nil {
		return checked{}, err
	}
	if block != "" {
		v.Pass = false
		v.Reasons = append(v.Reasons, block)
	}
	if err := record(ctx, g.DB, t.ID, KindGate, gateRecord{v, facts}); err != nil {
		return checked{}, err
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
	if ReleaseAuthorized(cur.Detail) && info.State == "MERGED" {
		return landed{note: "PR 已按授权合入并发布，没有要应用的"}, nil
	}
	block, err := QueueBlock(ctx, g.DB, &info.PR, t.ID)
	if err != nil {
		return landed{}, err
	}
	if block != "" {
		return landed{bounce: block}, nil
	}
	return landed{stage: ledger.StageMerge, note: "进合入队列"}, nil
}

// acceptBy 是这件任务过了交付检查、审阅之后要等谁验收：部门的验收人（沿树继承），auto 为空。
// 没有应用的交付方式（dir、message）和运行时自己建的审阅任务不等人验收。
func acceptBy(ctx context.Context, q store.Querier, t ledger.Task, d Delivery) (string, error) {
	if d.land == nil {
		return "", nil
	}
	if _, review, err := Last(ctx, q, t.ID, KindReviewOf); err != nil || review {
		return "", err
	}
	who, _, err := org.Acceptor(ctx, q, t.Org)
	if err != nil || who == org.AcceptAuto {
		return "", err
	}
	return who, nil
}

var acceptLabel = map[string]string{org.AcceptUser: "你", org.AcceptLeader: "负责人"}

// pass 过了交付检查或审阅：要等验收（acceptBy）就停在等验收；否则当场应用。
func (g *Gate) pass(ctx context.Context, t ledger.Task, d Delivery, kind ledger.EventKind, note string) error {
	by, err := acceptBy(ctx, g.DB, t, d)
	if err != nil {
		return err
	}
	if by != "" {
		note += fmt.Sprintf("；等%s验收：atrium task accept %s，或 atrium task reject %s --reason 原因", acceptLabel[by], t.ID, t.ID)
		_, err := ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: kind, AcceptBy: by}, Actor, note)
		return err
	}
	return g.land(ctx, t, d, kind, Actor, note)
}

// land 做交付方式应用的第一步并记录结果：有后续步骤进那一步，没有任务完成；无法应用交回原执行者。
func (g *Gate) land(ctx context.Context, t ledger.Task, d Delivery, kind ledger.EventKind, actor, note string) error {
	var l landed
	if d.land != nil {
		var err error
		if l, err = d.land(g, ctx, t); err != nil {
			return err
		}
	}
	if l.bounce != "" {
		_, err := Bounce(ctx, g.DB, t.ID, actor, note+"；应用交付结果失败："+l.bounce)
		return err
	}
	if l.note != "" {
		note += "；" + l.note
	}
	_, err := ledger.Apply(ctx, g.DB, t.ID, ledger.Event{Kind: kind, Land: l.stage}, actor, note)
	return err
}

// awaiting 取等验收的任务并核对 actor 能不能判：用户与秘书都能；负责人不能代用户验收（管辖由负责人权限另判）。
func (g *Gate) awaiting(ctx context.Context, id, actor string) (ledger.Task, error) {
	t, err := ledger.Get(ctx, g.DB, id)
	if err != nil {
		return t, err
	}
	if t.Status != ledger.Running || t.Stage != ledger.StageAccept {
		return t, api.Conflict("%s 不在等验收（当前 %s/%s）", id, t.Status, t.Stage).WithNext("atrium task show " + id)
	}
	who, _, err := org.Acceptor(ctx, g.DB, t.Org)
	if err != nil {
		return t, err
	}
	if !org.MayAccept(actor, who) {
		return t, api.Forbidden("%s 所在部门的验收人是用户，%s 不能代验；需要就上报", id, actor).
			WithNext("atrium leader escalate <说明> --kind beyond --task " + id)
	}
	return t, nil
}

// Accept 是 task accept：验收通过，做交付方式应用的第一步（pr 进合入队列，local 合进本机主分支，choice 登记选项单）。
func (g *Gate) Accept(ctx context.Context, id, actor string) (ledger.Task, error) {
	t, err := g.awaiting(ctx, id, actor)
	if err != nil {
		return t, err
	}
	d, err := g.deliveryOf(ctx, t, false)
	if err != nil {
		return t, err
	}
	if err := g.land(ctx, t, d, ledger.Accept, actor, "验收通过（"+actor+"）"); err != nil {
		return t, err
	}
	return ledger.Get(ctx, g.DB, id)
}

// Reject 是 task reject：验收打回，交回原执行者照原因改（与交付检查未通过同一套计次，第 3 次转受阻）。
func (g *Gate) Reject(ctx context.Context, id, actor, reason string) (ledger.Task, error) {
	if strings.TrimSpace(reason) == "" {
		return ledger.Task{}, api.Usage("--reason: 不能为空（写清哪里不行，执行者照它改）")
	}
	if _, err := g.awaiting(ctx, id, actor); err != nil {
		return ledger.Task{}, err
	}
	return Bounce(ctx, g.DB, id, actor, "验收打回（"+actor+"）："+Clip(reason, 2000))
}
