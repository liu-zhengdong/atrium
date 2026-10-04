package events

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liu-zhengdong/atrium/internal/store"
)

func TestChoicesUpgradeDelivery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "atrium.db")
	db, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO departments(id,name,created_at,updated_at) VALUES('o1','根部门',1,1);
 INSERT INTO identities(id,kind,name,created_at) VALUES('a1','leader','负责人',1);
 UPDATE departments SET leader='a1' WHERE id='o1';`); err != nil {
		t.Fatal(err)
	}
	// 故意缺少现行索引依赖的列：建表阶段也必须能降级。
	if _, err := db.Exec(`DROP TABLE choices; CREATE TABLE choices(id TEXT PRIMARY KEY, unknown TEXT); INSERT INTO choices VALUES('c1','保留');`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	db, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := ReportChoicesUpgrade(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	if err := ReportChoicesUpgrade(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	rows, err := Take(context.Background(), db, "a1", false)
	if err != nil || len(rows) != 1 {
		t.Fatalf("负责人未收到事件：%v %v", rows, err)
	}
	if rows[0].Kind != ChoicesUpgradeSkipped || rows[0].Level != Act || rows[0].Count != 2 {
		t.Fatal(rows[0])
	}
	if summary := Summary(rows[0], nil); !strings.Contains(summary, path) || !strings.Contains(summary, "手工迁移") {
		t.Fatal(summary)
	}
	var body map[string]string
	if err := json.Unmarshal(rows[0].Body, &body); err != nil {
		t.Fatal(err)
	}
	if body["database"] != path || !strings.Contains(body["structure"], "unknown") || body["skipped"] == "" || body["next"] == "" {
		t.Fatal(body)
	}
	var value string
	if err := db.QueryRow(`SELECT unknown FROM choices WHERE id='c1'`).Scan(&value); err != nil || value != "保留" {
		t.Fatal(value, err)
	}
	t.Log("未知结构 Open 成功，原数据保留，负责人 Take 收到 act 事件及库路径、结构、跳过项和下一步；重复启动通知合并")
}
