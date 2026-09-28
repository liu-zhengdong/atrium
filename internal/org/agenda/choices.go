package agenda

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/events"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 选项单：调研后提给用户的 3–5 个方向，各写能多做到什么、为什么现在、代价、不做会怎样、依据，外加推荐与理由。
// 只有用户能拍板：pick 选中的在部门下各建一件任务（详述 = 选项全文），整轮记一条决定；pass 整份不做，也记一条。
const (
	maxChoiceTitle = 100
	maxOptionTitle = 80
	maxOptionField = 600
	maxReason      = 600
	maxPickNote    = 300
	choiceFile     = "choice.json" // 调研任务在工作目录根写它，完成时登记（Settle）
)

type OptionInput struct {
	Title    string `json:"title"`
	Gain     string `json:"gain"`     // 能多做到什么
	WhyNow   string `json:"why_now"`  // 为什么现在
	Cost     string `json:"cost"`     // 代价
	IfNot    string `json:"if_not"`   // 不做会怎样
	Evidence string `json:"evidence"` // 依据
}

// ChoiceInput 是 choice add 的输入，也是 choice.json 的格式（Org 在 choice.json 里不写，取任务的部门）。
type ChoiceInput struct {
	Org       string        `json:"org,omitempty"`
	Title     string        `json:"title"`
	Options   []OptionInput `json:"options"`
	Recommend []int         `json:"recommend"` // 推荐第几项（1 起）
	Reason    string        `json:"reason"`
}

type Option struct {
	Pos int `json:"pos"`
	OptionInput
	Task string `json:"task,omitempty"` // 选中后建的任务
}

type Choice struct {
	ID        string   `json:"id"`
	Org       string   `json:"org"`
	Task      string   `json:"task,omitempty"` // 出这份选项单的调研任务
	Title     string   `json:"title"`
	Recommend []int    `json:"recommend"`
	Reason    string   `json:"reason"`
	Status    string   `json:"status"` // open picked passed
	Note      string   `json:"note,omitempty"`
	Decision  string   `json:"decision,omitempty"`
	CreatedBy string   `json:"created_by"`
	CreatedAt int64    `json:"created_at"`
	DecidedAt *int64   `json:"decided_at,omitempty"`
	Options   []Option `json:"options"`
}

func need(field, v string, limit int) error {
	if strings.TrimSpace(v) == "" {
		return api.Usage("%s: 不能为空", field)
	}
	if n := utf8.RuneCountInString(v); n > limit {
		return api.Usage("%s: 最多 %d 字，收到 %d 字", field, limit, n)
	}
	return nil
}

// CheckChoice 纯判定：3–5 项，每项五栏都写了，推荐的是其中几项且写了理由。
func CheckChoice(in ChoiceInput) error {
	if err := need("title", in.Title, maxChoiceTitle); err != nil {
		return err
	}
	n := len(in.Options)
	if n > org.MaxOptions {
		return org.Full("options", "", n)
	}
	if n < org.MinOptions {
		return api.Usage("options: 至少 %d 项，收到 %d 项：只有一两条路就直接建任务，不用选项单", org.MinOptions, n)
	}
	for i, o := range in.Options {
		p := fmt.Sprintf("options[%d].", i+1)
		for _, f := range []struct {
			name, v string
			limit   int
		}{{"title", o.Title, maxOptionTitle}, {"gain", o.Gain, maxOptionField}, {"why_now", o.WhyNow, maxOptionField},
			{"cost", o.Cost, maxOptionField}, {"if_not", o.IfNot, maxOptionField}, {"evidence", o.Evidence, maxOptionField}} {
			if err := need(p+f.name, f.v, f.limit); err != nil {
				return err
			}
		}
	}
	if err := CheckPicks("recommend", in.Recommend, n); err != nil {
		return err
	}
	return need("reason", in.Reason, maxReason)
}

// CheckPicks 纯判定：非空、在 1–n 之内、不重复。
func CheckPicks(field string, picks []int, n int) error {
	if len(picks) == 0 {
		return api.Usage("%s: 至少一项", field)
	}
	seen := map[int]bool{}
	for _, p := range picks {
		if p < 1 || p > n {
			return api.Usage("%s: 应为 1–%d，收到 %d", field, n, p)
		}
		if seen[p] {
			return api.Usage("%s: %d 重复", field, p)
		}
		seen[p] = true
	}
	return nil
}

