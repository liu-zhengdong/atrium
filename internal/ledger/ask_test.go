package ledger

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestCheckAsk(t *testing.T) {
	for _, status := range Statuses {
		t.Run(string(status), func(t *testing.T) {
			err := CheckAsk(Task{ID: "t1", Status: status}, "挑几号？")
			if (err == nil) != (status == Todo) {
				t.Fatalf("%s: %v", status, err)
			}
		})
	}
	for _, c := range []struct {
		text string
		ok   bool
	}{{" \n ", false}, {strings.Repeat("问", MaxAsk), true}, {strings.Repeat("问", MaxAsk+1), false}} {
		if err := CheckAsk(Task{ID: "t1", Status: Todo}, c.text); (err == nil) != c.ok {
			t.Fatalf("%d 字: %v", len([]rune(c.text)), err)
		}
	}
}

func TestAskClearedOnStateChange(t *testing.T) {
	for _, to := range []Status{Draft, Queued, Running, Done, Failed, Blocked, Cancelled} {
		t.Run(string(to), func(t *testing.T) {
			db, err := store.Open(t.TempDir() + "/ask.db")
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			ctx := context.Background()
			task, err := Add(ctx, db, NewTask{Title: "在问用户"}, "u1")
			if err != nil {
				t.Fatal(err)
			}
			if err := db.Tx(ctx, func(tx *sql.Tx) error { return SetAsk(ctx, tx, task.ID, "挑几号？") }); err != nil {
				t.Fatal(err)
			}
			ev := Event{Kind: Set, To: to}
			if to == Queued {
				ev = Event{Kind: Enqueue}
			}
			if to == Blocked {
				ev = Event{Kind: Block}
			}
			if to == Draft {
				// 转草稿需要部门。
				if _, err := db.Exec(`INSERT INTO departments (id, name, created_at, updated_at) VALUES ('o1', '测试', 0, 0)`); err != nil {
					t.Fatal(err)
				}
				dept := "o1"
				if _, err := Edit(ctx, db, task.ID, Patch{Org: &dept}, "u1"); err != nil {
					t.Fatal(err)
				}
			}
			if to == Running {
				if _, err := Apply(ctx, db, task.ID, Event{Kind: Enqueue}, "u1", ""); err != nil {
					t.Fatal(err)
				}
				ev = Event{Kind: Start}
			}
			got, err := Apply(ctx, db, task.ID, ev, "u1", "不再等待回话")
			if err != nil {
				t.Fatal(err)
			}
			if got.Ask != "" || got.AskedAt != 0 || got.Status != to {
				t.Fatalf("状态切换应清题: %+v", got)
			}
		})
	}
}
