package store

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// 存量 schedules（种类 CHECK 没有 wake）升级后数据原样、能写入 wake，重复打开幂等；未知结构拒绝打开。
func TestSchedulesUpgradeAllowsWake(t *testing.T) {
	path := filepath.Join(t.TempDir(), "atrium.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(strings.Replace(schema, ", 'wake'", "", 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`INSERT INTO departments(id,name,created_at,updated_at) VALUES('o1','隔离',1,1);
 INSERT INTO schedules(id,department,kind,every_ms,title,next_at,created_by,created_at) VALUES
 ('s1','o1','task',3600000,'每小时',1000,'u1',1);`); err != nil {
		t.Fatal(err)
	}
	legacy.Close()

	// 第一次打开：升级旧表，老数据原样，能写入 wake。
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var kind, title string
	if err := db.QueryRow(`SELECT kind, title FROM schedules WHERE id='s1'`).Scan(&kind, &title); err != nil || kind != "task" || title != "每小时" {
		t.Fatalf("kind=%s title=%s err=%v", kind, title, err)
	}
	if _, err := db.Exec(`INSERT INTO schedules(id,department,kind,every_ms,title,next_at,created_by,created_at)
		VALUES('s2','o1','wake',0,'到点叫醒',2000,'a9',2)`); err != nil {
		t.Fatalf("升级后应能写 wake：%v", err)
	}
	db.Close()

	// 重复打开幂等，两条都在。
	db, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM schedules`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	db.Close()

	// 未知结构拒绝打开。
	unknown, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := unknown.Exec(`ALTER TABLE schedules ADD COLUMN unknown TEXT`); err != nil {
		t.Fatal(err)
	}
	unknown.Close()
	if db, err := Open(path); err == nil {
		db.Close()
		t.Fatal("未知结构放行")
	}
}