// OptionDetail 纯函数：选中后建的任务的详述 = 选项全文。
func OptionDetail(c Choice, o Option, note string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "来自选项单 %s「%s」第 %d 项（用户选定）。\n\n", c.ID, c.Title, o.Pos)
	for _, kv := range [][2]string{{"能多做到什么", o.Gain}, {"为什么现在", o.WhyNow}, {"代价", o.Cost},
		{"不做会怎样", o.IfNot}, {"依据", o.Evidence}} {
		fmt.Fprintf(&b, "%s：%s\n", kv[0], kv[1])
	}
	if note != "" {
		fmt.Fprintf(&b, "\n用户说明：%s\n", note)
	}
	return b.String()
}

// VerdictText 纯函数：一轮拍板记成一条决定的文字。picks 为空表示整份不做。
func VerdictText(c Choice, picks []int) string {
	var do, skip []string
	for _, o := range c.Options {
		if slices.Contains(picks, o.Pos) {
			do = append(do, o.Title)
		} else {
			skip = append(skip, o.Title)
		}
	}
	s := fmt.Sprintf("%s「%s」：", c.ID, c.Title)
	switch {
	case len(do) == 0:
		s += "这轮都不做（" + strings.Join(skip, "、") + "）"
	case len(skip) == 0:
		s += "全做（" + strings.Join(do, "、") + "）"
	default:
		s += "做 " + strings.Join(do, "、") + "；这轮不做 " + strings.Join(skip, "、")
	}
	if r := []rune(s); len(r) > 300 {
		s = string(r[:299]) + "…"
	}
	return s
}

func joinInts(v []int) string {
	s := make([]string, len(v))
	for i, n := range v {
		s[i] = strconv.Itoa(n)
	}
	return strings.Join(s, ",")
}

func splitInts(s string) []int {
	out := []int{}
	for _, p := range strings.Split(s, ",") {
		if n, err := strconv.Atoi(strings.TrimSpace(p)); err == nil {
			out = append(out, n)
		}
	}
	return out
}

