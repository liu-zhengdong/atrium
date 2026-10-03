package web

import (
	"context"
	"encoding/json"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/org"
	"github.com/liu-zhengdong/atrium/internal/store"
	"path/filepath"
	"reflect"
	"testing"
)

func TestTaskRoleProjection(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	dept, err := org.Add(ctx, db, org.NewDept{Name: "隔离"})
	must(err)
	task, err := ledger.Add(ctx, db, ledger.NewTask{Title: "角色投影", Org: dept.ID}, "a99")
	must(err)
	ix, err := loadOrg(ctx, db)
	must(err)
	row, err := looseRow(ctx, db, task, ix)
	must(err)
	if row.Owner != "a99" || row.OwnerLabel != "未登记负责人（a99）" {
		t.Fatalf("未知身份投影：%+v", row)
	}
	owner := "secretary"
	task, err = ledger.Edit(ctx, db, task.ID, ledger.Patch{Owner: &owner}, "u1")
	must(err)
	row, err = looseRow(ctx, db, task, ix)
	must(err)
	if row.Owner != "secretary" || row.OwnerLabel != "秘书" {
		t.Fatalf("处理人变更：%+v", row)
	}
	for i := 0; i < 55; i++ {
		must(ledger.Record(ctx, db, task.ID, "note", "a99", "a1 历史正文<&"))
	}
	detail, err := loadTask(ctx, db, task.ID)
	must(err)
	parties, err := ledger.PartiesOf(ctx, db, task.ID)
	must(err)
	history, err := ledger.History(ctx, db, task.ID, 50)
	must(err)
	if detail.Parties != parties || !reflect.DeepEqual(detail.History, history) || len(history) != 50 {
		t.Fatal("账本派生或经历上限不一致")
	}
	if detail.HistoryLabels["a99"] != "未登记负责人（a99）" || history[0].Body != "a1 历史正文<&" {
		t.Fatal("结构身份或历史正文被改")
	}
	bytes, err := json.Marshal(detail.Task)
	must(err)
	var machine map[string]any
	must(json.Unmarshal(bytes, &machine))
	for _, key := range []string{"owner", "owner_label", "parties", "history", "party_labels", "history_labels"} {
		if _, ok := machine[key]; ok {
			t.Fatalf("机器 Task 新增 %s", key)
		}
	}
	// 损坏建立记录必须报错，不能猜身份后继续显示。
	_, err = db.ExecContext(ctx, `UPDATE task_events SET body = ? WHERE task = ? AND kind = 'created'`, "{", task.ID)
	must(err)
	if _, err = looseRow(ctx, db, task, ix); err == nil {
		t.Fatal("损坏 PartiesOf 记录未被拒绝")
	}
}
