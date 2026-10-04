package merge_test

import (
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/api"
	"github.com/liu-zhengdong/atrium/internal/gates"
	"github.com/liu-zhengdong/atrium/internal/ledger"
	"github.com/liu-zhengdong/atrium/internal/merge"
)

func TestDeliverRefusesDraftAndNotDone(t *testing.T) {
	e := setup(t, nil)
	e.gh.Branch(filepath.Join(t.TempDir(), "wt"), "t1-a", map[string]string{"a.go": "package a\n"})
	n := e.gh.Open("t1-a", "")
	e.gh.PRs[0].Draft = true
	task, err := ledger.Add(e.ctx, e.db, ledger.NewTask{Title: "亲手做的"}, "u1")
	if err != nil {
		t.Fatal(err)
	}
	body := merge.Body{PR: "https://github.com/o/r/pull/" + strconv.Itoa(n)}
	_, err = merge.Deliver(e.ctx, e.db, e.gh, task.ID, body, "u1")
	t.Logf("草稿：%v", err)
	if ae, ok := err.(*api.Error); !ok || ae.Code != "conflict" || !strings.Contains(ae.Message, "gh pr ready 1 -R o/r") || !strings.Contains(ae.Next, "atrium task merge "+task.ID) {
		t.Fatalf("草稿应拦住并给出命令：%v", err)
	}
	if got := e.get(task.ID); got.Stage == ledger.StageMerge {
		t.Fatal("草稿不该进合入队列")
	}

	e.gh.PRs[0].Draft = false
	if err := ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "u1", "还没写完\n交付结论：没做成"); err != nil {
		t.Fatal(err)
	}
	_, err = merge.Deliver(e.ctx, e.db, e.gh, task.ID, body, "u1")
	t.Logf("没做成：%v", err)
	if ae, ok := err.(*api.Error); !ok || !strings.Contains(ae.Message, "交付结论：没做成（还没写完）") || !strings.Contains(ae.Message, "修完再交") {
		t.Fatalf("没做成应拦住：%v", err)
	}
	if got := e.get(task.ID); got.Stage == ledger.StageMerge {
		t.Fatal("没做成不该进合入队列")
	}

	if err := ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "u1", "等 #806 合入\n交付结论：受阻"); err != nil {
		t.Fatal(err)
	}
	_, err = merge.Deliver(e.ctx, e.db, e.gh, task.ID, body, "u1")
	t.Logf("受阻：%v", err)
	if ae, ok := err.(*api.Error); !ok || !strings.Contains(ae.Message, "交付结论：受阻（等 #806 合入）") {
		t.Fatalf("受阻应拦住：%v", err)
	}
	if got := e.get(task.ID); got.Stage == ledger.StageMerge {
		t.Fatal("受阻不该进合入队列")
	}

	if err := ledger.Record(e.ctx, e.db, task.ID, gates.KindResult, "u1", "写完了\n交付结论：完成"); err != nil {
		t.Fatal(err)
	}
	got, err := merge.Deliver(e.ctx, e.db, e.gh, task.ID, body, "u1")
	if err != nil || got.Stage != ledger.StageMerge {
		t.Fatalf("最新结论是完成且不是草稿，应进队列：%+v %v", got, err)
	}
}
