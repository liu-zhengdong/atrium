package org

import (
	"context"
	"fmt"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/cli"
	"github.com/liu-zhengdong/atrium/internal/store"
)

// 上限表：会增长的东西 → 上限 → 满了找谁 → 怎么办。这里是唯一来源：常量给代码用，Limits 给人和网页看，
// 满了的报错（Full）也从这里取说法。满了先合并、删最不值的、下沉或拆分，最后才提高上限。
const (
	MaxDepth         = 5    // 部门树深
	MaxDepts         = 500  // 全部部门（一次读全树的上限）
	MaxPoints        = 7    // 每部门要点
	MaxRepos         = 20   // 每部门仓库
	MaxMemo          = 2000 // 每份备忘（字；秘书、每位负责人各一份）
	MaxLeaders       = 200  // 全部负责人
	MaxLeaderWorkers = 5    // 负责人的执行者组合
	MaxSkills        = 50   // 全部技能
	MaxSkillBody     = 6 << 10
	MaxSkillFile     = 5     // 技能里单个文件（MB；截图等二进制也收）
	MaxSkillTotal    = 10    // 一个技能全部文件合计（MB）
	MaxSkillLayer    = 12    // 技能目录里每一层的项数（直接的文件 + 子文件夹）
	MaxOverview      = 3000  // 部门资料总览（字）
	MaxMaterial      = 50000 // 部门资料文本总量（字；二进制不计，见 Units）
	MaxMaterialFile  = 20    // 单个资料文件（MB）
	MaxMaterialBin   = 200   // 部门二进制资料总量（MB）
	MinOptions       = 3     // 每份选项单至少几项
	MaxOptions       = 5     // 每份选项单至多几项
	MaxChoices       = 5     // 每部门待拍板的选项单
	MaxSchedules     = 10    // 每部门周期任务
	MaxSecrets       = 20    // 每部门凭据
	MaxDrafts        = 20    // 全部草稿任务（秘书一次能过完的量）
)

// Limit 是上限表的一行。Next 里的 {dept} 换成部门短号。
type Limit struct {
	Key   string `json:"key"`
	What  string `json:"what"`
	Max   int    `json:"max"`
	Unit  string `json:"unit"`
	Owner string `json:"owner"` // 满了找谁
	Fix   string `json:"fix"`   // 怎么办
	Next  string `json:"next"`  // 腾地方的第一条命令
}

