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

// upgradeTables 是存量表结构升级的公共路径：仅接受已确认的旧定义，与现行不一致且不是已知旧结构就报错停下；
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
	return rebuildTable(ctx, conn, table, current)
}

func rebuildTable(ctx context.Context, conn *sql.Conn, table, current string) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
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
	upgrade := table + "_upgrade"
	for _, statement := range []string{
		strings.Replace(current, "IF NOT EXISTS "+table, upgrade, 1),
		`INSERT INTO ` + upgrade + ` SELECT * FROM ` + table,
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

// upgradeChoices 仅接受已确认的旧 choices：没有 void 状态的那一版。
func upgradeChoices(ctx context.Context, db *sql.DB) error {
	return upgradeTables(ctx, db, "choices", strings.Replace(tableDefinition("choices"), "'passed', 'void'", "'passed'", 1))
}

// upgradeSchedules 仅接受已确认的旧 schedules：种类 CHECK 没有 wake 的那一版。
func upgradeSchedules(ctx context.Context, db *sql.DB) error {
	return upgradeTables(ctx, db, "schedules", strings.Replace(tableDefinition("schedules"), ", 'wake'", "", 1))
}
