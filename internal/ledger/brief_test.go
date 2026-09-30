package ledger

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestBrief(t *testing.T) {
	ctx := context.Background()
	db := openDB(t)
	task, err := Add(ctx, db, NewTask{Title: "任务", Detail: " 原说明 "}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	detail, upto, err := Brief(ctx, db, task)
	if err != nil || detail != "原说明" || upto != 0 {
		t.Fatalf("无补充：%q %d %v", detail, upto, err)
	}
	for i := 1; i <= 22; i++ {
		if err := Record(ctx, db, task.ID, "tell", "a7", fmt.Sprintf("补充%02d", i)); err != nil {
			t.Fatal(err)
		}
	}
	// 普通备注不是任务要求，也不能推进补充说明的送达编号。
	if err := Record(ctx, db, task.ID, "note", "a7", "备注"); err != nil {
		t.Fatal(err)
	}
	detail, upto, err = Brief(ctx, db, task)
	if err != nil {
		t.Fatal(err)
	}
	var want strings.Builder
	want.WriteString("原说明\n\n### 之后的补充（以后面为准）\n\n")
	for i := 3; i <= 22; i++ {
		fmt.Fprintf(&want, "- 补充%02d\n", i)
	}
	var last int64
	if err := db.QueryRowContext(ctx, `SELECT max(id) FROM task_events WHERE task = ? AND kind = 'tell'`, task.ID).Scan(&last); err != nil {
		t.Fatal(err)
	}
	if detail != strings.TrimSpace(want.String()) || upto != last {
		t.Fatalf("补充范围、排序或送达编号不对：%q %d（应为 %d）", detail, upto, last)
	}
}