var Limits = []Limit{
	{"depth", "部门树深", MaxDepth, "层", "秘书", "把这块并进上级，或挂到更浅的部门下", "atrium org tree"},
	{"depts", "全部部门", MaxDepts, "个", "秘书", "合并职责相近的部门", "atrium org tree"},
	{"points", "每部门要点", MaxPoints, "条", "部门负责人",
		"先合并相近的（atrium point edit kN --text …）、删掉最不值的（atrium point edit kN --delete），或下沉到子部门",
		"atrium org show {dept}"},
	{"repos", "每部门仓库", MaxRepos, "个", "部门负责人", "拆子部门，或去掉不用的（atrium org edit {dept} --repo-rm …）", "atrium org show {dept}"},
	{"leaders", "全部负责人", MaxLeaders, "位", "秘书", "合并职责相近的部门，一位负责人管几个部门", "atrium leader ls"},
	{"memo", "每份备忘", MaxMemo, "字", "备忘的主人", "不记进展（任务到哪了看 atrium top）；删掉已经过时的、合并重复的，只留账本里没有、下次醒来必须知道的；定下的规矩提成要点", "atrium memo show"},
	{"skills", "全部技能", MaxSkills, "个", "秘书", "合并相近的技能，删掉没人用的", "atrium skill ls"},
	{"skill_body", "每份 SKILL.md", MaxSkillBody, "B", "技能作者", "细节挪进技能目录里的附属文件，SKILL.md 只留做法", "atrium skill ls"},
	{"skill_file", "技能里单个文件", MaxSkillFile, "MB", "技能作者", "压缩或拆小；截图只留说明做法必需的", "atrium skill ls"},
	{"skill_total", "每个技能文件合计", MaxSkillTotal, "MB", "技能作者", "删掉不必要的附属文件、压缩截图", "atrium skill ls"},
	{"skill_layer", "技能目录每一层", MaxSkillLayer, "项", "技能作者",
		"按用途收进子文件夹（如 taste/good、taste/bad），或合并相近的文件", "atrium skill ls"},
	{"overview", "部门资料总览", MaxOverview, "字", "部门负责人", "总览只留每次都要知道的，细节挪进细节文件", "atrium material ls --node {dept}"},
	{"materials", "部门资料文本总量", MaxMaterial, "字", "部门负责人",
		"归档过时的（atrium material archive mN），或把一块知识下沉到子部门", "atrium material ls --node {dept}"},
	{"material_file", "单个资料文件", MaxMaterialFile, "MB", "加资料的人",
		"压缩或拆小；大文件放仓库或外部存储，资料里只写它是什么、在哪", "atrium material ls --node {dept}"},
	{"material_bin", "部门二进制资料总量", MaxMaterialBin, "MB", "部门负责人",
		"归档过时的图片等二进制资料（atrium material archive mN）", "atrium material ls --node {dept}"},
	{"options", "每份选项单", MaxOptions, "项", "出选项单的人", "只留最值得的几项", "atrium choice ls"},
	{"choices", "每部门待拍板的选项单", MaxChoices, "份", "用户", "先拍板或放弃已有的（atrium choice pick cN <第几项> 或 --none）", "atrium choice ls"},
	{"schedules", "每部门周期任务", MaxSchedules, "条", "部门负责人", "合并相近的、删掉不值的（atrium schedule rm sN）", "atrium schedule ls --node {dept}"},
	{"drafts", "全部草稿", MaxDrafts, "件", "秘书",
		"想清楚的转待派（atrium task set tN --status todo），不做的取消（--status cancelled），相近的合并", "atrium task ls --status draft"},
	{"secrets", "每部门凭据", MaxSecrets, "个", "用户", "删掉不用的（atrium secret set {dept} 名称 --rm），或挪到上级部门共用", "atrium secret ls --node {dept}"},
}

// ReadCap 是读路径的技术上限，不是业务上限：读东西不按上表截断（导入的旧数据、调低过的上限都可能超），
// 超了照样全部读出，由调用方标「超限 8/7」（Over）让人整理。查询仍有界：读到 ReadCap 条以上报错，不静默少给。
const ReadCap = 1000

// capErr：读到的条数超过 ReadCap 时报错。
func capErr(what string, n int) error {
	if n > ReadCap {
		return fmt.Errorf("%s超过 %d 条（读取上限），先整理", what, ReadCap)
	}
	return nil
}

// Over 是超了业务上限时的标注「超限 8/7」；没超返回空串。纯函数。
func Over(key string, used int) string {
	l := LimitOf(key)
	if used <= l.Max {
		return ""
	}
	return fmt.Sprintf("超限 %d/%d", used, l.Max)
}

// Tally 是用量的写法：「6/7」，超了写「超限 8/7」。纯函数。
func Tally(key string, used int) string {
	if o := Over(key, used); o != "" {
		return o
	}
	return fmt.Sprintf("%d/%d", used, LimitOf(key).Max)
}

// LimitOf 取上限表的一行；键写错是编程错误。
func LimitOf(key string) Limit {
	for _, l := range Limits {
		if l.Key == key {
			return l
		}
	}
	panic("上限表没有这一项：" + key)
}

// Full 是「满了」的报错：几 / 上限、找谁、怎么办，并附腾地方的命令。dept 可空（全局的上限）。
func Full(key, dept string, used int) error {
	l := LimitOf(key)
	return api.Limit(NoticeNext(l, dept), "%s", NoticeText(l, dept, used))
}

// MB 把字节数折成 MB，向上取整（上限表里文件大小的单位）。纯函数。
func MB(bytes int) int { return (bytes + 1<<20 - 1) >> 20 }

