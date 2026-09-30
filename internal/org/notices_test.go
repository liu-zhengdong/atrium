package org

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestScanNoticesOverThenClearThenAgain(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO identities (id, kind, name, created_at) VALUES ('a1', 'leader', '甲', 0)`); err != nil {
		t.Fatal(err)
	}
	root, err := Add(ctx, db, NewDept{Name: "公司", Leader: "a1"})
	if err != nil {
		t.Fatal(err)
	}
	sub, err := Add(ctx, db, NewDept{Name: "运行时", Parent: root.ID, Leader: "a1"})
	if err != nil {
		t.Fatal(err)
	}
	insertOverPoints(t, db, sub.ID, MaxPoints+1)

	emit, clear, err := ScanNotices(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(clear) != 0 || len(emit) != 1 || emit[0].Scope != sub.ID || emit[0].Target != "a1" ||
		emit[0].Limit.Key != "points" || emit[0].Used != MaxPoints+1 {
		t.Fatalf("超限该提醒部门负责人一次：emit=%+v clear=%v", emit, clear)
	}

	if err := RecordNotice(ctx, db, emit[0].Scope, emit[0].Limit.Key, emit[0].Used); err != nil {
		t.Fatal(err)
	}
	emit, clear, err = ScanNotices(ctx, db)
	if err != nil || len(emit) != 0 || len(clear) != 0 {
		t.Fatalf("已提醒不该再发：emit=%+v clear=%v err=%v", emit, clear, err)
	}

	if _, err := db.ExecContext(ctx, `DELETE FROM points WHERE department = ? AND pos > ?`, sub.ID, MaxPoints-1); err != nil {
		t.Fatal(err)
	}
	emit, clear, err = ScanNotices(ctx, db)
	if err != nil || len(emit) != 0 || len(clear) != 1 || clear[0] != (NoticeRef{Scope: sub.ID, Key: "points"}) {
		t.Fatalf("回落该清：emit=%+v clear=%v err=%v", emit, clear, err)
	}
	if err := ForgetNotice(ctx, db, clear[0].Scope, clear[0].Key); err != nil {
		t.Fatal(err)
	}

	insertOverPoints(t, db, sub.ID, 2)
	emit, clear, err = ScanNotices(ctx, db)
	if err != nil || len(clear) != 0 || len(emit) != 1 || emit[0].Used != MaxPoints+1 {
		t.Fatalf("回落后再超再发：emit=%+v clear=%v err=%v", emit, clear, err)
	}
}

func TestScanNoticesAtLimitAndNoLeader(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	root, err := Add(ctx, db, NewDept{Name: "公司"})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < MaxPoints; i++ {
		if _, err := AddPoint(ctx, db, root.ID, NewPoint{Text: "p"}, "u1"); err != nil {
			t.Fatal(err)
		}
	}
	emit, _, err := ScanNotices(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(emit) != 1 || emit[0].Used != MaxPoints || emit[0].Target != Secretary || emit[0].Scope != root.ID {
		t.Fatalf("刚到上限、没负责人投秘书：%+v", emit)
	}
}

func insertOverPoints(t *testing.T, db *store.DB, dept string, n int) {
	t.Helper()
	ctx := context.Background()
	var maxPos int
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(max(pos), 0) FROM points WHERE department = ?`, dept).Scan(&maxPos); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= n; i++ {
		pos := maxPos + i
		id := fmt.Sprintf("k%s-%d", dept, pos)
		if _, err := db.ExecContext(ctx, `INSERT INTO points (id, department, pos, text, decided_by, updated_by, updated_at)
			VALUES (?, ?, ?, '规矩', 'u1', 'import', 0)`, id, dept, pos); err != nil {
			t.Fatal(err)
		}
	}
}

func TestScanNoticesDraftsPerDept(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	for _, id := range []string{"a1", "a2", "a3"} {
		if _, err := db.Exec(`INSERT INTO identities (id, kind, name, created_at) VALUES (?, 'leader', ?, 0)`, id, id); err != nil {
			t.Fatal(err)
		}
	}
	root := must(Add(ctx, db, NewDept{Name: "公司", Leader: "a1"}))
	full := must(Add(ctx, db, NewDept{Name: "运行时", Parent: root.ID, Leader: "a2"}))
	other := must(Add(ctx, db, NewDept{Name: "网页", Parent: root.ID, Leader: "a3"}))
	n := 0
	draft := func(dept string) {
		n++
		if _, err := db.Exec(`INSERT INTO tasks (id, department, title, status, created_at, updated_at) VALUES (?, ?, '草稿', 'draft', 0, 0)`,
			fmt.Sprintf("t%d", n), dept); err != nil {
			t.Fatal(err)
		}
	}
	for range MaxDrafts {
		draft(full.ID)
	}
	draft(other.ID)
	emit, _, err := ScanNotices(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(emit) != 1 || emit[0].Limit.Key != "drafts" || emit[0].Scope != full.ID || emit[0].Target != "a2" || emit[0].Used != MaxDrafts {
		t.Fatalf("草稿满了只提醒该部门的负责人（不找秘书、不找上级）：%+v", emit)
	}
	if got := NoticeNext(emit[0].Limit, full.ID); got != "atrium task ls --org "+full.ID+" --status draft" {
		t.Fatalf("腾地方的命令应指向本部门的草稿：%q", got)
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
