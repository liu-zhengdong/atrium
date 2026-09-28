package org

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 决定：只记用户拍板的事与原因，只追加（dN）。推翻或合并时写新的一条并用 Replaces 指出旧的，
// 旧的记 superseded_by 指向它、不再算有效。有效条目每部门上限 MaxDecisions，满了先整理。
const (
	maxDecisionText = 300
	maxDecisionWhy  = 1000
)

type Decision struct {
	ID           string `json:"id"`
	Org          string `json:"org"`
	Text         string `json:"text"`
	Why          string `json:"why,omitempty"`
	By           string `json:"by"`
	SupersededBy string `json:"superseded_by,omitempty"`
	CreatedAt    int64  `json:"created_at"`
}

// NewDecision 是 decision add 的输入。Replaces 是这条推翻或合并掉的旧决定。
type NewDecision struct {
	Org      string   `json:"org"`
	Text     string   `json:"text"`
	Why      string   `json:"why"`
	Replaces []string `json:"replaces"`
}

// DecisionRoom 纯判定：有效 active 条，加一条、换掉 replaced 条后是否超上限。
func DecisionRoom(dept string, active, replaced int) error {
	if active+1-replaced > MaxDecisions {
		return Full("decisions", dept, active)
	}
	return nil
}

// AddDecision 在调用方的事务里记一条决定（选项单拍板也用它，与拍板同生同死）。
func AddDecision(ctx context.Context, tx *sql.Tx, in NewDecision, actor string) (Decision, error) {
	if err := checkText("text", in.Text, maxDecisionText, true); err != nil {
		return Decision{}, err
	}
	if err := checkText("why", in.Why, maxDecisionWhy, false); err != nil {
		return Decision{}, err
	}
	if _, err := Get(ctx, tx, in.Org); err != nil {
		return Decision{}, err
	}
	for _, old := range in.Replaces {
		d, err := GetDecision(ctx, tx, old)
		if err != nil {
			return Decision{}, err
		}
		if d.SupersededBy != "" {
			return Decision{}, api.Conflict("--replaces: %s 已被 %s 推翻", old, d.SupersededBy)
		}
		if d.Org != in.Org {
			return Decision{}, api.Usage("--replaces: %s 属于 %s，不是 %s", old, d.Org, in.Org)
		}
	}
	var active int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM decisions WHERE department = ? AND superseded_by IS NULL`,
		in.Org).Scan(&active); err != nil {
		return Decision{}, err
	}
	if err := DecisionRoom(in.Org, active, len(in.Replaces)); err != nil {
		return Decision{}, err
	}
	id, err := store.NextID(ctx, tx, "d")
	if err != nil {
		return Decision{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO decisions (id, department, text, why, decided_by, created_at)
		VALUES (?, ?, ?, ?, ?, ?)`, id, in.Org, strings.TrimSpace(in.Text), in.Why, actor, store.Now()); err != nil {
		return Decision{}, err
	}
	for _, old := range in.Replaces {
		if _, err := tx.ExecContext(ctx, `UPDATE decisions SET superseded_by = ? WHERE id = ?`, id, old); err != nil {
			return Decision{}, err
		}
	}
	return GetDecision(ctx, tx, id)
}

const decisionCols = `id, department, text, why, decided_by, COALESCE(superseded_by, ''), created_at`

func scanDecision(s interface{ Scan(...any) error }) (Decision, error) {
	var d Decision
	err := s.Scan(&d.ID, &d.Org, &d.Text, &d.Why, &d.By, &d.SupersededBy, &d.CreatedAt)
	return d, err
}

func GetDecision(ctx context.Context, q store.Querier, id string) (Decision, error) {
	d, err := scanDecision(q.QueryRowContext(ctx, `SELECT `+decisionCols+` FROM decisions WHERE id = ?`, id))
	if store.IsNotFound(err) {
		return Decision{}, api.NotFound("决定 %s 不存在", id).WithNext("atrium decision ls")
	}
	return d, err
}

// DecisionFilter 是 decision ls 的条件：关键词（在决定与原因里找）、部门、是否含已推翻的。
type DecisionFilter struct {
	Keyword string
	Org     string
	All     bool
	Limit   int
}