// TooBig 是按 MB 计的大小上限超了的报错：谁、多大、上限多少、超出多少、怎么办。key 是上限表里单位为 MB 的一项。
func TooBig(key, name string, bytes int) error {
	l := LimitOf(key)
	mb := func(b int) float64 { return float64(b) / (1 << 20) }
	return api.Limit(l.Next, "%s %s 有 %.1f MB，超过上限 %d MB（多 %.1f MB）：%s",
		l.What, name, mb(bytes), l.Max, mb(bytes-l.Max<<20), l.Fix)
}

// Count 是一项计数，网页显示成「6/7」。
type Count struct {
	Key  string `json:"key"`
	What string `json:"what"`
	Used int    `json:"used"`
	Max  int    `json:"max"`
	Unit string `json:"unit"`
}

func (c Count) String() string { return fmt.Sprintf("%s %d/%d %s", c.What, c.Used, c.Max, c.Unit) }

// Counts 取一个部门的各项计数；dept 为空时取全局的（部门数、技能数）。
func Counts(ctx context.Context, q store.Querier, dept string) ([]Count, error) {
	var queries []struct {
		key, sql string
		args     []any
	}
	add := func(key, sql string, args ...any) {
		queries = append(queries, struct {
			key, sql string
			args     []any
		}{key, sql, args})
	}
	if dept == "" {
		add("depts", `SELECT count(*) FROM departments`)
		add("skills", `SELECT count(DISTINCT name) FROM skills`)
		add("leaders", `SELECT count(*) FROM identities WHERE kind = 'leader'`)
		add("drafts", `SELECT count(*) FROM tasks WHERE status = 'draft'`)
	} else {
		if _, err := Get(ctx, q, dept); err != nil {
			return nil, err
		}
		add("points", `SELECT count(*) FROM points WHERE department = ?`, dept)
		add("repos", `SELECT count(*) FROM department_repos WHERE department = ?`, dept)
		add("memo", `SELECT COALESCE((SELECT length(m.body) FROM departments d JOIN memos m ON m.identity = d.leader
			WHERE d.id = ?), 0)`, dept)
		add("overview", `SELECT COALESCE(sum(units), 0) FROM materials m WHERE department = ? AND kind = 'overview'
			AND archived_at IS NULL AND rev = (SELECT max(rev) FROM materials WHERE id = m.id)`, dept)
		add("materials", `SELECT COALESCE(sum(units), 0) FROM materials m WHERE department = ? AND archived_at IS NULL
			AND rev = (SELECT max(rev) FROM materials WHERE id = m.id)`, dept)
		add("material_bin", `SELECT COALESCE(sum(f.size), 0) FROM materials m JOIN material_files f ON f.id = m.id AND f.rev = m.rev
			WHERE m.department = ? AND m.archived_at IS NULL AND f.binary AND m.rev = (SELECT max(rev) FROM materials WHERE id = m.id)`, dept)
		add("choices", `SELECT count(*) FROM choices WHERE department = ? AND status = 'open'`, dept)
		add("schedules", `SELECT count(*) FROM schedules WHERE department = ?`, dept)
		add("secrets", `SELECT count(*) FROM secrets WHERE department = ?`, dept)
	}
	out := make([]Count, 0, len(queries))
	for _, x := range queries {
		var n int
		if err := q.QueryRowContext(ctx, x.sql, x.args...).Scan(&n); err != nil {
			return nil, err
		}
		if x.key == "material_bin" {
			n = MB(n)
		}
		l := LimitOf(x.key)
		out = append(out, Count{Key: l.Key, What: l.What, Used: n, Max: l.Max, Unit: l.Unit})
	}
	return out, nil
}

// resourceRoutes、resourceCommands 接入第二波的技能、资料、凭据与上限表。
func resourceRoutes(r *api.Router, env *app.Env) {
	skillRoutes(r, env)
	materialRoutes(r, env)
	secretRoutes(r, env)
	// 上限表与计数（网页显示「6/7」）：不给 node 是全局的。
	r.Handle("GET /api/limits", func(q *api.Req) (any, error) {
		counts, err := Counts(q.Context(), env.DB, q.URL.Query().Get("node"))
		return map[string]any{"table": Limits, "counts": counts}, err
	})
}

func resourceCommands(t *cli.Table) {
	skillCommands(t)
	materialCommands(t)
	secretCommands(t)
}
