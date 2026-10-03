package web

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestTodayDraftCountMatchesDestination(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "atrium.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	check := func(want int) {
		t.Helper()
		today, err := loadToday(ctx, db, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if today.Drafts != want {
			t.Fatalf("今天页草稿 = %d，期望 %d", today.Drafts, want)
		}
	}
	check(0) // 无组织
	root, err := org.Add(ctx, db, org.NewDept{Name: "组织"})
	if err != nil {
		t.Fatal(err)
	}
	sub, err := org.Add(ctx, db, org.NewDept{Name: "网页", Parent: root.ID})
	if err != nil {
		t.Fatal(err)
	}
	check(0) // 空草稿组
	add := func(title, dept, parent string, draft bool) ledger.Task {
		t.Helper()
		task, err := ledger.Add(ctx, db, ledger.NewTask{Title: title, Org: dept, Parent: parent, Draft: draft}, "u1")
		if err != nil {
			t.Fatal(err)
		}
		return task
	}
	goal := add("进行中的目标", root.ID, "", false)
	for _, kind := range []ledger.EventKind{ledger.Enqueue, ledger.Start} {
		if _, err := ledger.Apply(ctx, db, goal.ID, ledger.Event{Kind: kind}, "u1", ""); err != nil {
			t.Fatal(err)
		}
	}
	child := add("挂在进行中任务下的草稿", sub.ID, goal.ID, true)
	draft := add("独立草稿", sub.ID, "", true)
	add("草稿下的草稿", sub.ID, draft.ID, true)
	check(1) // 三件草稿，但草稿组只有一个根
	page, err := loadDept(ctx, db, t.TempDir(), root.ID)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	found := false
	for _, row := range page.Tasks {
		if row.State == "draft" {
			n++
		}
		if row.ID == goal.ID {
			for _, kid := range row.Kids {
				if kid.ID == child.ID {
					found = true
				}
			}
		}
	}
	if n != 1 || !found {
		t.Fatalf("草稿组根数 %d，进行中目标下草稿保留 %v", n, found)
	}
	other, err := org.Add(ctx, db, org.NewDept{Name: "另一棵组织"})
	if err != nil {
		t.Fatal(err)
	}
	add("其他组织草稿", other.ID, "", true)
	check(1) // 跳转只去第一个根组织
	// 超过部门页加载上限时也使用相同目标集合，不另算全库。
	for i := 0; i < 105; i++ {
		add("待派", sub.ID, "", false)
	}
	page, err = loadDept(ctx, db, t.TempDir(), root.ID)
	if err != nil {
		t.Fatal(err)
	}
	n = 0
	for _, row := range page.Tasks {
		if row.State == "draft" {
			n++
		}
	}
	check(n)
}
