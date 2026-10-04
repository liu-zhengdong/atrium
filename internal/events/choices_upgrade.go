package events

import (
	"context"
	"database/sql"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// ReportChoicesUpgrade 经已有投递路径通知组织根部门负责人；无负责人时交秘书。
func ReportChoicesUpgrade(ctx context.Context, db *store.DB) error {
	if db.ChoicesSkipped == nil {
		return nil
	}
	var root string
	err := db.QueryRowContext(ctx, `SELECT id FROM departments WHERE parent IS NULL ORDER BY created_at, id LIMIT 1`).Scan(&root)
	if err != nil && !store.IsNotFound(err) {
		return err
	}
	return db.Tx(ctx, func(tx *sql.Tx) error {
		return Emit(ctx, tx, Event{Kind: ChoicesUpgradeSkipped, Dept: root, Level: Act,
			Key: "choices-upgrade:" + db.ChoicesSkipped.Database,
			Body: map[string]string{"database": db.ChoicesSkipped.Database, "structure": db.ChoicesSkipped.Structure,
				"skipped": "choices 结构升级（原表与数据保留）", "next": "手工迁移 choices，或向上级负责人上报迁移方案；选项单相关操作可能报错，其他服务继续运行"}})
	})
}
