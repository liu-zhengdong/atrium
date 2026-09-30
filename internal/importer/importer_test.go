package importer

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/hosts"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func i64(n int64) *int64 { return &n }

func TestPlanDepts(t *testing.T) {
	nodes := []oldNode{
		{ID: 4, Parent: i64(2), Name: "cli", Fields: `{"alias":"命令行","what":"入口","uses":["看全景","派活"]}`},
		{ID: 1, Name: "组织", Fields: `{"what":"根"}`},
		{ID: 2, Parent: i64(1), Name: "Atrium", Fields: `{"alias":"","now":" 在做 "}`},
		{ID: 3, Parent: i64(1), Name: "旧", Archived: true},
		{ID: 5, Parent: i64(3), Name: "旧的下级"},
	}
	got, skipped, err := planDepts(nodes)
	if err != nil {
		t.Fatal(err)
	}
	want := []Dept{
		{ID: "o1", Name: "组织", What: "根"},
		{ID: "o2", Parent: "o1", Name: "Atrium", Now: "在做"},
		{ID: "o4", Parent: "o2", Name: "命令行", What: "入口", Uses: "看全景\n派活"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("部门：\n得到 %+v\n想要 %+v", got, want)
	}
	if !reflect.DeepEqual(skipped, []string{"o3 已归档", "o5 上级 o3 没导入"}) {
		t.Errorf("跳过：%v", skipped)
	}
	if _, _, err := planDepts([]oldNode{{ID: 1, Name: "x", Fields: `{"what":3}`}}); err == nil {
		t.Error("what 是数字应报错")
	}
	if _, _, err := planDepts([]oldNode{{ID: 1, Parent: i64(9), Name: "x"}}); err == nil {
		t.Error("上级不存在应报错")
	}
}

func TestPlanPoints(t *testing.T) {
	var list []oldPoint
	for i := int64(1); i <= 9; i++ {
		list = append(list, oldPoint{ID: 20 - i, Node: 2, Pos: i - 5, Text: "p"})
	}
	list = append(list, oldPoint{ID: 30, Node: 1, Pos: 1}, oldPoint{ID: 31, Node: 1, Pos: 1}, oldPoint{ID: 40, Node: 7, Pos: 1})
	got, skipped, over := planPoints(list, map[string]bool{"o1": true, "o2": true})
	if len(got) != 11 || got[0].ID != "k30" || got[1].ID != "k31" || got[1].Pos != 2 || got[2].ID != "k19" || got[2].Pos != 1 || got[10].Pos != 9 {
		t.Errorf("排序或重排不对：%+v", got)
	}
	if !reflect.DeepEqual(skipped, []string{"k40 所在部门 o7 没导入"}) || !reflect.DeepEqual(over, []string{"o2 9/7"}) {
		t.Errorf("跳过 %v 超限 %v", skipped, over)
	}
}

func TestSmallRules(t *testing.T) {
	if checkHostJSON(`{"max_workers":6}`, `["*"]`) != nil || checkHostJSON("", `[]`) != nil {
		t.Error("合法的机器信息被拒")
	}
	if checkHostJSON(`[1]`, `["*"]`) == nil || checkHostJSON("", `"*"`) == nil {
		t.Error("坏的机器信息应报错")
	}
	for p, ok := range map[string]bool{"a/b.md": true, "README.md": true, "../x": false, "/etc/passwd": false,
		"a/../../x": false, ".git/config": false, "a//b": false, `a\b`: false, "": false} {
		if safeRel(p) != ok {
			t.Errorf("safeRel(%q) 应为 %v", p, ok)
		}
	}
	files, err := skillFiles(`{"SKILL.md":"做法","references/a.md":"x"}`)
	if err != nil || len(files) != 2 {
		t.Errorf("技能文件：%v %v", files, err)
	}
	if _, err := skillFiles(`{"SKILL.md":"x","../../evil":"x"}`); err == nil {
		t.Error("越界的附属文件路径应报错")
	}
	if _, err := skillFiles(`{"README.md":"x"}`); err == nil {
		t.Error("没有 SKILL.md 应报错")
	}
}

// oldSchema 是旧库里导入用到的表（只含用到的列）。
const oldSchema = `
CREATE TABLE org_nodes (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT NOT NULL, archived_at INTEGER);
CREATE TABLE org_docs (node_id INTEGER, doc TEXT, fields TEXT);
CREATE TABLE org_node_repos (node_id INTEGER, repo TEXT);
CREATE TABLE org_points (id INTEGER PRIMARY KEY, node_id INTEGER, pos INTEGER, text TEXT, why TEXT, decided_by TEXT, check_ref TEXT, updated_by TEXT, updated_at INTEGER);
CREATE TABLE org_leaders (id INTEGER PRIMARY KEY, name TEXT, worker TEXT, created_at INTEGER);
CREATE TABLE memos (owner TEXT PRIMARY KEY, body TEXT, updated_at INTEGER);
CREATE TABLE org_skills (id INTEGER PRIMARY KEY, slug TEXT, rev INTEGER, files TEXT, archived_at INTEGER, updated_at INTEGER);
CREATE TABLE materials (id INTEGER PRIMARY KEY, node_id INTEGER, kind TEXT, name TEXT, note TEXT DEFAULT '', version INTEGER, bytes INTEGER, created_by TEXT, created_at INTEGER, archived_at INTEGER, superseded_by INTEGER);
CREATE TABLE material_versions (material_id INTEGER, version INTEGER, manifest TEXT);
CREATE TABLE worker_profiles (layer TEXT, name TEXT, source TEXT, updated_by TEXT, updated_at INTEGER);
CREATE TABLE hosts (id INTEGER PRIMARY KEY, name TEXT, kind TEXT, info TEXT, repos TEXT, max_running INTEGER, removed_at INTEGER, last_seen_at INTEGER, created_at INTEGER, ssh_target TEXT, ssh_key TEXT, tunnel_local_port INTEGER, tunnel_remote_port INTEGER);
CREATE TABLE tasks (id INTEGER PRIMARY KEY);
CREATE TABLE choices (id INTEGER PRIMARY KEY);
CREATE TABLE schedules (id INTEGER PRIMARY KEY);
INSERT INTO org_nodes VALUES (1, NULL, '组织', NULL), (2, 1, 'atrium', NULL), (3, 1, '旧', 5);
INSERT INTO org_docs VALUES (2, 'charter', '{"alias":"Atrium","what":"底座","uses":["a","b"]}');
INSERT INTO org_node_repos VALUES (2, '/repo/atrium');
INSERT INTO org_points VALUES (5, 2, -1, '先减后加', '简单', 'u1 09-27', NULL, 'u1', 1), (6, 2, 0, '事实为准', '', 'u1', '$ make', 'u1', 2);
INSERT INTO org_leaders VALUES (1, 'Atrium 负责人', 'claude+opus:high', 1);
INSERT INTO memos VALUES ('a1', '备忘', 3), ('secretary', '秘书备忘', 4), ('a9', '没这个人', 5);
INSERT INTO org_skills VALUES (1, 'visual-design', 2, '{"SKILL.md":"---\ndescription: 视觉设计\n---\n做法","references/a.md":"细节"}', NULL, 10);
INSERT INTO materials VALUES (1, 2, 'dir', '设计稿', '原型与截图', 1, 5, 'u1', 11, NULL, NULL);
INSERT INTO material_versions VALUES (1, 1, '[{"path":"README.md","size":2},{"path":"shots/a.png","size":3}]');
INSERT INTO worker_profiles VALUES ('harness', 'claude', '---\ntrust: high\n---\n', 'u1', 12);
INSERT INTO hosts VALUES (1, '本机', 'local', '{"max_workers":6,"node":"v24"}', '["*"]', NULL, NULL, NULL, 13, NULL, NULL, NULL, NULL), (2, '旧', 'remote', NULL, '[]', NULL, 99, NULL, 14, NULL, NULL, NULL, NULL), (3, 'ggb', 'remote', NULL, '["*"]', 4, NULL, 15, 16, 'me@ggb', '/k/id_ggb', 4310, 14310);
INSERT INTO tasks VALUES (306);
INSERT INTO choices VALUES (3);
`

func oldDB(t *testing.T, extra string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "atrium.sqlite")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(oldSchema + extra); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{"README.md": "hi", "shots/a.png": "png"}
	for p, body := range files {
		full := filepath.Join(dir, "materials", "m1", "v1", filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(full), 0o700)
		os.WriteFile(full, []byte(body), 0o600)
	}
	return path
}

