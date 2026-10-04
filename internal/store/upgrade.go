package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// tableDefinition 只从现行 schema 取表定义，避免升级另存一份列定义。
func tableDefinition(table string) string {
	start := strings.Index(schema, "CREATE TABLE IF NOT EXISTS "+table+" (")
	end := strings.Index(schema[start:], ");") + start + 2
	return schema[start:end]
}

func normalizeDDL(s, table string) string {
	s = strings.Replace(s, "IF NOT EXISTS ", "", 1)
	s = strings.Replace(s, `CREATE TABLE "`+table+`"`, `CREATE TABLE `+table, 1)
	return strings.Join(strings.Fields(strings.TrimSuffix(strings.TrimSpace(s), ";")), " ")
}

// upgradeTables 仅升级已确认的旧定义；未知 choices 返回降级信号，其他未知结构报错；
// 新库与现行结构不复制数据。
func upgradeTables(ctx context.Context, db *sql.DB, table, old string) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	return upgradeTableConn(ctx, conn, table, old)
}

func upgradeTableConn(ctx context.Context, conn *sql.Conn, table, old string) (err error) {
	var ddl string
	err = conn.QueryRowContext(ctx, `SELECT sql FROM sqlite_schema WHERE type='table' AND name=?`, table).Scan(&ddl)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	current := tableDefinition(table)
	if normalizeDDL(ddl, table) == normalizeDDL(current, table) {
		return nil
	}
	if table == "choices" {
		legacyDecision := strings.Replace(old, "  created_by", "  decision   TEXT REFERENCES decisions (id),\n  created_by", 1)
		if normalizeDDL(ddl, table) == normalizeDDL(legacyDecision, table) {
			var populated bool
			if err := conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM choices WHERE decision IS NOT NULL)`).Scan(&populated); err != nil {
				return err
			}
			if !populated {
				old = legacyDecision
			}
		}
		if normalizeDDL(ddl, table) != normalizeDDL(old, table) {
			return &ChoicesSkipped{Structure: normalizeDDL(ddl, table)}
		}
	}
	if normalizeDDL(ddl, table) != normalizeDDL(old, table) {
		return fmt.Errorf("未知 %s 结构，停止升级", table)
	}

	if _, err = conn.ExecContext(ctx, `PRAGMA foreign_keys=OFF`); err != nil {
		return err
	}
	defer func() {
		_, restoreErr := conn.ExecContext(context.Background(), `PRAGMA foreign_keys=ON`)
		err = errors.Join(err, restoreErr)
	}()
	return rebuildTable(ctx, conn, table, current, table == "choices" && strings.Contains(old, "decision   TEXT"))
}

func rebuildTable(ctx context.Context, conn *sql.Conn, table, current string, decision bool) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if decision {
		// 在写事务中再次确认，防止识别后其他写者填入 decision。
		var populated bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM choices WHERE decision IS NOT NULL)`).Scan(&populated); err != nil {
			return err
		}
		if populated {
			return &ChoicesSkipped{Structure: "历史 choices 的 decision 已有值"}
		}
	}
	// 显式索引也在同一事务保存、恢复；自动唯一索引由现行表定义建立。
	rows, err := tx.QueryContext(ctx, `SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name`, table)
	if err != nil {
		return err
	}
	var indexes []string
	for rows.Next() {
		var index string
		if err = rows.Scan(&index); err != nil {
			rows.Close()
			return err
		}
		indexes = append(indexes, index)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	// 列名从现行 DDL 派生，历史多余列不参与复制。
	var columns []string
	for _, line := range strings.Split(current, "\n")[1:] {
		fields := strings.Fields(line)
		if len(fields) > 1 {
			columns = append(columns, fields[0])
		}
	}
	cols := strings.Join(columns, ", ")
	upgrade := table + "_upgrade"
	for _, statement := range []string{
		strings.Replace(current, "IF NOT EXISTS "+table, upgrade, 1),
		`INSERT INTO ` + upgrade + ` (` + cols + `) SELECT ` + cols + ` FROM ` + table,
		`DROP TABLE ` + table,
		`ALTER TABLE ` + upgrade + ` RENAME TO ` + table,
	} {
		if _, err = tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	for _, index := range indexes {
		if _, err = tx.ExecContext(ctx, index); err != nil {
			return err
		}
	}
	rows, err = tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	broken := rows.Next()
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if broken {
		return fmt.Errorf("升级后外键检查失败")
	}
	return tx.Commit()
}

// ChoicesSkipped 表示未知 choices 原样保留，交给事件模块报告负责人。
type ChoicesSkipped struct {
	Database  string `json:"database"`
	Structure string `json:"structure"`
}

func (e *ChoicesSkipped) Error() string {
	return "未知 choices 结构，跳过 choices 升级：" + e.Structure
}

// upgradeChoices 仅接受已确认的旧 choices。
func upgradeChoices(ctx context.Context, db *sql.DB) error {
	return upgradeTables(ctx, db, "choices", strings.Replace(tableDefinition("choices"), "'passed', 'void'", "'passed'", 1))
}

// upgradeSchedules 仅接受已确认的旧 schedules：种类 CHECK 没有 wake 的那一版。
func upgradeSchedules(ctx context.Context, db *sql.DB) error {
	return upgradeTables(ctx, db, "schedules", strings.Replace(tableDefinition("schedules"), ", 'wake'", "", 1))
}
