package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenCreatesAllTablesAndIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.db")
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = Open(path) // 再开一次不报错
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 22 {
		t.Fatalf("表数 = %d，想要 22", n)
	}
	var fk int
	db.QueryRow(`PRAGMA foreign_keys`).Scan(&fk)
	if fk != 1 {
		t.Fatal("外键没开")
	}
}

func TestNextIDIsPerPrefixAndNeverReused(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "a.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	next := func(p string) string {
		var id string
		if err := db.Tx(ctx, func(tx *sql.Tx) (err error) { id, err = NextID(ctx, tx, p); return }); err != nil {
			t.Fatal(err)
		}
		return id
	}
	for _, want := range []string{"t1", "t2"} {
		if got := next("t"); got != want {
			t.Fatalf("got %s want %s", got, want)
		}
	}
	if got := next("o"); got != "o1" {
		t.Fatalf("got %s", got)
	}
	if got := next("t"); got != "t3" {
		t.Fatalf("got %s", got)
	}
	if _, err := NextID(ctx, db, "x"); err == nil {
		t.Fatal("未知前缀应报错")
	}
}
