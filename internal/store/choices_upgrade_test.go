package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func legacyChoices(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "atrium.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	old := strings.Replace(schema, "'passed', 'void'", "'passed'", 1)
	if _, err := db.Exec(old); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO departments(id,name,created_at,updated_at) VALUES('o1','隔离',1,1);
 INSERT INTO choices(id,department,title,recommend,reason,status,created_by,created_at) VALUES
 ('c1','o1','待选','1','理由','open','secretary',1),
 ('c2','o1','已选','1','理由','picked','secretary',2),
 ('c3','o1','略过','1','理由','passed','secretary',3);
 INSERT INTO choice_options(choice,pos,title,gain,why_now,cost,if_not,evidence) SELECT id,1,'项','收益','现在','成本','影响','m1/report.md' FROM choices;
 INSERT INTO choice_option_orgs(choice,pos,department) SELECT id,1,'o1' FROM choices;
 CREATE INDEX choices_created_test ON choices(created_at);
 INSERT INTO ids VALUES('c',3);`); err != nil {
		t.Fatal(err)
	}
	return db, path
}

func TestChoicesUpgradePreservesData(t *testing.T) {
	original, path := legacyChoices(t)
	original.Close()
	for i := 0; i < 2; i++ {
		db, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		var states string
		if err := db.QueryRow(`SELECT group_concat(status,',') FROM (SELECT status FROM choices ORDER BY id)`).Scan(&states); err != nil {
			t.Fatal(err)
		}
		if states != "open,picked,passed" {
			t.Fatal(states)
		}
		for _, table := range []string{"choice_options", "choice_option_orgs"} {
			var n int
			db.QueryRow(`SELECT count(*) FROM ` + table).Scan(&n)
			if n != 3 {
				t.Fatal(table, n)
			}
		}
		var n int
		db.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE name='choices_created_test'`).Scan(&n)
		if n != 1 {
			t.Fatal("索引丢失")
		}
		var fk int
		db.QueryRow(`PRAGMA foreign_keys`).Scan(&fk)
		if fk != 1 {
			t.Fatal("外键未恢复")
		}
		if _, err := db.Exec(`UPDATE choices SET status='void' WHERE id='c1'`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`UPDATE choices SET status='open' WHERE id='c1'`); err != nil {
			t.Fatal(err)
		}
		db.Close()
	}
}

func TestChoicesUpgradeRollbackAndForeignKeys(t *testing.T) {
	db, _ := legacyChoices(t)
	// 模拟存量关联损坏，使升级在复制和改名之后、提交之前失败。
	if _, err := db.Exec(`INSERT INTO choice_option_orgs VALUES('missing',1,'o1')`); err != nil {
		t.Fatal(err)
	}
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	old := strings.Replace(tableDefinition("choices"), "'passed', 'void'", "'passed'", 1)
	if err := upgradeTableConn(context.Background(), conn, "choices", old); err == nil || !strings.Contains(err.Error(), "外键检查失败") {
		t.Fatalf("want failure: %v", err)
	}
	var fk int
	conn.QueryRowContext(context.Background(), `PRAGMA foreign_keys`).Scan(&fk)
	if fk != 1 {
		t.Fatal("失败后外键未恢复")
	}
	if _, err := conn.ExecContext(context.Background(), `INSERT INTO choice_option_orgs VALUES('another_missing',1,'o1')`); err == nil {
		t.Fatal("失败后同一连接放行了损坏的外键")
	}
	var ddl string
	conn.QueryRowContext(context.Background(), `SELECT sql FROM sqlite_schema WHERE name='choices'`).Scan(&ddl)
	if strings.Contains(ddl, "'void'") {
		t.Fatal("事务未回滚")
	}
	var n int
	conn.QueryRowContext(context.Background(), `SELECT count(*) FROM choices`).Scan(&n)
	if n != 3 {
		t.Fatal("数据丢失")
	}
	conn.QueryRowContext(context.Background(), `SELECT count(*) FROM sqlite_schema WHERE name='choices_upgrade'`).Scan(&n)
	if n != 0 {
		t.Fatal("临时表未回滚")
	}
	t.Log("故意失败后：旧 CHECK、3 条 choices、临时表回滚；同一专用连接 foreign_keys=1，非法关联写入被拒")
}

func TestChoicesUpgradeRejectsUnknown(t *testing.T) {
	db, path := legacyChoices(t)
	if _, err := db.Exec(`ALTER TABLE choices ADD COLUMN unknown TEXT`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if opened, err := Open(path); err == nil {
		opened.Close()
		t.Fatal("未知结构放行")
	}
}
