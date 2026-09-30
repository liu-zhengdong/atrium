package ledger

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// Source 是草稿记的发现从哪来。
type Source string

const (
	SourceUser Source = "user" // 用户纠正
	SourceOrg  Source = "org"  // 组织发现
)

// Label 是给人看的名字。
func (s Source) Label() string {
	return map[Source]string{SourceUser: "用户纠正", SourceOrg: "组织发现"}[s]
}

// By 是来源一行：「组织发现 · 记录人名字」；没记录人只写来源。
func (s Source) By(name string) string {
	if s.Label() == "" || name == "" {
		return s.Label()
	}
	return s.Label() + " · " + name
}

const maxClass = 40

// DraftHowTo 是记草稿的说明（k31 的做法）：负责人提示词与秘书会话开头都引用它，改只改这一处。
const DraftHowTo = "绕了路、撞了限制、被纠正了，就记一条草稿：atrium task add 现象 --draft --org 部门 --source user（用户纠正）或 org（组织发现）" +
	" --class 类名 --detail 依据、挡住了三个目标里的哪一个。类名按原因归（如「执行者可用性」），同一类用同一个名字：" +
	"回执会列出已有的类，写成新名字的用 atrium task set tN --class 已有类名 并进去。用户亲手验收退回、取消任务时运行时已自动记一条。"

func checkFinding(src Source, class string) error {
	if src != "" && src.Label() == "" {
		return api.Usage("--source: 应为 user（用户纠正）或 org（组织发现），收到 %q", src)
	}
	if strings.ContainsAny(class, "\r\n") {
		return api.Usage("--class: 类名写一行")
	}
	if n := utf8.RuneCountInString(class); n > maxClass {
		return api.Usage("--class: 最多 %d 字，收到 %d 字", maxClass, n)
	}
	return nil
}

// setFinding 写来源与类：都空为没有。
func setFinding(ctx context.Context, tx *sql.Tx, id string, src Source, class string) error {
	if src == "" && class == "" {
		_, err := tx.ExecContext(ctx, `DELETE FROM task_findings WHERE task = ?`, id)
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO task_findings (task, source, class) VALUES (?, ?, ?)
		ON CONFLICT (task) DO UPDATE SET source = excluded.source, class = excluded.class`, id, src, class)
	return err
}

// Correction 纯判定：用户本人（u1）在验收时退回、取消一件任务，要自动记的那条「用户纠正」草稿。
// 取消草稿不算（那是在清理草稿）。
func Correction(t Task, next State, kind EventKind, actor, note string) (NewTask, bool) {
	if actor != "u1" || t.Status == Draft {
		return NewTask{}, false
	}
	var did string
	switch {
	case kind == Bounce && t.Stage == StageAccept:
		did = "验收时退回"
	case next.Status == Cancelled && t.Status != Cancelled:
		did = "取消"
	default:
		return NewTask{}, false
	}
	why := strings.TrimSpace(note)
	if why == "" {
		why = "没写"
	}
	return NewTask{
		Title:    clip(fmt.Sprintf("用户%s %s：%s", did, t.ID, t.Title), maxTitle-1),
		Detail:   clip(fmt.Sprintf("%s「%s」被用户%s。\n原因：%s", t.ID, t.Title, did, why), maxDetail-1),
		Org:      t.Org,
		Priority: Normal,
		Draft:    true,
		Source:   SourceUser,
	}, true
}

// Class 是一个类与归进去的任务数。
type Class struct {
	Name  string `json:"name"`
	Tasks int    `json:"tasks"`
	Done  int    `json:"done"`
}

// Classes 列已有的类（按任务数多的在前），加草稿时对照，避免同一类写成两个名字。
func Classes(ctx context.Context, q store.Querier) ([]Class, error) {
	rows, err := q.QueryContext(ctx, `SELECT f.class, count(*), COALESCE(sum(t.status = 'done'), 0)
		FROM task_findings f JOIN tasks t ON t.id = f.task WHERE f.class <> ''
		GROUP BY f.class ORDER BY count(*) DESC, f.class LIMIT ?`, maxClasses+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Class{}
	for rows.Next() {
		var c Class
		if err := rows.Scan(&c.Name, &c.Tasks, &c.Done); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	if len(out) > maxClasses {
		return nil, fmt.Errorf("类超过 %d 个，先把同一类的并起来（atrium task set tN --class 已有类名）", maxClasses)
	}
	return out, rows.Err()
}

// maxClasses 是一次读出的类的技术上限。
const maxClasses = 1000
