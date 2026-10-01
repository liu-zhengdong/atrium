package ledger

import (
	"context"
	"database/sql"
	"strings"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 在问用户的话：负责人问用户、等回话的一句话，挂在待派任务上（task_asks，一件最多一条）。
// 挂着时当前等待对象是用户、不计时（watch.HolderOf）；提出经 leader escalate --kind ask（投秘书转告用户），
// 回话与撤回都走 task tell（RecordTell 清掉它、发给处理它的负责人），任务离开待派时 Apply 一并删掉。

// MaxAsk 是在问用户的话的字数上限：一两个问题，秘书能原样转告；背景写进说明或备注。
const MaxAsk = 500

// CheckAsk 纯校验：问的话不能空、不超过 MaxAsk，任务要是待派（在做、等依赖以外的别的状态都不是在等用户回话）。
func CheckAsk(t Task, text string) error {
	if strings.TrimSpace(text) == "" {
		return api.Usage("<说明>: 不能为空：写清要问用户的话")
	}
	if n := utf8.RuneCountInString(text); n > MaxAsk {
		return api.Usage("<说明>: 问用户的话最多 %d 字，收到 %d 字；背景写进 task note %s", MaxAsk, n, t.ID)
	}
	switch {
	case t.Status.Finished():
		return api.Conflict("%s 已%s，任务已结束，不再挂问题", t.ID, t.Status).WithNext("atrium task add <标题> --parent " + t.ID)
	case t.Status != Todo:
		return api.Conflict("%s 是 %s，只有待派的任务能挂在问用户的话", t.ID, t.Status).WithNext("atrium task set " + t.ID + " --status todo")
	}
	return nil
}

// SetAsk 在调用方事务里给任务挂上在问用户的话；已有一条就换成这一条（一件任务同时最多一条）。
func SetAsk(ctx context.Context, tx *sql.Tx, id, text string) error {
	t, err := Get(ctx, tx, id)
	if err != nil {
		return err
	}
	text = strings.TrimSpace(text)
	if err := CheckAsk(t, text); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO task_asks (task, text, at) VALUES (?, ?, ?)
		ON CONFLICT (task) DO UPDATE SET text = excluded.text, at = excluded.at`, id, text, store.Now())
	return err
}

// clearAsk 删掉在问用户的话，并把任务的改动时刻记成现在：任务回到负责人手上，计时从这一刻起（watch.leaderSince）。
func clearAsk(ctx context.Context, tx *sql.Tx, id string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM task_asks WHERE task = ?`, id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE tasks SET updated_at = ? WHERE id = ?`, store.Now(), id)
	return err
}

// answerTo 是回话发给谁：处理人是负责人就给它（同交给它拆的任务），否则给部门往上最近的负责人（watch.HolderOf 计时的那位）；
// 没有负责人，或说话的就是它自己（撤回）时不发。
func answerTo(ctx context.Context, q store.Querier, t Task, p Parties, by string) (string, error) {
	who := p.Owner
	if !api.IsRef(who, "a") {
		var err error
		if who, err = org.Recipient(ctx, q, t.Org); err != nil {
			return "", err
		}
	}
	if !api.IsRef(who, "a") || who == by {
		return "", nil
	}
	return who, nil
}