func newDB(t *testing.T) (*store.DB, string) {
	t.Helper()
	data := t.TempDir()
	db, err := store.Open(filepath.Join(data, "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db, data
}

func count(t *testing.T, db *store.DB, q string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(q).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRun(t *testing.T) {
	ctx := context.Background()
	from := oldDB(t, "")
	db, data := newDB(t)
	rep, err := Run(ctx, from, db, data)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][2]int{}
	for _, it := range rep.Items {
		got[it.Kind] = [2]int{it.Imported, it.Skipped}
	}
	want := map[string][2]int{"部门": {2, 1}, "部门仓库": {1, 0}, "要点": {2, 0}, "负责人": {1, 0}, "备忘": {2, 1},
		"技能": {1, 0}, "资料": {1, 0}, "执行者档案": {1, 0}, "机器": {2, 1}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("回执：\n得到 %v\n想要 %v", got, want)
	}
	var name, uses string
	db.QueryRow(`SELECT name, uses FROM departments WHERE id = 'o2'`).Scan(&name, &uses)
	if name != "Atrium" || uses != "a\nb" {
		t.Errorf("部门 o2：%q %q", name, uses)
	}
	if n := count(t, db, `SELECT count(*) FROM points WHERE id = 'k5' AND pos = 1`); n != 1 {
		t.Error("k5 应是 o2 第 1 条")
	}
	h1, err := hosts.Get(ctx, db, "h1")
	if err != nil || h1.Info == nil || h1.Info.MaxWorkers != 6 || h1.Repos[0] != "*" {
		t.Errorf("h1 用 hosts 包读回：%+v %v", h1, err)
	}
	if h3, _ := hosts.Get(ctx, db, "h3"); h3.SSH != "me@ggb" || h3.Key != "/k/id_ggb" || h3.TunnelRemote != 14310 || h3.TunnelLocal != 0 {
		t.Errorf("h3 的隧道与私钥应带过来、本机端口不带：%+v", h3)
	}
	if h3, _ := hosts.Get(ctx, db, "h3"); h3.MaxRunning != 4 || h3.Joined {
		t.Errorf("h3：%+v（令牌不搬，应未接入）", h3)
	}
	if n := count(t, db, `SELECT count(*) FROM worker_profiles WHERE name = 'harness/claude'`); n != 1 {
		t.Error("档案名应带层名")
	}
	// 目录资料还是一条 m1：标题是原名称，README.md 是正文，图片按相对路径跟着。
	if b, err := os.ReadFile(filepath.Join(data, "materials", "m1", "r1", "shots", "a.png")); err != nil || string(b) != "png" {
		t.Errorf("资料文件：%q %v", b, err)
	}
	var title, note, entry string
	db.QueryRow(`SELECT title, note, file FROM materials WHERE id = 'm1'`).Scan(&title, &note, &entry)
	if title != "设计稿" || note != "原型与截图" || entry != "README.md" {
		t.Errorf("资料 m1：%q %q %q", title, note, entry)
	}
	if n := count(t, db, `SELECT count(*) FROM material_files WHERE id = 'm1' AND rev = 1`); n != 2 {
		t.Errorf("资料 m1 的文件清单：%d", n)
	}
	if b, err := os.ReadFile(filepath.Join(data, "skills", "visual-design", "r2", "references", "a.md")); err != nil || string(b) != "细节" {
		t.Errorf("技能附属文件：%q %v", b, err)
	}
	var summary string
	db.QueryRow(`SELECT summary FROM skills WHERE name = 'visual-design'`).Scan(&summary)
	if summary != "视觉设计" {
		t.Errorf("技能一行说明：%q", summary)
	}
	// 短号接着旧库往后：任务虽没搬，下一个也是 t307。
	next, err := store.NextID(ctx, db, "t")
	if err != nil || next != "t307" {
		t.Errorf("下一个任务号 %s %v", next, err)
	}
	if !strings.Contains(Text(rep, data), "a9 不是已导入的身份") {
		t.Error("人读回执应写跳过原因")
	}
	// 新库有数据就拒绝。
	if _, err := Run(ctx, from, db, data); err == nil || !strings.Contains(err.Error(), "新库已有数据") {
		t.Errorf("第二次导入应拒绝：%v", err)
	}
}

// 破坏输入：清单里有 .. 路径、资料文件缺失、大小不符，都整体失败且新库保持空。
func TestRunBrokenMaterial(t *testing.T) {
	cases := map[string]string{
		"越界路径": `UPDATE material_versions SET manifest = '[{"path":"../../etc/passwd","size":2}]';`,
		"文件缺失": `UPDATE material_versions SET manifest = '[{"path":"missing.md","size":2}]';`,
		"大小不符": `UPDATE material_versions SET manifest = '[{"path":"README.md","size":99}]';`,
	}
	for name, extra := range cases {
		t.Run(name, func(t *testing.T) {
			db, data := newDB(t)
			if _, err := Run(context.Background(), oldDB(t, extra), db, data); err == nil {
				t.Fatal("应失败")
			}
			if n := count(t, db, `SELECT count(*) FROM departments`); n != 0 {
				t.Errorf("失败后新库应回滚为空，部门 %d", n)
			}
			if _, err := os.Stat(filepath.Join(data, "materials")); !os.IsNotExist(err) {
				t.Errorf("失败后不应留下资料目录：%v", err)
			}
		})
	}
}

func TestConvertProfile(t *testing.T) {
	known := []string{"finished", "pr_exists"}
	same := "---\ntrust: high   # 注释留着\n---\n正文\n"
	if out, gone, err := convertProfile(same, known); err != nil || out != same || gone != nil {
		t.Fatalf("没有旧键应原样返回：%q %v %v", out, gone, err)
	}
	old := "---\ninvoke: codex exec -\ncost: plan\ntrust: low\nchecks: [pr_exists, finished, local_check]\n---\n正文\n"
	out, gone, err := convertProfile(old, known)
	if err != nil {
		t.Fatal(err)
	}
	want := "---\nchecks:\n    - pr_exists\n    - finished\ntrust: low\n---\n正文\n"
	if out != want || !reflect.DeepEqual(gone, []string{"invoke", "cost", "checks:local_check"}) {
		t.Fatalf("得到 %q %v", out, gone)
	}
	if _, _, err := convertProfile("---\nx: [\n---\n", known); err == nil {
		t.Fatal("坏 YAML 应报错")
	}
}