// Decisions 按新到旧列决定。负责人唤醒附「最近有效决定」用 Decisions(…, DecisionFilter{Org: oN})。
func Decisions(ctx context.Context, q store.Querier, f DecisionFilter) ([]Decision, error) {
	where, args := []string{"1 = 1"}, []any{}
	if !f.All {
		where = append(where, "superseded_by IS NULL")
	}
	if f.Org != "" {
		where, args = append(where, "department = ?"), append(args, f.Org)
	}
	if f.Keyword != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(f.Keyword) + "%"
		where, args = append(where, `(text LIKE ? ESCAPE '\' OR why LIKE ? ESCAPE '\')`), append(args, like, like)
	}
	// 没给 Limit 就全给（超了每部门上限的也给，由调用方标「超限」），读到 ReadCap 以上报错；给了按调用方要的条数。
	explicit := f.Limit > 0
	if !explicit || f.Limit > ReadCap {
		f.Limit = ReadCap + 1
	}
	rows, err := q.QueryContext(ctx, `SELECT `+decisionCols+` FROM decisions WHERE `+strings.Join(where, " AND ")+
		` ORDER BY created_at DESC, id DESC LIMIT ?`, append(args, f.Limit)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Decision{}
	for rows.Next() {
		d, err := scanDecision(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !explicit {
		return out, capErr("决定", len(out))
	}
	return out[:min(len(out), ReadCap)], nil
}

func decisionRoutes(r *api.Router, env *app.Env) {
	db := env.DB
	r.Handle("GET /api/decisions", func(q *api.Req) (any, error) {
		v := q.URL.Query()
		f := DecisionFilter{Keyword: v.Get("q"), Org: v.Get("node"), All: v.Get("all") == "1"}
		if s := v.Get("limit"); s != "" {
			n, err := strconv.Atoi(s)
			if err != nil {
				return nil, api.Usage("--limit: 应为整数")
			}
			f.Limit = n
		}
		return Decisions(q.Context(), db, f)
	})
	r.Handle("POST /api/decisions", func(q *api.Req) (any, error) {
		if err := CheckUser(q.Actor, "记决定"); err != nil {
			return nil, err
		}
		var in NewDecision
		if err := q.Decode(&in); err != nil {
			return nil, err
		}
		var d Decision
		err := db.Tx(q.Context(), func(tx *sql.Tx) error {
			var err error
			d, err = AddDecision(q.Context(), tx, in, q.Actor.ID)
			return err
		})
		return d, err
	})
}

func decisionLine(d Decision) string {
	s := fmt.Sprintf("%s（%s，%s）%s", d.ID, d.Org, fmtTime(d.CreatedAt), d.Text)
	if d.Why != "" {
		s += "——" + d.Why
	}
	if d.SupersededBy != "" {
		s += "〔已被 " + d.SupersededBy + " 推翻〕"
	}
	return s
}

func decisionCommands(t *cli.Table) {
	t.Group("decision", "决定")
	t.Add(cli.Command{Path: "decision add", Args: "<oN> <决定>", Summary: fmt.Sprintf("记一条用户拍板的决定（有效条目每部门上限 %d）", MaxDecisions),
		Flags: []cli.Flag{
			{Name: "why", Value: "文字", Help: "原因"},
			{Name: "replaces", Value: "dN", Multi: true, Help: "这条推翻或合并掉的旧决定"},
		},
		Run: func(c *cli.Ctx) error {
			dept, err := c.Arg(0, "<oN>")
			if err != nil {
				return err
			}
			text, err := c.Arg(1, "<决定>")
			if err != nil {
				return err
			}
			if err := c.MaxArgs(2); err != nil {
				return err
			}
			var d Decision
			in := NewDecision{Org: dept, Text: text, Why: c.Str("why"), Replaces: c.List("replaces")}
			if err := c.Call("POST", "/api/decisions", in, &d); err != nil {
				return err
			}
			msg := "已记决定 " + decisionLine(d)
			if len(in.Replaces) > 0 {
				msg += "\n推翻：" + strings.Join(in.Replaces, "、")
			}
			return c.Done(d, msg, "atrium decision ls --node "+d.Org)
		}})
	t.Add(cli.Command{Path: "decision ls", Args: "[关键词]", Summary: "查决定（缺省只列有效的）",
		Flags: []cli.Flag{
			{Name: "node", Value: "oN", Help: "只看这个部门的"},
			{Name: "all", Bool: true, Help: "含已推翻的"},
		},
		Run: func(c *cli.Ctx) error {
			if err := c.MaxArgs(1); err != nil {
				return err
			}
			v := url.Values{}
			if len(c.Args) == 1 {
				v.Set("q", c.Args[0])
			}
			if n := c.Str("node"); n != "" {
				v.Set("node", n)
			}
			if c.Bool("all") {
				v.Set("all", "1")
			}
			var list []Decision
			if err := c.Call("GET", "/api/decisions?"+v.Encode(), nil, &list); err != nil {
				return err
			}
			if len(list) == 0 {
				return c.Done(list, "没有决定", "atrium decision add <oN> <决定> --why <原因>")
			}
			var b strings.Builder
			for _, d := range list {
				b.WriteString(decisionLine(d) + "\n")
			}
			return c.Done(list, b.String(), "atrium decision add <oN> <决定> --replaces <dN>")
		}})
}
