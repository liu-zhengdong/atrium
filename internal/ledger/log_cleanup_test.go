package ledger

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestTaskLogCleanupEntrypoints(t *testing.T) {
	for _, entry := range []string{"startup", "add", "finish"} {
		t.Run(entry, func(t *testing.T) {
			db, ctx := openDB(t), context.Background()
			var seq int
			var name, path string
			if err := db.QueryRow("PRAGMA database_list").Scan(&seq, &name, &path); err != nil {
				t.Fatal(err)
			}
			root := filepath.Dir(path)
			for i, status := range []Status{Done, Failed, Cancelled, Done, Running, Done} {
				id := fmt.Sprintf("t%d", i+1)
				finished := store.Now() - taskLogRetention.Milliseconds() - time.Hour.Milliseconds()
				if i == 3 {
					finished = store.Now()
				}
				var stamp any = finished
				if i == 5 {
					stamp = nil
				}
				if _, err := db.Exec(`INSERT INTO tasks (id,title,status,created_at,updated_at,finished_at) VALUES (?,?,?,0,0,?)`, id, id, status, stamp); err != nil {
					t.Fatal(err)
				}
				dir := filepath.Join(root, "tasks", id)
				if err := os.MkdirAll(dir, 0o700); err != nil {
					t.Fatal(err)
				}
				for _, file := range []string{"run-1.log", "run-2.log", "notes.md"} {
					if err := os.WriteFile(filepath.Join(dir, file), []byte("保留内容"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if _, err := db.Exec(`INSERT INTO ids (prefix,last) VALUES ('t',6)`); err != nil {
				t.Fatal(err)
			}
			var err error
			switch entry {
			case "startup":
				err = Module().Run(ctx, &app.Env{DB: db})
			case "add":
				_, err = Add(ctx, db, NewTask{Title: "新任务"}, "u1")
			case "finish":
				_, err = Apply(ctx, db, "t5", Event{Kind: Cancel}, "test", "")
			}
			if err != nil {
				t.Fatal(err)
			}
			for i := 1; i <= 6; i++ {
				for _, file := range []string{"run-1.log", "run-2.log", "notes.md"} {
					_, err := os.Stat(filepath.Join(root, "tasks", fmt.Sprintf("t%d", i), file))
					deleted := i <= 3 && file != "notes.md"
					if deleted && !os.IsNotExist(err) || !deleted && err != nil {
						t.Fatalf("t%d/%s: deleted=%v err=%v", i, file, deleted, err)
					}
				}
			}
			t.Log("三种过期终态日志已删除；近期、非终态、无结束时间日志及其他文件保留")
		})
	}
}