// AddChoice 登记一份选项单。task 非空时同一件任务只登记一次（再调返回已有的）。
func AddChoice(ctx context.Context, db *store.DB, in ChoiceInput, task, actor string) (Choice, error) {
	if err := CheckChoice(in); err != nil {
		return Choice{}, err
	}
	var id string
	err := db.Tx(ctx, func(tx *sql.Tx) error {
		if task != "" {
			err := tx.QueryRowContext(ctx, `SELECT id FROM choices WHERE task = ?`, task).Scan(&id)
			if err == nil {
				return nil
			}
			if !store.IsNotFound(err) {
				return err
			}
		}
		if _, err := org.Get(ctx, tx, in.Org); err != nil {
			return err
		}
		var open int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM choices WHERE department = ? AND status = 'open'`, in.Org).Scan(&open); err != nil {
			return err
		}
		if open >= org.MaxChoices {
			return org.Full("choices", in.Org, open)
		}
		var err error
		if id, err = store.NextID(ctx, tx, "c"); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO choices (id, department, task, title, recommend, reason, status, created_by, created_at)
			VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`, id, in.Org, store.Null(task), strings.TrimSpace(in.Title),
			joinInts(in.Recommend), in.Reason, actor, store.Now()); err != nil {
			return err
		}
		for i, o := range in.Options {
			if _, err := tx.ExecContext(ctx, `INSERT INTO choice_options (choice, pos, title, gain, why_now, cost, if_not, evidence)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, i+1, strings.TrimSpace(o.Title), o.Gain, o.WhyNow, o.Cost, o.IfNot, o.Evidence); err != nil {
				return err
			}
		}
		return events.Emit(ctx, tx, events.Event{Kind: events.ChoiceOpen, Task: task, Dept: in.Org, Target: events.Secretary,
			Level: events.Act, Body: map[string]any{"choice": id, "title": id + " 等你拍板：" + in.Title}})
	})
	if err != nil {
		return Choice{}, err
	}
	return GetChoice(ctx, db, id)
}

func GetChoice(ctx context.Context, q store.Querier, id string) (Choice, error) {
	var c Choice
	var task, note, decision sql.NullString
	var decided sql.NullInt64
	var rec string
	err := q.QueryRowContext(ctx, `SELECT id, department, task, title, recommend, reason, status, note, decision, created_by,
		created_at, decided_at FROM choices WHERE id = ?`, id).Scan(&c.ID, &c.Org, &task, &c.Title, &rec, &c.Reason, &c.Status,
		&note, &decision, &c.CreatedBy, &c.CreatedAt, &decided)
	if store.IsNotFound(err) {
		return Choice{}, api.NotFound("选项单 %s 不存在", id).WithNext("atrium choice ls")
	}
	if err != nil {
		return Choice{}, err
	}
	c.Task, c.Note, c.Decision, c.Recommend = task.String, note.String, decision.String, splitInts(rec)
	if decided.Valid {
		c.DecidedAt = &decided.Int64
	}
	rows, err := q.QueryContext(ctx, `SELECT pos, title, gain, why_now, cost, if_not, evidence, COALESCE(task, '')
		FROM choice_options WHERE choice = ? ORDER BY pos LIMIT ?`, id, org.MaxOptions)
	if err != nil {
		return Choice{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var o Option
		if err := rows.Scan(&o.Pos, &o.Title, &o.Gain, &o.WhyNow, &o.Cost, &o.IfNot, &o.Evidence, &o.Task); err != nil {
			return Choice{}, err
		}
		c.Options = append(c.Options, o)
	}
	return c, rows.Err()
}

// Choices 列选项单（不含选项正文）：缺省只列等拍板的。
func Choices(ctx context.Context, q store.Querier, dept string, all bool) ([]Choice, error) {
	where, args := []string{"1 = 1"}, []any{}
	if !all {
		where = append(where, "status = 'open'")
	}
	if dept != "" {
		where, args = append(where, "department = ?"), append(args, dept)
	}
	rows, err := q.QueryContext(ctx, `SELECT id FROM choices WHERE `+strings.Join(where, " AND ")+
		` ORDER BY created_at DESC, id DESC LIMIT 200`, args...)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	out := []Choice{}
	for _, id := range ids {
		c, err := GetChoice(ctx, q, id)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Decide 是用户拍板：picks 非空为 pick（各建一件任务），空为 pass。整轮记一条决定。
// 建任务走 ledger.Add（各自一个事务），所以先把会拒绝的都查完（状态、决定上限），再建任务，最后一个事务记结果。
func Decide(ctx context.Context, db *store.DB, id string, picks []int, note, actor string) (Choice, error) {
	if utf8.RuneCountInString(note) > maxPickNote {
		return Choice{}, api.Usage("--note: 最多 %d 字", maxPickNote)
	}
	c, err := GetChoice(ctx, db, id)
	if err != nil {
		return Choice{}, err
	}
	if c.Status != "open" {
		return Choice{}, api.Conflict("%s 已经拍过板（%s）", id, c.Status).WithNext("atrium choice ls " + id)
	}
	if picks != nil {
		if err := CheckPicks("picks", picks, len(c.Options)); err != nil {
			return Choice{}, err
		}
	}
	var active int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM decisions WHERE department = ? AND superseded_by IS NULL`, c.Org).Scan(&active); err != nil {
		return Choice{}, err
	}
	if err := org.DecisionRoom(c.Org, active, 0); err != nil {
		return Choice{}, err
	}
	made := map[int]string{}
	for _, o := range c.Options {
		if !slices.Contains(picks, o.Pos) {
			continue
		}
		t, err := ledger.Add(ctx, db, ledger.NewTask{Title: o.Title, Detail: OptionDetail(c, o, note), Org: c.Org}, actor)
		if err != nil {
			return Choice{}, err
		}
		made[o.Pos] = t.ID
	}
	status := "passed"
	if len(picks) > 0 {
		status = "picked"
	}
	err = db.Tx(ctx, func(tx *sql.Tx) error {
		d, err := org.AddDecision(ctx, tx, org.NewDecision{Org: c.Org, Text: VerdictText(c, picks), Why: note}, actor)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE choices SET status = ?, note = ?, decision = ?, decided_at = ? WHERE id = ? AND status = 'open'`,
			status, note, d.ID, store.Now(), id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return api.Conflict("%s 同时被别人拍了板", id)
		}
		for pos, task := range made {
			if _, err := tx.ExecContext(ctx, `UPDATE choice_options SET task = ? WHERE choice = ? AND pos = ?`, task, id, pos); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return Choice{}, err
	}
	return GetChoice(ctx, db, id)
}

// Settle 是调研任务完成时的钩子（gates 在判过关卡后调）：工作目录根有 choice.json 就登记成选项单，挂在任务的部门下。
// 没有这个文件返回 nil；文件不合法返回错误（写明哪一栏），调用方把它当关卡不过交回执行者修。
func Settle(ctx context.Context, db *store.DB, task, workdir string) (*Choice, error) {
	raw, err := os.ReadFile(filepath.Join(workdir, choiceFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var in ChoiceInput
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		return nil, api.Usage("%s 不合法：%v", choiceFile, err)
	}
	t, err := ledger.Get(ctx, db, task)
	if err != nil {
		return nil, err
	}
	if t.Org == "" {
		return nil, api.Usage("%s 没挂部门，%s 无处登记", task, choiceFile)
	}
	in.Org = t.Org
	c, err := AddChoice(ctx, db, in, task, task)
	if err != nil {
		return nil, err
	}
	return &c, nil
}
