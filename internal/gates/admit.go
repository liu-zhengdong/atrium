package gates

import (
	"context"
	"fmt"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// Admit 判这份 PR 交付现在能不能过（纯函数）。
// 先读这一轮的交付结论：是「受阻」即停车（blocked 非空），跳过 PR 草稿等现算检查，归入停下等人定的路。
// 结论不是「受阻」时照旧现算：PR 是草稿，或结论是没做成、未完成，都不通过（reasons，交回执行者改）。
// 不读上一次的结论。执行者把草稿转成 ready 只改变草稿这一条，结论仍要现读。
// 草稿不由关卡代为 gh pr ready：草稿是执行者自己留下的「还没交」，代转等于替他改口。
func Admit(pr *PR, reply string) (reasons []string, blocked string) {
	word, why, ok := Ending(reply)
	if ok && word == "受阻" {
		return nil, blockedReason(why)
	}
	if pr != nil && pr.Draft && (pr.State == "" || pr.State == "OPEN") {
		reasons = append(reasons, draftReason(pr))
	}
	if ok && word != "完成" {
		reasons = append(reasons, endingReason(word, why))
	}
	return reasons, ""
}

func draftReason(pr *PR) string {
	cmd := fmt.Sprintf("gh pr ready %d", pr.Number)
	if repo := repoOfPR(pr.URL); repo != "" {
		cmd += " -R " + repo
	}
	return fmt.Sprintf("PR #%d 还是草稿：把 PR 转 ready（%s）或修完再交", pr.Number, cmd)
}

func endingReason(word, why string) string {
	why = strings.Join(strings.Fields(why), " ")
	if why == "" {
		why = "没写原因"
	}
	return fmt.Sprintf("交付结论：%s（%s）：修完再交，最后一行写「交付结论：完成」", word, why)
}

// blockedReason 是「受阻」的备注：交付当前成果、停下等外部依赖；关卡停车并通知负责人，不算失败，解除后继续。
func blockedReason(why string) string {
	why = strings.Join(strings.Fields(why), " ")
	if why == "" {
		why = "没写原因"
	}
	return fmt.Sprintf("交付结论：受阻（%s）：停下等外部依赖，不算失败；负责人解除后 atrium task run 继续", why)
}

func repoOfPR(raw string) string {
	rest, ok := strings.CutPrefix(raw, "https://github.com/")
	if !ok {
		return ""
	}
	owner, rest, ok := strings.Cut(rest, "/")
	name, _, ok2 := strings.Cut(rest, "/")
	if !ok || !ok2 || owner == "" || name == "" || strings.Contains(name, "..") {
		return ""
	}
	return owner + "/" + name
}

// QueueBlock 是进合入队列前、以及每次交付检查时的重查：读这一轮回复，对当前 PR 跑 Admit。
// reasons 交回执行者照改，blocked 非空（结论是受阻）时停下等人定转受阻；都空表示可以过。
// 不读交付检查记录。pr 为 nil 时只看回复。
func QueueBlock(ctx context.Context, q store.Querier, pr *PR, id string) (reasons []string, blocked string, err error) {
	reply, err := CurrentReply(ctx, q, id)
	if err != nil {
		return nil, "", err
	}
	reasons, blocked = Admit(pr, reply)
	return reasons, blocked, nil
}
